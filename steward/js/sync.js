// Google sign-in, Google Drive sync, Google Calendar, and reminder notifications on the phone and the Mac (sent by
// the Google helper through Web Push; the old "Steward Reminders" calendar is kept only until they are proven).
// Since 4.0 Steward asks Google only for per-file Drive access ("drive.file": the files Steward itself made), so the
// sign-in has no warning screen and needs no Google review. What it cannot see that way (Claude's change files and
// scans, the notifications folder, Google Calendar) it reaches through the Steward helper's web app, which runs in
// Charles's own Google account and answers only Steward's own sign-in for that account (steward-helper/).
import { store, settings, BUNDLES, ITEMWISE } from './store.js';
import { applyOps, buildSummary } from './model.js';
import { adoptWriting } from './migrate.js';
import { pad } from './util.js';
import { snapshot, backgroundIsNewer, kvGet } from './lsmirror.js';

const SCOPES = 'https://www.googleapis.com/auth/drive.file';
const SCOPE_V = 2; // 1: whole Drive and Calendar (before 4.0); 2: per-file Drive only
// Google's permission screen can show the Drive box unticked. If it is left unticked Google still signs Steward in, but
// Steward cannot reach its files: catch that and say what to do.
const NEEDED = [['https://www.googleapis.com/auth/drive.file', 'Google Drive']];
function checkScopes(granted) {
  if (!granted) return; // Google left the list out: nothing to check
  const have = String(granted).split(/[\s,]+/);
  const missing = NEEDED.filter(([s]) => !have.includes(s)).map(([, n]) => n);
  if (!missing.length) return;
  const e = new Error('scopes');
  e.detail = `Google signed you in but left out ${missing.join(' and ')}. Tap here, and on Google's screen tick every box (or "Select all") before Continue.`;
  throw e;
}
const DRIVE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FILE_NAMES = { tasks: 'steward-tasks.json', organize: 'steward-organize.json' };
// Before 2.4, notes were one whole-section file. Any still found is read in once, then moved to the trash.
const OLD_FILES = { 'steward-notes.json': ['notebooks', 'notes', 'ocr'] };
const LIB = 'library';
const WINDOW = 10 * 60000; // re-list files changed this long before the last one seen: Drive's file list can lag a little
const itemName = (t, id) => `${t}.${id}.json`;
const parseName = n => { const m = /^([a-z]+)\.(.+)\.json$/.exec(n || ''); return m && ITEMWISE.includes(m[1]) ? { t: m[1], id: m[2] } : null; };
const wait = ms => new Promise(r => setTimeout(r, ms));
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));
const inWorker = typeof window === 'undefined';
/** What this device is called in notifications ("Reminders will show on this phone"). */
export const deviceName = () => { const u = navigator.userAgent; return /Android|iPhone/i.test(u) ? 'phone' : /iPad/i.test(u) ? 'iPad' : /Macintosh/i.test(u) ? 'Mac' : /Windows/i.test(u) ? 'PC' : 'computer'; };
export const pushSupported = () => typeof Notification !== 'undefined' && typeof PushManager !== 'undefined' && (inWorker ? !!self.registration : 'serviceWorker' in navigator);
/** Run fn over items, n at a time. Stops starting new work after the first failure, then reports it. */
async function pool(items, n, fn) {
  let i = 0, err = null;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (!err && i < items.length) { const it = items[i++]; try { await fn(it); } catch (e) { err ||= e; } }
  }));
  if (err) throw err;
}

const ls = {
  get(k, d) { try { return JSON.parse(localStorage.getItem('steward.' + k)) ?? d; } catch { return d; } },
  set(k, v) { localStorage.setItem('steward.' + k, JSON.stringify(v)); },
  del(k) { localStorage.removeItem('steward.' + k); },
};

export const sync = {
  status: 'off', message: '', lastSync: ls.get('lastSync', 0), listeners: new Set(), busy: false, again: false,
  on(fn) { this.listeners.add(fn); },
  set(status, message = '') { this.status = status; this.message = message; for (const fn of this.listeners) fn(); },
  configured() { return !!settings.get('clientId'); },
  connected() { return this.configured() && !!ls.get('connected', false); },
  hasToken() { const t = ls.get('token'); return !!t && t.exp > Date.now() + 60000 && !(ls.get('connected', false) && ls.get('scopeV', 1) < SCOPE_V); },

  // ---- sign-in ---------------------------------------------------------------
  _gis: null,
  loadGis() {
    return this._gis ||= new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client'; s.onload = res; s.onerror = () => { this._gis = null; rej(new Error('offline')); };
      document.head.append(s);
    });
  },
  // Sign-in has two modes. With the Google client secret on this device, Steward uses Google's code flow and keeps a
  // refresh token, so it renews its one-hour pass quietly and never has to ask again. Without it, it falls back to
  // the older token flow, which needs a tap (pop-up) whenever the pass runs out.
  secret() { return ls.get('secret', ''); },
  setSecret(v) { if (v) ls.set('secret', v); else ls.del('secret'); },
  staysSignedIn() { return !!(this.secret() && ls.get('refresh')); },
  async tokenCall(params) {
    const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: settings.get('clientId'), client_secret: this.secret(), ...params }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j.error === 'invalid_grant' ? 'auth' : j.error === 'invalid_client' ? 'bad-secret' : (j.error || 'auth')); e.detail = j.error_description; throw e; }
    checkScopes(j.scope);
    ls.set('token', { access_token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 });
    if (j.refresh_token) ls.set('refresh', j.refresh_token);
    ls.set('connected', true); ls.set('scopeV', SCOPE_V);
    return j.access_token;
  },
  /** A device still signed in with the old wide access gives it back once, then signs in again with the narrow one. */
  dropOldGrant() {
    if (!ls.get('connected', false) || ls.get('scopeV', 1) >= SCOPE_V) return false;
    const rt = ls.get('refresh'), t = ls.get('token');
    const tok = rt || t?.access_token;
    if (tok) fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(tok), { method: 'POST' }).catch(() => {});
    ls.del('refresh'); ls.del('token'); ls.set('scopeV', SCOPE_V);
    return true;
  },
  async token(interactive) {
    if (this.dropOldGrant() && !interactive) throw new Error('auth');
    const t = ls.get('token');
    const upgrade = interactive && this.secret() && !ls.get('refresh');
    if (t && t.exp > Date.now() + 60000 && !upgrade) return t.access_token;
    if (!this.configured()) throw new Error('not-configured');
    if (!navigator.onLine) throw new Error('offline');
    const refresh = ls.get('refresh');
    if (refresh && this.secret()) {
      try { return await (this._refreshing ||= this.tokenCall({ grant_type: 'refresh_token', refresh_token: refresh })); }
      catch (e) { if (e.message === 'auth' || e.message === 'bad-secret') { ls.del('refresh'); if (e.message === 'bad-secret') this.setSecret(''); if (!interactive) throw new Error('auth'); } else throw e; }
      finally { this._refreshing = null; }
    }
    await this.loadGis();
    if (interactive && this.secret()) {
      return new Promise((res, rej) => {
        const client = google.accounts.oauth2.initCodeClient({
          client_id: settings.get('clientId'), scope: SCOPES, ux_mode: 'popup', login_hint: ls.get('email', undefined), include_granted_scopes: false,
          callback: r => { if (r.error) return rej(new Error(r.error)); this.tokenCall({ grant_type: 'authorization_code', code: r.code, redirect_uri: 'postmessage' }).then(res, rej); },
          error_callback: e => rej(new Error(e?.type || 'auth')),
        });
        // Asking for consent makes Google hand over a refresh token even if Steward was allowed before.
        client.requestCode({ prompt: 'consent' });
      });
    }
    return new Promise((res, rej) => {
      const client = google.accounts.oauth2.initTokenClient({
        client_id: settings.get('clientId'), scope: SCOPES, login_hint: ls.get('email', undefined), include_granted_scopes: false,
        callback: r => {
          if (r.error) return rej(new Error(r.error));
          try { checkScopes(r.scope); } catch (e) { return rej(e); }
          ls.set('token', { access_token: r.access_token, exp: Date.now() + (r.expires_in || 3600) * 1000 });
          ls.set('connected', true); ls.set('scopeV', SCOPE_V);
          res(r.access_token);
        },
        error_callback: e => rej(new Error(e?.type || 'auth')),
      });
      client.requestAccessToken({ prompt: interactive && (!ls.get('connected', false) || ls.get('askAgain', false)) ? 'consent' : '' });
    });
  },
  /** Shares the client secret between your devices through a small file in the Steward folder of your own Drive. */
  async shareSecret(d) {
    const name = 'steward-google-login.json';
    if (this.secret()) {
      if (d.files.login) return;
      const f = await this.find(name, d.root);
      if (f) { d.files.login = f.id; return; }
      const r = await this.upload(null, name, d.root, 'application/json', JSON.stringify({ about: 'Lets Steward on your other devices stay signed in to Google. Keep this file private.', clientSecret: this.secret() }));
      d.files.login = r.id;
    } else {
      const f = await this.find(name, d.root);
      if (!f) return;
      try { const j = await (await this.api(`${DRIVE}/files/${f.id}?alt=media`, {}, true)).json(); if (j.clientSecret) { this.setSecret(j.clientSecret); d.files.login = f.id; } } catch (e) { if (e.message === 'auth') throw e; }
    }
  },
  async connect() {
    await this.run(true);
    if (this.hasToken() && !ls.get('email')) try { const me = await this.api(`${DRIVE}/about?fields=user(emailAddress)`); ls.set('email', me.user.emailAddress); } catch {}
  },
  disconnect() {
    const t = ls.get('token'), rt = ls.get('refresh');
    if (rt) fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(rt), { method: 'POST' }).catch(() => {});
    else if (t && window.google?.accounts) try { google.accounts.oauth2.revoke(t.access_token, () => {}); } catch {}
    for (const k of ['token', 'refresh', 'connected', 'drive', 'versions', 'remCal', 'email', 'pushKey', 'pushFile', 'pushDevs', 'pushActive', 'askAgain', 'startFresh', 'inboxDone']) ls.del(k);
    this.code = '';
    store.driveClear().catch(() => {});
    this.set('off');
  },
  email() { return ls.get('email', ''); },
  /** Settings → "Start a new Steward in this account": allow making the Steward folder in an account that has none. */
  startFresh() { ls.set('startFresh', true); return this.run(true); },

  async api(url, opts = {}, raw = false) {
    const safe = !opts.method || opts.method === 'GET' || /\/upload\/drive\/v3\/files\/[^/?]+/.test(url) && opts.method === 'PATCH';
    for (let attempt = 0; ; attempt++) {
      const tok = await this.token(false);
      let r;
      try { r = await fetch(url, { ...opts, headers: { Authorization: 'Bearer ' + tok, ...(opts.headers || {}) } }); }
      catch (e) { if (safe && attempt < 2 && navigator.onLine) { await wait(600 * 3 ** attempt); continue; } throw e; }
      if (r.status === 401) { ls.del('token'); if (attempt === 0 && this.staysSignedIn()) continue; throw new Error('auth'); }
      if (!r.ok) {
        const e = new Error(`Google said ${r.status}`); e.status = r.status; try { e.detail = (await r.json()).error?.message; } catch {}
        // Google asks apps to slow down and try again when busy; only repeat requests that cannot create a duplicate.
        const busy = r.status === 429 || r.status === 503 || (r.status === 403 && /rate limit/i.test(e.detail || '')) || (safe && r.status >= 500);
        if (busy && attempt < 2) { await wait(600 * 3 ** attempt); continue; }
        throw e;
      }
      if (raw) return r;
      return r.status === 204 ? null : r.json();
    }
  },

  // ---- the Steward helper (Apps Script web app in Charles's Google account) ----------------------------------------
  helperUrl() { const u = settings.get('helperUrl'); return typeof u === 'string' && /^https:\/\/script\.google(usercontent)?\.com\//.test(u) ? u : ''; },
  async helper(action, data = {}) {
    const url = this.helperUrl();
    if (!url) throw new Error('no-helper');
    for (let attempt = 0; ; attempt++) {
      const token = await this.token(false);
      // text/plain keeps this a "simple" request, which Apps Script web apps accept from another site
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ token, action, ...data }) });
      let j; try { j = await r.json(); } catch { j = null; }
      if (!r.ok || !j) { const e = new Error(`The Steward helper said ${r.status}`); e.status = r.status >= 400 ? r.status : 502; e.helper = true; if (attempt < 1 && r.status >= 500) { await wait(1500); continue; } throw e; }
      if (j.ok) return j;
      // The helper did not accept this device's Google pass. That is the helper's trouble, not the sign-in's: Drive
      // itself says so (401) when a pass is truly no good. Never throw the pass away over it.
      if (j.error === 'busy' && attempt < 2) { await wait(3000); continue; }
      const e = new Error('Steward helper: ' + (j.error === 'auth' ? 'it did not recognise this device\'s sign-in' : j.error)); e.helper = true; throw e;
    }
  },
  helperTrouble: '',

  // ---- Drive helpers -----------------------------------------------------------
  async find(name, parent, folder) {
    const q = `name='${name.replace(/'/g, "\\'")}' and '${parent}' in parents and trashed=false` + (folder ? ` and mimeType='application/vnd.google-apps.folder'` : '');
    const r = await this.api(`${DRIVE}/files?q=${encodeURIComponent(q)}&fields=files(id,name,version)&orderBy=createdTime`);
    return r.files[0] || null;
  },
  async folder(name, parent) {
    const f = await this.find(name, parent, true);
    if (f) return f.id;
    const r = await this.api(`${DRIVE}/files?fields=id`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, parents: [parent], mimeType: 'application/vnd.google-apps.folder' }) });
    return r.id;
  },
  async layout() {
    let d = ls.get('drive');
    if (d?.root) { if (!ls.get('rootSeen')) ls.set('rootSeen', d.root); return d; }
    const seen = await this.find('Steward', 'root', true);
    if (!seen) {
      // Never start a second Steward folder: if this device (or the helper) knows one exists that Steward cannot see
      // with its per-file access, stop and say so instead of making an empty new one.
      let known = ls.get('rootSeen');
      if (!known && this.helperUrl()) known = (await this.helper('ping').catch(() => ({}))).root;
      if (known) { const e = new Error('no-access'); e.detail = 'Steward cannot see its folder in your Google Drive with the new sign-in. Ask Claude to look at it.'; throw e; }
      // Several Google accounts can be signed in on one device. Picking one that has no Steward folder would quietly
      // start a second, empty Steward there. Stop and say so, unless the person chose to start fresh in that account.
      if (!ls.get('startFresh', false)) {
        let email = ls.get('email', '');
        try { email = (await this.api(`${DRIVE}/about?fields=user(emailAddress)`)).user.emailAddress; ls.set('email', email); } catch {}
        const e = new Error('no-folder');
        e.detail = `${email || 'This Google account'} has no Steward folder in its Drive. Your Steward data is probably in a different Google account: in Settings tap Disconnect, then connect again and pick that account.`;
        throw e;
      }
    }
    const root = seen ? seen.id : await this.folder('Steward', 'root');
    ls.set('rootSeen', root);
    d = { root, att: await this.folder('attachments', root), inbox: await this.folder('inbox for Claude', root), files: {} };
    ls.set('drive', d);
    return d;
  },
  async upload(id, name, parent, mime, body) {
    // Google's one-step upload is meant for files of 5 MB or less; photos, long recordings and big PDFs use a resumable upload.
    if (!id && body instanceof Blob && body.size > 4e6) return this.uploadLarge(name, parent, mime, body);
    if (id) return this.api(`${UPLOAD}/files/${id}?uploadType=media&fields=id,version,md5Checksum`, { method: 'PATCH', headers: { 'Content-Type': mime }, body });
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify({ name, parents: [parent], mimeType: mime })], { type: 'application/json' }));
    form.append('file', body instanceof Blob ? body : new Blob([body], { type: mime }));
    return this.api(`${UPLOAD}/files?uploadType=multipart&fields=id,version,md5Checksum`, { method: 'POST', body: form });
  },

  async uploadLarge(name, parent, mime, blob) {
    const start = await this.api(`${UPLOAD}/files?uploadType=resumable&fields=id,version,md5Checksum`, { method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': mime, 'X-Upload-Content-Length': String(blob.size) },
      body: JSON.stringify({ name, parents: [parent], mimeType: mime }) }, true);
    const where = start.headers.get('Location');
    if (!where) throw new Error('Google did not start the upload');
    return this.api(where, { method: 'PUT', headers: { 'Content-Type': mime }, body: blob });
  },

  // ---- the sync cycle ------------------------------------------------------------
  // background: true inside the service worker (Steward closed). onStale: set by the app; called instead of syncing
  // when the background sync has run since this window loaded, so its in-memory copy must be reloaded first.
  background: false, onStale: null,
  async run(interactive = false) {
    if (this.background) return this._run(interactive);
    // Google's sign-in window can wait for the person for as long as it likes (or never come back, on phones), so it
    // happens BEFORE the sync lock is taken: nothing else in Steward may ever be stuck waiting on it.
    // One tap can reach here twice (the status button and the tap-anywhere listener): open Google's window once.
    // Only for two seconds, so a window that never came back cannot make later taps do nothing.
    if (interactive && this._signing && Date.now() - this._signing < 2000) return;
    if (interactive && this.configured() && navigator.onLine && (!this.hasToken() || (this.secret() && !ls.get('refresh')))) {
      const mine = this._signing = Date.now();
      try { await this.token(true); interactive = false; } // signed in: the sync itself must never open a window
      catch (e) { console.warn('sign-in', e); this.fail(e, true); return; }
      finally { if (this._signing === mine) this._signing = 0; }
    }
    const go = async () => {
      if (await backgroundIsNewer()) await this.onStale?.(); // take in what the background sync saved, then carry on
      await this._run(interactive);
      await snapshot().catch(e => console.warn('snapshot', e));
    };
    return navigator.locks ? navigator.locks.request('steward-sync', go) : go();
  },
  async _run(interactive = false) {
    if (!this.configured() || (!this.connected() && !interactive)) return;
    if (this.busy) { this.again = true; return; }
    if (!navigator.onLine) return this.set('offline', 'No signal. Changes are saved on this device and will sync later.');
    this.busy = true; this.set('syncing');
    try {
      await this.token(interactive);
      const d = await this.layout();
      // 1. Bring this device up to date FIRST. Claude's change files refer to tasks and notes by id as they stand in
      //    Drive; applying them to an out-of-date copy would build blank items that then overwrite the real ones.
      let wrote = false;
      const syncAll = async () => {
        for (const file of Object.keys(BUNDLES)) wrote = (await this.syncFile(d, file)) || wrote;
        wrote = (await this.syncLibrary(d)) || wrote;
      };
      await syncAll();
      // 2. Now apply Claude's changes, and send them straight back up so the other device sees them.
      //    The helper hands those over. If it cannot be reached, tasks and notes must still sync: note it and go on.
      this.helperTrouble = '';
      let applied = 0;
      try { applied = await this.inbox(d); }
      catch (e) { if (e.message === 'auth' || e.message === 'offline') throw e; console.warn('helper', e); this.helperTrouble = e.helper ? e.message : 'The Steward helper could not be reached'; }
      if (applied) await syncAll();
      // 3. Photos, PDFs and recordings last, one at a time: a file that will not upload never holds up tasks and notes.
      if (await this.pushAttachments(d)) wrote = (await this.syncLibrary(d)) || wrote;
      if (wrote || !d.files.summary) await this.writeSummary(d);
      ls.set('drive', d);
      await this.syncPush().catch(e => { if (e.message === 'auth') throw e; console.warn('notifications', e); });
      // (The backup "Steward Reminders" calendar is kept by the helper now: Steward itself has no Calendar access.)
      await this.refreshEvents().catch(e => { if (e.message === 'auth') throw e; console.warn('calendar', e); if (this.helperUrl() && !this.helperTrouble) this.helperTrouble = e.helper ? e.message : 'The Steward helper could not be reached'; });
      await this.shareSecret(d).catch(e => { if (e.message === 'auth') throw e; console.warn('login file', e); });
      ls.set('drive', d);
      this.lastSync = Date.now(); ls.set('lastSync', this.lastSync);
      ls.del('askAgain'); this.code = '';
      // This device just learned how to stay signed in: one tap finishes it (Google needs a tap to show its window).
      if (this.secret() && !ls.get('refresh')) { this.set('auth', 'Tap once so Google keeps Steward signed in'); this.armGesture(); }
      else this.set('idle');
    } catch (e) {
      console.warn('sync', e);
      if (e.status === 404 && !e.helper) { ls.del('drive'); store.driveClear().catch(() => {}); }
      this.fail(e, false);
    } finally {
      this.busy = false;
      if (this.again && !this.background) { this.again = false; setTimeout(() => this.run(), 500); } // in the background, bg.js repeats
    }
  },
  /** Turn a failure into what the person sees, and into what the next tap does. code: a short name for the screens. */
  code: '',
  fail(e, signingIn) {
    const m = e.message;
    this.code = '';
    // Google refused the pass for lack of permission: a box was left unticked when signing in. Throw the pass away so
    // the next tap opens Google's full screen again instead of reusing a pass that can never work.
    const lacking = m === 'scopes' || (e.status === 403 && /insufficient authentication scopes|insufficient permission/i.test(e.detail || ''));
    if (lacking) {
      ls.del('token'); ls.del('refresh'); ls.set('askAgain', true); this.code = 'scopes';
      this.set('auth', m === 'scopes' ? e.detail : `Google signed you in without access to your files. Tap here, and on Google's screen tick every box (or "Select all") before Continue.`);
      this.armGesture();
    } else if (m === 'no-folder') { this.code = 'no-folder'; this.set('error', e.detail); }
    else if (m === 'popup_failed_to_open') { this.code = 'popup'; this.set('auth', 'Your browser blocked Google\'s sign-in window. Tap here to try again.'); this.armGesture(); }
    else if (['auth', 'popup_closed', 'interaction_required', 'access_denied', 'unknown'].includes(m) || signingIn && !(m === 'offline' || e instanceof TypeError)) {
      if (signingIn) ls.set('askAgain', true);
      this.set('auth', signingIn ? 'Google sign-in did not finish. Tap to try again.' : 'Tap to reconnect to Google'); this.armGesture();
    }
    else if (m === 'offline' || e instanceof TypeError) this.set('offline', 'No signal. Changes are saved on this device and will sync later.');
    else this.set('error', e.detail || m);
  },
  armGesture() {
    if (this.background || typeof document === 'undefined' || this._armed) return; this._armed = true;
    // 'click', not 'pointerdown': on phones only a finished tap counts as permission to open Google's window.
    const go = () => { this._armed = false; document.removeEventListener('click', go, true); this.run(true); };
    document.addEventListener('click', go, true);
  },
  async syncFile(d, file) {
    const versions = ls.get('versions', {});
    let id = d.files[file];
    if (!id) { const f = await this.find(FILE_NAMES[file], d.root); if (f) id = d.files[file] = f.id; }
    let localNewer = true;
    if (id) {
      const meta = await this.api(`${DRIVE}/files/${id}?fields=version,trashed`);
      if (meta.trashed) { id = d.files[file] = null; }
      else if (meta.version !== versions[file]) {
        const remote = await (await this.api(`${DRIVE}/files/${id}?alt=media`, {}, true)).json();
        localNewer = store.merge(file, remote).localNewer;
        versions[file] = meta.version;
      } else localNewer = false;
    }
    if (!id || localNewer || store.isDirty(file)) {
      // Look once more right before saving: if the Google helper or another device saved in the last moment, fold
      // that in first, so this upload never wipes out changes (Claude's included) it has not seen.
      if (id) {
        const again = await this.api(`${DRIVE}/files/${id}?fields=version`);
        if (again.version !== versions[file]) { store.merge(file, await (await this.api(`${DRIVE}/files/${id}?alt=media`, {}, true)).json()); versions[file] = again.version; }
      }
      store.clearDirty(file);
      try {
        const r = await this.upload(id, FILE_NAMES[file], d.root, 'text/plain', JSON.stringify(store.snapshot(file)));
        d.files[file] = r.id; versions[file] = r.version;
      } catch (e) { localStorage.setItem('steward.dirty.' + file, '1'); throw e; }
      ls.set('versions', versions);
      return true;
    }
    ls.set('versions', versions);
    return false;
  },
  /**
   * Notes, notebooks, page text from scans and saved note versions: one small file per item in Steward/library.
   * 1. Ask Drive which files changed since last time and download only those.
   * 2. Upload only the items edited on this device since they were last uploaded.
   * Newest edit of each item wins, as before.
   */
  async syncLibrary(d) {
    const map = await store.driveAll();
    let cursor = map.get('_cursor') || 0;
    // the library folder: create it, and start over if someone deleted it
    let alive = false;
    if (d.lib) { try { alive = !(await this.api(`${DRIVE}/files/${d.lib}?fields=trashed`)).trashed; } catch (e) { if (e.status !== 404) throw e; } }
    if (!alive) { d.lib = await this.folder(LIB, d.root); ls.set('drive', d); if (map.size) { await store.driveClear(); map.clear(); } cursor = 0; }
    const save = [];
    let changed = false;
    if (await this.retireWriting(d)) changed = true;

    // ---- 1. what changed in Drive ----
    let q = `'${d.lib}' in parents and trashed=false`;
    if (cursor) q += ` and modifiedTime > '${new Date(cursor - WINDOW).toISOString()}'`;
    const listed = [];
    let pageToken = '';
    do {
      const r = await this.api(`${DRIVE}/files?q=${encodeURIComponent(q)}&fields=${encodeURIComponent('nextPageToken,files(id,name,version,md5Checksum,modifiedTime)')}&pageSize=1000${pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''}`);
      listed.push(...(r.files || [])); pageToken = r.nextPageToken || '';
    } while (pageToken);
    const byFile = new Map(); for (const [k, m] of map) if (k !== '_cursor' && m?.f) byFile.set(m.f, k);
    const known = f => { const m = map.get(byFile.get(f.id)); return m && (m.v === f.version || (m.h && m.h === f.md5Checksum)); };
    const want = listed.filter(f => parseName(f.name) && !known(f)).sort((a, b) => a.id < b.id ? -1 : 1);
    let newest = cursor;
    for (const f of listed) { const t = Date.parse(f.modifiedTime); if (t > newest) newest = t; }
    const losers = new Set();
    let n = 0;
    const take = (key, f, u) => {
      const m = map.get(key);
      if (m && m.f && m.f !== f.id) { // the same item in two files (two devices created it at once): both devices keep the same one
        const win = m.f < f.id ? m.f : f.id; losers.add(win === f.id ? m.f : f.id);
        if (win !== f.id) { byFile.delete(f.id); return; }
      }
      const v = { f: f.id, v: f.version, h: f.md5Checksum || null, u };
      map.set(key, v); byFile.set(f.id, key); save.push([key, v]);
    };
    try { await pool(want, 6, async f => {
      const nm = parseName(f.name);
      let item = null;
      try {
        const j = JSON.parse(await (await this.api(`${DRIVE}/files/${f.id}?alt=media`, {}, true)).text());
        if (j?.t === nm.t && j.v?.id === nm.id) item = j.v;
      } catch (e) { if (e.message === 'auth' || e instanceof TypeError || e.status >= 500 || e.status === 429) throw e; }
      const key = nm.t + '|' + nm.id;
      if (!item) { take(key, f, null); } // unreadable: this device's copy (if it has one) will replace it
      else { const u = item.updatedAt || 0; if (store.mergeItem(nm.t, item) === 'took') changed = true; take(key, f, u); }
      if (want.length > 30 && ++n % 25 === 0) this.set('syncing', `Downloading ${n} of ${want.length}`);
    }); } finally { store.settle(); if (save.length) await store.drivePut(save.splice(0)); } // keep what arrived even if Google stopped part-way
    for (const id of losers) { await this.api(`${DRIVE}/files/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }) }).catch(() => {}); }
    if (newest !== cursor) { map.set('_cursor', newest); save.push(['_cursor', newest]); }
    if (save.length) await store.drivePut(save.splice(0));

    // ---- 2. forget items deleted more than 90 days ago, and their files ----
    const cutoff = Date.now() - 90 * 864e5;
    for (const t of ITEMWISE) for (const x of store.raw(t)) {
      if (!x.deleted || (x.updatedAt || 0) > cutoff) continue;
      const key = t + '|' + x.id, m = map.get(key);
      if (m?.f) await this.api(`${DRIVE}/files/${m.f}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }) }).catch(e => { if (e.status !== 404) throw e; });
      map.delete(key); await store.drivePut([[key, null]]); store.purge(t, x.id);
    }

    // ---- 3. upload what this device changed ----
    const todo = [];
    for (const t of ITEMWISE) for (const x of store.raw(t)) {
      const m = map.get(t + '|' + x.id);
      if (x.deleted && !m) continue; // made and deleted before it was ever uploaded
      if (!m || m.u !== (x.updatedAt || 0)) todo.push([t, x.id]);
    }
    n = 0;
    await pool(todo, 4, async ([t, id]) => {
      const x = store.rawGet(t, id);
      if (!x) return;
      const key = t + '|' + id, m = map.get(key), u = x.updatedAt || 0;
      const body = JSON.stringify({ app: 'steward', t, v: x });
      let r;
      try { r = await this.upload(m?.f, itemName(t, id), d.lib, 'text/plain', body); }
      catch (e) { if (e.status !== 404 || !m?.f) throw e; r = await this.upload(null, itemName(t, id), d.lib, 'text/plain', body); } // its file was deleted: make a new one
      const v = { f: r.id, v: r.version, h: r.md5Checksum || null, u };
      map.set(key, v); await store.drivePut([[key, v]]);
      if (todo.length > 30 && ++n % 25 === 0) this.set('syncing', `Uploading ${n} of ${todo.length}`);
    });

    // ---- 4. notes saved by Steward 2.3 or earlier (on a device not yet updated) ----
    const oq = `'${d.root}' in parents and trashed=false and name='steward-notes.json'`;
    const old = (await this.api(`${DRIVE}/files?q=${encodeURIComponent(oq)}&fields=files(id,name)`)).files || [];
    for (const f of old) {
      const types = OLD_FILES[f.name]; if (!types) continue;
      let j; try { j = JSON.parse(await (await this.api(`${DRIVE}/files/${f.id}?alt=media`, {}, true)).text()); } catch (e) { if (e.message === 'auth' || e instanceof TypeError) throw e; continue; }
      for (const t of types) for (const x of j?.[t] || []) if (store.mergeItem(t, x) === 'took') changed = true;
      store.settle(); await store.flush();
      await this.api(`${DRIVE}/files/${f.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }) });
      this.again = true; // upload what came in on the next pass
    }
    return changed || todo.length > 0;
  },
  /**
   * Steward 4.5 removed the Writing section. Once per device: any old document or source file still in Drive is read,
   * documents with real text become notes in "From Writing" (sources become one note), and only then is each old
   * file moved to the Drive trash (recoverable there for 30 days). Nothing is dropped without being looked at.
   */
  async retireWriting(d) {
    if (ls.get('writingGone')) return false;
    const q = `'${d.lib}' in parents and trashed=false and (name contains 'docs.' or name contains 'sources.')`;
    const files = [];
    let pageToken = '';
    do {
      const r = await this.api(`${DRIVE}/files?q=${encodeURIComponent(q)}&fields=${encodeURIComponent('nextPageToken,files(id,name)')}&pageSize=1000${pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''}`);
      files.push(...(r.files || []).filter(f => /^(docs|sources)\..+\.json$/.test(f.name))); pageToken = r.nextPageToken || '';
    } while (pageToken);
    const docs = [], sources = [];
    for (const f of files) {
      let j = null;
      try { j = JSON.parse(await (await this.api(`${DRIVE}/files/${f.id}?alt=media`, {}, true)).text()); }
      catch (e) { if (e.message === 'auth' || e instanceof TypeError || e.status >= 500 || e.status === 429) throw e; }
      if (j?.v?.id) (f.name.startsWith('docs.') ? docs : sources).push(j.v);
    }
    const made = adoptWriting({ docs, sources });
    if (made) { store.settle(); await store.flush(); }
    for (const f of files) await this.api(`${DRIVE}/files/${f.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }) }).catch(e => { if (e.status !== 404) throw e; });
    ls.set('writingGone', 1);
    return made > 0;
  },
  async writeSummary(d) {
    if (!d.files.summary) { const f = await this.find('steward-summary.md', d.root); if (f) d.files.summary = f.id; }
    const r = await this.upload(d.files.summary, 'steward-summary.md', d.root, 'text/plain', buildSummary());
    d.files.summary = r.id;
  },
  /**
   * Files Claude leaves in "inbox for Claude" are lists of changes. Steward cannot open them itself (Claude made them,
   * and Steward only sees its own files), so the helper hands them over; Steward applies each one, then the helper
   * moves it to the trash. The helper's own timer applies task-only files while Steward is closed.
   */
  async inbox(d) {
    if (!this.helperUrl()) return 0;
    const report = async (name, lines) => {
      const body = [`Steward ${new Date().toString()}`, `Changes from ${name}:`, ...lines].join('\n');
      await this.upload(null, `report-${String(name).replace(/\.json$/i, '')}.txt`, d.inbox, 'text/plain', body).catch(e => console.warn('report', e));
    };
    // Change files already applied here whose move to the trash did not go through: finish the move, never apply twice.
    const earlier = ls.get('inboxDone', []);
    if (earlier.length) { await this.helper('inboxDone', { done: earlier }); ls.set('inboxDone', []); }
    const { files } = await this.helper('inbox');
    const done = [], failed = [], release = [];
    let applied = 0;
    for (const f of files) {
      let ops;
      try {
        const j = JSON.parse(String(f.text).replace(/^\uFEFF/, '').replace(/[\u201C\u201D]/g, '"').trim());
        ops = Array.isArray(j) ? j : j?.ops;
        if (!Array.isArray(ops)) throw new Error('not a list of changes');
      } catch (e) {
        failed.push({ id: f.id, name: f.name });
        await report(f.name, ['Nothing was applied: ' + (e.message || 'the file could not be read')]);
        continue;
      }
      // Notes need the page's HTML tools: a change file with any is left for when Steward is opened.
      if (this.background && ops.some(o => o && o.op !== 'delete' && ['note'].includes(String(o.type || '').toLowerCase()))) { release.push(f.id); continue; }
      const results = applyOps(ops);
      applied++; done.push(f.id); ls.set('inboxDone', done);
      await store.flush().catch(() => {});
      const problems = results.filter(x => x.startsWith('problem'));
      if (problems.length) await report(f.name, [`${results.filter(x => x.startsWith('ok')).length} applied, ${problems.length} with problems:`, ...problems]);
    }
    if (done.length || failed.length || release.length) {
      try { await this.helper('inboxDone', { done, failed, release }); ls.set('inboxDone', []); }
      catch (e) { if (e.message === 'auth') throw e; console.warn('inbox', e); this.again = true; } // finished on the next sync
    }
    return applied;
  },
  /**
   * Upload photos, PDFs and recordings added on this device. Each file is tried on its own: one that fails (too big, a
   * hiccup at Google) is skipped and retried later with a growing wait, so it never stops tasks and notes from syncing.
   * Returns how many files went up.
   */
  attWaiting: 0,
  async pushAttachments(d) {
    const fails = ls.get('attFails', {}), now = Date.now();
    let sent = 0, waiting = 0;
    for (const n of store.all('notes')) {
      const done = new Map();
      for (const a of n.attachments || []) {
        if (a.driveId) continue;
        const f = fails[a.id];
        if (f && now - f.at < Math.min(6 * 3600e3, 5 * 60e3 * 2 ** (f.n - 1))) { waiting++; continue; }
        const blob = await store.getBlob(a.id);
        if (!blob) continue; // another device holds the file and uploads it
        try {
          const r = await this.upload(null, `${a.id}-${a.name}`, d.att, a.mime || 'application/octet-stream', blob);
          done.set(a.id, r.id); delete fails[a.id]; sent++;
        } catch (e) {
          if (e.message === 'auth') { ls.set('attFails', fails); throw e; }
          if (e instanceof TypeError || !navigator.onLine) { waiting++; break; } // connection dropped: try next time
          console.warn('attachment upload', a.name, e);
          fails[a.id] = { n: (f?.n || 0) + 1, at: now, why: e.detail || e.message }; waiting++;
        }
      }
      if (done.size) { const cur = store.get('notes', n.id); if (cur) store.put('notes', { ...cur, attachments: (cur.attachments || []).map(a => done.has(a.id) ? { ...a, driveId: done.get(a.id) } : a) }, { silent: true }); }
    }
    for (const id of Object.keys(fails)) if (now - fails[id].at > 30 * 864e5) delete fails[id];
    ls.set('attFails', fails);
    this.attWaiting = waiting;
    return sent;
  },
  /** Get an attachment's contents, downloading from Drive if this device has not seen it yet. */
  async blob(att) {
    let b = await store.getBlob(att.id);
    if (b) return b;
    if (!att.driveId || !this.connected() || !navigator.onLine) return null;
    try {
      try {
        const r = await this.api(`${DRIVE}/files/${att.driveId}?alt=media`, {}, true);
        b = new Blob([await r.arrayBuffer()], { type: att.mime || 'application/octet-stream' });
      } catch (e) {
        // A scan or photo Claude uploaded: Steward cannot open it itself, so the helper passes it along.
        if (!(e.status === 404 || e.status === 403) || !this.helperUrl()) throw e;
        const r = await this.helper('file', { id: att.driveId });
        b = new Blob([Uint8Array.from(atob(r.b64), c => c.charCodeAt(0))], { type: att.mime || r.mime || 'application/octet-stream' });
      }
      await store.putBlob(att.id, b);
      return b;
    } catch { return null; }
  },

  // ---- Google Calendar ---------------------------------------------------------------
  calendars() { return ls.get('calendars', []); },
  events: [],
  async loadCachedEvents() { this.events = (await store.getKV('events')) || []; },
  window() { const a = new Date(); a.setDate(a.getDate() - 45); const b = new Date(); b.setDate(b.getDate() + 150); return [a, b]; },
  norm(e, cal) {
    return {
      id: e.id, calId: cal.id, title: e.summary || '(No title)', allDay: !!e.start?.date,
      start: e.start?.dateTime || e.start?.date, end: e.end?.dateTime || e.end?.date,
      location: e.location || '', description: e.description || '', color: cal.backgroundColor || '#3b74c4',
      recurringEventId: e.recurringEventId || null, link: e.htmlLink || '', readOnly: !['owner', 'writer'].includes(cal.accessRole),
    };
  },
  async fetchRange(from, to) {
    const r = await this.helper('calendar', { from: from.toISOString(), to: to.toISOString(), hidden: settings.get('hidden') });
    ls.set('calendars', r.calendars || []);
    const byId = new Map((r.calendars || []).map(c => [c.id, c]));
    return (r.events || []).filter(x => byId.has(x.calId)).map(x => this.norm(x.e, byId.get(x.calId)));
  },
  async refreshEvents() {
    const [a, b] = this.window();
    this.events = await this.fetchRange(a, b);
    await store.putKV('events', this.events);
    store.emit({ events: true });
  },
  async ensureRange(from, to) {
    const [a, b] = this.window();
    if ((from >= a && to <= b) || !this.connected() || !navigator.onLine) return false;
    try {
      const extra = await this.fetchRange(from, to);
      const ids = new Set(extra.map(e => e.calId + e.id));
      this.events = this.events.filter(e => !ids.has(e.calId + e.id)).concat(extra);
      return true;
    } catch { return false; }
  },
  eventBody(ev) {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const b = { summary: ev.title, location: ev.location || '', description: ev.description || '' };
    if (ev.allDay) { b.start = { date: ev.start.slice(0, 10) }; b.end = { date: ev.end.slice(0, 10) }; }
    else { b.start = { dateTime: new Date(ev.start).toISOString(), timeZone: tz }; b.end = { dateTime: new Date(ev.end).toISOString(), timeZone: tz }; }
    if (ev.rrule) b.recurrence = [ev.rrule];
    return b;
  },
  async saveEvent(ev) {
    await this.helper('calSave', { calId: ev.calId, eventId: ev.id || null, body: this.eventBody(ev) });
    await this.refreshEvents();
  },
  async deleteEvent(ev, whole) {
    await this.helper('calDelete', { calId: ev.calId, eventId: whole && ev.recurringEventId ? ev.recurringEventId : ev.id });
    await this.refreshEvents();
  },

  // ---- notifications on this device ---------------------------------------------------------------------------
  // The Google helper (Apps Script, every minute) sends reminders by Web Push to every device listed in
  // Steward/notifications. Here this device subscribes with the helper's public key (key.json), lists itself in
  // device-<id>.json, and marks itself confirmed once the helper's test notification has arrived.
  pushInfo() {
    return { supported: pushSupported(), permission: typeof Notification !== 'undefined' ? Notification.permission : 'unsupported', wanted: ls.get('pushWanted', true),
      helper: !!ls.get('pushKey'), mine: ls.get('pushFile', null), devices: ls.get('pushDevs', {}), active: !!ls.get('pushActive', false), name: deviceName() };
  },
  setPushWanted(on) { ls.set('pushWanted', !!on); },
  async syncPush() {
    if (!pushSupported() || !this.helperUrl()) return;
    // the helper's public sender key, and the devices it sends to
    let info = await this.helper('push');
    if (!info.publicKey) { ls.set('pushActive', false); ls.del('pushKey'); return; }
    const key = { pub: info.publicKey };
    ls.set('pushKey', key);

    // this device's subscription
    const reg = inWorker ? self.registration : await navigator.serviceWorker.ready;
    const want = Notification.permission === 'granted' && ls.get('pushWanted', true);
    let sub = await reg.pushManager.getSubscription();
    const sameKey = s => { const k = s?.options?.applicationServerKey; return !!k && b64u(k) === key.pub; };
    if (sub && (!want || !sameKey(sub))) { await sub.unsubscribe().catch(() => {}); sub = null; }
    if (!sub && want) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: unb64u(key.pub) });

    // this device's entry, kept by the helper in Steward/notifications as device-<id>.json
    let devId = ls.get('deviceId'); if (!devId) { devId = Math.random().toString(36).slice(2, 10); ls.set('deviceId', devId); }
    let mine = ls.get('pushFile', null);
    if (mine && !info.devices.some(x => x.id === mine.id)) mine = null; // removed from Drive (here or by the helper)
    if (!sub) {
      if (mine) info = await this.helper('push', { remove: mine.id });
      ls.del('pushFile'); mine = null;
    } else {
      const js = sub.toJSON();
      const ok = await kvGet('pushOk').catch(() => null); // set by the service worker when a notification arrives
      const confirmedAt = ok?.endpoint === js.endpoint ? ok.at : (mine?.endpoint === js.endpoint ? mine.confirmedAt || 0 : 0);
      const body = JSON.stringify({ about: 'Lets the Steward helper send reminders to this device.', name: deviceName(), endpoint: js.endpoint, keys: js.keys, vapid: key.pub, confirmedAt });
      if (!mine || mine.body !== body) {
        info = await this.helper('push', { device: { id: devId, body } });
        mine = { id: info.mine, endpoint: js.endpoint, confirmedAt, body };
        ls.set('pushFile', mine);
      }
    }

    // every device's state: notifications are proven once every device listed has shown its test
    const devs = {};
    for (const x of info.devices || []) devs[x.id] = { name: x.name, confirmedAt: mine && x.id === mine.id ? mine.confirmedAt : x.confirmedAt, mine: !!mine && x.id === mine.id };
    ls.set('pushDevs', devs);
    const all = Object.values(devs);
    ls.set('pushActive', all.length > 0 && all.every(x => x.confirmedAt));
  },
  /** Stop this device's notifications and take it off the list (another device's entry: just take it off). */
  async removeDevice(fileId) {
    const mine = ls.get('pushFile', null);
    if (!fileId || fileId === mine?.id) {
      ls.set('pushWanted', false);
      const reg = await navigator.serviceWorker.ready; const sub = await reg.pushManager.getSubscription(); if (sub) await sub.unsubscribe().catch(() => {});
      if (mine) await this.helper('push', { remove: mine.id }).catch(() => {});
      ls.del('pushFile');
    } else await this.helper('push', { remove: fileId });
    const devs = ls.get('pushDevs', {}); delete devs[fileId || mine?.id]; ls.set('pushDevs', devs);
    ls.set('pushActive', Object.values(devs).length > 0 && Object.values(devs).every(x => x.confirmedAt));
  },
};

export const isoLocal = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

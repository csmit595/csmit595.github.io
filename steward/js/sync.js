// Google sign-in, Google Drive sync, Google Calendar, and phone reminders (through a "Steward Reminders" calendar).
import { store, settings, BUNDLES, ITEMWISE } from './store.js';
import { applyOps, buildSummary, reminderTimes, openTasks } from './model.js';
import { pad } from './util.js';

const SCOPES = 'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/calendar';
const DRIVE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const CAL = 'https://www.googleapis.com/calendar/v3';
const FILE_NAMES = { tasks: 'steward-tasks.json' };
// Before 2.4, notes and writing were whole-section files. Any still found are read in once, then moved to the trash.
const OLD_FILES = { 'steward-notes.json': ['notebooks', 'notes', 'ocr'], 'steward-writing.json': ['docs', 'sources'] };
const LIB = 'library';
const WINDOW = 10 * 60000; // re-list files changed this long before the last one seen: Drive's file list can lag a little
const itemName = (t, id) => `${t}.${id}.json`;
const parseName = n => { const m = /^([a-z]+)\.(.+)\.json$/.exec(n || ''); return m && ITEMWISE.includes(m[1]) ? { t: m[1], id: m[2] } : null; };
const wait = ms => new Promise(r => setTimeout(r, ms));
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
  hasToken() { const t = ls.get('token'); return !!t && t.exp > Date.now() + 60000; },

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
    ls.set('token', { access_token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 });
    if (j.refresh_token) ls.set('refresh', j.refresh_token);
    ls.set('connected', true);
    return j.access_token;
  },
  async token(interactive) {
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
          client_id: settings.get('clientId'), scope: SCOPES, ux_mode: 'popup', login_hint: ls.get('email', undefined),
          callback: r => { if (r.error) return rej(new Error(r.error)); this.tokenCall({ grant_type: 'authorization_code', code: r.code, redirect_uri: 'postmessage' }).then(res, rej); },
          error_callback: e => rej(new Error(e?.type || 'auth')),
        });
        // Asking for consent makes Google hand over a refresh token even if Steward was allowed before.
        client.requestCode({ prompt: 'consent' });
      });
    }
    return new Promise((res, rej) => {
      const client = google.accounts.oauth2.initTokenClient({
        client_id: settings.get('clientId'), scope: SCOPES, login_hint: ls.get('email', undefined),
        callback: r => {
          if (r.error) return rej(new Error(r.error));
          ls.set('token', { access_token: r.access_token, exp: Date.now() + (r.expires_in || 3600) * 1000 });
          ls.set('connected', true);
          res(r.access_token);
        },
        error_callback: e => rej(new Error(e?.type || 'auth')),
      });
      client.requestAccessToken({ prompt: interactive && !ls.get('connected', false) ? 'consent' : '' });
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
    await this.token(true);
    try { const me = await this.api(`${DRIVE}/about?fields=user(emailAddress)`); ls.set('email', me.user.emailAddress); } catch {}
    return this.run(true);
  },
  disconnect() {
    const t = ls.get('token'), rt = ls.get('refresh');
    if (rt) fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(rt), { method: 'POST' }).catch(() => {});
    else if (t && window.google?.accounts) try { google.accounts.oauth2.revoke(t.access_token, () => {}); } catch {}
    for (const k of ['token', 'refresh', 'connected', 'drive', 'versions', 'remCal', 'email']) ls.del(k);
    store.driveClear().catch(() => {});
    this.set('off');
  },
  email() { return ls.get('email', ''); },

  async api(url, opts = {}, raw = false) {
    const safe = !opts.method || opts.method === 'GET' || /\/upload\/drive\/v3\/files\/[^/?]+/.test(url) && opts.method === 'PATCH';
    for (let attempt = 0; ; attempt++) {
      const tok = await this.token(false);
      let r;
      try { r = await fetch(url, { ...opts, headers: { Authorization: 'Bearer ' + tok, ...(opts.headers || {}) } }); }
      catch (e) { if (safe && attempt < 2 && navigator.onLine) { await wait(600 * 3 ** attempt); continue; } throw e; }
      if (r.status === 401) { ls.del('token'); throw new Error('auth'); }
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
    if (d?.root) return d;
    const root = await this.folder('Steward', 'root');
    d = { root, att: await this.folder('attachments', root), inbox: await this.folder('inbox for Claude', root), files: {} };
    ls.set('drive', d);
    return d;
  },
  async upload(id, name, parent, mime, body) {
    if (id) return this.api(`${UPLOAD}/files/${id}?uploadType=media&fields=id,version,md5Checksum`, { method: 'PATCH', headers: { 'Content-Type': mime }, body });
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify({ name, parents: [parent], mimeType: mime })], { type: 'application/json' }));
    form.append('file', body instanceof Blob ? body : new Blob([body], { type: mime }));
    return this.api(`${UPLOAD}/files?uploadType=multipart&fields=id,version,md5Checksum`, { method: 'POST', body: form });
  },

  // ---- the sync cycle ------------------------------------------------------------
  async run(interactive = false) {
    if (!this.configured() || (!this.connected() && !interactive)) return;
    if (this.busy) { this.again = true; return; }
    if (!navigator.onLine) return this.set('offline', 'No signal. Changes are saved on this device and will sync later.');
    this.busy = true; this.set('syncing');
    try {
      await this.token(interactive);
      const d = await this.layout();
      await this.inbox(d);
      await this.pushAttachments(d);
      let wrote = false;
      for (const file of Object.keys(BUNDLES)) wrote = (await this.syncFile(d, file)) || wrote;
      wrote = (await this.syncLibrary(d)) || wrote;
      if (wrote || !d.files.summary) await this.writeSummary(d);
      ls.set('drive', d);
      await this.syncReminders().catch(e => console.warn('reminders', e));
      await this.refreshEvents().catch(e => console.warn('calendar', e));
      await this.shareSecret(d).catch(e => { if (e.message === 'auth') throw e; console.warn('login file', e); });
      ls.set('drive', d);
      this.lastSync = Date.now(); ls.set('lastSync', this.lastSync);
      // This device just learned how to stay signed in: one tap finishes it (Google needs a tap to show its window).
      if (this.secret() && !ls.get('refresh')) { this.set('auth', 'Tap once so Google keeps Steward signed in'); this.armGesture(); }
      else this.set('idle');
    } catch (e) {
      console.warn('sync', e);
      if (e.status === 404) { ls.del('drive'); store.driveClear().catch(() => {}); }
      if (['auth', 'popup_failed_to_open', 'popup_closed', 'interaction_required', 'access_denied'].includes(e.message)) { this.set('auth', 'Tap to reconnect to Google'); this.armGesture(); }
      else if (e.message === 'offline' || e instanceof TypeError) this.set('offline', 'No signal. Changes are saved on this device and will sync later.');
      else this.set('error', e.detail || e.message);
    } finally {
      this.busy = false;
      if (this.again) { this.again = false; setTimeout(() => this.run(), 500); }
    }
  },
  armGesture() {
    if (this._armed) return; this._armed = true;
    const go = () => { this._armed = false; document.removeEventListener('pointerdown', go, true); this.run(true); };
    document.addEventListener('pointerdown', go, true);
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
   * Notes, notebooks, page text from scans, and Writing documents and sources: one small file per item in Steward/library.
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

    // ---- 4. notes and writing saved by Steward 2.3 or earlier (on a device not yet updated) ----
    const oq = `'${d.root}' in parents and trashed=false and (name='steward-notes.json' or name='steward-writing.json')`;
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
  async writeSummary(d) {
    if (!d.files.summary) { const f = await this.find('steward-summary.md', d.root); if (f) d.files.summary = f.id; }
    const r = await this.upload(d.files.summary, 'steward-summary.md', d.root, 'text/plain', buildSummary());
    d.files.summary = r.id;
  },
  /** Files Claude leaves in "inbox for Claude" are lists of changes. Apply each one, then move it to the trash. */
  async inbox(d) {
    const q = `'${d.inbox}' in parents and trashed=false`;
    const r = await this.api(`${DRIVE}/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType)&orderBy=createdTime&pageSize=100`);
    for (const f of r.files) {
      if (f.name.startsWith('failed-') || f.mimeType === 'application/vnd.google-apps.folder') continue;
      try {
        const url = f.mimeType === 'application/vnd.google-apps.document' ? `${DRIVE}/files/${f.id}/export?mimeType=text/plain` : `${DRIVE}/files/${f.id}?alt=media`;
        let text = await (await this.api(url, {}, true)).text();
        text = text.replace(/^﻿/, '').replace(/[“”]/g, '"').trim();
        const j = JSON.parse(text);
        const ops = Array.isArray(j) ? j : j?.ops;
        if (!Array.isArray(ops)) throw new Error('not a list of changes');
        applyOps(ops);
        await this.api(`${DRIVE}/files/${f.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }) });
      } catch (e) {
        if (e.message === 'auth' || e instanceof TypeError) throw e;
        await this.api(`${DRIVE}/files/${f.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'failed-' + f.name }) }).catch(() => {});
      }
    }
  },
  async pushAttachments(d) {
    for (const n of store.all('notes')) {
      let changed = false;
      const atts = [];
      for (const a of n.attachments || []) {
        if (!a.driveId) {
          const blob = await store.getBlob(a.id);
          if (blob) { const r = await this.upload(null, `${a.id}-${a.name}`, d.att, a.mime || 'application/octet-stream', blob); atts.push({ ...a, driveId: r.id }); changed = true; continue; }
        }
        atts.push(a);
      }
      if (changed) { const cur = store.get('notes', n.id); if (cur) store.put('notes', { ...cur, attachments: (cur.attachments || []).map(a => atts.find(x => x.id === a.id) || a) }, { silent: true }); }
    }
  },
  /** Get an attachment's contents, downloading from Drive if this device has not seen it yet. */
  async blob(att) {
    let b = await store.getBlob(att.id);
    if (b) return b;
    if (!att.driveId || !this.connected() || !navigator.onLine) return null;
    try {
      const r = await this.api(`${DRIVE}/files/${att.driveId}?alt=media`, {}, true);
      b = new Blob([await r.arrayBuffer()], { type: att.mime || 'application/octet-stream' });
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
    const out = [];
    const hidden = settings.get('hidden');
    for (const cal of this.calendars()) {
      if (hidden.includes(cal.id) || cal.id === ls.get('remCal')) continue;
      let pageToken = '';
      do {
        const u = `${CAL}/calendars/${encodeURIComponent(cal.id)}/events?singleEvents=true&orderBy=startTime&maxResults=2500&timeMin=${encodeURIComponent(from.toISOString())}&timeMax=${encodeURIComponent(to.toISOString())}${pageToken ? '&pageToken=' + pageToken : ''}`;
        const r = await this.api(u);
        for (const e of r.items || []) if (e.status !== 'cancelled') out.push(this.norm(e, cal));
        pageToken = r.nextPageToken || '';
      } while (pageToken);
    }
    return out;
  },
  async refreshEvents() {
    const r = await this.api(`${CAL}/users/me/calendarList?minAccessRole=reader`);
    ls.set('calendars', (r.items || []).map(c => ({ id: c.id, summary: c.summaryOverride || c.summary, backgroundColor: c.backgroundColor, primary: !!c.primary, accessRole: c.accessRole })));
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
    const base = `${CAL}/calendars/${encodeURIComponent(ev.calId)}/events`;
    const opts = { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(this.eventBody(ev)) };
    if (ev.id) await this.api(`${base}/${ev.id}`, { method: 'PATCH', ...opts }); else await this.api(base, { method: 'POST', ...opts });
    await this.refreshEvents();
  },
  async deleteEvent(ev, whole) {
    await this.api(`${CAL}/calendars/${encodeURIComponent(ev.calId)}/events/${whole && ev.recurringEventId ? ev.recurringEventId : ev.id}`, { method: 'DELETE' });
    await this.refreshEvents();
  },

  // ---- phone reminders: mirrored into a Google calendar so the phone buzzes even when Steward is closed ----
  async syncReminders() {
    let calId = ls.get('remCal');
    if (!calId) {
      const list = await this.api(`${CAL}/users/me/calendarList?minAccessRole=owner`);
      calId = (list.items || []).find(c => c.summary === 'Steward Reminders')?.id;
      if (!calId) calId = (await this.api(`${CAL}/calendars`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ summary: 'Steward Reminders', description: 'Task reminders from the Steward app. Managed automatically.' }) })).id;
      ls.set('remCal', calId);
    }
    const now = Date.now(), horizon = now + 60 * 864e5;
    const want = new Map();
    const enc = s => Array.from(s, c => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
    for (const t of openTasks()) for (const at of reminderTimes(t)) {
      const ms = at.getTime();
      if (ms < now - 60000 || ms > horizon) continue;
      want.set(`st${enc(t.id)}t${Math.floor(ms / 60000).toString(32)}`, { summary: '⏰ ' + t.content, at });
    }
    const base = `${CAL}/calendars/${encodeURIComponent(calId)}/events`;
    const r = await this.api(`${base}?singleEvents=true&maxResults=2500&timeMin=${encodeURIComponent(new Date(now).toISOString())}`);
    const have = new Map((r.items || []).filter(e => e.status !== 'cancelled').map(e => [e.id, e]));
    const json = { 'Content-Type': 'application/json' };
    const body = (id, w) => JSON.stringify({ id, summary: w.summary, description: 'Reminder from Steward', status: 'confirmed', start: { dateTime: w.at.toISOString() }, end: { dateTime: new Date(w.at.getTime() + 5 * 60000).toISOString() }, reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 0 }] } });
    for (const [id, e] of have) if (id.startsWith('st') && !want.has(id)) await this.api(`${base}/${id}`, { method: 'DELETE' }).catch(() => {});
    for (const [id, w] of want) {
      const e = have.get(id);
      if (e && e.summary === w.summary) continue;
      if (e) { await this.api(`${base}/${id}`, { method: 'PATCH', headers: json, body: body(id, w) }).catch(() => {}); continue; }
      try { await this.api(base, { method: 'POST', headers: json, body: body(id, w) }); }
      catch (err) { if (err.status === 409) await this.api(`${base}/${id}`, { method: 'PUT', headers: json, body: body(id, w) }).catch(() => {}); else throw err; }
    }
  },
};

export const isoLocal = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

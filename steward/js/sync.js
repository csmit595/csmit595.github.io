// Google sign-in, Google Drive sync, Google Calendar, and phone reminders (through a "Steward Reminders" calendar).
import { store, settings, FILES } from './store.js';
import { applyOps, buildSummary, reminderTimes, openTasks } from './model.js';
import { pad } from './util.js';

const SCOPES = 'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/calendar';
const DRIVE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const CAL = 'https://www.googleapis.com/calendar/v3';
const FILE_NAMES = { tasks: 'steward-tasks.json', notes: 'steward-notes.json', writing: 'steward-writing.json' };

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
  async token(interactive) {
    const t = ls.get('token');
    if (t && t.exp > Date.now() + 60000) return t.access_token;
    if (!this.configured()) throw new Error('not-configured');
    if (!navigator.onLine) throw new Error('offline');
    await this.loadGis();
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
  async connect() {
    await this.token(true);
    try { const me = await this.api(`${DRIVE}/about?fields=user(emailAddress)`); ls.set('email', me.user.emailAddress); } catch {}
    return this.run(true);
  },
  disconnect() {
    const t = ls.get('token');
    if (t && window.google?.accounts) try { google.accounts.oauth2.revoke(t.access_token, () => {}); } catch {}
    for (const k of ['token', 'connected', 'drive', 'versions', 'remCal', 'email']) ls.del(k);
    this.set('off');
  },
  email() { return ls.get('email', ''); },

  async api(url, opts = {}, raw = false) {
    const tok = await this.token(false);
    const r = await fetch(url, { ...opts, headers: { Authorization: 'Bearer ' + tok, ...(opts.headers || {}) } });
    if (r.status === 401) { ls.del('token'); throw new Error('auth'); }
    if (!r.ok) { const e = new Error(`Google said ${r.status}`); e.status = r.status; try { e.detail = (await r.json()).error?.message; } catch {} throw e; }
    if (raw) return r;
    return r.status === 204 ? null : r.json();
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
    if (id) return this.api(`${UPLOAD}/files/${id}?uploadType=media&fields=id,version`, { method: 'PATCH', headers: { 'Content-Type': mime }, body });
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify({ name, parents: [parent], mimeType: mime })], { type: 'application/json' }));
    form.append('file', body instanceof Blob ? body : new Blob([body], { type: mime }));
    return this.api(`${UPLOAD}/files?uploadType=multipart&fields=id,version`, { method: 'POST', body: form });
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
      let wrote = false;
      for (const file of Object.keys(FILES)) wrote = (await this.syncFile(d, file)) || wrote;
      await this.pushAttachments(d);
      if (wrote || !d.files.summary) await this.writeSummary(d);
      ls.set('drive', d);
      await this.syncReminders().catch(e => console.warn('reminders', e));
      await this.refreshEvents().catch(e => console.warn('calendar', e));
      this.lastSync = Date.now(); ls.set('lastSync', this.lastSync);
      this.set('idle');
    } catch (e) {
      console.warn('sync', e);
      if (e.status === 404) ls.del('drive');
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

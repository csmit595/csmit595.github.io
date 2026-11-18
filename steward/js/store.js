// Local data store. Everything lives on the device first (IndexedDB) and is merged with Google Drive by sync.js.
import { uid } from './util.js';

export const FILES = {
  tasks: ['projects', 'sections', 'tasks', 'comments', 'labels', 'filters', 'prefs', 'blocks'],
  notes: ['notebooks', 'notes', 'ocr'],
  writing: ['docs', 'sources'],
};
export const TYPES = Object.values(FILES).flat();
// Synced to Drive as one file per item (folder Steward/library), so editing one note uploads only that note.
export const ITEMWISE = ['notebooks', 'notes', 'ocr', 'docs', 'sources'];
// Synced as one combined file (small and changes often).
export const BUNDLES = { tasks: FILES.tasks };
const fileOf = type => Object.keys(FILES).find(f => FILES[f].includes(type));

const data = Object.fromEntries(TYPES.map(t => [t, new Map()]));

// ---- field-by-field change times, so edits made on two devices before they sync both survive ----
const META = new Set(['id', 'updatedAt', 'createdAt', '_f', 'hist']);
// key order must not matter: two devices can build the same item with fields in a different order
const canon = v => (Array.isArray(v) ? '[' + v.map(canon).join(',') + ']' : v && typeof v === 'object' ? '{' + Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}' : JSON.stringify(v ?? null));
const same = (a, b) => a === b || canon(a) === canon(b);
/** When a field of an item was last changed. Items saved before field stamps existed count every field as changed at updatedAt. */
const fieldTime = (x, k) => (x._f ? (x._f[k] ?? (k in x ? x.createdAt || 0 : 0)) : (k in x ? x.updatedAt || 0 : 0));
/** Combine two copies of one item: for each field, the copy that changed it most recently wins. */
export function mergeFields(l, r) {
  if (l.deleted || r.deleted) { // a delete is all or nothing
    if ((r.updatedAt || 0) !== (l.updatedAt || 0)) return (r.updatedAt || 0) > (l.updatedAt || 0) ? r : l;
    return l.deleted ? l : r;
  }
  const out = { ...l }, f = { ...(l._f || {}) };
  for (const k of new Set([...Object.keys(l), ...Object.keys(r)])) {
    if (META.has(k)) continue;
    const rt = fieldTime(r, k), lt = fieldTime(l, k);
    // equal times with different values: both devices must pick the same one, or they would trade it back and forth
    const rWins = rt > lt || (rt === lt && !same(l[k], r[k]) && canon(r[k]) > canon(l[k]));
    if (rWins) { if (k in r) out[k] = r[k]; else delete out[k]; }
    f[k] = Math.max(rt, lt);
  }
  out._f = f;
  out.updatedAt = Math.max(l.updatedAt || 0, r.updatedAt || 0);
  out.createdAt = Math.min(l.createdAt || out.updatedAt, r.createdAt || out.updatedAt);
  // history: keep every entry from both copies, newest 15
  if (l.hist || r.hist) { const seen = new Map(); for (const e of [...(l.hist || []), ...(r.hist || [])]) seen.set(e.at + '|' + Object.keys(e.old || {}).join(','), e); out.hist = [...seen.values()].sort((a, b) => a.at - b.at).slice(-15); }
  return out;
}
const HIST_SKIP = new Set(['order', 'remindedFor', 'lastDoneAt', 'doneCount']);
const listeners = new Set();
let db = null;
const pending = new Map(); // "type|id" -> [type, id]: only changed items are written to disk
const touchItem = (type, id) => pending.set(type + '|' + id, [type, id]);
let flushTimer = null;

function openDb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('steward', 4);
    r.onupgradeneeded = () => {
      const d = r.result;
      for (const s of ['kv', 'blobs', 'events', 'vec', 'items', 'drive']) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s);
    };
    r.onsuccess = () => { r.result.onversionchange = () => r.result.close(); res(r.result); };
    r.onerror = () => rej(r.error);
  });
}
function idb(storeName, mode, fn) {
  return new Promise((res, rej) => {
    const tx = db.transaction(storeName, mode);
    const out = fn(tx.objectStore(storeName));
    tx.oncomplete = () => res(out && 'result' in out ? out.result : undefined);
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error);
  });
}

export const store = {
  async init() {
    if (db) { try { await this.flush(); } catch {} db.close(); }
    db = await openDb();
    for (const t of TYPES) data[t].clear(); // the background sync re-reads everything each time it wakes
    // Each item is stored on its own, so saving one note never rewrites the whole library.
    const rows = await new Promise((res, rej) => { const out = []; const tx = db.transaction('items', 'readonly'); const c = tx.objectStore('items').openCursor(); c.onsuccess = () => { const cur = c.result; if (cur) { out.push(cur.value); cur.continue(); } }; tx.oncomplete = () => res(out); tx.onerror = () => rej(tx.error); });
    for (const row of rows) if (data[row.t]) data[row.t].set(row.v.id, row.v);
    for (const t of TYPES) { // one-time move from the old whole-list storage
      const arr = await idb('kv', 'readonly', st => st.get(t));
      if (!arr?.length) continue;
      for (const x of arr) if (x?.id && !data[t].has(x.id)) { data[t].set(x.id, x); touchItem(t, x.id); }
      await this.flush(); await idb('kv', 'readwrite', st => st.delete(t));
    }
    if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  },
  on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  emit(info) { for (const fn of listeners) fn(info || {}); },
  all(type) { const out = []; for (const x of data[type].values()) if (!x.deleted) out.push(x); return out; },
  raw(type) { return [...data[type].values()]; },
  rawGet(type, id) { return data[type].get(id) || null; },
  get(type, id) { const x = data[type].get(id); return x && !x.deleted ? x : null; },
  put(type, item, opts = {}) {
    if (!item.id) item.id = uid();
    const now = Date.now();
    if (!item.createdAt) item.createdAt = now;
    const cur = data[type].get(item.id);
    const f = { ...((cur && !cur.deleted && cur._f) || item._f || {}) };
    const old = {};
    for (const k of new Set([...Object.keys(item), ...(cur && !cur.deleted ? Object.keys(cur) : [])])) {
      if (META.has(k)) continue;
      const was = cur && !cur.deleted ? cur[k] : undefined;
      if (!cur || cur.deleted || !same(was, item[k])) { f[k] = now; if (cur && !cur.deleted && !HIST_SKIP.has(k)) old[k] = was === undefined ? null : was; }
    }
    // opts.keepTimes (imports): keep the item's own edit time, so a note last edited in 2019 still says 2019
    const at = opts.keepTimes && item.updatedAt ? Math.min(item.updatedAt, now) : now;
    if (at !== now) for (const k in f) if (f[k] === now) f[k] = at;
    item._f = f;
    if (type === 'tasks' && Object.keys(old).length && !opts.noHistory) {
      const hist = [...(cur.hist || [])];
      const last = hist[hist.length - 1];
      // typing in a field saves often: fold changes made within a minute into one entry
      if (last && now - last.at < 60000 && !opts.by) { last.at = now; for (const k in old) if (!(k in last.old)) last.old[k] = old[k]; }
      else hist.push({ at: now, by: opts.by || null, old });
      item.hist = hist.slice(-15);
    } else if (cur && cur.hist && !item.hist) item.hist = cur.hist;
    item.updatedAt = at;
    data[type].set(item.id, item);
    this._changed(type, opts, item.id);
    return item;
  },
  patch(type, id, fields, opts) {
    const cur = data[type].get(id);
    if (!cur) return null;
    return this.put(type, { ...cur, ...fields }, opts);
  },
  remove(type, id, opts = {}) {
    if (!data[type].has(id)) return;
    const cur = data[type].get(id);
    // a deleted task keeps a copy for 90 days so it can be brought back
    data[type].set(id, { id, deleted: true, updatedAt: Date.now(), ...(type === 'tasks' && cur && !cur.deleted ? { was: cur } : {}) });
    this._changed(type, opts, id);
  },
  _changed(type, opts, id) {
    touchItem(type, id);
    if (!ITEMWISE.includes(type)) localStorage.setItem('steward.dirty.' + fileOf(type), '1');
    clearTimeout(flushTimer);
    flushTimer = setTimeout(() => this.flush().catch(e => console.warn('save failed', e)), 250);
    if (!opts.silent) this.emit({ type, local: true });
  },
  async flush() {
    clearTimeout(flushTimer);
    if (!pending.size) return;
    const batch = [...pending.values()]; pending.clear();
    try {
      await new Promise((res, rej) => {
        const tx = db.transaction('items', 'readwrite'), st = tx.objectStore('items');
        for (const [t, id] of batch) { const v = data[t].get(id); if (v) st.put({ t, v }, t + '|' + id); else st.delete(t + '|' + id); }
        tx.oncomplete = res; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error || new Error('aborted'));
      });
    } catch (e) { for (const b of batch) touchItem(b[0], b[1]); this.emit({ storageError: e?.name || String(e) }); throw e; }
  },
  isDirty(file) { return localStorage.getItem('steward.dirty.' + file) === '1'; },
  clearDirty(file) { localStorage.removeItem('steward.dirty.' + file); },

  // ---- sync support -------------------------------------------------------
  snapshot(file) {
    const out = { app: 'steward', format: 1, savedAt: new Date().toISOString() };
    for (const t of FILES[file]) out[t] = [...data[t].values()];
    return out;
  },
  /** Merge a remote snapshot. Newest edit of each item wins. Returns whether this device holds anything the remote lacks. */
  merge(file, remote) {
    let localNewer = false, changed = false;
    const cutoff = Date.now() - 90 * 864e5, soon = Date.now() + 5 * 60000;
    for (const t of FILES[file]) {
      const map = data[t];
      const seen = new Set();
      for (const r of remote?.[t] || []) {
        if (!r || !r.id) continue;
        if ((r.updatedAt || 0) > soon) r.updatedAt = Date.now(); // a device with a wrong clock must not win forever
        seen.add(r.id);
        const l = map.get(r.id);
        if (!l) { map.set(r.id, r); changed = true; touchItem(t, r.id); continue; }
        if (same(l, r)) continue;
        const m = mergeFields(l, r);
        if (!same(m, l)) { map.set(r.id, m); changed = true; touchItem(t, r.id); }
        if (!same(m, r)) localNewer = true;
      }
      for (const [id, l] of map) {
        if (!seen.has(id)) localNewer = true;
        if (l.deleted && (l.updatedAt || 0) < cutoff) { map.delete(id); touchItem(t, id); }
      }
    }
    if (changed) { this.flush().catch(() => {}); this.emit({ remote: true }); }
    return { localNewer, changed };
  },

  /** Merge one item read from its own Drive file. Returns 'took' (Drive copy was newer), 'mine' (this device is newer) or 'same'. */
  mergeItem(type, r) {
    if (!data[type] || !r || !r.id) return 'same';
    if ((r.updatedAt || 0) > Date.now() + 5 * 60000) r.updatedAt = Date.now(); // a device with a wrong clock must not win forever
    const l = data[type].get(r.id);
    if (!l) { data[type].set(r.id, r); touchItem(type, r.id); this._merged = true; return 'took'; }
    if (same(l, r)) return 'same';
    const m = mergeFields(l, r);
    // holding a change Drive lacks: give it a fresh time so the upload step (which compares times) sends it
    if (!same(m, r)) m.updatedAt = Math.max(m.updatedAt, Date.now());
    const took = !same(m, l);
    if (took) { data[type].set(r.id, m); touchItem(type, r.id); this._merged = true; }
    // 'mine' means this device holds something Drive lacks, so it is uploaded
    return !same(m, r) ? 'mine' : took ? 'took' : 'same';
  },
  /** After a batch of mergeItem calls: save and tell the screens once. */
  settle() { if (this._merged) { this._merged = false; this.flush().catch(() => {}); this.emit({ remote: true }); } },
  /** Forget a long-deleted item for good. */
  purge(type, id) { if (data[type].delete(id)) touchItem(type, id); },

  // ---- which Drive file holds which item (this device only) -------------------
  driveAll() { return new Promise((res, rej) => { const out = new Map(); const tx = db.transaction('drive', 'readonly'); const c = tx.objectStore('drive').openCursor(); c.onsuccess = () => { const cur = c.result; if (cur) { out.set(cur.key, cur.value); cur.continue(); } }; tx.oncomplete = () => res(out); tx.onerror = () => rej(tx.error); }); },
  drivePut(entries) { return idb('drive', 'readwrite', s => { for (const [k, v] of entries) v == null ? s.delete(k) : s.put(v, k); }); },
  driveClear() { return idb('drive', 'readwrite', s => s.clear()); },

  // ---- attachments (binary files) ----------------------------------------
  putBlob(id, blob) { return idb('blobs', 'readwrite', s => s.put(blob, id)); },
  getBlob(id) { return idb('blobs', 'readonly', s => s.get(id)); },
  blobIds() { return idb('blobs', 'readonly', s => s.getAllKeys()).then(k => new Set(k || [])); },
  delBlob(id) { return idb('blobs', 'readwrite', s => s.delete(id)); },
  // ---- cached calendar events --------------------------------------------
  putKV(key, val) { return idb('events', 'readwrite', s => s.put(val, key)); },
  getKV(key) { return idb('events', 'readonly', s => s.get(key)); },

  // ---- meaning-search vectors (kept on this device only) -----------------------
  vecPut(key, val) { return idb('vec', 'readwrite', s => s.put(val, key)); },
  vecDel(key) { return idb('vec', 'readwrite', s => s.delete(key)); },
  vecAll() { return new Promise((res, rej) => { const out = []; const tx = db.transaction('vec', 'readonly'); const c = tx.objectStore('vec').openCursor(); c.onsuccess = () => { const cur = c.result; if (cur) { out.push([cur.key, cur.value]); cur.continue(); } }; tx.oncomplete = () => res(out); tx.onerror = () => rej(tx.error); }); },

  async exportAll() {
    const out = { app: 'steward', format: 1, exportedAt: new Date().toISOString() };
    for (const t of TYPES) out[t] = this.all(t);
    return out;
  },
  importAll(obj) {
    let n = 0;
    // A restore must win over what is in Drive: stamp every field as changed now (old per-field times would lose).
    const now = Date.now();
    for (const t of TYPES) for (const x of obj[t] || []) { if (x && x.id) { const { _f, ...rest } = x; data[t].set(x.id, { ...rest, updatedAt: now }); touchItem(t, x.id); n++; } }
    for (const f of Object.keys(FILES)) localStorage.setItem('steward.dirty.' + f, '1');
    this.flush().catch(() => {}); this.emit({});
    return n;
  },
};

// ---- settings ------------------------------------------------------------------
// Most settings belong to one device (theme, home screen). Settings that change what Steward does with your
// data (reminders, work hours, rest day) are SHARED: kept in the synced "prefs" item so the Mac and phone agree.
// hours: per weekday (0 = Sunday) the window tasks may be planned in, or null for no planning that day.
const WEEK_HOURS = [null, ...Array(5).fill({ start: '07:00', end: '22:30' }), { start: '07:00', end: '22:30' }];
const defaults = { theme: 'light', weekStart: 0, home: 'today', autoRemind: true, remindLead: 0, clientId: '953176719624-701gj43chqpp040biv5qvvr628o8rflo.apps.googleusercontent.com', calView: 'week', hidden: [], workStart: '07:00', workEnd: '18:00', restDay: 0, hours: WEEK_HOURS };
export const SHARED = ['autoRemind', 'remindLead', 'remindersPaused', 'workStart', 'workEnd', 'restDay', 'hours', 'helperUrl'];
const local = {
  get(k) { try { return JSON.parse(localStorage.getItem('steward.set.' + k)); } catch { return null; } },
  set(k, v) { localStorage.setItem('steward.set.' + k, JSON.stringify(v)); },
};
export const settings = {
  get(k) {
    if (SHARED.includes(k)) { const p = data.prefs.get('shared'); if (p && !p.deleted && p[k] !== undefined) return p[k]; }
    return local.get(k) ?? defaults[k];
  },
  set(k, v) {
    if (SHARED.includes(k)) { const p = data.prefs.get('shared'); store.put('prefs', { ...(p && !p.deleted ? p : {}), id: 'shared', [k]: v }); return; }
    local.set(k, v);
  },
  /** First run after updating: copy this device's own values into the shared settings, if none exist yet. */
  adoptLocal() {
    const p = data.prefs.get('shared');
    if (p && !p.deleted) return;
    const v = {};
    for (const k of SHARED) { const x = local.get(k); if (x != null) v[k] = x; }
    if (local.get('workStart') && local.get('workEnd') && !v.hours) v.hours = WEEK_HOURS.map((h, i) => (i === (local.get('restDay') ?? 0) ? null : { start: local.get('workStart'), end: local.get('workEnd') }));
    if (Object.keys(v).length) store.put('prefs', { id: 'shared', ...v });
  },
};

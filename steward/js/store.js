// Local data store. Everything lives on the device first (IndexedDB) and is merged with Google Drive by sync.js.
import { uid } from './util.js';

export const FILES = {
  tasks: ['projects', 'sections', 'tasks', 'comments', 'labels', 'filters'],
  notes: ['notebooks', 'notes'],
};
export const TYPES = [...FILES.tasks, ...FILES.notes];
const fileOf = type => (FILES.tasks.includes(type) ? 'tasks' : 'notes');

const data = Object.fromEntries(TYPES.map(t => [t, new Map()]));
const listeners = new Set();
let db = null;
const pending = new Set();
let flushTimer = null;

function openDb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('steward', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      for (const s of ['kv', 'blobs', 'events']) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s);
    };
    r.onsuccess = () => res(r.result);
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
    db = await openDb();
    for (const t of TYPES) {
      const arr = (await idb('kv', 'readonly', s => s.get(t))) || [];
      data[t] = new Map(arr.map(x => [x.id, x]));
    }
    if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  },
  on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  emit(info) { for (const fn of listeners) fn(info || {}); },
  all(type) { const out = []; for (const x of data[type].values()) if (!x.deleted) out.push(x); return out; },
  raw(type) { return [...data[type].values()]; },
  get(type, id) { const x = data[type].get(id); return x && !x.deleted ? x : null; },
  put(type, item, opts = {}) {
    if (!item.id) item.id = uid();
    if (!item.createdAt) item.createdAt = Date.now();
    item.updatedAt = Date.now();
    data[type].set(item.id, item);
    this._changed(type, opts);
    return item;
  },
  patch(type, id, fields, opts) {
    const cur = data[type].get(id);
    if (!cur) return null;
    return this.put(type, { ...cur, ...fields }, opts);
  },
  remove(type, id, opts = {}) {
    if (!data[type].has(id)) return;
    data[type].set(id, { id, deleted: true, updatedAt: Date.now() });
    this._changed(type, opts);
  },
  _changed(type, opts) {
    pending.add(type);
    localStorage.setItem('steward.dirty.' + fileOf(type), '1');
    clearTimeout(flushTimer);
    flushTimer = setTimeout(() => this.flush(), 250);
    if (!opts.silent) this.emit({ type, local: true });
  },
  async flush() {
    clearTimeout(flushTimer);
    const types = [...pending]; pending.clear();
    for (const t of types) await idb('kv', 'readwrite', s => s.put([...data[t].values()], t));
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
    const cutoff = Date.now() - 90 * 864e5;
    for (const t of FILES[file]) {
      const map = data[t];
      const seen = new Set();
      for (const r of remote?.[t] || []) {
        if (!r || !r.id) continue;
        seen.add(r.id);
        const l = map.get(r.id);
        if (!l || (r.updatedAt || 0) > (l.updatedAt || 0)) { map.set(r.id, r); changed = true; pending.add(t); }
        else if ((l.updatedAt || 0) > (r.updatedAt || 0)) localNewer = true;
      }
      for (const [id, l] of map) {
        if (!seen.has(id)) localNewer = true;
        if (l.deleted && (l.updatedAt || 0) < cutoff) { map.delete(id); pending.add(t); }
      }
    }
    if (changed) { this.flush(); this.emit({ remote: true }); }
    return { localNewer, changed };
  },

  // ---- attachments (binary files) ----------------------------------------
  putBlob(id, blob) { return idb('blobs', 'readwrite', s => s.put(blob, id)); },
  getBlob(id) { return idb('blobs', 'readonly', s => s.get(id)); },
  delBlob(id) { return idb('blobs', 'readwrite', s => s.delete(id)); },
  // ---- cached calendar events --------------------------------------------
  putKV(key, val) { return idb('events', 'readwrite', s => s.put(val, key)); },
  getKV(key) { return idb('events', 'readonly', s => s.get(key)); },

  async exportAll() {
    const out = { app: 'steward', format: 1, exportedAt: new Date().toISOString() };
    for (const t of TYPES) out[t] = this.all(t);
    return out;
  },
  importAll(obj) {
    let n = 0;
    for (const t of TYPES) for (const x of obj[t] || []) { if (x && x.id) { data[t].set(x.id, { ...x, updatedAt: Date.now() }); pending.add(t); n++; } }
    localStorage.setItem('steward.dirty.tasks', '1'); localStorage.setItem('steward.dirty.notes', '1');
    this.flush(); this.emit({});
    return n;
  },
};

// ---- settings (per device, not synced) -------------------------------------
const defaults = { theme: 'auto', weekStart: 0, home: 'today', autoRemind: true, remindLead: 0, clientId: '', calView: 'week', hidden: [] };
export const settings = {
  get(k) { try { const v = JSON.parse(localStorage.getItem('steward.set.' + k)); return v ?? defaults[k]; } catch { return defaults[k]; } },
  set(k, v) { localStorage.setItem('steward.set.' + k, JSON.stringify(v)); },
};

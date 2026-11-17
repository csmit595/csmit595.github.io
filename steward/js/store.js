// Local data store. Everything lives on the device first (IndexedDB) and is merged with Google Drive by sync.js.
import { uid } from './util.js';

export const FILES = {
  tasks: ['projects', 'sections', 'tasks', 'comments', 'labels', 'filters'],
  notes: ['notebooks', 'notes', 'ocr'],
  writing: ['docs', 'sources'],
};
export const TYPES = Object.values(FILES).flat();
const fileOf = type => Object.keys(FILES).find(f => FILES[f].includes(type));

const data = Object.fromEntries(TYPES.map(t => [t, new Map()]));
const listeners = new Set();
let db = null;
const pending = new Map(); // "type|id" -> [type, id]: only changed items are written to disk
const touchItem = (type, id) => pending.set(type + '|' + id, [type, id]);
let flushTimer = null;

function openDb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('steward', 3);
    r.onupgradeneeded = () => {
      const d = r.result;
      for (const s of ['kv', 'blobs', 'events', 'vec', 'items']) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s);
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
    db = await openDb();
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
  get(type, id) { const x = data[type].get(id); return x && !x.deleted ? x : null; },
  put(type, item, opts = {}) {
    if (!item.id) item.id = uid();
    if (!item.createdAt) item.createdAt = Date.now();
    item.updatedAt = Date.now();
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
    data[type].set(id, { id, deleted: true, updatedAt: Date.now() });
    this._changed(type, opts, id);
  },
  _changed(type, opts, id) {
    touchItem(type, id);
    localStorage.setItem('steward.dirty.' + fileOf(type), '1');
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
        if (!l || (r.updatedAt || 0) > (l.updatedAt || 0)) { map.set(r.id, r); changed = true; touchItem(t, r.id); }
        else if ((l.updatedAt || 0) > (r.updatedAt || 0)) localNewer = true;
      }
      for (const [id, l] of map) {
        if (!seen.has(id)) localNewer = true;
        if (l.deleted && (l.updatedAt || 0) < cutoff) { map.delete(id); touchItem(t, id); }
      }
    }
    if (changed) { this.flush().catch(() => {}); this.emit({ remote: true }); }
    return { localNewer, changed };
  },

  // ---- attachments (binary files) ----------------------------------------
  putBlob(id, blob) { return idb('blobs', 'readwrite', s => s.put(blob, id)); },
  getBlob(id) { return idb('blobs', 'readonly', s => s.get(id)); },
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
    for (const t of TYPES) for (const x of obj[t] || []) { if (x && x.id) { data[t].set(x.id, { ...x, updatedAt: Date.now() }); touchItem(t, x.id); n++; } }
    for (const f of Object.keys(FILES)) localStorage.setItem('steward.dirty.' + f, '1');
    this.flush().catch(() => {}); this.emit({});
    return n;
  },
};

// ---- settings (per device, not synced) -------------------------------------
const defaults = { theme: 'light', weekStart: 0, home: 'today', autoRemind: true, remindLead: 0, clientId: '953176719624-701gj43chqpp040biv5qvvr628o8rflo.apps.googleusercontent.com', calView: 'week', hidden: [] };
export const settings = {
  get(k) { try { const v = JSON.parse(localStorage.getItem('steward.set.' + k)); return v ?? defaults[k]; } catch { return defaults[k]; } },
  set(k, v) { localStorage.setItem('steward.set.' + k, JSON.stringify(v)); },
};

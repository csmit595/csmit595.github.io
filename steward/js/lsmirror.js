// Steward keeps small settings (Google sign-in, sync bookkeeping) in localStorage, which only an open window can read.
// To let the background sync (service worker) work while Steward is closed, those values are mirrored into
// IndexedDB. The page writes the mirror; the background sync reads it, works, and writes it back; the next time the
// page opens it takes the background's newer values first.
const KEY = '_ls';
const AT = 'steward._lsAt';
const inWindow = typeof window !== 'undefined' && typeof document !== 'undefined';

function openDb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('steward', 4);
    // must match store.js, in case this runs first on a brand-new device
    r.onupgradeneeded = () => { const d = r.result; for (const s of ['kv', 'blobs', 'events', 'vec', 'items', 'drive']) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s); };
    r.onsuccess = () => { r.result.onversionchange = () => r.result.close(); res(r.result); };
    r.onerror = () => rej(r.error);
  });
}
async function withKv(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((res, rej) => {
      const tx = db.transaction('kv', mode), st = tx.objectStore('kv');
      let out;
      fn(st, v => { out = v; });
      tx.oncomplete = () => res(out); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error);
    });
  } finally { db.close(); }
}
export const readMirror = () => withKv('readonly', (st, set) => { const g = st.get(KEY); g.onsuccess = () => set(g.result || null); });

// ---- in the open app ---------------------------------------------------------------------------------------------
const pageAt = () => Number(localStorage.getItem(AT) || 0);
/** True when the background sync ran after this window last saved: what this window holds in memory is out of date. */
export async function backgroundIsNewer() {
  try { const m = await readMirror(); return !!m && m.src === 'sw' && m.at > pageAt(); } catch { return false; }
}
/** Before anything else loads: take the values the background sync left behind. */
export async function hydrate() {
  if (!inWindow) return;
  let m; try { m = await readMirror(); } catch { return; }
  if (!m || m.src !== 'sw' || !(m.at > pageAt())) return;
  const keep = new Set(Object.keys(m.data));
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i);
    // Unsent-change flags are only ever added here, never dropped: at worst one extra upload.
    if (k && k.startsWith('steward.') && k !== AT && !k.startsWith('steward.dirty.') && !keep.has(k)) localStorage.removeItem(k);
  }
  for (const [k, v] of Object.entries(m.data)) localStorage.setItem(k, v);
  localStorage.setItem(AT, String(m.at));
}
/** Save this window's values for the background sync. Never overwrites newer values the background sync wrote. */
export async function snapshot() {
  if (!inWindow) return false;
  const data = {};
  for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith('steward.') && k !== AT) data[k] = localStorage.getItem(k); }
  const mine = pageAt(), at = Math.max(Date.now(), mine + 1);
  const ok = await withKv('readwrite', (st, set) => {
    const g = st.get(KEY);
    g.onsuccess = () => {
      const m = g.result;
      if (m && m.src === 'sw' && m.at > mine) return set(false); // background is newer: this window must reload first
      st.put({ at, src: 'page', data }, KEY); set(true);
    };
  });
  if (ok) localStorage.setItem(AT, String(at));
  return ok;
}

// ---- in the background sync (service worker) ---------------------------------------------------------------------
const mem = new Map();
const shim = {
  getItem: k => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => { mem.set(k, String(v)); },
  removeItem: k => { mem.delete(k); },
  key: i => [...mem.keys()][i] ?? null,
  get length() { return mem.size; },
  clear: () => mem.clear(),
};
if (typeof localStorage === 'undefined') globalThis.localStorage = shim;
/** Background only: load the mirrored values. Returns false if the app has never saved any (nothing to sync with). */
export async function loadShim() {
  const m = await readMirror();
  mem.clear();
  if (!m) return false;
  for (const [k, v] of Object.entries(m.data)) mem.set(k, v);
  return true;
}
/** Background only: write the values back, marked newer than anything the app has. */
export async function saveShim() {
  const data = Object.fromEntries(mem);
  await withKv('readwrite', (st, set) => {
    const g = st.get(KEY);
    g.onsuccess = () => { const prev = g.result; st.put({ at: Math.max(Date.now(), (prev?.at || 0) + 1), src: 'sw', data }, KEY); set(true); };
  });
}

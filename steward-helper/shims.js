// Apps Script has no localStorage, timers or crypto. Steward's task code only needs simple stand-ins for this job.
const mem = new Map();
if (typeof globalThis.localStorage === 'undefined') globalThis.localStorage = {
  getItem: k => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => { mem.set(k, String(v)); }, removeItem: k => { mem.delete(k); },
  key: i => [...mem.keys()][i] ?? null, get length() { return mem.size; },
};
// store.js schedules saves to IndexedDB with a timer; here everything is uploaded to Drive at the end instead.
if (typeof globalThis.setTimeout === 'undefined') { globalThis.setTimeout = () => 0; globalThis.clearTimeout = () => {}; }
if (typeof globalThis.crypto === 'undefined') globalThis.crypto = { getRandomValues: a => { for (let i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 256); return a; } };

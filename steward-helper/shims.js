// Apps Script has no localStorage, timers or crypto. Steward's task code only needs simple stand-ins for this job.
const mem = new Map();
if (typeof globalThis.localStorage === 'undefined') globalThis.localStorage = {
  getItem: k => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => { mem.set(k, String(v)); }, removeItem: k => { mem.delete(k); },
  key: i => [...mem.keys()][i] ?? null, get length() { return mem.size; },
};
// store.js schedules saves to IndexedDB with a timer; here everything is uploaded to Drive at the end instead.
if (typeof globalThis.setTimeout === 'undefined') { globalThis.setTimeout = () => 0; globalThis.clearTimeout = () => {}; }
// Random numbers: the notification keys need real randomness. Apps Script's UUIDs come from Java's SecureRandom, so
// each batch of bytes is a SHA-256 of two fresh UUIDs (244 random bits).
const secure = typeof Utilities !== 'undefined' && Utilities.getUuid && Utilities.computeDigest;
if (typeof globalThis.crypto === 'undefined') globalThis.crypto = { getRandomValues: a => {
  const bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  for (let i = 0; i < bytes.length;) {
    const chunk = secure ? Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, Utilities.getUuid() + Utilities.getUuid() + Date.now()) : Array.from({ length: 32 }, () => Math.floor(Math.random() * 256));
    for (const b of chunk) { if (i >= bytes.length) break; bytes[i++] = b & 255; }
  }
  return a;
} };

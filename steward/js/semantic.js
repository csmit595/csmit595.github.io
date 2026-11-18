// Search by meaning. A small language model (bundled with the app, running only on this device) turns each
// note and task into numbers that capture what it is about. A search is turned into the same kind of numbers
// and compared, so "what do I owe the nursery" can find an invoice that never uses the word "owe".
import { store, settings } from './store.js';
import { docs } from './search.js';

let worker = null, seq = 0, loaded = false, indexing = false, timer = null, failed = '';
const waiting = new Map();
const vectors = new Map(); // "note:ID" -> { hash, chunks: [{ text, v: Float32Array }] }
const listeners = new Set();
export const status = { done: 0, total: 0, ready: false, error: '' };
const tell = () => { for (const f of listeners) f(); };

export const enabled = () => { const v = settings.get('semantic'); return v == null ? window.matchMedia('(pointer: fine)').matches : !!v; };

/** Turn texts into meaning vectors with the on-device model (also used by the organizer). */
export function embed(texts) {
  if (!worker) {
    worker = new Worker(new URL('./semantic-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = e => { const w = waiting.get(e.data.id); waiting.delete(e.data.id); if (!w) return; e.data.error ? w.rej(new Error(e.data.error)) : w.res(e.data.vecs); };
    worker.onerror = e => { for (const w of waiting.values()) w.rej(new Error(e.message || 'worker failed')); waiting.clear(); worker = null; };
  }
  return new Promise((res, rej) => { const id = ++seq; waiting.set(id, { res, rej }); worker.postMessage({ id, texts }); });
}
const hash = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36) + s.length; };
function chunksOf(d) {
  const body = [d.body, ...d.atts.map(a => a.text)].filter(Boolean).join('\n').replace(/\s+/g, ' ').trim();
  const head = d.title + (d.meta.trim() ? ' (' + d.meta.trim() + ')' : '');
  if (!body) return [head];
  const out = []; let i = 0;
  while (i < body.length && out.length < 12) {
    let end = Math.min(body.length, i + 700);
    if (end < body.length) { const sp = body.lastIndexOf(' ', end); if (sp > i + 300) end = sp; }
    out.push(body.slice(i, end)); i = end;
  }
  return out.map((c, k) => (k === 0 ? head + '. ' : d.title + '. ') + c);
}
async function loadVectors() {
  if (loaded) return; loaded = true;
  for (const [k, v] of await store.vecAll()) if (!String(k).startsWith('org:')) vectors.set(k, v); // org: the organizer's own
}

/** Keep the meaning index up to date in the background. */
async function run() {
  if (indexing || !enabled() || document.hidden) return;
  indexing = true;
  try {
    await loadVectors();
    const all = docs(), keys = new Set();
    const todo = [];
    for (const d of all) {
      const key = d.kind + ':' + d.item.id; keys.add(key);
      const chunks = chunksOf(d), hsh = hash(chunks.join('|'));
      if (vectors.get(key)?.hash !== hsh) todo.push({ key, chunks, hsh });
    }
    for (const k of [...vectors.keys()]) if (!keys.has(k)) { vectors.delete(k); store.vecDel(k); }
    status.total = all.length; status.done = all.length - todo.length; tell();
    for (const t of todo) {
      if (document.hidden || !enabled()) break;
      const vs = [];
      for (let i = 0; i < t.chunks.length; i += 6) vs.push(...await embed(t.chunks.slice(i, i + 6)));
      const rec = { hash: t.hsh, chunks: t.chunks.map((text, i) => ({ text, v: vs[i] })) };
      vectors.set(t.key, rec); await store.vecPut(t.key, rec);
      status.done++; status.ready = true; status.error = ''; failed = '';
      if (status.done % 5 === 0 || status.done === status.total) tell();
      await new Promise(r => setTimeout(r, 15));
    }
    status.ready = true; tell();
  } catch (e) {
    console.warn('meaning search', e); failed = e.message; status.error = navigator.onLine ? e.message : 'offline'; tell();
  } finally { indexing = false; }
}
export const semantic = {
  on(f) { listeners.add(f); return () => listeners.delete(f); },
  kick(delay = 5000) { clearTimeout(timer); if (enabled()) timer = setTimeout(run, delay); },
  /** Items closest in meaning to the query: [{kind, item, score, text}] best first. */
  async query(q, opts = {}) {
    if (!enabled()) return [];
    await loadVectors();
    if (!vectors.size) return [];
    const [qv] = await embed([q]);
    const norm = t => t.toLowerCase();
    const stems = [...new Set(q.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 4).map(w => w.replace(/(ing|ed|es|s)$/, '')).filter(w => w.length >= 3))].slice(0, 4);
    const byKey = new Map(docs().map(d => [d.kind + ':' + d.item.id, d]));
    const out = [];
    for (const [key, rec] of vectors) {
      const d = byKey.get(key);
      if (!d || (opts.kind && d.kind !== opts.kind) || (opts.filter && !opts.filter(d.item))) continue;
      let best = -1, text = '';
      for (const c of rec.chunks) { let s = 0; const v = c.v; for (let i = 0; i < v.length; i++) s += v[i] * qv[i]; if (s > best) { best = s; text = c.text; } }
      for (const st of stems) if (norm(d.title + ' ' + text).includes(st)) best += 0.04; // small bonus when a word (or its root) also appears
      if (d.kind === 'task' && d.item.completedAt) best *= 0.92;
      out.push({ ...d, score: best, text });
    }
    out.sort((a, b) => b.score - a.score);
    const top = out[0]?.score || 0;
    return out.filter(r => r.score >= 0.21 && r.score >= top - 0.15).slice(0, opts.limit || 8);
  },
};

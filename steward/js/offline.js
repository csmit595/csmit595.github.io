// Offline: keeps everything Steward needs on this device so it works with no signal.
// - The tools (PDF reader, Word import/export, page reader, search model) live in their own cache that survives updates.
// - Every attachment (photos, PDFs, recordings) is kept on the device, not only the ones opened before.
import { store } from './store.js';
import { sync } from './sync.js';

export const TOOLS_CACHE = 'steward-tools-1'; // keep in step with sw.js
const base = p => new URL(p, document.baseURI).href;
// Small, needed to read PDFs and work with Word files: downloaded automatically.
const BASIC = ['vendor/pdf/pdf.min.mjs', 'vendor/pdf/pdf.worker.min.mjs', 'vendor/fflate/fflate.js', 'vendor/docx/docx.js', 'vendor/mammoth/mammoth.browser.min.js', 'vendor/paged/paged.polyfill.min.js'];
// Larger: the page reader (reads text in photos) and search by meaning.
const BIG = ['vendor/tess/tesseract.min.js', 'vendor/tess/worker.min.js', 'vendor/tess/core/tesseract-core-lstm.wasm.js', 'vendor/tess/core/tesseract-core-simd-lstm.wasm.js', 'vendor/tess/lang/eng.traineddata.gz',
  'vendor/tf/transformers.min.js', 'vendor/tf/ort-wasm.wasm', 'vendor/tf/ort-wasm-simd.wasm',
  'vendor/models/Xenova/all-MiniLM-L6-v2/config.json', 'vendor/models/Xenova/all-MiniLM-L6-v2/tokenizer.json', 'vendor/models/Xenova/all-MiniLM-L6-v2/tokenizer_config.json',
  'vendor/models/Xenova/all-MiniLM-L6-v2/special_tokens_map.json', 'vendor/models/Xenova/all-MiniLM-L6-v2/onnx/model_quantized.onnx'];
export const ALL_TOOLS = [...BASIC, ...BIG];

const KEEP = 'steward.offline.keepFiles'; // per device; on unless turned off
export const keepFiles = () => { try { return localStorage.getItem(KEEP) !== '0'; } catch { return true; } };
export const setKeepFiles = on => { try { localStorage.setItem(KEEP, on ? '1' : '0'); } catch {} if (on) keepSoon(); };

const listeners = new Set();
export const state = { busy: false, line: '' };
export const onChange = fn => listeners.add(fn);
const tell = line => { state.line = line; listeners.forEach(f => { try { f(); } catch {} }); };

async function haveTool(cache, p) { return !!(await cache.match(base(p), { ignoreSearch: true })); }
async function getTool(cache, p) {
  if (await haveTool(cache, p)) return true;
  const res = await fetch(base(p), { cache: 'reload' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  await cache.put(base(p), res);
  return true;
}

/** What is on this device now. */
export async function status() {
  const out = { tools: 0, toolsTotal: ALL_TOOLS.length, files: 0, filesTotal: 0, bytes: 0, quota: 0, persisted: false };
  try { const c = await caches.open(TOOLS_CACHE); for (const p of ALL_TOOLS) if (await haveTool(c, p)) out.tools++; } catch {}
  try {
    const have = await store.blobIds();
    for (const a of attachments()) { out.filesTotal++; if (have.has(a.id)) out.files++; }
  } catch {}
  try { const e = await navigator.storage.estimate(); out.bytes = e.usage || 0; out.quota = e.quota || 0; } catch {}
  try { out.persisted = await navigator.storage.persisted(); } catch {}
  return out;
}

function attachments() {
  const out = [];
  for (const n of store.all('notes')) if (!n.trashed) for (const a of n.attachments || []) if (a.driveId) out.push(a);
  return out;
}

/** Fetch whatever is missing. full = also the big tools; otherwise just the basics. */
async function fill({ full, files, quiet }) {
  if (state.busy || !navigator.onLine) return false;
  state.busy = true;
  let failed = 0;
  try {
    try { await navigator.storage?.persist?.(); } catch {}
    const cache = await caches.open(TOOLS_CACHE);
    const tools = full ? ALL_TOOLS : BASIC;
    let i = 0;
    for (const p of tools) {
      i++;
      if (!quiet) tell(`Downloading tools ${i} of ${tools.length}…`);
      try { await getTool(cache, p); } catch (e) { failed++; if (!navigator.onLine) break; }
    }
    if (files && sync.connected()) {
      const have = await store.blobIds();
      const want = attachments().filter(a => !have.has(a.id));
      let n = 0;
      for (const a of want) {
        if (!navigator.onLine) break;
        n++;
        if (!quiet) tell(`Downloading attachments ${n} of ${want.length}…`);
        if (!(await sync.blob(a))) failed++;
      }
    }
  } finally {
    state.busy = false;
    tell(failed ? `${failed} item${failed === 1 ? '' : 's'} could not download. Try again with a stronger signal.` : quiet ? '' : 'Everything is on this device.');
  }
  return !failed;
}

/** The "Download everything" button. */
export const downloadAll = () => fill({ full: true, files: true });

// Quietly, after each sync: the basic tools, plus any new attachments (unless turned off or Data Saver is on).
let t = null;
export function keepSoon(ms = 8000) {
  clearTimeout(t);
  t = setTimeout(() => {
    if (document.hidden || navigator.connection?.saveData) return;
    fill({ full: false, files: keepFiles(), quiet: true }).catch(() => {});
  }, ms);
}

// Offline: keeps everything Steward needs on this device so it works with no signal.
// - The tools (PDF reader, page reader, search model) live in their own cache that survives updates.
// - Every attachment (photos, PDFs, recordings) is kept on the device, not only the ones opened before.
import { store } from './store.js';
import { sync } from './sync.js';
import { setModelHere } from './dictate.js';

export const TOOLS_CACHE = 'steward-tools-1'; // keep in step with sw.js
const base = p => new URL(p, document.baseURI).href;
// Small, needed to read PDFs: downloaded automatically.
const BASIC = ['vendor/pdf/pdf.min.mjs', 'vendor/pdf/pdf.worker.min.mjs'];
// Larger: the page reader (reads text in photos) and search by meaning.
const BIG = ['vendor/tess/tesseract.min.js', 'vendor/tess/worker.min.js', 'vendor/tess/core/tesseract-core-lstm.wasm.js', 'vendor/tess/core/tesseract-core-simd-lstm.wasm.js', 'vendor/tess/lang/eng.traineddata.gz',
  'vendor/tf/transformers.min.js', 'vendor/tf/ort-wasm.wasm', 'vendor/tf/ort-wasm-simd.wasm',
  'vendor/models/Xenova/all-MiniLM-L6-v2/config.json', 'vendor/models/Xenova/all-MiniLM-L6-v2/tokenizer.json', 'vendor/models/Xenova/all-MiniLM-L6-v2/tokenizer_config.json',
  'vendor/models/Xenova/all-MiniLM-L6-v2/special_tokens_map.json', 'vendor/models/Xenova/all-MiniLM-L6-v2/onnx/model_quantized.onnx'];
// Steward's own speech model, so dictation works with no signal (about 77 MB). Fetched quietly on Wi-Fi.
const W = 'vendor/models/Xenova/whisper-base.en/';
export const SPEECH = ['js/whisper-worker.js', 'js/listen-device.js', 'js/mic-worklet.js', 'vendor/tf/transformers.min.js', 'vendor/tf/ort-wasm.wasm', 'vendor/tf/ort-wasm-simd.wasm',
  ...['config.json', 'generation_config.json', 'preprocessor_config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_merged_quantized.onnx'].map(f => W + f)];
const SPEECH_TOOLS = SPEECH.filter(p => p.startsWith('vendor/'));
export const ALL_TOOLS = [...new Set([...BASIC, ...BIG, ...SPEECH_TOOLS])];

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

/** Is the whole speech model on this device? (Also tells dictate.js.) */
export async function speechHere() {
  let ok = false;
  try { const c = await caches.open(TOOLS_CACHE); ok = true; for (const p of SPEECH_TOOLS) if (!(await haveTool(c, p))) { ok = false; break; } } catch { ok = false; }
  setModelHere(ok);
  return ok;
}
let speechBusy = false;
/** Download the speech model. onStep(i, n) reports progress. */
export async function downloadSpeech({ quiet = false } = {}) {
  if (speechBusy || !navigator.onLine) return false;
  speechBusy = true;
  try {
    try { await navigator.storage?.persist?.(); } catch {}
    const cache = await caches.open(TOOLS_CACHE);
    let i = 0;
    for (const p of SPEECH_TOOLS) {
      i++;
      if (!quiet) tell(`Downloading the speech model ${i} of ${SPEECH_TOOLS.length}…`);
      await getTool(cache, p);
    }
    // the app's own small speech files live in the app cache; a normal fetch through the service worker keeps them
    await Promise.all(SPEECH.filter(p => p.startsWith('js/')).map(p => fetch(base(p)).catch(() => {})));
    if (!quiet) tell('The speech model is on this device. Dictation now works with no signal.');
    return await speechHere();
  } catch (e) {
    if (!quiet) tell('The speech model did not finish downloading. Try again with a stronger signal (Wi-Fi is best).');
    return false;
  } finally { speechBusy = false; }
}
// Wi-Fi (or a Mac, which has no data plan to worry about) and not Data Saver.
const roomy = () => { const c = navigator.connection; if (c?.saveData) return false; if (c?.type) return c.type === 'wifi' || c.type === 'ethernet'; return !/Android|iPhone|iPad/i.test(navigator.userAgent); };

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
    speechHere().catch(() => {});
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
    // the speech model, once, the first time there is Wi-Fi
    speechHere().then(ok => { if (!ok && roomy()) downloadSpeech({ quiet: true }); }).catch(() => {});
  }, ms);
}

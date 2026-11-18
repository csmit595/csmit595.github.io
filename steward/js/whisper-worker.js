// Steward's own speech model (Whisper base, English), run on this device so dictation works with no signal.
// Takes 16 kHz mono audio of one spoken phrase and returns its words. Runs off the main thread.
import { pipeline, env } from '../vendor/tf/transformers.min.js';
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.useBrowserCache = false; // the app's own offline cache keeps these files
env.localModelPath = new URL('../vendor/models/', import.meta.url).href;
env.backends.onnx.wasm.wasmPaths = new URL('../vendor/tf/', import.meta.url).href;
env.backends.onnx.wasm.numThreads = 1;
export const MODEL = 'Xenova/whisper-base.en';

let asr = null, loading = null;
const load = () => loading ||= pipeline('automatic-speech-recognition', MODEL, {
  quantized: true,
  progress_callback: p => { if (p.status === 'progress' && /\.onnx$/.test(p.file || '')) self.postMessage({ progress: { file: p.file, pct: Math.round(p.progress || 0) } }); },
}).then(a => (asr = a)).catch(e => { loading = null; throw e; });

self.onmessage = async e => {
  const { id, audio, warm } = e.data;
  try {
    await load();
    if (warm) { self.postMessage({ id, ready: true }); return; }
    const out = await asr(audio, { return_timestamps: false });
    self.postMessage({ id, text: String(out?.text || '') });
  } catch (err) { self.postMessage({ id, error: String(err?.message || err) }); }
};

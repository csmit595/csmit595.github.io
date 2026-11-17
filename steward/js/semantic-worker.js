// Runs the small language model off the main thread so typing never stutters.
import { pipeline, env } from '../vendor/tf/transformers.min.js';
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.useBrowserCache = false; // the app's own offline cache already keeps these files
env.localModelPath = new URL('../vendor/models/', import.meta.url).href;
env.backends.onnx.wasm.wasmPaths = new URL('../vendor/tf/', import.meta.url).href;
env.backends.onnx.wasm.numThreads = 1;
let extractor = null;
self.onmessage = async e => {
  const { id, texts } = e.data;
  try {
    extractor ||= await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { quantized: true });
    const out = await extractor(texts, { pooling: 'mean', normalize: true });
    const dim = out.dims[1], vecs = [];
    for (let i = 0; i < texts.length; i++) vecs.push(out.data.slice(i * dim, (i + 1) * dim));
    self.postMessage({ id, vecs });
  } catch (err) { extractor = null; self.postMessage({ id, error: String(err?.message || err) }); }
};

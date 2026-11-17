// Makes text inside photos and PDFs searchable. Runs quietly in the background, one attachment at a time.
// Results are kept in their own synced list ("ocr"), keyed by attachment id, so every device can search them.
import { store } from './store.js';

const url = p => new URL(p, document.baseURI).href;
let busy = false, tess = null, pdfjs = null, timer = null;
const MAX_CHARS = 30000, MAX_BYTES = 40e6;

function loadScript(src) {
  return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('offline')); document.head.append(s); });
}
async function reader() {
  if (tess) return tess;
  if (!window.Tesseract) await loadScript(url('vendor/tess/tesseract.min.js'));
  tess = await window.Tesseract.createWorker('eng', 1, { workerPath: url('vendor/tess/worker.min.js'), corePath: url('vendor/tess/core'), langPath: url('vendor/tess/lang'), gzip: true });
  return tess;
}
async function readImage(source) { const r = await (await reader()).recognize(source); return r.data.text || ''; }
async function readPdf(blob) {
  if (!pdfjs) { pdfjs = await import(url('vendor/pdf/pdf.min.mjs')); pdfjs.GlobalWorkerOptions.workerSrc = url('vendor/pdf/pdf.worker.min.mjs'); }
  const doc = await pdfjs.getDocument({ data: await blob.arrayBuffer(), isEvalSupported: false }).promise;
  let text = '';
  const pages = Math.min(doc.numPages, 80);
  for (let i = 1; i <= pages && text.length < MAX_CHARS; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    text += tc.items.map(it => it.str).join(' ') + '\n';
  }
  if (text.replace(/\s/g, '').length < 20) { // a scanned PDF: read the first pages as pictures
    text = '';
    for (let i = 1; i <= Math.min(doc.numPages, 5); i++) {
      const page = await doc.getPage(i), vp = page.getViewport({ scale: 1.7 });
      const canvas = document.createElement('canvas'); canvas.width = vp.width; canvas.height = vp.height;
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
      text += (await readImage(canvas)) + '\n';
    }
  }
  doc.destroy?.();
  return text;
}
const readable = a => (a.mime || '').startsWith('image/') || a.mime === 'application/pdf' || /\.pdf$/i.test(a.name || '');

async function run() {
  if (busy || document.hidden) return;
  busy = true;
  try {
    for (const n of store.all('notes')) {
      if (n.trashed) continue;
      for (const a of n.attachments || []) {
        if (!readable(a) || store.get('ocr', a.id)) continue;
        const blob = await store.getBlob(a.id);
        if (!blob) continue; // another device holds the file and will read it
        let text = '', failed = false;
        try {
          if (blob.size > MAX_BYTES) failed = true;
          else text = (a.mime || '').startsWith('image/') ? await readImage(blob) : await readPdf(blob);
        } catch (e) {
          if (e.message === 'offline' || !navigator.onLine) return; // reader not downloaded yet; try again later
          console.warn('could not read', a.name, e); failed = true;
        }
        store.put('ocr', { id: a.id, noteId: n.id, name: a.name, text: text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_CHARS), ...(failed ? { failed: true } : {}) }, { silent: true });
        store.emit({ ocr: true });
        await new Promise(r => setTimeout(r, 50));
      }
    }
  } finally { busy = false; }
}
export const ocr = {
  /** Ask for a background pass soon (after a new attachment, a sync, or start-up). */
  kick(delay = 4000) { clearTimeout(timer); timer = setTimeout(() => run().catch(e => console.warn('ocr', e)), delay); },
  /** All text found inside a note's attachments. */
  textFor(note) { let out = ''; for (const a of note.attachments || []) { const o = store.get('ocr', a.id); if (o?.text) out += ' ' + o.text; } return out; },
  run,
};

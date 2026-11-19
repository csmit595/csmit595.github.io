// One-time move of the old Writing section (removed in Steward 4.5) into notes. No browser APIs: tests/legacy-writing.test.mjs.
// A document with real text becomes a note in the notebook "From Writing"; every saved source becomes one line in a
// single note. The ids are worked out from the old ids, so the phone and the Mac each make the SAME note and the two
// copies merge instead of doubling.
const escH = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const plain = html => String(html || '').replace(/<(br|\/p|\/div|\/h\d|\/li|\/tr|\/blockquote)\b[^>]*>/gi, '\n').replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/[ \t]+/g, ' ').trim();
const fnOrder = html => [...String(html || '').matchAll(/data-fn="([^"]+)"/g)].map(m => m[1]);
export const NOTEBOOK = 'From Writing';

/** One source as a readable citation line (every field that was filled in, most useful first). */
export function sourceLine(s) {
  const first = ['authors', 'title', 'container', 'editors', 'translator', 'edition', 'volume', 'series', 'city', 'publisher', 'year', 'pages', 'url', 'accessed'];
  const skip = new Set(['id', 'type', '_f', 'hist', 'createdAt', 'updatedAt', 'deleted', 'short', 'containerAbbr', 'seriesAbbr']);
  const keys = [...first.filter(k => s[k]), ...Object.keys(s).filter(k => !first.includes(k) && !skip.has(k) && (typeof s[k] === 'string' || typeof s[k] === 'number') && String(s[k]).trim())];
  return keys.map(k => String(s[k]).trim()).filter(Boolean).join('. ').replace(/\.\./g, '.');
}
/** Does a document hold anything worth keeping (text in the body or in a footnote)? An empty test document does not. */
export function hasRealText(d) {
  if (!d || d.deleted) return false;
  return !!plain(d.body) || Object.values(d.footnotes || {}).some(f => f && (plain(f.html) || f.cite));
}
/** The note a document becomes. sources: every saved source, to write out footnotes that only pointed at one. */
export function docToNote(d, sources = []) {
  const byId = new Map(sources.map(s => [s.id, s]));
  const fns = d.footnotes || {};
  const notes = fnOrder(d.body).map((id, i) => {
    const f = fns[id] || {};
    let html = f.html || '';
    if (f.cite) { const s = byId.get(f.cite.sourceId); html = s ? escH(sourceLine(s)) + (f.cite.pages ? ', ' + escH(f.cite.pages) : '') + (f.cite.suffix ? ' ' + escH(f.cite.suffix) : '') : html || '[source not found]'; }
    return `<li>${html || '&nbsp;'}</li>`;
  });
  // footnote markers were numbered by the Writing screen's styles; write the numbers into the text so they still show
  let n = 0;
  const body = String(d.body || '').replace(/<sup\b[^>]*data-fn="[^"]*"[^>]*>[\s\S]*?<\/sup>/g, () => `<sup>${++n}</sup>`).replace(/<p\b/g, '<div').replace(/<\/p>/g, '</div>');
  const meta = d.meta || {};
  const head = [meta.author, meta.course, meta.professor, meta.monthYear].filter(Boolean).map(escH).join(' · ');
  return {
    id: 'fw-' + d.id, title: d.title || 'Untitled document', notebook: NOTEBOOK, tags: ['from-writing'], pinned: false, sourceUrl: '', attachments: [], trashed: !!d.trashed,
    body: (head ? `<div><i>${head}</i></div>` : '') + body + (notes.length ? `<h3>Footnotes</h3><ol>${notes.join('')}</ol>` : ''),
    createdAt: d.createdAt || undefined, updatedAt: d.updatedAt || undefined,
  };
}
/** One note listing every saved source, or null when there are none. */
export function sourcesToNote(sources) {
  const live = (sources || []).filter(s => s && !s.deleted && sourceLine(s));
  if (!live.length) return null;
  live.sort((a, b) => String(a.authors || a.title || '').localeCompare(String(b.authors || b.title || '')));
  return { id: 'fw-sources', title: 'Sources (from Writing)', notebook: NOTEBOOK, tags: ['from-writing'], pinned: false, sourceUrl: '', attachments: [], trashed: false,
    body: `<div>The sources saved in Steward’s old Writing section, kept here when Writing was removed.</div><ul>${live.map(s => `<li>${escH(sourceLine(s))}</li>`).join('')}</ul>` };
}
/** Everything to do for a set of old items: notes to make (or add to), and which old items held nothing. */
export function convert({ docs = [], sources = [] }) {
  const liveSources = sources.filter(s => s && !s.deleted);
  const notes = [], empty = [];
  for (const d of docs) { if (!d || d.deleted) continue; if (hasRealText(d)) notes.push(docToNote(d, liveSources)); else empty.push(d.id); }
  const sn = sourcesToNote(liveSources);
  return { notes, sourcesNote: sn, empty };
}

// Search across tasks, notes, comments, tags and the text inside attachments.
// Ranked (title beats body), forgiving (word starts, small typos), with phrases and a few operators:
//   "exact phrase"   -word   tag:x   notebook:x   project:x   @label   in:tasks   in:notes   is:done   has:file
import { store } from './store.js';
import * as M from './model.js';
import { h, stripHtml } from './util.js';
import { docText, liveDocs } from './writing.js';

const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const bodyCache = new Map();
function noteBody(n) {
  const c = bodyCache.get(n.id);
  if (c && c.at === n.updatedAt) return c.text;
  const text = stripHtml((n.body || '').replace(/<(\/?(div|p|li|h\d|tr|br|td|th))\b/gi, ' <$1')).replace(/\s+/g, ' ').trim();
  bodyCache.set(n.id, { at: n.updatedAt, text });
  return text;
}
const attText = n => { const out = []; for (const a of n.attachments || []) { const o = store.get('ocr', a.id); if (o?.text) out.push({ name: a.name, text: o.text }); } return out; };

export function parseQuery(q) {
  const out = { terms: [], not: [], ops: {} };
  const re = /(-)?(?:(tag|notebook|nb|project|label|in|type|is|has):)?(?:"([^"]+)"|(\S+))/gi;
  let m;
  while ((m = re.exec(q))) {
    let val = norm(m[3] || m[4]), op = (m[2] || '').toLowerCase();
    if (!op && !m[3] && val.length > 1 && val[0] === '@') { op = 'label'; val = val.slice(1); }
    if (!val) continue;
    if (op) (out.ops[op === 'nb' ? 'notebook' : op === 'type' ? 'in' : op] ||= []).push(val);
    else (m[1] ? out.not : out.terms).push(val);
  }
  return out;
}
function editWithin(a, b, max) { // edit distance where swapping two neighbouring letters counts as one mistake
  if (Math.abs(a.length - b.length) > max) return false;
  let prev2 = null, prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]; let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (prev2 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) cur[j] = Math.min(cur[j], prev2[j - 2] + 1);
      if (cur[j] < best) best = cur[j];
    }
    if (best > max) return false;
    prev2 = prev; prev = cur;
  }
  return prev[b.length] <= max;
}
const isWord = c => !!c && /[a-z0-9]/.test(c);
/** How well one search term matches one piece of text: 1 whole word, .8 start of a word, .5 inside a word, .3 near-miss spelling. */
function termScore(term, text, fuzzy) {
  let best = 0, i = -1;
  while ((i = text.indexOf(term, i + 1)) >= 0) {
    const startOk = !isWord(text[i - 1]), endOk = !isWord(text[i + term.length]);
    const s = startOk && endOk ? 1 : startOk ? 0.8 : 0.5;
    if (s > best) best = s;
    if (best === 1) break;
  }
  if (!best && fuzzy && term.length >= 4 && !term.includes(' ')) {
    const max = term.length >= 8 ? 2 : 1;
    for (const w of text.split(/[^a-z0-9]+/)) if (w.length >= 3 && Math.abs(w.length - term.length) <= max && editWithin(term, w, max)) return 0.3;
  }
  return best;
}
const WEIGHT = { title: 10, meta: 5, body: 3, att: 2 };

export function docs() {
  const out = [];
  const comments = new Map();
  for (const c of store.all('comments')) comments.set(c.taskId, (comments.get(c.taskId) || '') + ' ' + c.text);
  for (const t of store.all('tasks')) out.push({ kind: 'task', item: t, title: t.content, meta: (t.labels || []).map(l => '@' + l).join(' ') + ' ' + M.projectName(t.projectId), body: (t.description || '') + (comments.get(t.id) || ''), atts: [], when: t.updatedAt });
  for (const n of M.liveNotes()) out.push({ kind: 'note', item: n, title: n.title || 'Untitled', meta: (n.tags || []).join(' ') + ' ' + (store.get('notebooks', n.notebookId)?.name || '') + ' ' + (n.attachments || []).map(a => a.name).join(' '), body: noteBody(n), atts: attText(n), when: n.updatedAt });
  for (const w of liveDocs()) out.push({ kind: 'doc', item: w, title: w.title || 'Untitled', meta: (w.kind || '') + ' writing ' + (w.meta?.course || ''), body: docBody(w), atts: [], when: w.updatedAt });
  return out;
}
const docCache = new Map();
function docBody(w) { const c = docCache.get(w.id); if (c && c.at === w.updatedAt) return c.text; const text = docText(w); docCache.set(w.id, { at: w.updatedAt, text }); return text; }
function passesOps(d, ops) {
  const any = (list, f) => !list || list.some(f);
  if (ops.in && !ops.in.some(v => v.startsWith(d.kind) || (d.kind === 'doc' && /^(writ|paper|sermon)/.test(v)))) return false;
  if (d.kind === 'doc') return !(ops.tag || ops.notebook || ops.label || ops.project || ops.is || ops.has);
  if (d.kind === 'task') {
    const t = d.item;
    if (ops.tag || ops.notebook) return false;
    if (!any(ops.label, v => (t.labels || []).some(l => norm(l).startsWith(v)))) return false;
    if (!any(ops.project, v => norm(M.projectName(t.projectId)).includes(v))) return false;
    if (ops.is && !ops.is.every(v => (v === 'done' || v === 'completed') ? !!t.completedAt : v === 'open' ? !t.completedAt : true)) return false;
    if (ops.has) return false;
  } else {
    const n = d.item;
    if (ops.label || ops.project || ops.is) return false;
    if (!any(ops.tag, v => (n.tags || []).some(x => norm(x).startsWith(v)))) return false;
    if (!any(ops.notebook, v => norm(store.get('notebooks', n.notebookId)?.name).includes(v))) return false;
    if (ops.has && !(n.attachments || []).length) return false;
  }
  return true;
}
function scoreDoc(d, q, fuzzy) {
  const f = { title: norm(d.title), meta: norm(d.meta), body: norm(d.body), att: norm(d.atts.map(a => a.text).join(' ')) };
  for (const x of q.not) if (f.title.includes(x) || f.meta.includes(x) || f.body.includes(x) || f.att.includes(x)) return 0;
  let total = 0; const where = new Set();
  for (const term of q.terms) {
    let best = 0, bestField = null;
    for (const k of ['title', 'meta', 'body', 'att']) { const s = termScore(term, f[k], fuzzy) * WEIGHT[k]; if (s > best) { best = s; bestField = k; } }
    if (!best) return 0;
    total += best; where.add(bestField);
  }
  if (!q.terms.length) total = 1;
  const ageDays = (Date.now() - (d.when || 0)) / 864e5;
  total += Math.max(0, 1 - ageDays / 365);
  if (d.kind === 'task' && d.item.completedAt) total *= 0.6;
  return { score: total, where };
}
/** Returns ranked results: [{kind, item, score, where, title, body, atts}] */
export function search(query, opts = {}) {
  const q = parseQuery(query);
  if (!q.terms.length && !q.not.length && !Object.keys(q.ops).length) return { q, results: [], fuzzy: false };
  const pool = docs().filter(d => (!opts.kind || d.kind === opts.kind) && (!opts.filter || opts.filter(d.item)) && passesOps(d, q.ops));
  const run = fuzzy => pool.map(d => { const r = scoreDoc(d, q, fuzzy); return r ? { ...d, ...r } : null; }).filter(Boolean).sort((a, b) => b.score - a.score);
  let results = run(false), fuzzy = false;
  if (results.length < 3 && q.terms.some(t => t.length >= 4)) { const loose = run(true); if (loose.length > results.length) { results = loose; fuzzy = true; } }
  return { q, results, fuzzy };
}

/** Text with the matching words wrapped in <mark>. */
export function highlight(text, terms) {
  const low = text.toLowerCase(), marks = [];
  for (const t of terms) { let i = -1; while ((i = low.indexOf(t, i + 1)) >= 0) marks.push([i, i + t.length]); }
  if (!marks.length) return [text];
  marks.sort((a, b) => a[0] - b[0]);
  const out = []; let pos = 0;
  for (const [a, b] of marks) { if (a < pos) continue; if (a > pos) out.push(text.slice(pos, a)); out.push(h('mark', null, text.slice(a, b))); pos = b; }
  if (pos < text.length) out.push(text.slice(pos));
  return out;
}
/** A short excerpt around the first match, saying where it was found. */
export function excerpt(r, terms) {
  const cut = (text, label) => {
    const low = text.toLowerCase(); let at = -1;
    for (const t of terms) { const i = low.indexOf(t); if (i >= 0 && (at < 0 || i < at)) at = i; }
    if (at < 0) return null;
    const start = Math.max(0, at - 40), piece = (start ? '…' : '') + text.slice(start, at + 110).replace(/\s+/g, ' ') + (at + 110 < text.length ? '…' : '');
    return [label && h('em', null, label + ' '), ...highlight(piece, terms)];
  };
  return cut(r.body, '') || r.atts.map(a => cut(a.text, `In ${a.name}:`)).find(Boolean) || [r.body.slice(0, 110)];
}

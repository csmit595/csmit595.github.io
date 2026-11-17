// Writing: a word processor for papers and sermons, kept apart from notes and tasks.
// Documents have real footnotes, Turabian citations from a list of sources, an automatic bibliography,
// a paged preview for printing, and export to a Word file.
import { h, fill, uid, esc, sanitize, debounce, stripHtml } from './util.js';
import { store } from './store.js';
import * as C from './cite.js';
import { icon, btn, iconBtn, modal, confirmDlg, toast, menu, isMobile } from './ui.js';
import { installTools, importDocx } from './writing-tools.js';

const go = hash => { location.hash = hash; };
let mounted = null, listQ = '';
const KINDS = { paper: 'Turabian paper (BJU Seminary)', sermon: 'Sermon', other: 'Document' };
const TEMPLATES = {
  paper: { title: '', body: '<p><br></p>', meta: { titlePage: true, bibliography: true, spacing: 2, fontSize: 12, pageNum: 'bottom', place: 'Greenville, South Carolina' } },
  sermon: { title: '', body: '<h3>Passage</h3><p><br></p><h3>Introduction</h3><p><br></p><h3>Exposition</h3><p><br></p><h3>Application</h3><p><br></p><h3>Conclusion</h3><p><br></p>', meta: { titlePage: false, bibliography: false, spacing: 1.5, fontSize: 14, pageNum: 'bottom' } },
  other: { title: '', body: '<p><br></p>', meta: { titlePage: false, bibliography: false, spacing: 1.5, fontSize: 12, pageNum: 'bottom' } },
};
export const liveDocs = () => store.all('docs').filter(d => !d.trashed);
const metaOf = d => ({ ...TEMPLATES[d.kind || 'other'].meta, ...(d.meta || {}) });
const fnOrder = html => [...String(html || '').matchAll(/data-fn="([^"]+)"/g)].map(m => m[1]);
const words = text => (text.trim().match(/\S+/g) || []).length;

/** Footnotes in the order they appear, with citation text worked out (full the first time, short after). */
export function computeNotes(doc, order = fnOrder(doc.body), fns = doc.footnotes || {}) {
  const seen = new Set();
  return order.map((id, i) => {
    const f = fns[id] || {};
    let html = f.html || '';
    if (f.cite) {
      const s = store.get('sources', f.cite.sourceId);
      if (!s) html = '<i>[source was deleted]</i>';
      else { html = seen.has(s.id) ? C.shortNote(s, f.cite.pages) : C.fullNote(s, f.cite.pages); seen.add(s.id); if (f.cite.suffix) html += ' ' + esc(f.cite.suffix); }
    }
    return { id, n: i + 1, html, cite: f.cite || null };
  });
}
export function bibliographyFor(doc, order = fnOrder(doc.body), fns = doc.footnotes || {}) {
  const ids = new Set(order.map(id => fns[id]?.cite?.sourceId).filter(Boolean));
  for (const id of metaOf(doc).extraSources || []) ids.add(id);
  return C.bibliography([...ids].map(id => store.get('sources', id)).filter(Boolean));
}
/** Plain text of a document (body plus footnotes), for search. */
export function docText(doc) {
  const body = stripHtml(String(doc.body || '').replace(/<(\/?(div|p|li|h\d|tr|br|td|th|blockquote))\b/gi, ' <$1'));
  const notes = computeNotes(doc).map(n => stripHtml(n.html)).join(' ');
  return (body + ' ' + notes).replace(/\s+/g, ' ').trim();
}

export function leaveWriting() { mounted?.save(); mounted?.destroy?.(); mounted = null; }
export function renderWriting(route, main, info = {}) {
  if (route.view === 'doc') {
    if (mounted && mounted.id === route.id && main.querySelector('.writer')) { if (info.remote && !main.contains(document.activeElement)) mountEditor(main, route.id); return; }
    leaveWriting(); main.className = 'writer-main'; fill(main); mountEditor(main, route.id); return;
  }
  leaveWriting(); main.className = ''; fill(main);
  if (route.view === 'sources') return viewSources(main);
  viewList(main);
}

// ---- document list ---------------------------------------------------------------------
function newDoc(kind) {
  const t = TEMPLATES[kind];
  const d = store.put('docs', { title: '', kind, body: t.body, footnotes: {}, meta: { ...t.meta, monthYear: new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) }, trashed: false });
  go('#/doc/' + d.id);
}
function viewList(main) {
  const search = h('input', { class: 'field', type: 'search', placeholder: 'Filter documents by title', value: listQ, oninput: () => { listQ = search.value; draw(); } });
  const rows = h('div', { class: 'rows' });
  const docxIn = h('input', { type: 'file', accept: '.docx', hidden: true, onchange: async () => {
    const f = docxIn.files[0]; docxIn.value = ''; if (!f) return;
    try { toast('Reading the Word file…'); const r = await importDocx(f); toast(`Imported with ${r.notes} footnote${r.notes === 1 ? '' : 's'}. Check the formatting; set the kind of document in Page setup.`, null, null, 8000); go('#/doc/' + r.doc.id); }
    catch (e) { console.error(e); toast(navigator.onLine ? 'That file could not be read as a Word document.' : 'Opening Word files needs one online visit to download the reader.'); }
  } });
  const draw = () => {
    const q = listQ.toLowerCase().trim();
    const docs = liveDocs().filter(d => !q || (d.title || '').toLowerCase().includes(q)).sort((a, b) => b.updatedAt - a.updatedAt);
    fill(rows, docs.map(d => h('div', { class: 'rowlink' }, icon('edit', 16),
      h('a', { class: 'grow', href: '#/doc/' + d.id }, d.title || 'Untitled', h('small', null, `${KINDS[d.kind] || 'Document'} · ${words(stripHtml(d.body || ''))} words · edited ${new Date(d.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`)),
      iconBtn('more', 'Document options', e => menu(e.currentTarget, [
        { label: 'Duplicate', icon: 'note', onclick: () => { const { id, createdAt, updatedAt, ...rest } = d; store.put('docs', { ...structuredClone(rest), title: (d.title || 'Untitled') + ' (copy)' }); draw(); } },
        { label: 'Delete', icon: 'trash', danger: true, onclick: async () => { if (await confirmDlg(`Delete "${d.title || 'Untitled'}"?`)) { store.patch('docs', d.id, { trashed: true }); toast('Document deleted', 'Undo', () => { store.patch('docs', d.id, { trashed: false }); draw(); }, 8000); draw(); } } },
      ])))),
    !docs.length && h('div', { class: 'empty' }, h('strong', null, q ? 'No documents match' : 'No documents yet'), h('p', null, q ? '' : 'Start a Turabian paper or a sermon manuscript.')));
  };
  main.append(h('header', { class: 'vhead' }, h('div', null, h('h1', null, 'Writing'), h('div', { class: 'sub' }, 'Papers, sermons and other long documents')),
    h('div', { class: 'row' }, h('a', { class: 'btn', href: '#/sources' }, icon('book', 16), 'Sources'), docxIn, btn('Open a Word file', () => docxIn.click(), '', 'note'),
      btn('New', e => menu(e.currentTarget, [{ label: 'Turabian paper (BJU Seminary)', icon: 'edit', onclick: () => newDoc('paper') }, { label: 'Sermon manuscript', icon: 'edit', onclick: () => newDoc('sermon') }, { label: 'Blank document', icon: 'edit', onclick: () => newDoc('other') }]), 'primary', 'plus'))),
    search, rows);
  draw();
}

// ---- sources -----------------------------------------------------------------------------
export function editSource(src, onSaved) {
  modal(close => {
    const s = { type: 'book', ...(src || {}) };
    const form = h('div', { class: 'form' }), preview = h('div', { class: 'cite-preview' });
    const type = h('select', { class: 'field', onchange: () => { s.type = type.value; draw(); } }, Object.entries(C.TYPES).map(([k, v]) => h('option', { value: k }, v.label)));
    type.value = s.type;
    const show = () => { fill(preview, h('div', { class: 'sub' }, 'First footnote'), h('div', { html: C.fullNote(s, '00') }), h('div', { class: 'sub' }, 'Later footnotes'), h('div', { html: C.shortNote(s, '00') }), h('div', { class: 'sub' }, 'Bibliography'), h('div', { html: C.bibEntry(s) })); };
    const draw = () => {
      fill(form, h('label', null, 'Kind of source', type), [...C.TYPES[s.type].fields, 'short'].map(f => { const inp = h('input', { class: 'field', value: s[f] || '', placeholder: C.FIELD_LABELS[f][1], oninput: () => { s[f] = inp.value; show(); } }); return h('label', null, C.fieldLabel(s.type, f), inp); }));
      show();
    };
    draw();
    return h('div', null, h('div', { class: 'src-grid' }, form, preview),
      h('div', { class: 'row end' }, src?.id && btn('Delete', async () => { if (await confirmDlg('Delete this source? Footnotes that cite it will show "[source was deleted]".')) { store.remove('sources', src.id); close(); onSaved?.(null); } }, 'danger'), btn('Cancel', close),
        btn('Save', () => { if (!(s.title || '').trim()) return toast('A source needs at least a title'); const saved = store.put('sources', s); close(); onSaved?.(saved); }, 'primary')));
  }, { title: src?.id ? 'Edit source' : 'New source', cls: 'wide' });
}
function viewSources(main) {
  const search = h('input', { class: 'field', type: 'search', placeholder: 'Filter sources' });
  const rows = h('div', { class: 'rows' });
  const draw = () => {
    const q = search.value.toLowerCase().trim();
    const list = store.all('sources').filter(s => !q || JSON.stringify(s).toLowerCase().includes(q)).sort((a, b) => C.sortKey(a).localeCompare(C.sortKey(b)));
    fill(rows, list.map(s => h('button', { class: 'rowlink', onclick: () => editSource(s, draw) }, icon('book', 16), h('span', { class: 'grow' }, h('span', { html: C.bibEntry(s) }), h('small', null, C.TYPES[s.type]?.label || '')))),
      !list.length && h('div', { class: 'empty' }, h('strong', null, 'No sources yet'), h('p', null, 'Add each book or article once. Steward writes the footnotes and bibliography from it.')));
  };
  search.addEventListener('input', draw);
  main.append(h('header', { class: 'vhead' }, h('div', null, h('h1', null, 'Sources'), h('div', { class: 'sub' }, 'Shared by all your documents · formatted to the BJU Seminary style manual (Turabian 9)')),
    h('div', { class: 'row' }, h('a', { class: 'btn', href: '#/writing' }, icon('back', 16), 'Documents'), btn('New source', () => editSource(null, draw), 'primary', 'plus'))), search, rows);
  draw();
}
function pickSource(onPick) {
  modal(close => {
    const input = h('input', { class: 'field', placeholder: 'Find a source by author or title', autofocus: true });
    const pages = h('input', { class: 'field', placeholder: 'Page(s), e.g. 45 or 45-47' });
    const list = h('div', { class: 'rows picker' });
    let chosen = null;
    const draw = () => {
      const q = input.value.toLowerCase().trim();
      const srcs = store.all('sources').filter(s => !q || `${s.authors} ${s.editors} ${s.title} ${s.container}`.toLowerCase().includes(q)).sort((a, b) => C.sortKey(a).localeCompare(C.sortKey(b))).slice(0, 40);
      fill(list, srcs.map(s => h('button', { class: 'rowlink' + (chosen === s.id ? ' on' : ''), onclick: () => { chosen = s.id; draw(); pages.focus(); } }, icon('book', 16), h('span', { class: 'grow', html: C.bibEntry(s) }))),
        h('button', { class: 'rowlink', onclick: () => editSource(null, s => { if (s) { chosen = s.id; draw(); pages.focus(); } }) }, icon('plus', 16), 'Add a new source'));
    };
    const ok = () => { if (!chosen) return toast('Choose a source first'); close(); onPick({ sourceId: chosen, pages: pages.value.trim() }); };
    input.addEventListener('input', draw); pages.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); ok(); } });
    draw();
    return h('div', { class: 'form' }, input, list, h('label', null, 'Page cited', pages), h('div', { class: 'row end' }, btn('Cancel', close), btn('Insert citation', ok, 'primary')));
  }, { title: 'Cite a source' });
}

/** Tidy what the browser's editor leaves behind before saving: stray inline styles, empty wrappers, lists nested in paragraphs, duplicated footnote marks. */
export function cleanBody(html) {
  const d = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  for (const el of d.body.querySelectorAll('[style]')) {
    for (const prop of ['text-indent', 'font-size', 'line-height', 'text-align-last', 'caret-color', 'letter-spacing', 'word-spacing', 'white-space', 'orphans', 'widows']) el.style.removeProperty(prop);
    if (/^(rgb\(17, 17, 17\)|rgb\(0, 0, 0\))$/.test(el.style.color)) el.style.removeProperty('color');
    if (/^(rgb\(255, 255, 255\)|transparent|rgba\(0, 0, 0, 0\))$/.test(el.style.backgroundColor)) el.style.removeProperty('background-color');
    if (/Times New Roman/i.test(el.style.fontFamily)) el.style.removeProperty('font-family');
    if (!el.getAttribute('style')?.trim()) el.removeAttribute('style');
  }
  for (const sp of [...d.body.querySelectorAll('span')]) if (!sp.attributes.length) sp.replaceWith(...sp.childNodes);
  const seen = new Set();
  for (const m of d.body.querySelectorAll('sup.fn')) { if (seen.has(m.dataset.fn)) m.remove(); else seen.add(m.dataset.fn); }
  for (const p of [...d.body.querySelectorAll('p')]) if (!p.childNodes.length) p.remove();
  d.body.normalize();
  return d.body.innerHTML;
}

// ---- the editor -------------------------------------------------------------------------------
function mountEditor(main, id) {
  const d0 = store.get('docs', id);
  if (!d0 || d0.trashed) { fill(main, h('div', { class: 'empty' }, h('strong', null, 'Document not found'), h('p', null, h('a', { href: '#/writing' }, 'Back to Writing')))); return; }
  const get = () => store.get('docs', id);
  const fns = structuredClone(d0.footnotes || {});
  let meta = metaOf(d0), dirty = false, lastOrder = '', kind = d0.kind || 'other', T = null;
  const title = h('input', { class: 'wtitle', placeholder: 'Title', value: d0.title || '' });
  const body = h('div', { class: 'wbody', contentEditable: 'true', spellcheck: true, html: sanitize(d0.body || '') || '<p><br></p>' });
  const notesEl = h('div', { class: 'wnotes' }), bibEl = h('div', { class: 'wbib' }), count = h('span', { class: 'sub wcount' }), tp = h('button', { class: 'wtp', type: 'button', onclick: () => setup() });
  const order = () => [...body.querySelectorAll('sup.fn')].map(s => s.dataset.fn);
  const save = () => {
    if (!dirty) return; dirty = false;
    const keep = {}; for (const k of order()) if (fns[k]) keep[k] = fns[k];
    if (get()) store.patch('docs', id, { title: title.value.trim(), kind, body: cleanBody(body.innerHTML), footnotes: keep, comments: T ? T.comments() : (d0.comments || {}), meta });
  };
  const queue = debounce(save, 800);
  const touch = () => { dirty = true; queue(); };
  const sheet = h('div', { class: 'wsheet' });
  const applyLook = () => { sheet.style.setProperty('--sp', meta.spacing); sheet.style.setProperty('--fs', meta.fontSize + 'pt'); sheet.classList.toggle('paper', kind === 'paper');
    fill(tp, meta.titlePage ? [h('b', null, title.value || 'Title'), h('span', { class: 'gap' }), h('span', null, 'by'), h('b', null, meta.author || 'Your name'), h('span', { class: 'gap' }), h('span', null, 'A Paper Submitted to the Faculty of BJU Seminary'), h('span', null, 'in Fulfillment of the Requirements for the Degree of'), h('span', null, meta.degree || '<Degree Name>'), h('span', { class: 'gap' }), h('span', null, meta.place || 'Greenville, South Carolina'), h('span', null, meta.monthYear || 'Month Year'), h('small', null, 'Title page · click to edit')] : h('small', null, 'No title page · click for page setup')); };

  // selection helpers
  let saved = null;
  const keep = () => { const s = getSelection(); if (s.rangeCount && body.contains(s.anchorNode)) saved = s.getRangeAt(0).cloneRange(); };
  const restore = () => { body.focus(); if (saved) { const s = getSelection(); s.removeAllRanges(); s.addRange(saved); } };
  for (const ev of ['keyup', 'pointerup', 'blur']) body.addEventListener(ev, keep);
  const cmd = (c, v) => { T?.mark(); restore(); document.execCommand(c, false, v); touch(); keep(); syncStyle(); T?.mark(); };
  const insert = html => { T?.mark(); restore(); document.execCommand('insertHTML', false, html); touch(); keep(); T?.mark(); };

  // footnotes
  const drawNotes = () => {
    const ord = order(); lastOrder = ord.join(',');
    const notes = computeNotes({}, ord, fns);
    fill(notesEl, notes.length > 0 && h('div', { class: 'wrule' }), notes.map(n => {
      const row = h('div', { class: 'wnote', dataset: { fn: n.id } }, h('button', { class: 'wnum', type: 'button', title: 'Go to this footnote in the text', onclick: () => { const m = body.querySelector(`sup.fn[data-fn="${n.id}"]`); m?.scrollIntoView({ block: 'center', behavior: 'smooth' }); m?.classList.add('flash'); setTimeout(() => m?.classList.remove('flash'), 1200); } }, String(n.n)));
      if (n.cite) {
        const pg = h('input', { class: 'wpg', placeholder: 'page', value: n.cite.pages || '', title: 'Page cited', onchange: () => { fns[n.id].cite.pages = pg.value.trim(); touch(); drawNotes(); } });
        const sfx = h('input', { class: 'wsfx', placeholder: 'add a comment after the citation', value: n.cite.suffix || '', onchange: () => { fns[n.id].cite.suffix = sfx.value.trim(); touch(); drawNotes(); } });
        row.append(h('div', { class: 'grow' }, h('div', { class: 'wtext', html: n.html }), h('div', { class: 'wtools' }, pg, sfx,
          h('button', { class: 'linkbtn', type: 'button', onclick: () => { const s = store.get('sources', n.cite.sourceId); if (s) editSource(s, drawNotes); } }, 'Edit source'),
          h('button', { class: 'linkbtn', type: 'button', title: 'Turn this into ordinary text you can edit freely', onclick: () => { fns[n.id] = { html: n.html }; touch(); drawNotes(); } }, 'Edit as text'))));
      } else {
        const ed = h('div', { class: 'wtext', contentEditable: 'true', html: sanitize(n.html), 'data-placeholder': 'Footnote text' });
        ed.addEventListener('input', () => { fns[n.id] = { html: ed.innerHTML }; touch(); });
        ed.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); restore(); } });
        row.append(ed);
      }
      return row;
    }));
    const bib = meta.bibliography ? bibliographyFor({ meta }, ord, fns) : [];
    fill(bibEl, bib.length > 0 && [h('div', { class: 'wbib-h' }, 'Bibliography'), bib.map(b => h('p', { class: 'wbib-e', html: b })), h('div', { class: 'sub' }, 'Built automatically from the sources you cite. It goes on its own page when printed.')]);
  };
  const addNote = data => {
    T?.mark();
    const nid = uid(); fns[nid] = data;
    restore();
    const mark = h('sup', { class: 'fn', contentEditable: 'false' }); mark.dataset.fn = nid;
    const sel = getSelection(), r = sel.rangeCount && body.contains(sel.anchorNode) ? sel.getRangeAt(0) : null;
    if (r) { r.deleteContents(); r.insertNode(mark); r.setStartAfter(mark); r.collapse(true); sel.removeAllRanges(); sel.addRange(r); keep(); }
    else (body.querySelector('p:last-of-type') || body).append(mark);
    drawNotes(); touch(); T?.mark();
    if (!data.cite) setTimeout(() => notesEl.querySelector(`[data-fn="${nid}"] .wtext`)?.focus(), 30);
  };
  const footnote = () => { keep(); addNote({ html: '' }); };
  const cite = () => { keep(); pickSource(c => addNote({ cite: c })); };

  // paper setup
  const setup = () => modal(close => {
    const f = (label, key, ph = '') => { const inp = h('input', { class: 'field', value: meta[key] || '', placeholder: ph }); inp.dataset.key = key; return h('label', null, label, inp); };
    const chk = (label, key) => { const c = h('input', { type: 'checkbox', checked: !!meta[key] }); c.dataset.key = key; return h('label', { class: 'inline' }, c, ' ' + label); };
    const sel = (label, key, opts) => { const s = h('select', { class: 'field' }, opts.map(([v, l]) => h('option', { value: v }, l))); s.value = String(meta[key]); s.dataset.key = key; return h('label', null, label, s); };
    const kindSel = h('select', { class: 'field' }, Object.entries(KINDS).map(([v, l]) => h('option', { value: v }, l))); kindSel.value = kind;
    const form = h('div', { class: 'form' }, h('label', null, 'Kind of document', kindSel), chk('Include a title page', 'titlePage'), f('Your name (first name, middle initial, last name; no titles)', 'author', 'Charles E. Smith'), f('Degree', 'degree', 'Master of Divinity'), f('City and state', 'place', 'Greenville, South Carolina'), f('Month and year', 'monthYear', 'November 2026'),
      chk('Add a bibliography of the sources cited', 'bibliography'),
      sel('Line spacing', 'spacing', [['2', 'Double (BJU papers)'], ['1.5', 'One and a half'], ['1.15', 'Single']]), sel('Text size', 'fontSize', [['12', '12 point (BJU papers)'], ['14', '14 point'], ['16', '16 point'], ['11', '11 point']]),
      sel('Page numbers', 'pageNum', [['bottom', 'Bottom center (BJU papers)'], ['top', 'Top right'], ['none', 'None']]),
      kind === 'paper' && h('p', { class: 'sub' }, 'Papers follow the BJU Seminary Style Manual for Turabian Papers (updated 2024): Times New Roman 12 point, body at exactly 24 points, footnotes 10 point, 1-inch margins (2 inches at the top of the title page), title repeated in bold on page 1, page numbers bottom center. The manual asks for a table of contents only in papers over 25 pages; add that in Word.'));
    return h('div', null, form, h('div', { class: 'row end' }, btn('Cancel', close), btn('Save', () => {
      for (const el of form.querySelectorAll('[data-key]')) { const k = el.dataset.key; meta = { ...meta, [k]: el.type === 'checkbox' ? el.checked : (k === 'spacing' || k === 'fontSize') ? +el.value : el.value.trim() }; }
      kind = kindSel.value; applyLook(); drawNotes(); touch(); close();
    }, 'primary')));
  }, { title: 'Page setup' });

  // toolbar
  const style = h('select', { class: 'field slim wstyle', 'aria-label': 'Paragraph style', onpointerdown: keep, onchange: () => { const v = style.value; cmd('formatBlock', v); } },
    [['P', 'Normal text'], ['H1', 'Main heading'], ['H2', 'Subheading'], ['H3', 'Sub-subheading'], ['BLOCKQUOTE', 'Block quote']].map(([v, l]) => h('option', { value: v }, l)));
  const syncStyle = () => { const n = getSelection().anchorNode; const el = (n?.nodeType === 1 ? n : n?.parentElement)?.closest?.('h1,h2,h3,blockquote,p,div'); if (el && body.contains(el)) style.value = ['H1', 'H2', 'H3', 'BLOCKQUOTE'].includes(el.tagName) ? el.tagName : 'P'; };
  const tb = (label, tip, fn, cls = '') => h('button', { type: 'button', class: 'tb ' + cls, title: tip, 'aria-label': tip, onpointerdown: e => e.preventDefault(), onclick: fn }, label);
  const toolbar = h('div', { class: 'toolbar wbar' }, iconBtn('back', 'Back to documents', () => { save(); go('#/writing'); }), style, h('span', { class: 'sep' }),
    tb('B', 'Bold (Cmd+B)', () => cmd('bold'), 'b'), tb('I', 'Italic (Cmd+I)', () => cmd('italic'), 'i'), tb('U', 'Underline (Cmd+U)', () => cmd('underline'), 'u'), h('span', { class: 'sep' }),
    tb('⇤', 'Align left', () => cmd('justifyLeft')), tb('↔', 'Center', () => cmd('justifyCenter')), h('span', { class: 'sep' }),
    tb('•', 'Bulleted list', () => T.list('insertUnorderedList')), tb('1.', 'Numbered list', () => T.list('insertOrderedList')), tb('⇥', 'Indent a list item (Tab)', () => T.dent(1)), tb('⇤', 'Outdent a list item (Shift+Tab)', () => T.dent(-1)), h('span', { class: 'sep' }),
    tb('Footnote', 'Insert a footnote (Cmd+Option+F)', footnote, 'wide'), tb('Cite', 'Cite a source in a footnote (Cmd+Shift+C)', cite, 'wide'),
    tb('▦', 'Table', () => insert('<table><tbody>' + '<tr><td><br></td><td><br></td><td><br></td></tr>'.repeat(3) + '</tbody></table><p><br></p>')),
    tb('⤓', 'Page break', () => insert('<hr class="pagebreak"><p><br></p>')), h('span', { class: 'sep' }), tb('↶', 'Undo (Cmd+Z)', () => T.undo()), tb('↷', 'Redo (Cmd+Shift+Z)', () => T.redo()), h('span', { class: 'sep', id: 'wtools-slot' }),
    h('span', { class: 'grow' }), count,
    btn('Page setup', setup, 'tiny'), btn('Preview and print', () => { save(); preview(get()); }, 'tiny'), btn('Word file', () => { save(); exportWord(get()); }, 'tiny primary'));

  body.addEventListener('input', () => { touch(); if (order().join(',') !== lastOrder) drawNotes(); updateCount(); });
  body.addEventListener('keyup', syncStyle); body.addEventListener('pointerup', syncStyle);
  body.addEventListener('click', e => { const m = e.target.closest?.('sup.fn'); if (m) { const row = notesEl.querySelector(`[data-fn="${m.dataset.fn}"]`); row?.scrollIntoView({ block: 'center', behavior: 'smooth' }); row?.classList.add('flash'); setTimeout(() => row?.classList.remove('flash'), 1200); } });
  body.addEventListener('keydown', e => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.altKey && e.code === 'KeyF') { e.preventDefault(); footnote(); }
    else if (mod && e.shiftKey && e.code === 'KeyC') { e.preventDefault(); cite(); }
    else if (e.key === 'Tab') { e.preventDefault(); const n = getSelection().anchorNode; if ((n?.nodeType === 1 ? n : n?.parentElement)?.closest?.('li')) { keep(); T.dent(e.shiftKey ? -1 : 1); } }
  });
  body.addEventListener('paste', e => { // paste as clean text with paragraphs, so pasted web formatting cannot break the paper's layout
    const html = e.clipboardData?.getData('text/html'), text = e.clipboardData?.getData('text/plain');
    if (!html && !text) return; e.preventDefault();
    let out;
    if (html) { const doc = new DOMParser().parseFromString(sanitize(html), 'text/html'); doc.querySelectorAll('[style],[class],[id]').forEach(n => { n.removeAttribute('style'); n.removeAttribute('class'); n.removeAttribute('id'); }); doc.querySelectorAll('span,font').forEach(n => n.replaceWith(...n.childNodes)); doc.querySelectorAll('img,svg,button,input').forEach(n => n.remove()); out = doc.body.innerHTML; }
    else out = text.split(/\n{2,}/).map(p => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
    T?.mark(); document.execCommand('insertHTML', false, out); touch(); T?.mark();
  });
  title.addEventListener('input', () => { touch(); applyLook(); });
  title.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); body.focus(); } });
  const updateCount = () => { count.textContent = `${words(stripHtml(body.innerHTML.replace(/<(\/?(div|p|li|h\d|tr|br|td|th|blockquote))\b/gi, ' <$1')))} words`; };

  fill(sheet, tp, title, body, notesEl, bibEl);
  T = installTools({ body, fns, id, doc: d0, sheet, title, meta: () => meta, touch, keep, restore, drawNotes: () => drawNotes(), updateCount: () => updateCount() });
  const slot = toolbar.querySelector('#wtools-slot'); slot.after(T.buttons.fontSel, T.buttons.painterBtn, T.buttons.find, T.buttons.more, T.buttons.colorIn);
  count.after(T.buttons.cmCount); count.title = 'Word count details'; count.classList.add('clicky'); count.addEventListener('click', () => T.countDlg());
  fill(main, h('div', { class: 'writer' }, toolbar, T.bars, h('div', { class: 'wscroll' }, sheet)));
  try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch {}
  applyLook(); drawNotes(); updateCount();
  mounted = { id, save, destroy: () => T.destroy() };
  if (!d0.title && !isMobile()) title.focus();
}
window.addEventListener('pagehide', () => mounted?.save());
document.addEventListener('visibilitychange', () => { if (document.hidden) mounted?.save(); });

// ---- paged preview and printing ---------------------------------------------------------------
export function buildPrintHtml(doc) {
  const meta = metaOf(doc), notes = computeNotes(doc), bib = meta.bibliography ? bibliographyFor(doc) : [];
  const dom = new DOMParser().parseFromString(`<body>${sanitize(doc.body || '')}</body>`, 'text/html');
  dom.querySelectorAll('sup.fn').forEach(m => { const n = notes.find(x => x.id === m.dataset.fn); if (!n) return m.remove(); const wrap = dom.createElement('span'); wrap.innerHTML = `<sup class="call">${n.n}</sup><span class="footnote"><span class="fnum">${n.n}</span> ${n.html}</span>`; m.replaceWith(...wrap.childNodes); });
  dom.querySelectorAll('hr.pagebreak').forEach(x => { const b = dom.createElement('div'); b.className = 'pagebreak'; x.replaceWith(b); });
  dom.querySelectorAll('[contenteditable]').forEach(x => x.removeAttribute('contenteditable'));
  const fs = meta.fontSize, lh = +(fs * meta.spacing).toFixed(2), one = fs; // exact line heights, as the BJU manual requires ("exactly 24 point")
  const num = meta.pageNum === 'top' ? `@top-right { content: counter(page); font: ${fs}pt "Times New Roman", Times, serif; }` : meta.pageNum === 'none' ? '' : `@bottom-center { content: counter(page); font: ${fs}pt "Times New Roman", Times, serif; }`;
  const css = `
@page { size: 8.5in 11in; margin: 1in; ${num} @footnote { float: bottom; margin-top: 12pt; } }
@page title { margin: 2in 1in 1in 1in; @bottom-center { content: none; } @top-right { content: none; } }
html, body { margin: 0; }
body { font: ${fs}pt/${lh}pt "Times New Roman", Times, serif; color: #000; text-align: left; hyphens: manual; }
p, .docbody > div { margin: 0; text-indent: 0.5in; orphans: 2; widows: 2; }
h1, h2, h3 { font-size: inherit; line-height: inherit; font-weight: normal; margin: ${one}pt 0 0; break-after: avoid; text-indent: 0; }
h1 { text-align: center; font-style: italic; } h2 { text-align: center; } h3 { text-align: left; font-style: italic; }
blockquote { margin: ${one}pt 0 ${one}pt 0.5in; line-height: ${one}pt; text-indent: 0; } blockquote p { text-indent: 0; margin-bottom: ${one}pt; } blockquote p:last-child { margin-bottom: 0; }
ul, ol { margin: 0; padding-left: 1in; } li { text-indent: 0; }
ol.outline { list-style: upper-roman; } ol.outline ol { list-style: upper-alpha; padding-left: 0.5in; } ol.outline ol ol { list-style: decimal; } ol.outline ol ol ol { list-style: lower-alpha; }
table { border-collapse: collapse; width: 100%; line-height: ${one}pt; margin: ${one * 2}pt 0; } td, th { border: 0.75pt solid #000; padding: 3pt 5pt; text-indent: 0; vertical-align: top; }
.pagebreak { break-after: page; }
sup.call { font-size: 0.7em; line-height: 0; }
.footnote { float: footnote; font-size: 10pt; line-height: 12pt; text-indent: 0.5in; text-align: left; font-weight: normal; font-style: normal; display: block; margin-bottom: 12pt; }
.footnote i { font-style: italic; } .footnote .fnum { font-size: 0.7em; vertical-align: super; line-height: 0; }
[data-footnote-call]::after { content: none !important; } .footnote::marker, [data-footnote-marker]::marker { content: none !important; } [data-footnote-marker] { list-style: none; }
.pagedjs_footnote_inner_content::before { content: ""; display: block; width: 2in; border-top: 0.75pt solid #000; margin-bottom: 12pt; }
.titlepage { page: title; break-after: page; text-align: center; text-indent: 0; height: 7.9in; display: flex; flex-direction: column; justify-content: space-between; line-height: 24pt; }
.titlepage .tp-title { font-weight: bold; line-height: 12pt; } .titlepage b { font-weight: bold; }
.doctitle { text-align: center; font-weight: bold; text-indent: 0; line-height: ${one}pt; margin-bottom: ${one * 2}pt; }
.docbody { counter-reset: page 1; }
.bib { break-before: page; } .bib .doctitle { margin-bottom: ${one * 2}pt; } .bibentry { text-indent: -0.5in; margin: 0 0 ${one}pt 0.5in; line-height: ${one}pt; }
@media screen { body { background: #8a8a8a; } .pagedjs_pages { padding: 16px 0; } .pagedjs_page { background: #fff; margin: 0 auto 16px; box-shadow: 0 2px 10px rgba(0,0,0,.4); } }
@media print { .pagedjs_page { margin: 0; box-shadow: none; } }`;
  const tpHtml = meta.titlePage ? `<section class="titlepage"><div class="tp-title">${esc(doc.title || 'Untitled')}</div><div>by<br><b>${esc(meta.author || '')}</b></div><div>A Paper Submitted to<br>the Faculty of BJU Seminary<br>in Fulfillment of the Requirements for the Degree of<br>${esc(meta.degree || '')}</div><div>${esc(meta.place || 'Greenville, South Carolina')}<br>${esc(meta.monthYear || '')}</div></section>` : '';
  const head = doc.title ? `<div class="doctitle">${esc(doc.title)}</div>` : '';
  const bibHtml = bib.length ? `<section class="bib"><div class="doctitle">Bibliography</div>${bib.map(b => `<p class="bibentry">${b}</p>`).join('')}</section>` : '';
  const lib = new URL('vendor/paged/paged.polyfill.min.js', document.baseURI).href;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(doc.title || 'Document')}</title><style>${css}</style></head><body>${tpHtml}<section class="docbody">${head}${dom.body.innerHTML}</section>${bibHtml}<script src="${lib}"></scr` + `ipt></body></html>`;
}
function preview(doc) {
  modal(close => {
    const frame = h('iframe', { class: 'wframe', title: 'Print preview' });
    frame.srcdoc = buildPrintHtml(doc);
    return h('div', { class: 'wprev' }, h('div', { class: 'row between' }, h('span', { class: 'sub' }, 'This is how the pages will print. In the print window choose "Save as PDF" to make a PDF, and turn off "Headers and footers".'),
      h('div', { class: 'row' }, btn('Close', close), btn('Print or save as PDF', () => frame.contentWindow.print(), 'primary'))), frame);
  }, { title: 'Preview', cls: 'full' });
}
async function exportWord(doc) {
  try {
    toast('Building the Word file…');
    const { toDocx } = await import('./export-docx.js');
    const blob = await toDocx(doc, { meta: metaOf(doc), notes: computeNotes(doc), bib: metaOf(doc).bibliography ? bibliographyFor(doc) : [] });
    const a = h('a', { href: URL.createObjectURL(blob), download: (doc.title || 'Document').replace(/[\\/:*?"<>|]+/g, ' ').trim() + '.docx' });
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  } catch (e) { console.error(e); toast(navigator.onLine ? 'The Word file could not be built: ' + e.message : 'The Word exporter needs one online visit to download. Try again when connected.'); }
}

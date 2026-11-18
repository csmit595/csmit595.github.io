// Editing tools for the Writing section: undo history, find and replace, extra formatting, format painter,
// table tools, outline numbering, symbols, comments, versions, word count, dictation, read-aloud, curly quotes.
import { canDictate, listen, listeningBar, insertSpoken } from './dictate.js';
import { h, fill, uid, esc, debounce, stripHtml, sanitize } from './util.js';
import { store, settings } from './store.js';
import { icon, btn, iconBtn, modal, confirmDlg, promptDlg, toast, menu } from './ui.js';

const words = t => (t.trim().match(/\S+/g) || []).length;
const SYMBOLS = ['—', '–', '…', '§', '¶', '†', '‡', '•', '©', '°', '′', '″', '“', '”', '‘', '’', '«', '»', '½', '¼', '¾', '×', '÷', '±', '≈', '≠', '≤', '≥', '→', '←',
  'α', 'β', 'γ', 'δ', 'ε', 'ζ', 'η', 'θ', 'ι', 'κ', 'λ', 'μ', 'ν', 'ξ', 'ο', 'π', 'ρ', 'σ', 'ς', 'τ', 'υ', 'φ', 'χ', 'ψ', 'ω', 'Α', 'Β', 'Γ', 'Δ', 'Ε', 'Ζ', 'Η', 'Θ', 'Ι', 'Κ', 'Λ', 'Μ', 'Ν', 'Ξ', 'Ο', 'Π', 'Ρ', 'Σ', 'Τ', 'Υ', 'Φ', 'Χ', 'Ψ', 'Ω',
  'א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ז', 'ח', 'ט', 'י', 'כ', 'ך', 'ל', 'מ', 'ם', 'נ', 'ן', 'ס', 'ע', 'פ', 'ף', 'צ', 'ץ', 'ק', 'ר', 'ש', 'ת'];
const FONTS = ['Times New Roman', 'Georgia', 'Garamond', 'Arial', 'Helvetica', 'Courier New'];

export function installTools(E) {
  const { body, fns, id } = E;
  const comments = structuredClone(E.doc.comments || {});

  // ---- undo history that covers everything, footnotes included -------------------------------
  const caret = () => { const s = getSelection(); if (!s.rangeCount || !body.contains(s.focusNode)) return null; const r = document.createRange(); r.selectNodeContents(body); r.setEnd(s.focusNode, s.focusOffset); return r.toString().length; };
  const setCaret = off => {
    if (off == null) return;
    const w = document.createTreeWalker(body, NodeFilter.SHOW_TEXT); let n, left = off, last = null;
    while ((n = w.nextNode())) { last = n; if (left <= n.data.length) { const s = getSelection(), r = document.createRange(); r.setStart(n, left); r.collapse(true); s.removeAllRanges(); s.addRange(r); return; } left -= n.data.length; }
    if (last) { const s = getSelection(), r = document.createRange(); r.setStart(last, last.data.length); r.collapse(true); s.removeAllRanges(); s.addRange(r); }
  };
  const hist = { stack: [], idx: -1 };
  const snap = () => ({ html: body.innerHTML, fns: JSON.stringify(fns), cm: JSON.stringify(comments), caret: caret() });
  const mark = () => { const s = snap(), top = hist.stack[hist.idx]; if (top && top.html === s.html && top.fns === s.fns && top.cm === s.cm) { if (s.caret != null) top.caret = s.caret; return; } hist.stack.splice(hist.idx + 1); hist.stack.push(s); if (hist.stack.length > 300) hist.stack.shift(); hist.idx = hist.stack.length - 1; };
  const markSoon = debounce(mark, 350);
  const apply = s => {
    body.innerHTML = s.html;
    for (const k of Object.keys(fns)) delete fns[k]; Object.assign(fns, JSON.parse(s.fns));
    for (const k of Object.keys(comments)) delete comments[k]; Object.assign(comments, JSON.parse(s.cm));
    body.focus(); setCaret(s.caret); E.keep(); E.drawNotes(); E.updateCount(); E.touch(); refreshFind();
  };
  const undo = () => { mark(); if (hist.idx > 0) apply(hist.stack[--hist.idx]); };
  const redo = () => { if (hist.idx < hist.stack.length - 1) apply(hist.stack[++hist.idx]); };
  mark();
  body.addEventListener('beforeinput', e => { if (e.inputType === 'historyUndo') { e.preventDefault(); undo(); } else if (e.inputType === 'historyRedo') { e.preventDefault(); redo(); } });
  const run = fn => { mark(); fn(); E.touch(); E.keep(); mark(); };
  const exec = (c, v) => run(() => { E.restore(); document.execCommand('styleWithCSS', false, true); document.execCommand(c, false, v); document.execCommand('styleWithCSS', false, false); });
  const sel = () => { E.restore(); const s = getSelection(); return s.rangeCount && body.contains(s.anchorNode) ? s.getRangeAt(0) : null; };
  /** Wrap the selected text in copies of an element. Works across formatting and paragraph edges (e.g. a triple-click selection). */
  const wrap = make => {
    const r = sel(); if (!r || r.collapsed) return toast('Select some text first'), false;
    const nodes = [], w = document.createTreeWalker(body, NodeFilter.SHOW_TEXT); let n, done = 0;
    while ((n = w.nextNode())) if (n.data.length && r.intersectsNode(n) && !n.parentElement.closest('sup.fn')) nodes.push(n);
    const sc = r.startContainer, so = r.startOffset, ec = r.endContainer, eo = r.endOffset;
    for (let node of nodes) {
      const start = node === sc ? so : 0, end = node === ec ? eo : node.data.length;
      if (end <= start || !node.data.slice(start, end).trim()) continue;
      if (end < node.data.length) node.splitText(end);
      if (start > 0) node = node.splitText(start);
      const el = make(); node.replaceWith(el); el.append(node); done++;
    }
    if (!done) toast('Select some text first');
    return done > 0;
  };

  // ---- find and replace ---------------------------------------------------------------------------
  let matches = [], cur = -1;
  const fIn = h('input', { class: 'field slim', type: 'search', placeholder: 'Find', 'aria-label': 'Find' }), rIn = h('input', { class: 'field slim', placeholder: 'Replace with', 'aria-label': 'Replace with' });
  const fCount = h('span', { class: 'sub fcount' }), caseBox = h('input', { type: 'checkbox', 'aria-label': 'Match case' });
  const findBar = h('div', { class: 'wfind', hidden: true }, fIn, fCount, iconBtn('left', 'Previous match', () => step(-1), 'mini'), iconBtn('right', 'Next match', () => step(1), 'mini'), h('label', { class: 'inline sub' }, caseBox, 'Match case'), rIn,
    btn('Replace', () => replaceOne(), 'tiny'), btn('Replace all', () => replaceAll(), 'tiny'), h('span', { class: 'grow' }), iconBtn('x', 'Close find', () => closeFind(), 'mini'));
  const collect = () => {
    matches = []; const q = fIn.value; if (!q) return;
    const needle = caseBox.checked ? q : q.toLowerCase();
    const w = document.createTreeWalker(body, NodeFilter.SHOW_TEXT); let n;
    while ((n = w.nextNode())) { const hay = caseBox.checked ? n.data : n.data.toLowerCase(); let i = -1; while ((i = hay.indexOf(needle, i + 1)) >= 0) { const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + q.length); matches.push(r); } }
  };
  const paint = () => {
    if (!window.CSS?.highlights || !window.Highlight) return;
    CSS.highlights.delete('steward-find'); CSS.highlights.delete('steward-find-cur');
    if (findBar.hidden || !matches.length) return;
    CSS.highlights.set('steward-find', new Highlight(...matches));
    if (matches[cur]) CSS.highlights.set('steward-find-cur', new Highlight(matches[cur]));
  };
  function refreshFind(keepPos) { if (findBar.hidden) return paint(); collect(); if (!keepPos || cur >= matches.length) cur = matches.length ? 0 : -1; fCount.textContent = fIn.value ? (matches.length ? `${cur + 1} of ${matches.length}` : 'No matches') : ''; paint(); }
  const show = () => { const m = matches[cur]; if (!m) return; const el = m.startContainer.parentElement; el?.scrollIntoView({ block: 'center', behavior: 'smooth' }); fCount.textContent = `${cur + 1} of ${matches.length}`; paint(); };
  const step = d => { if (!matches.length) return; cur = (cur + d + matches.length) % matches.length; show(); };
  const replaceOne = () => { const m = matches[cur]; if (!m) return; mark(); m.deleteContents(); m.insertNode(document.createTextNode(rIn.value)); body.normalize(); E.touch(); mark(); const at = cur; refreshFind(); cur = Math.min(at, matches.length - 1); show(); E.updateCount(); };
  const replaceAll = () => { if (!matches.length) return; mark(); const n = matches.length; for (let i = matches.length - 1; i >= 0; i--) { matches[i].deleteContents(); matches[i].insertNode(document.createTextNode(rIn.value)); } body.normalize(); E.touch(); mark(); refreshFind(); E.updateCount(); toast(`Replaced ${n} ${n === 1 ? 'place' : 'places'}`); };
  const openFind = (replace) => { findBar.hidden = false; const s = String(getSelection()); if (s && s.length < 80 && !s.includes('\n')) fIn.value = s; refreshFind(); (replace ? rIn : fIn).focus(); fIn.select?.(); };
  const closeFind = () => { findBar.hidden = true; paint(); body.focus(); };
  fIn.addEventListener('input', () => refreshFind()); caseBox.addEventListener('change', () => refreshFind());
  fIn.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1); } else if (e.key === 'Escape') closeFind(); });
  rIn.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); replaceOne(); } else if (e.key === 'Escape') closeFind(); });

  // ---- format painter -------------------------------------------------------------------------------
  let paintFmt = null;
  const painterBtn = h('button', { type: 'button', class: 'tb', title: 'Format painter: copy the formatting of the selected text, then select the text to apply it to', 'aria-label': 'Format painter', onpointerdown: e => e.preventDefault(), onclick: () => {
    if (paintFmt) { paintFmt = null; painterBtn.classList.remove('on'); return; }
    E.restore(); const q = c => document.queryCommandState(c);
    paintFmt = { bold: q('bold'), italic: q('italic'), underline: q('underline'), strikeThrough: q('strikeThrough'), font: document.queryCommandValue('fontName'), color: document.queryCommandValue('foreColor') };
    painterBtn.classList.add('on'); toast('Now select the text to format');
  } }, '🖌');
  body.addEventListener('pointerup', () => setTimeout(() => {
    if (!paintFmt) return; const s = getSelection(); if (!s.rangeCount || s.isCollapsed || !body.contains(s.anchorNode)) return;
    const f = paintFmt; paintFmt = null; painterBtn.classList.remove('on'); E.keep();
    run(() => { document.execCommand('removeFormat'); document.execCommand('styleWithCSS', false, true); for (const c of ['bold', 'italic', 'underline', 'strikeThrough']) if (f[c]) document.execCommand(c); if (f.font) document.execCommand('fontName', false, f.font.replace(/"/g, '')); if (f.color) document.execCommand('foreColor', false, f.color); document.execCommand('styleWithCSS', false, false); });
  }, 10));

  // ---- tables -------------------------------------------------------------------------------------------
  const cellAt = () => { const n = getSelection().anchorNode; const c = (n?.nodeType === 1 ? n : n?.parentElement)?.closest?.('td,th'); return c && body.contains(c) ? c : null; };
  let lastCell = null;
  const tAct = fn => () => { const c = lastCell; if (!c || !c.isConnected) return; mark(); fn(c, c.parentElement, c.closest('table'), [...c.parentElement.children].indexOf(c)); E.touch(); mark(); };
  const into = cell => { lastCell = cell && cell.isConnected ? cell : null; tableBar.hidden = !lastCell; if (lastCell) { const r = document.createRange(); r.selectNodeContents(lastCell); r.collapse(true); const s = getSelection(); s.removeAllRanges(); s.addRange(r); } };
  const newCell = tag => { const x = document.createElement(tag); x.innerHTML = '<br>'; return x; };
  const tableBar = h('div', { class: 'wtable', hidden: true }, h('span', { class: 'sub' }, 'Table:'),
    btn('Row above', tAct((c, tr) => { const r = tr.cloneNode(false); for (const x of tr.children) r.append(newCell('td')); tr.before(r); }), 'tiny'), btn('Row below', tAct((c, tr) => { const r = tr.cloneNode(false); for (const x of tr.children) r.append(newCell('td')); tr.after(r); }), 'tiny'),
    btn('Column left', tAct((c, tr, t, i) => { for (const r of t.rows) r.children[i]?.before(newCell(r.children[i].tagName.toLowerCase())); }), 'tiny'), btn('Column right', tAct((c, tr, t, i) => { for (const r of t.rows) r.children[i]?.after(newCell(r.children[i].tagName.toLowerCase())); }), 'tiny'),
    btn('Header row', tAct((c, tr, t) => { const first = t.rows[0]; const to = first.children[0]?.tagName === 'TH' ? 'td' : 'th'; let keepCell = null; for (const x of [...first.children]) { const y = document.createElement(to); y.innerHTML = x.innerHTML; x.replaceWith(y); if (x === c) keepCell = y; } into(keepCell || first.children[0]); }), 'tiny'),
    btn('Delete row', tAct((c, tr, t, i) => { const next = (tr.nextElementSibling || tr.previousElementSibling)?.children[i]; if (t.rows.length > 1) { tr.remove(); into(next); } else { t.remove(); into(null); } }), 'tiny danger'), btn('Delete column', tAct((c, tr, t, i) => { const next = c.nextElementSibling || c.previousElementSibling; if (tr.children.length > 1) { for (const r of [...t.rows]) r.children[i]?.remove(); into(next); } else { t.remove(); into(null); } }), 'tiny danger'),
    btn('Delete table', tAct((c, tr, t) => { t.remove(); into(null); }), 'tiny danger'));
  tableBar.addEventListener('pointerdown', e => e.preventDefault());
  const onSel = () => { if (!document.activeElement || document.activeElement !== body) return; const c = cellAt(); lastCell = c || null; tableBar.hidden = !c; };
  document.addEventListener('selectionchange', onSel);

  // ---- comments ------------------------------------------------------------------------------------------
  const addComment = async () => {
    const r = sel(); if (!r || r.collapsed) return toast('Select the text you want to comment on');
    const text = await promptDlg('Comment', '', 'Your note about this passage'); if (!text) return;
    const cid = uid();
    mark(); if (wrap(() => { const span = h('span', { class: 'cmt' }); span.dataset.c = cid; return span; })) { comments[cid] = { text, at: Date.now() }; E.touch(); mark(); cmBtn(); }
  };
  const unwrap = cid => { for (const s of body.querySelectorAll(`span.cmt[data-c="${cid}"]`)) s.replaceWith(...s.childNodes); delete comments[cid]; body.normalize(); };
  const jump = cid => { const s = body.querySelector(`span.cmt[data-c="${cid}"]`); s?.scrollIntoView({ block: 'center', behavior: 'smooth' }); s?.classList.add('flash'); setTimeout(() => s?.classList.remove('flash'), 1500); };
  const titles = () => { for (const s of body.querySelectorAll('span.cmt')) s.title = 'Comment: ' + (comments[s.dataset.c]?.text || ''); };
  const listComments = () => modal(close => {
    const box = h('div', { class: 'rows picker' });
    const draw = () => { const ids = [...body.querySelectorAll('span.cmt')].map(s => s.dataset.c).filter((v, i, a) => a.indexOf(v) === i && comments[v]);
      fill(box, ids.map(cid => h('div', { class: 'rowlink' }, icon('comment', 16), h('button', { class: 'grow linklike', onclick: () => { close(); jump(cid); } }, comments[cid].text, h('small', null, '“' + [...body.querySelectorAll(`span.cmt[data-c="${cid}"]`)].map(x => x.textContent).join('').slice(0, 70) + '”')),
        btn('Edit', async () => { const t = await promptDlg('Comment', comments[cid].text); if (t) { comments[cid].text = t; titles(); E.touch(); draw(); } }, 'tiny'), btn('Resolve', () => { mark(); unwrap(cid); E.touch(); mark(); cmBtn(); draw(); }, 'tiny'))),
        !ids.length && h('p', { class: 'sub' }, 'No comments. Select text, then choose More, Comment on selection.')); };
    draw(); return h('div', null, h('p', { class: 'sub' }, 'Commented text is shaded in the document; hover over it to read the comment. Comments are not printed or exported.'), box);
  }, { title: 'Comments' });
  const cmCount = h('span', { class: 'sub' });
  function cmBtn() { titles(); const n = new Set([...body.querySelectorAll('span.cmt')].map(s => s.dataset.c)).size; cmCount.textContent = n ? `${n} comment${n === 1 ? '' : 's'}` : ''; cmCount.hidden = !n; }
  cmCount.addEventListener('click', listComments); cmCount.classList.add('cmcount'); cmBtn();

  // ---- versions (kept on this device) ---------------------------------------------------------------------
  const vKey = 'ver:' + id;
  const current = () => ({ at: Date.now(), title: E.title.value, body: body.innerHTML, footnotes: structuredClone(fns), comments: structuredClone(comments), meta: E.meta(), words: words(stripHtml(body.innerHTML.replace(/</g, ' <'))) });
  const saveVersion = async (label) => { const list = (await store.getKV(vKey)) || []; const v = current(); if (label) v.label = label; if (!label && list[0] && list[0].body === v.body && JSON.stringify(list[0].footnotes) === JSON.stringify(v.footnotes)) return false; list.unshift(v); await store.putKV(vKey, list.slice(0, 40)); return true; };
  let lastAuto = Date.now();
  const autoVersion = () => { if (Date.now() - lastAuto > 10 * 60000) { lastAuto = Date.now(); saveVersion().catch(() => {}); } };
  store.getKV(vKey).then(list => { if (!list?.length || Date.now() - list[0].at > 10 * 60000) saveVersion().catch(() => {}); });
  const versions = async () => { const list = (await store.getKV(vKey)) || [];
    modal(close => h('div', null, h('p', { class: 'sub' }, 'A copy is kept automatically about every ten minutes while you write, and whenever you save one yourself. Versions stay on this device and are not synced.'),
      h('div', { class: 'row gap' }, btn('Save a version now', async () => { const name = await promptDlg('Name this version (optional)', '', 'Before the rewrite'); if (name === null) return; await saveVersion(name || 'Saved by hand'); close(); toast('Version saved'); }, 'tiny primary')),
      h('div', { class: 'rows picker' }, list.map((v, i) => h('div', { class: 'rowlink' }, icon('upcoming', 16), h('span', { class: 'grow' }, new Date(v.at).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }), h('small', null, `${v.words} words${v.label ? ' · ' + v.label : ''}`)),
        btn('Open as a copy', () => { const d = store.put('docs', { title: (v.title || 'Untitled') + ' (earlier version)', kind: E.doc.kind, body: v.body, footnotes: v.footnotes, comments: v.comments || {}, meta: v.meta, trashed: false }); close(); location.hash = '#/doc/' + d.id; }, 'tiny'),
        btn('Restore', async () => { if (!(await confirmDlg('Replace the document with this version? Your current text is saved as a version first.', 'Restore', false))) return; await saveVersion('Before restoring'); mark(); apply({ html: sanitize(v.body), fns: JSON.stringify(v.footnotes || {}), cm: JSON.stringify(v.comments || {}), caret: 0 }); mark(); close(); toast('Version restored'); }, 'tiny'))), !list.length && h('p', { class: 'sub' }, 'No versions yet.'))), { title: 'Versions' }); };

  // ---- word count, symbols, dictation, read aloud ------------------------------------------------------------
  const countDlg = () => { const text = stripHtml(body.innerHTML.replace(/<(\/?(div|p|li|h\d|tr|br|td|th|blockquote))\b/gi, ' <$1')), selText = String(getSelection()), notes = Object.values(fns).map(f => stripHtml(f.html || '')).join(' ');
    const row = (a, b) => h('div', { class: 'row between' }, h('span', null, a), h('b', null, b));
    modal(() => h('div', { class: 'form' }, row('Words in the body', words(text).toLocaleString()), row('Characters (with spaces)', text.trim().length.toLocaleString()), row('Characters (no spaces)', text.replace(/\s/g, '').length.toLocaleString()), row('Paragraphs', String(body.querySelectorAll('p,li,h1,h2,h3,blockquote').length)),
      row('Footnotes', String(body.querySelectorAll('sup.fn').length)), row('Words in typed footnotes', words(notes).toLocaleString()), selText.trim() ? row('Words in your selection', words(selText).toLocaleString()) : null,
      row('Estimated pages (double-spaced)', '≈ ' + Math.max(1, Math.round(words(text) / 290))), row('Speaking time at 130 words a minute', '≈ ' + Math.max(1, Math.round(words(text) / 130)) + ' min')), { title: 'Word count', cls: 'small' }); };
  const symbols = () => { E.keep(); modal(close => h('div', { class: 'symgrid' }, SYMBOLS.map(ch => h('button', { type: 'button', onclick: () => { run(() => { E.restore(); document.execCommand('insertText', false, ch); }); toast(`Inserted ${ch}`, null, null, 900); } }, ch))), { title: 'Insert a symbol' }); };
  let rec = null, bar = null;
  const dictate = () => {
    if (rec) { rec.stop(); return; }
    if (!canDictate()) return toast('Dictation needs Chrome. Open Steward in Chrome to speak instead of type.');
    E.restore();
    bar = listeningBar(() => rec?.stop());
    rec = listen({
      onFinal: raw => { run(() => { E.restore(); insertSpoken(body, raw); }); E.updateCount(); },
      onInterim: t => bar?.set(t),
      onEnd: () => { rec = null; bar?.remove(); bar = null; sheetFlag('dictating', false); },
    });
    sheetFlag('dictating', true);
    addEventListener('hashchange', () => rec?.stop(), { once: true }); // leaving the document stops listening
  };
  const sheetFlag = (c, on) => E.sheet.closest('.writer')?.classList.toggle(c, on);
  const readAloud = () => {
    if (!window.speechSynthesis) return toast('Read aloud is not available in this browser');
    if (speechSynthesis.speaking) { speechSynthesis.cancel(); return; }
    let text = String(getSelection()).trim();
    if (!text) { const off = caret() || 0; const all = stripHtml(body.innerHTML.replace(/<(\/?(div|p|li|h\d|tr|br|blockquote))\b/gi, '. <$1')); text = all.slice(Math.max(0, all.indexOf(' ', Math.max(0, off - 1)))); }
    for (const part of text.match(/[^.!?]+[.!?]*/g) || [text]) { const u = new SpeechSynthesisUtterance(part.trim()); u.rate = 1; speechSynthesis.speak(u); }
    toast('Reading aloud… choose Read aloud again to stop', null, null, 3000);
  };

  // ---- curly quotes and dashes as you type -------------------------------------------------------------------
  const smart = () => settings.get('smartQuotes') !== false;
  body.addEventListener('keydown', e => {
    if (!smart() || e.metaKey || e.ctrlKey || e.altKey || (e.key !== '"' && e.key !== "'")) return;
    const s = getSelection(); if (!s.rangeCount) return;
    const r = document.createRange(); r.selectNodeContents(body); r.setEnd(s.anchorNode, s.anchorOffset); const before = r.toString().slice(-1);
    const open = !before || /[\s(\[{—–“‘]/.test(before);
    e.preventDefault(); document.execCommand('insertText', false, e.key === '"' ? (open ? '“' : '”') : (open ? '‘' : '’'));
  });
  body.addEventListener('input', e => {
    markSoon(); autoVersion(); if (!findBar.hidden) refreshFind(true);
    if (!smart() || e.inputType !== 'insertText' || e.data !== '-') return;
    const s = getSelection(), n = s.anchorNode, o = s.anchorOffset;
    if (n?.nodeType === 3 && o >= 2 && n.data.slice(o - 2, o) === '--') { n.replaceData(o - 2, 2, '—'); s.collapse(n, o - 1); }
  });

  // ---- shortcuts ---------------------------------------------------------------------------------------------
  const keys = e => {
    const mod = e.metaKey || e.ctrlKey; if (!mod) return;
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.altKey) { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (k === 'y') { e.preventDefault(); redo(); }
    else if (k === 'f' && !e.altKey && !e.shiftKey) { e.preventDefault(); openFind(false); }
    else if (k === 'h' && e.shiftKey) { e.preventDefault(); openFind(true); }
  };
  body.addEventListener('keydown', keys); findBar.addEventListener('keydown', keys);

  const blockAt = () => { const n = getSelection().anchorNode; const el = (n?.nodeType === 1 ? n : n?.parentElement)?.closest?.('li,p,h1,h2,h3,blockquote,td,th,div'); return el && body.contains(el) && el !== body ? el : null; };
  const inList = () => { const n = getSelection().anchorNode; return (n?.nodeType === 1 ? n : n?.parentElement)?.closest?.('li'); };
  const innerOff = el => { const s = getSelection(); if (!el || !s.rangeCount) return 0; const r = document.createRange(); r.selectNodeContents(el); try { r.setEnd(s.focusNode, s.focusOffset); } catch { return 0; } return r.toString().length; };
  const setInner = (el, off) => { // put the cursor `off` characters into this block (its own text only)
    if (!el || !el.isConnected) return; const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let n, left = off; const s = getSelection(), r = document.createRange();
    while ((n = w.nextNode())) { if (n.parentElement.closest('ol,ul') !== el.closest('ol,ul') && el.tagName === 'LI' && n.parentElement.closest('li') !== el) continue; if (left <= n.data.length) { r.setStart(n, left); r.collapse(true); s.removeAllRanges(); s.addRange(r); return; } left -= n.data.length; }
    r.selectNodeContents(el); r.collapse(off === 0); s.removeAllRanges(); s.addRange(r);
  };
  /** List commands. Chrome moves the cursor and nests the list inside a paragraph; put both right afterwards. */
  const list = (command, after) => {
    E.restore(); const collapsed = getSelection().isCollapsed, off = innerOff(blockAt());
    run(() => { document.execCommand(command); after?.(); const target = blockAt(); for (const l of body.querySelectorAll('p > ol, p > ul, div > ol, div > ul')) { const p = l.parentElement; if (p !== body && p.children.length === 1 && !p.textContent.replace(l.textContent, '').trim()) p.replaceWith(l); } if (collapsed) setInner(target, off); });
  };
  const outline = () => list(inList() ? 'styleWithCSS' : 'insertOrderedList', () => { let ol = inList()?.closest('ol'); while (ol?.parentElement?.closest('ol')) ol = ol.parentElement.closest('ol'); ol?.classList.toggle('outline'); });
  const dent = dir => {
    E.restore(); const li = inList();
    if (!li) return toast(dir > 0 ? 'Indent works inside lists. For a long quotation, choose the Block quote style.' : 'Outdent works inside lists.');
    const off = innerOff(li);
    run(() => { document.execCommand(dir > 0 ? 'indent' : 'outdent'); setInner(li.isConnected ? li : blockAt(), off); });
  };
  const fontSel = h('select', { class: 'field slim wfont', 'aria-label': 'Font', title: 'Font for the selected text', onpointerdown: () => E.keep(), onchange: () => { exec('fontName', fontSel.value); fontSel.value = ''; } }, h('option', { value: '' }, 'Font'), FONTS.map(f => h('option', { value: f }, f)));
  const colorIn = h('input', { type: 'color', hidden: true, onchange: () => exec('foreColor', colorIn.value) });
  const more = e => menu(e.currentTarget, [
    { label: 'Find and replace (Cmd+F)', icon: 'search', onclick: () => openFind(false) },
    '-',
    { label: 'Strikethrough', onclick: () => exec('strikeThrough') }, { label: 'Superscript', onclick: () => exec('superscript') }, { label: 'Subscript', onclick: () => exec('subscript') },
    { label: 'Small caps', onclick: () => { mark(); if (wrap(() => h('span', { style: { fontVariant: 'small-caps' } }))) { E.touch(); mark(); } } },
    { label: 'Text color…', onclick: () => { E.keep(); colorIn.click(); } }, { label: 'Highlight', onclick: () => exec('hiliteColor', '#fff3a3') },
    { label: 'Clear formatting', onclick: () => run(() => { E.restore(); document.execCommand('removeFormat'); }) },
    '-',
    { label: 'Outline numbering (I. A. 1. a.)', icon: 'list', onclick: outline }, { label: 'Insert a symbol…', onclick: symbols },
    { label: 'Comment on selection', icon: 'comment', onclick: addComment }, { label: 'Show comments', icon: 'comment', onclick: listComments },
    '-',
    { label: rec ? 'Stop dictating' : 'Dictate', icon: 'mic', onclick: dictate }, { label: window.speechSynthesis?.speaking ? 'Stop reading' : 'Read aloud', onclick: readAloud },
    { label: 'Word count…', onclick: countDlg }, { label: 'Versions…', icon: 'upcoming', onclick: versions },
    { label: (smart() ? '✓ ' : '') + 'Curly quotes and dashes as I type', onclick: () => { settings.set('smartQuotes', !smart()); toast(smart() ? 'Curly quotes on' : 'Curly quotes off'); } },
  ]);
  return {
    mark, undo, redo, list, dent, comments: () => { const live = new Set([...body.querySelectorAll('span.cmt')].map(s => s.dataset.c)); const out = {}; for (const k of live) if (comments[k]) out[k] = comments[k]; return out; },
    bars: [findBar, tableBar], buttons: { fontSel, painterBtn, colorIn, cmCount, more: h('button', { type: 'button', class: 'tb wide', title: 'More tools', onpointerdown: e => e.preventDefault(), onclick: more }, 'More ▾'), find: h('button', { type: 'button', class: 'tb', title: 'Find and replace (Cmd+F)', 'aria-label': 'Find and replace', onpointerdown: e => e.preventDefault(), onclick: () => openFind(false) }, icon('search', 15)) },
    countDlg, destroy() { document.removeEventListener('selectionchange', onSel); try { rec?.stop(); } catch {} window.speechSynthesis?.cancel(); if (window.CSS?.highlights) { CSS.highlights.delete('steward-find'); CSS.highlights.delete('steward-find-cur'); } },
  };
}

/** Read a Word (.docx) file into a new document, keeping headings, bold/italic, lists, tables and footnotes. */
export async function importDocx(file) {
  if (!window.mammoth) await new Promise((res, rej) => { const s = document.createElement('script'); s.src = new URL('vendor/mammoth/mammoth.browser.min.js', document.baseURI).href; s.onload = res; s.onerror = () => rej(new Error('offline')); document.head.append(s); });
  const out = await window.mammoth.convertToHtml({ arrayBuffer: await file.arrayBuffer() }, { styleMap: ["p[style-name='Block Text'] => blockquote:fresh", "p[style-name='Quote'] => blockquote:fresh", "p[style-name='Block Quotation'] => blockquote:fresh"] });
  const dom = new DOMParser().parseFromString(`<body>${out.value}</body>`, 'text/html');
  const footnotes = {}, texts = new Map();
  for (const li of dom.querySelectorAll('li[id^="footnote-"], li[id^="endnote-"]')) { li.querySelectorAll('a[href^="#footnote-ref"], a[href^="#endnote-ref"]').forEach(a => a.remove()); texts.set(li.id, [...li.querySelectorAll('p')].map(p => p.innerHTML.trim()).join(' ') || li.innerHTML.trim()); li.closest('ol')?.remove(); }
  for (const a of dom.querySelectorAll('a[href^="#footnote-"], a[href^="#endnote-"]')) {
    const key = a.getAttribute('href').slice(1), nid = uid(); footnotes[nid] = { html: texts.get(key) || '' };
    const m = dom.createElement('sup'); m.className = 'fn'; m.dataset.fn = nid; m.setAttribute('contenteditable', 'false');
    (a.closest('sup') || a).replaceWith(m);
  }
  dom.querySelectorAll('img').forEach(x => x.remove()); dom.querySelectorAll('a[id]').forEach(a => { if (!a.textContent) a.remove(); });
  dom.querySelectorAll('h4,h5,h6').forEach(x => { const y = dom.createElement('h3'); y.innerHTML = x.innerHTML; x.replaceWith(y); });
  const title = file.name.replace(/\.docx$/i, '');
  return { doc: store.put('docs', { title, kind: 'other', body: dom.body.innerHTML || '<p><br></p>', footnotes, comments: {}, meta: {}, trashed: false }), warnings: out.messages?.length || 0, notes: Object.keys(footnotes).length };
}

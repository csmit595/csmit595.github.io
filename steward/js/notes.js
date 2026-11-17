// Notes: notebooks, tags, rich-text editor, attachments (photos, PDFs, audio), clipping, Evernote import.
import { h, fill, uid, stripHtml, sanitize, debounce, esc, fmtSize, md5, mdToHtml } from './util.js';
import { store } from './store.js';
import * as M from './model.js';
import { sync } from './sync.js';
import { icon, btn, iconBtn, modal, confirmDlg, promptDlg, toast, menu, isMobile } from './ui.js';
import { openQuickAdd, openTask } from './tasks.js';
import { ocr } from './ocr.js';

const go = hash => { location.hash = hash; };
let scope = { kind: 'all' }, query = '', sortBy = 'updated';
let mounted = null; // { id, el, save, urls }
const textCache = new Map();
function textOf(n) {
  const c = textCache.get(n.id);
  if (c && c.at === n.updatedAt) return c.text;
  const text = stripHtml(n.body).replace(/\s+/g, ' ').trim();
  textCache.set(n.id, { at: n.updatedAt, text });
  return text;
}
const TEMPLATES = {
  'Site visit': '<h2>Customer</h2><div><br></div><h2>What they asked for</h2><ul><li><br></li></ul><h2>Measurements and materials</h2><ul><li><br></li></ul><h2>Promises I made</h2><ul class="todo"><li><br></li></ul><h2>Follow-up</h2><div><br></div>',
  'Estimate notes': '<h2>Scope</h2><ul><li><br></li></ul><h2>Labor</h2><div><br></div><h2>Materials</h2><table><tbody><tr><th>Item</th><th>Qty</th><th>Cost</th></tr><tr><td><br></td><td><br></td><td><br></td></tr><tr><td><br></td><td><br></td><td><br></td></tr></tbody></table><h2>Price quoted</h2><div><br></div>',
  'Sermon notes': '<h2>Passage</h2><div><br></div><h2>Main point</h2><div><br></div><h2>Outline</h2><ol><li><br></li></ol><h2>Application</h2><ul><li><br></li></ul>',
  'Meeting notes': '<h2>Who was there</h2><div><br></div><h2>Discussed</h2><ul><li><br></li></ul><h2>To do</h2><ul class="todo"><li><br></li></ul>',
};

export function leaveNotes() { mounted?.save(true); mounted?.urls.forEach(u => URL.revokeObjectURL(u)); mounted = null; }

export function renderNotes(route, main, info = {}) {
  if (route.view === 'notes') scope = route.scope || { kind: 'all' };
  if (route.view === 'trash') scope = { kind: 'trash' };
  if (!main.querySelector(':scope > .nlist')) {
    leaveNotes();
    fill(main, h('div', { class: 'nlist' }), h('div', { class: 'neditor' }));
  }
  main.className = 'notes-layout' + (route.view === 'note' ? ' has-note' : '');
  drawList(main.querySelector('.nlist'), route);
  const pane = main.querySelector('.neditor');
  if (route.view === 'note') {
    const focused = pane.contains(document.activeElement);
    if (!mounted || mounted.id !== route.id || (info.remote && !focused)) mountEditor(pane, route.id);
    else mounted.refreshTasks?.();
  } else { leaveNotes(); fill(pane, h('div', { class: 'empty' }, h('strong', null, 'Select a note'), h('p', null, 'or start a new one.'))); }
}

function scopeNotes() {
  let list = scope.kind === 'trash' ? store.all('notes').filter(n => n.trashed) : M.liveNotes();
  if (scope.kind === 'nb') list = list.filter(n => n.notebookId === scope.id);
  if (scope.kind === 'tag') list = list.filter(n => (n.tags || []).includes(scope.id));
  if (query.trim()) {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    list = list.filter(n => { const hay = ((n.title || '') + ' ' + textOf(n) + ' ' + (n.tags || []).join(' ') + ' ' + (n.attachments || []).map(a => a.name).join(' ') + ocr.textFor(n)).toLowerCase(); return words.every(w => hay.includes(w)); });
  }
  const key = sortBy === 'title' ? (a, b) => (a.title || '').localeCompare(b.title || '') : sortBy === 'created' ? (a, b) => b.createdAt - a.createdAt : (a, b) => b.updatedAt - a.updatedAt;
  return list.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || key(a, b));
}
function scopeTitle() {
  if (scope.kind === 'nb') return store.get('notebooks', scope.id)?.name || 'Notebook';
  if (scope.kind === 'tag') return '#' + scope.id;
  if (scope.kind === 'trash') return 'Trash';
  return 'All notes';
}
export function newNote(extra = {}) {
  const n = M.addNote({ notebookId: scope.kind === 'nb' ? scope.id : undefined, notebook: 'Notes', tags: scope.kind === 'tag' ? [scope.id] : [], ...extra });
  go('#/note/' + n.id);
  return n;
}
function drawList(el, route) {
  const list = scopeNotes();
  const hadFocus = el.querySelector('.nsearch') === document.activeElement;
  const search = h('input', { class: 'field nsearch', type: 'search', placeholder: 'Search notes', value: query, oninput: debounce(() => { query = search.value; drawList(el, route); }, 200) });
  const sort = h('select', { class: 'field slim', 'aria-label': 'Sort notes', onchange: () => { sortBy = sort.value; drawList(el, route); } }, h('option', { value: 'updated' }, 'Last edited'), h('option', { value: 'created' }, 'Newest'), h('option', { value: 'title' }, 'Title'));
  sort.value = sortBy;
  fill(el, 
    h('header', { class: 'vhead' }, h('div', null, h('h1', null, scopeTitle()), h('div', { class: 'sub' }, `${list.length} note${list.length === 1 ? '' : 's'}`)),
      scope.kind === 'trash' ? (list.length > 0 && btn('Empty trash', async () => { if (await confirmDlg(`Permanently delete ${list.length} notes?`)) for (const n of list) destroy(n); }, 'tiny danger'))
        : h('div', { class: 'row' }, iconBtn('more', 'New from template', e => menu(e.currentTarget, Object.keys(TEMPLATES).map(k => ({ label: k + ' template', icon: 'note', onclick: () => newNote({ title: k, body: TEMPLATES[k] }) })))), btn('New note', () => newNote(), 'primary', 'plus'))),
    h('div', { class: 'row gap nfilter' }, search, sort),
    h('div', { class: 'nitems' }, list.map(n => h('a', { class: 'nitem' + (route.view === 'note' && route.id === n.id ? ' on' : ''), href: '#/note/' + n.id },
      h('div', { class: 'ntitle' }, n.pinned && icon('pin', 13), n.title || 'Untitled'),
      h('div', { class: 'nsnip' }, textOf(n).slice(0, 110)),
      h('div', { class: 'nmeta' }, new Date(n.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: new Date(n.updatedAt).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' }),
        (n.attachments || []).length > 0 && h('span', null, icon('clip', 11), n.attachments.length), (n.tags || []).slice(0, 3).map(t => h('span', { class: 'ntag' }, t))))),
    !list.length && h('div', { class: 'empty' }, h('strong', null, query ? 'No notes match' : scope.kind === 'trash' ? 'Trash is empty' : 'No notes here yet'), h('p', null, query ? 'Try fewer words.' : scope.kind === 'trash' ? '' : 'Tap New note to start one.'))));
  if (hadFocus) { const s = el.querySelector('.nsearch'); s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
}
async function destroy(n) { for (const a of n.attachments || []) { await store.delBlob(a.id).catch(() => {}); store.remove('ocr', a.id, { silent: true }); } store.remove('notes', n.id); }

// ---- attachments -----------------------------------------------------------------
const attHtml = a => (a.mime || '').startsWith('image/') ? `<img data-att="${a.id}" alt="${esc(a.name)}">`
  : (a.mime || '').startsWith('audio/') ? `<audio controls data-att="${a.id}"></audio>&nbsp;`
  : `<a class="att" data-att="${a.id}" contenteditable="false">${esc(a.name)} · ${fmtSize(a.size || 0)}</a>&nbsp;`;
async function hydrate(root, atts, urls) {
  for (const el of root.querySelectorAll('[data-att]')) {
    if (el.dataset.ready) continue;
    const a = (atts || []).find(x => x.id === el.dataset.att);
    if (!a) continue;
    const blob = await sync.blob(a);
    if (!blob) { el.classList.add('missing'); if (el.tagName === 'A') el.title = 'Not downloaded yet. Connect to the internet and reopen this note.'; continue; }
    const url = URL.createObjectURL(blob); urls.push(url); el.dataset.ready = '1';
    if (el.tagName === 'A') { el.href = url; el.target = '_blank'; el.setAttribute('download', a.name); } else el.src = url;
  }
}
function serialize(body) {
  const c = body.cloneNode(true);
  c.querySelectorAll('[data-att]').forEach(el => { el.removeAttribute('src'); el.removeAttribute('href'); el.removeAttribute('data-ready'); el.classList.remove('missing'); });
  return c.innerHTML;
}
export async function filesToAttachments(files) {
  const out = [];
  for (const f of files) { const a = { id: uid(), name: f.name || 'file', mime: f.type || 'application/octet-stream', size: f.size }; await store.putBlob(a.id, f); out.push(a); }
  return out;
}

// ---- editor ------------------------------------------------------------------------
function mountEditor(pane, id) {
  leaveNotes();
  const n0 = store.get('notes', id);
  if (!n0) { fill(pane, h('div', { class: 'empty' }, h('strong', null, 'Note not found'), h('p', null, 'It may have been deleted on another device.'))); return; }
  const urls = [];
  const trashed = !!n0.trashed;
  const get = () => store.get('notes', id);
  const title = h('input', { class: 'etitle', placeholder: 'Title', value: n0.title || '', readOnly: trashed });
  const body = h('div', { class: 'ebody', contentEditable: trashed ? 'false' : 'true', html: sanitize(n0.body || '') || '<div><br></div>', spellcheck: true });
  let dirty = false;
  const save = now => {
    if (!dirty) return; dirty = false;
    const cur = get(); if (!cur) return;
    store.patch('notes', id, { title: title.value.trim(), body: serialize(body) });
  };
  const queue = debounce(() => save(), 700);
  const touch = () => { dirty = true; queue(); };
  title.addEventListener('input', touch);
  body.addEventListener('input', touch);
  title.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); body.focus(); } });

  let savedRange = null;
  const keepSel = () => { const s = getSelection(); if (s.rangeCount && body.contains(s.anchorNode)) savedRange = s.getRangeAt(0).cloneRange(); };
  const restoreSel = () => { body.focus(); if (savedRange) { const s = getSelection(); s.removeAllRanges(); s.addRange(savedRange); } };
  body.addEventListener('keyup', keepSel); body.addEventListener('pointerup', keepSel); body.addEventListener('blur', keepSel);
  const cmd = (c, v) => { restoreSel(); document.execCommand(c, false, v); touch(); keepSel(); };
  const insert = html => { restoreSel(); document.execCommand('insertHTML', false, html); touch(); };
  const attach = async files => {
    if (!files.length) return;
    const atts = await filesToAttachments(files);
    const cur = get();
    store.patch('notes', id, { attachments: [...(cur.attachments || []), ...atts] }, { silent: true });
    insert(atts.map(attHtml).join('') + '<div><br></div>');
    await hydrate(body, get().attachments, urls);
    save(true);
    ocr.kick(1500);
    if (sync.connected()) sync.run();
  };
  const linkNote = () => { keepSel(); pickNote(id, n => insert(`<a class="nlink" href="#/note/${n.id}">${esc(n.title || 'Untitled')}</a>&nbsp;`)); };
  body.addEventListener('input', () => {
    const s = getSelection(), node = s.anchorNode, off = s.anchorOffset;
    if (node?.nodeType === 3 && off >= 2 && node.data.slice(off - 2, off) === '[[') { node.deleteData(off - 2, 2); linkNote(); }
  });
  const fileIn = h('input', { type: 'file', multiple: true, hidden: true, onchange: () => { attach([...fileIn.files]); fileIn.value = ''; } });
  const camIn = h('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true, onchange: () => { attach([...camIn.files]); camIn.value = ''; } });
  let rec = null;
  const recBtn = iconBtn('mic', 'Record audio', async () => {
    if (rec) { rec.stop(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const chunks = []; rec = new MediaRecorder(stream);
      rec.ondataavailable = e => chunks.push(e.data);
      rec.onstop = () => { stream.getTracks().forEach(t => t.stop()); const type = rec.mimeType || 'audio/webm'; rec = null; recBtn.classList.remove('recording'); attach([new File(chunks, `Recording ${new Date().toLocaleString().replace(/[/:]/g, '-')}.${type.includes('mp4') ? 'm4a' : 'webm'}`, { type })]); };
      rec.start(); recBtn.classList.add('recording'); toast('Recording… tap the microphone again to stop');
    } catch { toast('Microphone is not available'); }
  });
  const tb = (label, title, fn, cls = '') => h('button', { type: 'button', class: 'tb ' + cls, title, 'aria-label': title, onpointerdown: e => e.preventDefault(), onclick: fn }, label);
  const toolbar = h('div', { class: 'toolbar' },
    tb('B', 'Bold', () => cmd('bold'), 'b'), tb('I', 'Italic', () => cmd('italic'), 'i'), tb('U', 'Underline', () => cmd('underline'), 'u'), tb('S', 'Strikethrough', () => cmd('strikeThrough'), 's'),
    tb('▇', 'Highlight', () => cmd('hiliteColor', '#fff3a3'), 'hl'),
    h('span', { class: 'sep' }),
    tb('H1', 'Heading', () => cmd('formatBlock', 'H1')), tb('H2', 'Subheading', () => cmd('formatBlock', 'H2')), tb('¶', 'Normal text', () => cmd('formatBlock', 'DIV')),
    h('span', { class: 'sep' }),
    tb('•', 'Bulleted list', () => cmd('insertUnorderedList')), tb('1.', 'Numbered list', () => cmd('insertOrderedList')),
    tb('☑', 'Checklist', () => { restoreSel(); const inList = getSelection().anchorNode?.parentElement?.closest?.('ul'); if (!inList) document.execCommand('insertUnorderedList'); const ul = (getSelection().anchorNode?.nodeType === 1 ? getSelection().anchorNode : getSelection().anchorNode?.parentElement)?.closest('ul'); if (ul) ul.classList.toggle('todo'); touch(); }),
    tb('❝', 'Quote', () => cmd('formatBlock', 'BLOCKQUOTE')), tb('</>', 'Code block', () => cmd('formatBlock', 'PRE')),
    tb('—', 'Divider', () => cmd('insertHorizontalRule')),
    tb('▦', 'Table', () => insert('<table><tbody>' + '<tr><td><br></td><td><br></td><td><br></td></tr>'.repeat(3) + '</tbody></table><div><br></div>')),
    tb(icon('link', 15), 'Link', async () => { keepSel(); const url = await promptDlg('Link address', 'https://'); if (url) { const sel = savedRange && !savedRange.collapsed; if (sel) cmd('createLink', url); else insert(`<a href="${esc(url)}">${esc(url)}</a>&nbsp;`); } }),
    tb(icon('note', 15), 'Link to another note (or type [[ )', linkNote),
    h('span', { class: 'sep' }),
    tb(icon('clip', 15), 'Attach a file', () => { keepSel(); fileIn.click(); }), tb(icon('camera', 15), 'Take a photo', () => { keepSel(); camIn.click(); }), recBtn,
    h('span', { class: 'sep' }), tb('↶', 'Undo', () => cmd('undo')), tb('↷', 'Redo', () => cmd('redo')));
  recBtn.addEventListener('pointerdown', e => e.preventDefault());

  body.addEventListener('click', e => {
    const li = e.target.closest?.('ul.todo > li');
    if (li && e.target === li && e.offsetX < 26) { li.toggleAttribute('data-checked'); if (li.hasAttribute('data-checked')) li.setAttribute('data-checked', '1'); touch(); }
    const a = e.target.closest?.('a[href]');
    if (a && (a.getAttribute('href') || '').startsWith('#/note/')) { e.preventDefault(); save(true); location.hash = a.getAttribute('href'); return; }
    if (a && !a.classList.contains('att') && (e.metaKey || e.ctrlKey || trashed || isMobile())) { e.preventDefault(); window.open(a.href, '_blank', 'noopener'); }
  });
  body.addEventListener('paste', e => { const files = [...(e.clipboardData?.files || [])]; if (files.length) { e.preventDefault(); keepSel(); attach(files); } });
  body.addEventListener('drop', e => { const files = [...(e.dataTransfer?.files || [])]; if (files.length) { e.preventDefault(); keepSel(); attach(files); } });
  body.addEventListener('keydown', e => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); toolbar.querySelector('[title="Link"]').click(); } });

  const nbSel = h('select', { class: 'field slim', 'aria-label': 'Notebook', disabled: trashed, onchange: () => store.patch('notes', id, { notebookId: nbSel.value }) }, store.all('notebooks').sort((a, b) => a.name.localeCompare(b.name)).map(b => h('option', { value: b.id }, b.name)));
  nbSel.value = n0.notebookId;
  const tagsEl = h('div', { class: 'etags' });
  const drawTags = () => {
    const n = get(); if (!n) return;
    const input = h('input', { class: 'tagin', placeholder: 'Add tag', list: 'tag-list', onkeydown: e => { if ((e.key === 'Enter' || e.key === ',') && input.value.trim()) { e.preventDefault(); store.patch('notes', id, { tags: [...new Set([...(n.tags || []), input.value.trim().replace(/^#/, '')])] }); drawTags(); tagsEl.querySelector('.tagin').focus(); } } });
    fill(tagsEl, icon('tag', 14), (n.tags || []).map(t => h('span', { class: 'chip' }, t, !trashed && h('button', { 'aria-label': 'Remove tag', onclick: () => { store.patch('notes', id, { tags: n.tags.filter(x => x !== t) }); drawTags(); } }, '×'))), !trashed && input, h('datalist', { id: 'tag-list' }, M.allTags().map(([t]) => h('option', { value: t }))));
  };
  drawTags();
  const tasksEl = h('div', { class: 'ntasks' });
  const refreshTasks = () => {
    const list = store.all('tasks').filter(t => t.noteId === id && !t.completedAt);
    const back = liveBacklinks(id);
    fill(tasksEl, back.length > 0 && h('h4', null, 'Notes that link here'), back.map(n => h('a', { class: 'rowlink', href: '#/note/' + n.id }, icon('note', 16), n.title || 'Untitled')), list.length > 0 && h('h4', null, 'Tasks linked to this note'), list.map(t => h('div', { class: `task pri${t.priority || 4}` }, h('button', { class: 'check', 'aria-label': 'Complete', onclick: () => { M.completeTask(t.id); } }, icon('check', 13)), h('div', { class: 'tbody', onclick: () => openTask(t.id) }, h('div', { class: 'tcontent' }, t.content)))));
  };
  refreshTasks();
  const more = e => { const n = get(); menu(e.currentTarget, trashed ? [
    { label: 'Restore note', icon: 'back', onclick: () => { store.patch('notes', id, { trashed: false }); go('#/notes'); } },
    { label: 'Delete forever', icon: 'trash', danger: true, onclick: async () => { if (await confirmDlg('Permanently delete this note and its attachments?')) { mounted = null; await destroy(n); go('#/trash'); } } },
  ] : [
    { label: 'Add a task from this note', icon: 'check', onclick: () => openQuickAdd({ noteId: id }) },
    { label: n.pinned ? 'Unpin' : 'Pin to top', icon: 'pin', onclick: () => store.patch('notes', id, { pinned: !n.pinned }) },
    { label: 'Duplicate', icon: 'note', onclick: () => { save(true); const c = get(); const d = M.addNote({ ...c, id: undefined, title: (c.title || 'Untitled') + ' (copy)' }); go('#/note/' + d.id); } },
    { label: 'Print or save as PDF', icon: 'note', onclick: () => window.print() },
    '-',
    { label: 'Move to trash', icon: 'trash', danger: true, onclick: () => { save(true); store.patch('notes', id, { trashed: true }); toast('Note moved to trash', 'Undo', () => store.patch('notes', id, { trashed: false })); go('#/notes'); } },
  ]); };
  fill(pane, 
    h('div', { class: 'ebar' }, iconBtn('back', 'Back to notes', () => { save(true); go(scope.kind === 'nb' ? '#/notes/nb/' + scope.id : scope.kind === 'tag' ? '#/notes/tag/' + encodeURIComponent(scope.id) : scope.kind === 'trash' ? '#/trash' : '#/notes'); }, 'only-mobile'),
      icon('book', 15), nbSel, h('span', { class: 'grow' }), h('span', { class: 'sub saved' }, 'Edited ' + new Date(n0.updatedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })), iconBtn('more', 'Note options', more)),
    trashed && h('div', { class: 'banner' }, 'This note is in the trash.'),
    !trashed && toolbar, h('div', { class: 'escroll' }, title, tagsEl, body, n0.sourceUrl && h('div', { class: 'sub src' }, 'Clipped from ', h('a', { href: n0.sourceUrl, target: '_blank', rel: 'noopener' }, n0.sourceUrl.replace(/^https?:\/\//, '').slice(0, 60))), tasksEl), fileIn, camIn);
  hydrate(body, n0.attachments, urls);
  mounted = { id, save, urls, refreshTasks };
  if (!n0.title && !trashed && !isMobile()) title.focus();
}
window.addEventListener('pagehide', () => mounted?.save(true));
document.addEventListener('visibilitychange', () => { if (document.hidden) { mounted?.save(true); store.flush(); } });

const liveBacklinks = id => M.liveNotes().filter(n => n.id !== id && (n.body || '').includes(`#/note/${id}"`));
function pickNote(selfId, onPick) {
  modal(close => {
    const input = h('input', { class: 'field', placeholder: 'Find a note by title', autofocus: true });
    const list = h('div', { class: 'rows picker' });
    const draw = () => {
      const q = input.value.toLowerCase().trim();
      const notes = M.liveNotes().filter(n => n.id !== selfId && (!q || (n.title || '').toLowerCase().includes(q))).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 30);
      fill(list, notes.map(n => h('button', { class: 'rowlink', onclick: () => { close(); onPick(n); } }, icon('note', 16), h('span', { class: 'grow' }, n.title || 'Untitled', h('small', null, store.get('notebooks', n.notebookId)?.name || '')))),
        !notes.length && h('div', { class: 'sub' }, 'No notes match.'),
        q && h('button', { class: 'rowlink', onclick: () => { const n = M.addNote({ title: input.value.trim(), notebookId: store.get('notes', selfId)?.notebookId }); close(); onPick(n); } }, icon('plus', 16), `Create a new note called "${input.value.trim()}"`));
    };
    input.addEventListener('input', draw);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') list.querySelector('button')?.click(); });
    draw();
    return h('div', { class: 'form' }, input, list);
  }, { title: 'Link to a note', cls: 'small' });
}

// ---- clipping -----------------------------------------------------------------------
/** Create a note from something shared into Steward (Android share sheet, Mac bookmark button). */
export async function createClip({ title, text, url, html, files }) {
  const atts = files?.length ? await filesToAttachments(files) : [];
  let body = '';
  if (html) body += sanitize(html);
  else if (text) body += mdToHtml(text);
  if (url && !html && !(text || '').includes(url)) body += `<div><a href="${esc(url)}">${esc(url)}</a></div>`;
  body += atts.map(attHtml).join('<div><br></div>');
  const n = M.addNote({ title: (title || (text || '').split('\n')[0] || (atts[0]?.name) || 'Clip').slice(0, 140), body, notebook: 'Clips', sourceUrl: url || '', attachments: atts });
  toast('Saved to the Clips notebook');
  ocr.kick(1500);
  go('#/note/' + n.id);
  if (sync.connected()) sync.run();
  return n;
}

// ---- Evernote import (.enex files) -------------------------------------------------------
const b64bytes = s => { const bin = atob(s.replace(/\s+/g, '')); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
const enDate = s => { const m = (s || '').match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : Date.now(); };
export async function importEnex(file, onProgress) {
  const xml = new DOMParser().parseFromString(await file.text(), 'application/xml');
  if (xml.querySelector('parsererror')) throw new Error('This file could not be read as an Evernote export.');
  const notebookId = M.ensureNotebook(file.name.replace(/\.enex$/i, ''));
  const notes = [...xml.querySelectorAll('en-export > note')];
  let count = 0;
  for (const el of notes) {
    const kid = name => [...el.children].find(c => c.tagName === name)?.textContent || '';
    const atts = [], byHash = new Map();
    for (const r of [...el.children].filter(c => c.tagName === 'resource')) {
      try {
        const bytes = b64bytes(r.querySelector('data')?.textContent || '');
        const mime = r.querySelector('mime')?.textContent || 'application/octet-stream';
        const name = r.querySelector('resource-attributes > file-name')?.textContent || `attachment.${mime.split('/')[1] || 'bin'}`;
        const a = { id: uid(), name, mime, size: bytes.length };
        await store.putBlob(a.id, new Blob([bytes], { type: mime }));
        atts.push(a); byHash.set(md5(bytes), a);
      } catch (e) { console.warn('attachment skipped', e); }
    }
    const doc = new DOMParser().parseFromString(kid('content'), 'text/html');
    const used = new Set();
    doc.querySelectorAll('en-media').forEach(m => { const a = byHash.get((m.getAttribute('hash') || '').toLowerCase()); if (a) { used.add(a.id); m.outerHTML = attHtml(a); } else m.remove(); });
    doc.querySelectorAll('en-todo').forEach(t => t.replaceWith(doc.createTextNode(t.getAttribute('checked') === 'true' ? '☑ ' : '☐ ')));
    const root = doc.querySelector('en-note') || doc.body;
    let body = sanitize(root.innerHTML);
    for (const a of atts) if (!used.has(a.id)) body += attHtml(a);
    const created = enDate(kid('created')), updated = enDate(kid('updated') || kid('created'));
    const src = el.querySelector('note-attributes > source-url')?.textContent || '';
    const n = M.addNote({ title: kid('title'), body, notebookId, tags: [...el.children].filter(c => c.tagName === 'tag').map(c => c.textContent), sourceUrl: src, attachments: atts });
    store.put('notes', { ...n, createdAt: created, editedAt: updated }, { silent: true });
    onProgress?.(++count, notes.length);
    if (count % 20 === 0) await new Promise(r => setTimeout(r));
  }
  store.emit({});
  ocr.kick(3000);
  return count;
}

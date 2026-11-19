// Notes: notebooks, tags, rich-text editor, attachments (photos, PDFs, audio), clipping, Evernote import.
import { h, fill, uid, stripHtml, sanitize, debounce, esc, fmtSize, md5, mdToHtml } from './util.js';
import { store } from './store.js';
import * as M from './model.js';
import { sync } from './sync.js';
import { icon, btn, iconBtn, modal, confirmDlg, promptDlg, toast, menu, isMobile } from './ui.js';
import { openQuickAdd, openTask } from './tasks.js';
import { ocr } from './ocr.js';
import { search } from './search.js';
import { canDictate, listen, listeningBar, insertSpoken, caretAtEnd, titleFrom } from './dictate.js';
import { orgPanel, readOrg, mergeList, hasArea, notebookIdByName } from './organize.js';
import * as V from './versions.js';
import { shrunk, diffWords, textOf as plainOf, GONE_DAYS } from './versions-core.js';

const go = hash => { location.hash = hash; };
let scope = { kind: 'all' }, query = '', sortBy = 'updated';
let mounted = null; // { id, el, save, urls }
const textCache = new Map();
function textOf(n) {
  const c = textCache.get(n.id);
  if (c && c.at === n.updatedAt) return c.text;
  const text = stripHtml((n.body || '').replace(/<(\/?(div|p|li|h\d|tr|br|td|th|blockquote))\b/gi, ' <$1')).replace(/\s+/g, ' ').trim();
  textCache.set(n.id, { at: n.updatedAt, text });
  return text;
}
const TEMPLATES = {
  'Site visit': '<h2>Customer</h2><div><br></div><h2>What they asked for</h2><ul><li><br></li></ul><h2>Measurements and materials</h2><ul><li><br></li></ul><h2>Promises I made</h2><ul class="todo"><li><br></li></ul><h2>Follow-up</h2><div><br></div>',
  'Estimate notes': '<h2>Scope</h2><ul><li><br></li></ul><h2>Labor</h2><div><br></div><h2>Materials</h2><table><tbody><tr><th>Item</th><th>Qty</th><th>Cost</th></tr><tr><td><br></td><td><br></td><td><br></td></tr><tr><td><br></td><td><br></td><td><br></td></tr></tbody></table><h2>Price quoted</h2><div><br></div>',
  'Sermon notes': '<h2>Passage</h2><div><br></div><h2>Main point</h2><div><br></div><h2>Outline</h2><ol><li><br></li></ol><h2>Application</h2><ul><li><br></li></ul>',
  'Meeting notes': '<h2>Who was there</h2><div><br></div><h2>Discussed</h2><ul><li><br></li></ul><h2>To do</h2><ul class="todo"><li><br></li></ul>',
};

// Notes started with "New note" on this device and never typed in: thrown away on leaving, like closing a blank page.
const fresh = new Set();
const isBlank = n => !String(n.title || '').trim() && !(n.attachments || []).length && !/<(img|audio|table|hr)\b/i.test(n.body || '') && !stripHtml(n.body || '').trim();
export function leaveNotes(nextId) {
  const was = mounted;
  mounted?.stopDictation?.();
  mounted?.save(true); mounted?.urls.forEach(u => URL.revokeObjectURL(u)); mounted = null;
  if (was && was.id !== nextId && fresh.has(was.id)) { fresh.delete(was.id); const n = store.get('notes', was.id); if (n && isBlank(n)) store.remove('notes', was.id); }
}

export function renderNotes(route, main, info = {}) {
  if (route.view === 'notes') scope = route.scope || { kind: 'all' };
  if (route.view === 'trash') scope = { kind: route.id === 'deleted' ? 'gone' : 'trash' };
  if (!main.querySelector(':scope > .nlist')) {
    leaveNotes();
    fill(main, h('div', { class: 'nlist' }), h('div', { class: 'neditor' }));
  }
  main.className = 'notes-layout' + (route.view === 'note' ? ' has-note' : '');
  drawList(main.querySelector('.nlist'), route);
  const pane = main.querySelector('.neditor');
  if (route.view === 'note') {
    const focused = pane.contains(document.activeElement);
    if (!mounted || mounted.id !== route.id || (info.remote && !focused && !mounted.isDictating?.())) mountEditor(pane, route.id);
    else mounted.refreshTasks?.();
  } else { leaveNotes(); fill(pane, h('div', { class: 'empty pane-empty' }, icon('note', 40), h('strong', null, 'Pick a note to read'), h('p', null, 'Or start a new one with ', h('kbd', null, 'N'), '. Everything here is searchable, even the words inside photos and PDFs.'), btn('New note', () => newNote(), 'primary', 'plus'))); }
}

function scopeNotes() {
  const binned = scope.kind === 'trash' || scope.kind === 'gone';
  let list = scope.kind === 'trash' ? M.trashedNotes() : scope.kind === 'gone' ? M.goneNotes() : M.liveNotes();
  if (scope.kind === 'nb') list = list.filter(n => n.notebookId === scope.id);
  if (scope.kind === 'tag') list = list.filter(n => (n.tags || []).includes(scope.id));
  if (query.trim() && binned) { const w = query.toLowerCase().split(/\s+/).filter(Boolean); return list.filter(n => w.every(x => ((n.title || '') + ' ' + textOf(n)).toLowerCase().includes(x))); }
  if (query.trim()) {
    const ids = new Set(list.map(n => n.id));
    return search(query, { kind: 'note', filter: n => ids.has(n.id) }).results.map(r => r.item).filter(n => ids.has(n.id));
  }
  const key = sortBy === 'title' ? (a, b) => (a.title || '').localeCompare(b.title || '') : sortBy === 'created' ? (a, b) => b.createdAt - a.createdAt : (a, b) => b.updatedAt - a.updatedAt;
  return list.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || key(a, b));
}
function scopeTitle() {
  if (scope.kind === 'nb') return store.get('notebooks', scope.id)?.name || 'Notebook';
  if (scope.kind === 'tag') return '#' + scope.id;
  if (scope.kind === 'trash') return 'Trash';
  if (scope.kind === 'gone') return 'Recently deleted';
  return 'All notes';
}
/** Start a new note and begin dictating into it right away. */
export function dictateNote(extra = {}) { const n = newNote(extra); dictateOnOpen = n.id; return n; }
let dictateOnOpen = null;
export function newNote(extra = {}) {
  const n = M.addNote({ notebookId: scope.kind === 'nb' ? scope.id : undefined, notebook: 'Notes', tags: scope.kind === 'tag' ? [scope.id] : [], ...extra });
  if (isBlank(n)) fresh.add(n.id);
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
      scope.kind === 'gone' ? h('a', { class: 'btn tiny', href: '#/trash' }, icon('back', 14), 'Trash')
        : scope.kind === 'trash' ? (list.length > 0 && btn('Empty trash', async () => { if (await confirmDlg(`Empty the trash (${list.length} note${list.length === 1 ? '' : 's'})? They stay in “Recently deleted” for ${GONE_DAYS} days, then are removed for good.`, 'Empty trash')) { for (const n of list) M.hideNote(n.id); toast('Trash emptied. Notes can be brought back for 30 days.', 'See them', () => go('#/trash/deleted'), 7000); } }, 'tiny danger'))
        : h('div', { class: 'row' }, iconBtn('more', 'New from template', e => menu(e.currentTarget, Object.keys(TEMPLATES).map(k => ({ label: k + ' template', icon: 'note', onclick: () => newNote({ title: k, body: TEMPLATES[k] }) })))), btn('New note', () => newNote(), 'primary', 'plus'))),
    h('div', { class: 'row gap nfilter' }, search, sort),
    h('div', { class: 'nitems' }, list.map(n => {
      const a = h('a', { class: 'nitem' + (route.view === 'note' && route.id === n.id ? ' on' : ''), href: '#/note/' + n.id },
        h('div', { class: 'ntitle' }, n.pinned && icon('pin', 13), n.title || 'Untitled'),
        h('div', { class: 'nsnip' }, textOf(n).slice(0, 110)),
        h('div', { class: 'nmeta' }, new Date(n.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: new Date(n.updatedAt).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' }),
          (n.attachments || []).length > 0 && h('span', null, icon('clip', 11), n.attachments.length), (n.tags || []).slice(0, 3).map(t => h('span', { class: 'ntag' }, t))));
      if (scope.kind !== 'trash' && scope.kind !== 'gone' && !window.matchMedia('(pointer: fine)').matches) swipeDelete(a, n);
      return h('div', { class: 'nswipe' }, a);
    }),
    !list.length && h('div', { class: 'empty' }, h('strong', null, query ? 'No notes match' : scope.kind === 'trash' ? 'Trash is empty' : scope.kind === 'gone' ? 'Nothing was deleted recently' : 'No notes here yet'), h('p', null, query ? 'Try fewer words.' : scope.kind === 'trash' ? '' : scope.kind === 'gone' ? 'Notes emptied from the trash wait here for 30 days.' : 'Tap New note to start one.')),
    scope.kind === 'gone' && list.length > 0 && h('p', { class: 'sub gone-note' }, `Notes emptied from the trash are kept here for ${GONE_DAYS} days, with their photos and files, then removed for good. Open one to restore it.`),
    scope.kind === 'trash' && h('a', { class: 'rowlink gone-link', href: '#/trash/deleted' }, icon('clock', 16), h('span', { class: 'grow' }, 'Recently deleted'), M.goneNotes().length > 0 && h('span', { class: 'count' }, M.goneNotes().length), icon('right', 14))));
  if (hadFocus) { const s = el.querySelector('.nsearch'); s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
}
/** Phones: swipe a note right to move it to the trash, with Undo at the bottom of the screen. */
function swipeDelete(row, n) {
  row.addEventListener('touchstart', e => {
    if (e.touches.length !== 1) return;
    const s = e.touches[0]; let dx = 0, on = false, dead = false;
    const move = ev => {
      const p = ev.touches[0], x = p.clientX - s.clientX, y = p.clientY - s.clientY;
      if (dead) return;
      if (!on) { if (Math.abs(y) > 10 && Math.abs(y) > Math.abs(x)) { dead = true; return; } if (x < 14) return; on = true; row.classList.add('swiping'); }
      dx = Math.max(0, Math.min(160, x));
      row.style.transform = `translateX(${dx}px)`;
      row.dataset.swipe = dx > 90 ? 'del' : 'del-pre';
    };
    const end = () => {
      document.removeEventListener('touchmove', move); document.removeEventListener('touchend', end); document.removeEventListener('touchcancel', end);
      if (!on) return;
      const swallow = ev => { ev.stopPropagation(); ev.preventDefault(); };
      row.addEventListener('click', swallow, { capture: true, once: true }); setTimeout(() => row.removeEventListener('click', swallow, true), 400);
      row.classList.remove('swiping');
      if (dx <= 90) { row.style.transform = ''; delete row.dataset.swipe; return; }
      navigator.vibrate?.(10);
      row.classList.add('gone'); row.style.transform = 'translateX(110%)';
      setTimeout(() => {
        const open = location.hash === '#/note/' + n.id;
        M.trashNote(n.id);
        toast(`“${(n.title || 'Untitled').slice(0, 40)}” moved to trash`, 'Undo', () => store.patch('notes', n.id, { trashed: false }), 3000);
        if (open) go('#/notes');
      }, 180);
    };
    document.addEventListener('touchmove', move, { passive: true }); document.addEventListener('touchend', end); document.addEventListener('touchcancel', end);
  }, { passive: true });
}

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

/** A note's words as plain text (for sharing): keeps line breaks, list marks and checkboxes; leaves attachments out. */
function plainText(root) {
  let out = '';
  const BLOCK = /^(DIV|P|H[1-6]|LI|BLOCKQUOTE|PRE|TR|UL|OL|TABLE|HR)$/;
  const walk = n => {
    for (const c of n.childNodes) {
      if (c.nodeType === 3) { out += c.data; continue; }
      if (c.nodeType !== 1) continue;
      const t = c.tagName;
      if (t === 'BR') { out += '\n'; continue; }
      if (t === 'IMG' || t === 'AUDIO' || c.classList.contains('att')) continue;
      const block = BLOCK.test(t);
      if (block && out && !out.endsWith('\n')) out += '\n';
      if (t === 'LI') { const p = c.parentElement; out += p.classList.contains('todo') ? (c.hasAttribute('data-checked') ? '☑ ' : '☐ ') : p.tagName === 'OL' ? ([...p.children].indexOf(c) + 1) + '. ' : '• '; }
      if (t === 'HR') out += '———';
      walk(c);
      if (t === 'A') { const href = c.getAttribute('href') || ''; if (/^https?:/i.test(href) && c.textContent.trim() !== href) out += ` (${href})`; }
      if (t === 'TD' || t === 'TH') out += '\t';
      if (block && !out.endsWith('\n')) out += '\n';
    }
  };
  walk(root);
  return out.replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
/** The phone's plus button, inside a note: add from the camera, the photo library or files. */
export function noteAddMenu(anchor) { mounted?.addMenu?.(anchor); }

// ---- editor ------------------------------------------------------------------------
function mountEditor(pane, id) {
  leaveNotes(id);
  if (String(id).startsWith('en:')) { openEvernoteLink(id.slice(3)); return; }
  const n0 = store.get('notes', id);
  if (!n0) { fill(pane, h('div', { class: 'empty' }, h('strong', null, 'Note not found'), h('p', null, 'It may have been deleted on another device.'))); return; }
  const urls = [];
  const trashed = !!n0.trashed;
  const get = () => store.get('notes', id);
  const title = h('input', { class: 'etitle', placeholder: 'Title', value: n0.title || '', readOnly: trashed });
  const body = h('div', { class: 'ebody', contentEditable: trashed ? 'false' : 'true', html: sanitize(n0.body || '') || '<div><br></div>', spellcheck: true });
  let dirty = false, edited = false, idleTimer = 0;
  // Version history: a copy of the note as it was when this editing session began, a copy whenever a save would cut
  // the text to less than half, and a copy of how it stands when the session ends (leaving the note, or 2 minutes idle).
  const sessionCopy = () => { clearTimeout(idleTimer); if (!edited) return; edited = false; const cur = get(); if (cur && !cur.trashed) V.snapshot(cur, 'edit'); };
  const save = now => {
    if (dirty) {
      dirty = false;
      const cur = get(); if (!cur) return;
      const next = serialize(body);
      if (shrunk(cur.body, next)) V.snapshot(cur, 'before a large deletion');
      store.patch('notes', id, { title: title.value.trim(), body: next });
    }
    if (now === true) sessionCopy();
  };
  const queue = debounce(() => save(), 700);
  let orgKick = () => {}; // set once the Organize row exists (dictated words count too)
  const touch = () => {
    if (!edited) { edited = true; const cur = get(); if (cur) V.snapshot(cur, 'before editing'); }
    clearTimeout(idleTimer); idleTimer = setTimeout(() => { save(); sessionCopy(); }, 120000);
    dirty = true; queue(); orgKick();
  };
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
  const photoIn = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true, onchange: () => { attach([...photoIn.files]); photoIn.value = ''; } });
  const addMenu = anchor => {
    if (trashed) { toast('Restore this note to add to it'); return; }
    keepSel();
    menu(anchor, [
      { label: 'Camera', icon: 'camera', onclick: () => camIn.click() },
      { label: 'Photos', icon: 'image', onclick: () => photoIn.click() },
      { label: 'Files', icon: 'clip', onclick: () => fileIn.click() },
    ]);
  };
  const share = async () => {
    save(true);
    const n = get(); if (!n) return;
    const name = n.title || 'Untitled', text = plainText(body);
    const data = { title: name, text: (n.title ? n.title + '\n\n' : '') + text };
    if (navigator.share) {
      const files = [];
      for (const a of n.attachments || []) { const b = await sync.blob(a).catch(() => null); if (b) files.push(new File([b], a.name || 'file', { type: a.mime || b.type || 'application/octet-stream' })); }
      const tries = files.length && navigator.canShare?.({ ...data, files }) ? [{ ...data, files }, data] : [data];
      for (const d of tries) { try { await navigator.share(d); return; } catch (e) { if (e?.name === 'AbortError') return; } }
    }
    try { await navigator.clipboard.writeText(data.text); toast('Note copied. Paste it into a text, email or anywhere else.'); }
    catch { toast('This browser could not share or copy the note'); }
  };
  let rec = null;
  // ---- dictation: speak and the words are typed at the cursor -------------------------------------------------
  let dict = null, bar = null;
  const stopDictation = () => dict?.stop();
  const dictate = () => {
    if (dict) { dict.stop(); return; }
    if (trashed) { toast('Restore this note to add to it'); return; }
    if (savedRange) restoreSel(); else { caretAtEnd(body); keepSel(); }
    bar = listeningBar(stopDictation);
    dictBtn.classList.add('recording');
    dict = listen({
      onFinal: raw => { restoreSel(); insertSpoken(body, raw); touch(); keepSel(); },
      onInterim: t => bar?.set(t),
      onStatus: t => bar?.set(t),
      onEnd: () => {
        dict = null; bar?.remove(); bar = null; dictBtn.classList.remove('recording');
        if (!body.isConnected) return;
        if (!title.value.trim()) { const t = titleFrom(plainText(body)); if (t) { title.value = t; touch(); } }
        save(true);
      },
    });
  };
  const dictBtn = iconBtn('mic', 'Dictate: speak and Steward types', dictate, 'edict');
  dictBtn.addEventListener('pointerdown', e => e.preventDefault()); // keep the cursor where it is
  if (!canDictate() || trashed) dictBtn.hidden = true;
  const recBtn = iconBtn('rec', 'Record audio (saved as a recording in the note)', async () => {
    if (rec) { rec.stop(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const chunks = []; rec = new MediaRecorder(stream);
      rec.ondataavailable = e => chunks.push(e.data);
      rec.onstop = () => { stream.getTracks().forEach(t => t.stop()); const type = rec.mimeType || 'audio/webm'; rec = null; recBtn.classList.remove('recording'); attach([new File(chunks, `Recording ${new Date().toLocaleString().replace(/[/:]/g, '-')}.${type.includes('mp4') ? 'm4a' : 'webm'}`, { type })]); };
      rec.start(); recBtn.classList.add('recording'); toast('Recording… tap the record button again to stop');
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
    if (a && (a.getAttribute('href') || '').startsWith('#/note/en:')) { e.preventDefault(); save(true); openEvernoteLink(a.getAttribute('href').slice(10)); return; }
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
  // Organize: as the note is written, suggest an area, tags, "customer promise" and a notebook; Confirm files it.
  const nbLower = () => { const nb = store.get('notebooks', get()?.notebookId); return nb && !/^notes$/i.test(nb.name) ? nb.name.toLowerCase() : null; };
  const org = orgPanel({ kind: 'note', minWords: 3, delay: 1200,
    text: () => [title.value.trim(), plainText(body)].filter(Boolean).join('. ').slice(0, 2000),
    current: () => readOrg(get()?.tags, { notebook: nbLower() }),
    apply: (fin, removed) => {
      save(true);
      const n = get(); if (!n) return;
      const f = { tags: mergeList(n.tags, fin, removed) };
      if (fin.notebook) { const nb = notebookIdByName(fin.notebook); if (nb && nb !== n.notebookId) { f.notebookId = nb; nbSel.value = nb; } }
      store.patch('notes', id, f); drawTags();
    } });
  if (!trashed) {
    if (hasArea(n0.tags)) org.showDone(readOrg(n0.tags, { notebook: nbLower() })); else org.refresh(true);
    orgKick = () => org.refresh();
  }
  const tasksEl = h('div', { class: 'ntasks' });
  const refreshTasks = () => {
    const list = store.all('tasks').filter(t => t.noteId === id && !t.completedAt);
    const back = liveBacklinks(id);
    fill(tasksEl, back.length > 0 && h('h4', null, 'Notes that link here'), back.map(n => h('a', { class: 'rowlink', href: '#/note/' + n.id }, icon('note', 16), n.title || 'Untitled')), list.length > 0 && h('h4', null, 'Tasks linked to this note'), list.map(t => h('div', { class: `task pri${t.priority || 4}` }, h('button', { class: 'check', 'aria-label': 'Complete', onclick: () => { M.completeTask(t.id); } }, icon('check', 13)), h('div', { class: 'tbody', onclick: () => openTask(t.id) }, h('div', { class: 'tcontent' }, t.content)))));
  };
  refreshTasks();
  const more = e => { const n = get(); menu(e.currentTarget, trashed ? [
    { label: 'Restore note', icon: 'back', onclick: () => { M.restoreNote(id); toast('Note restored'); go('#/note/' + id); } },
    { label: 'Version history', icon: 'clock', onclick: () => versionHistory(id, null) },
    !n.gone && { label: 'Delete forever', icon: 'trash', danger: true, onclick: async () => { if (await confirmDlg(`Delete this note? It stays in “Recently deleted” for ${GONE_DAYS} days, with its attachments, then is removed for good.`)) { mounted = null; M.hideNote(id); go('#/trash'); } } },
  ] : [
    { label: 'Add a task from this note', icon: 'check', onclick: () => openQuickAdd({ noteId: id }) },
    { label: n.pinned ? 'Unpin' : 'Pin to top', icon: 'pin', onclick: () => store.patch('notes', id, { pinned: !n.pinned }) },
    { label: 'Duplicate', icon: 'note', onclick: () => { save(true); const c = get(); const d = M.addNote({ ...c, id: undefined, title: (c.title || 'Untitled') + ' (copy)' }); go('#/note/' + d.id); } },
    { label: 'Print or save as PDF', icon: 'note', onclick: () => window.print() },
    { label: 'Version history', icon: 'clock', onclick: () => { save(true); versionHistory(id, () => mountEditor(pane, id)); } },
    '-',
    { label: 'Move to trash', icon: 'trash', danger: true, onclick: () => { save(true); M.trashNote(id); toast('Note moved to trash', 'Undo', () => store.patch('notes', id, { trashed: false })); go('#/notes'); } },
  ]); };
  fill(pane, 
    h('div', { class: 'ebar' }, iconBtn('back', 'Back to notes', () => { save(true); go(scope.kind === 'nb' ? '#/notes/nb/' + scope.id : scope.kind === 'tag' ? '#/notes/tag/' + encodeURIComponent(scope.id) : scope.kind === 'trash' ? '#/trash' : scope.kind === 'gone' ? '#/trash/deleted' : '#/notes'); }, 'only-mobile'),
      icon('book', 15), nbSel, h('span', { class: 'grow' }), h('span', { class: 'sub saved' }, 'Edited ' + new Date(n0.updatedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })), dictBtn, iconBtn('share', 'Share this note', share, 'eshare'), iconBtn('more', 'Note options', more)),
    trashed && h('div', { class: 'banner' }, n0.gone ? `This note was deleted. It is kept until ${new Date(n0.gone + GONE_DAYS * 864e5).toLocaleDateString(undefined, { month: 'long', day: 'numeric' })}. ` : 'This note is in the trash. ', btn('Restore', () => { M.restoreNote(id); toast('Note restored'); go('#/note/' + id); }, 'tiny')),
    !trashed && toolbar, h('div', { class: 'escroll' }, title, tagsEl, !trashed && org.el, body, n0.sourceUrl && h('div', { class: 'sub src' }, 'Clipped from ', h('a', { href: n0.sourceUrl, target: '_blank', rel: 'noopener' }, n0.sourceUrl.replace(/^https?:\/\//, '').slice(0, 60))), tasksEl), fileIn, camIn, photoIn);
  hydrate(body, n0.attachments, urls);
  mounted = { id, save, urls, refreshTasks, addMenu, stopDictation, isDictating: () => !!dict };
  if (dictateOnOpen === id) { dictateOnOpen = null; if (!trashed) { dictate(); return; } }
  if (!n0.title && !trashed && (!isMobile() || fresh.has(id))) title.focus();
}
window.addEventListener('pagehide', () => { mounted?.stopDictation?.(); mounted?.save(true); });
document.addEventListener('visibilitychange', () => { if (document.hidden) { mounted?.save(true); store.flush().catch(() => {}); } });

// ---- version history ------------------------------------------------------------------------------------------
const WHY = { edit: 'Edited', 'before editing': 'Before editing', 'before a large deletion': 'Before a large deletion', 'before trash': 'Before moving to trash', 'before delete': 'Before deleting',
  'before Claude’s change': 'Before Claude’s change', 'before sync': 'Before a sync replaced it', 'before restoring': 'Before a restore', 'before Writing update': 'Before a newer copy came from Writing' };
/** The list of saved versions of a note; tap one to read it, see what changed, and put it back. */
function versionHistory(id, afterRestore) {
  modal((close, body) => {
    const list = () => {
      const snaps = V.history(id), cur = store.get('notes', id);
      fill(body, h('p', { class: 'sub' }, 'Steward keeps a copy when you finish editing, before a large deletion, and before a note is trashed, changed by Claude or replaced by a sync: the newest 20, plus one a day for 30 days. Both devices share this list.'),
        !snaps.length && h('div', { class: 'empty' }, h('strong', null, 'No saved versions yet'), h('p', null, 'Copies start the next time this note is edited.')),
        h('div', { class: 'vlist' }, snaps.map(sn => h('button', { type: 'button', class: 'vrow', onclick: () => show(sn) },
          h('span', { class: 'grow' }, h('b', null, new Date(sn.at).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })), h('br'), h('small', null, [WHY[sn.why] || 'Saved', sn.device, `${sn.words ?? 0} word${sn.words === 1 ? '' : 's'}`].filter(Boolean).join(' · '))),
          cur && cur.body === sn.body && cur.title === sn.title ? h('span', { class: 'count' }, 'same as now') : icon('right', 14)))));
    };
    const show = sn => {
      const cur = store.get('notes', id);
      let marked = false;
      const view = h('div', { class: 'vprev ebody' });
      const draw = () => {
        const d = marked && cur ? diffWords(plainOf(cur.body), plainOf(sn.body)) : null;
        if (marked && d) fill(view, d.map(x => [h(x.t === 'add' ? 'ins' : x.t === 'del' ? 'del' : 'span', null, x.s), ' ']));
        else { view.innerHTML = sanitize(sn.body || ''); hydrate(view, cur?.attachments || [], mounted?.urls || []); }
      };
      draw();
      const canMark = !!cur && diffWords(plainOf(cur.body), plainOf(sn.body)) !== null && cur.body !== sn.body;
      const toggle = canMark && btn('Show what is different', () => { marked = !marked; toggle.textContent = marked ? 'Show the version itself' : 'Show what is different'; legend.hidden = !marked; draw(); }, 'tiny');
      const legend = h('p', { class: 'sub', hidden: true }, h('ins', null, 'In this version, not in the note now'), ' · ', h('del', null, 'In the note now, not in this version'));
      fill(body, h('div', { class: 'row between wrap' }, btn('All versions', list, 'tiny', 'back'), toggle),
        h('div', { class: 'sub vhead-line' }, new Date(sn.at).toLocaleString(undefined, { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }), ' · ', sn.device || '', ' · ', `${sn.words ?? 0} words`),
        h('h3', { class: 'vtitle' }, sn.title || 'Untitled'), legend, view,
        h('div', { class: 'row end gap' }, btn('Close', close), cur && btn('Restore this version', () => {
          if (V.restore(id, sn.at)) { close(); toast('Version restored. The text from before is in the history too.'); afterRestore?.(); }
        }, 'primary', 'back')));
    };
    list();
  }, { title: 'Version history', cls: 'wide' });
}

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
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); list.querySelector('button')?.click(); } });
    draw();
    return h('div', { class: 'form' }, input, list);
  }, { title: 'Link to a note', cls: 'small' });
}

// ---- clipping -----------------------------------------------------------------------
/** Create a note from something shared into Steward (Android share sheet, Mac bookmark button). */
export async function createClip({ title, text, url, html, files, images, notebook, tags, quiet }) {
  const atts = files?.length ? await filesToAttachments(files) : [];
  const shared = [...atts]; // files shared in go at the end; pictures from the page stay where they were
  let body = '';
  if (html) body += sanitize(html);
  // pictures the page handed over: keep copies in the note, in place of links to the website
  if (body && images?.length) {
    const doc = new DOMParser().parseFromString(`<body>${body}</body>`, 'text/html');
    const pics = new Map();
    for (const im of images) {
      if (!(im?.blob instanceof Blob) || !/^image\//.test(im.blob.type) || pics.has(im.src)) continue;
      const ext = (im.blob.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg').replace(/\W.*/, '');
      const base = decodeURIComponent(String(im.src).split(/[?#]/)[0].split('/').pop() || '').replace(/[^\w.-]+/g, '-').slice(0, 60);
      const a = { id: uid(), name: base && /\.\w{2,4}$/.test(base) ? base : `picture-${pics.size + 1}.${ext}`, mime: im.blob.type, size: im.blob.size };
      await store.putBlob(a.id, im.blob); pics.set(im.src, a); atts.push(a);
    }
    for (const img of doc.body.querySelectorAll('img[src]')) { const a = pics.get(img.getAttribute('src')); if (a) { img.removeAttribute('src'); img.setAttribute('data-att', a.id); if (!img.getAttribute('alt')) img.setAttribute('alt', a.name); } }
    body = doc.body.innerHTML;
  }
  else if (text) body += mdToHtml(text);
  if (url && html === undefined && !(text || '').includes(url)) body += `<div><a href="${esc(url)}">${esc(url)}</a></div>`;
  body += shared.map(attHtml).join('<div><br></div>');
  const n = M.addNote({ title: (title || (text || '').split('\n')[0] || (atts[0]?.name) || 'Clip').slice(0, 140), body, notebook: notebook || 'Clips', tags: [...new Set((tags || []).map(t => String(t).trim()).filter(Boolean))], sourceUrl: url || '', attachments: atts });
  ocr.kick(1500);
  if (quiet) toast(`Clipped “${n.title.slice(0, 60)}” to ${notebook || 'Clips'}`, 'Open', () => go('#/note/' + n.id), 6000);
  else { toast('Saved to the ' + (notebook || 'Clips') + ' notebook'); go('#/note/' + n.id); }
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
    // ENML writes <en-todo/> and <en-media .../> as self-closing tags, which an HTML reader does not honor: it would
    // swallow the rest of the line into them. Close them explicitly first.
    const enml = kid('content').replace(/<(en-todo|en-media)\b([^>]*?)\/\s*>/gi, '<$1$2></$1>');
    const doc = new DOMParser().parseFromString(enml, 'text/html');
    const used = new Set();
    doc.querySelectorAll('en-media').forEach(m => { const a = byHash.get((m.getAttribute('hash') || '').toLowerCase()); if (a) { used.add(a.id); m.outerHTML = attHtml(a); } else m.remove(); });
    enChecklists(doc);
    enNoteLinks(doc);
    const root = doc.querySelector('en-note') || doc.body;
    let body = sanitize(root.innerHTML);
    for (const a of atts) if (!used.has(a.id)) body += attHtml(a);
    const created = enDate(kid('created')), updated = enDate(kid('updated') || kid('created'));
    const src = el.querySelector('note-attributes > source-url')?.textContent || '';
    // keep Evernote's own created and last-edited dates, so "Last edited" sorting still means something
    store.put('notes', { title: kid('title'), body, notebookId, tags: [...el.children].filter(c => c.tagName === 'tag').map(c => c.textContent), pinned: false, sourceUrl: src, attachments: atts, trashed: false, createdAt: created, updatedAt: updated }, { silent: true, keepTimes: true });
    count++; onProgress?.(count, notes.length);
    if (count % 20 === 0) await new Promise(r => setTimeout(r));
  }
  resolveEvernoteLinks();
  store.emit({});
  ocr.kick(3000);
  return count;
}

/** Evernote checkboxes become real Steward checklists. Older notes use <en-todo> inside a line; newer ones mark lists with a style. */
function enChecklists(doc) {
  doc.querySelectorAll('ul, ol').forEach(l => { if (/--en-todo\s*:\s*true/i.test(l.getAttribute('style') || '')) { l.classList.add('todo'); l.removeAttribute('style'); l.querySelectorAll(':scope > li').forEach(li => { if (/--en-checked\s*:\s*true/i.test(li.getAttribute('style') || '')) li.setAttribute('data-checked', '1'); li.removeAttribute('style'); }); } });
  for (const t of [...doc.querySelectorAll('en-todo')]) {
    const checked = t.getAttribute('checked') === 'true';
    const li0 = t.closest('li');
    if (li0) { li0.parentElement?.classList.add('todo'); if (checked) li0.setAttribute('data-checked', '1'); t.remove(); continue; }
    const block = t.closest('div, p') ;
    t.remove();
    if (!block || block.tagName === 'EN-NOTE' || block.querySelector('div, p, ul, ol, table')) { // no line of its own: leave a plain mark
      continue;
    }
    const li = doc.createElement('li'); li.append(...block.childNodes); if (!li.textContent.trim()) li.append(doc.createElement('br'));
    if (checked) li.setAttribute('data-checked', '1');
    const prev = block.previousElementSibling;
    if (prev && prev.tagName === 'UL' && prev.classList.contains('todo') && prev.dataset.en) { prev.append(li); block.remove(); }
    else { const ul = doc.createElement('ul'); ul.className = 'todo'; ul.dataset.en = '1'; ul.append(li); block.replaceWith(ul); }
  }
  doc.querySelectorAll('ul[data-en]').forEach(u => u.removeAttribute('data-en'));
}
/** Links to other Evernote notes: Evernote's export does not say which note they point to, only the link's words,
 *  which are normally the note's title. They become note links that find the note by title. */
const EN_LINK = /^evernote:|evernote\.com\/(?:shard|client|l\/|nl\/|view)|share\.evernote\.com/i;
function enNoteLinks(doc) {
  doc.querySelectorAll('a[href]').forEach(a => {
    if (!EN_LINK.test(a.getAttribute('href') || '')) return;
    const title = a.textContent.trim();
    if (!title) { a.replaceWith(...a.childNodes); return; }
    a.setAttribute('href', '#/note/en:' + encodeURIComponent(title)); a.className = 'nlink';
  });
}
const byTitle = title => { const t = title.trim().toLowerCase(); return M.liveNotes().filter(n => (n.title || '').trim().toLowerCase() === t).sort((a, b) => b.updatedAt - a.updatedAt)[0] || null; };
/** Point Evernote links at the notes they name, now that those notes are here. Runs after each import. */
export function resolveEvernoteLinks() {
  for (const n of M.liveNotes()) {
    if (!(n.body || '').includes('#/note/en:')) continue;
    let changed = false;
    const body = n.body.replace(/href="#\/note\/en:([^"]*)"/g, (all, enc) => { let t; try { t = decodeURIComponent(enc); } catch { return all; } const hit = byTitle(t); if (!hit || hit.id === n.id) return all; changed = true; return `href="#/note/${hit.id}"`; });
    if (changed) store.put('notes', { ...n, body, updatedAt: n.updatedAt + 1 }, { silent: true, keepTimes: true });
  }
}
/** Follow a link to an Evernote note that was not matched at import time. */
export function openEvernoteLink(enc) {
  let t = ''; try { t = decodeURIComponent(enc); } catch {}
  const hit = t && byTitle(t);
  if (hit) { resolveEvernoteLinks(); go('#/note/' + hit.id); }
  else toast(`The note "${t}" has not been brought over from Evernote yet.`);
}

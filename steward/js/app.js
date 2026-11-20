// App shell: start-up, navigation, sidebar, search, settings, clipping intake, reminders.
import { h, fill, today, debounce, fmtDate, fmtTime, ymd, hm, mdToHtml } from './util.js';
import { store, settings } from './store.js';
import * as M from './model.js';
import { sync } from './sync.js';
import { icon, btn, iconBtn, modal, confirmDlg, promptDlg, toast, menu, modalOpen, isMobile, PHONE_MQ } from './ui.js';
import { renderTasks, openQuickAdd, openTask, editProject, projectTree } from './tasks.js';
import { renderNotes, leaveNotes, newNote, dictateNote, noteAddMenu, createClip, importEnex, noteBusy } from './notes.js';
import { canDictate, dictEngine, setDictEngine } from './dictate.js';
import { renderCalendar } from './calendar.js';
import { compileFilter } from './filters.js';
import { renderGoals, activeGoals } from './goals.js';
import { renderStats } from './stats.js';
import { renderReview, ensureReviewTask, reviewSettings } from './review.js';
import { renderFocus, leaveFocus, initFocus, startFamily, openFocusStart, runningSession, familyIdentity } from './focus.js';
import { ocr } from './ocr.js';
import { search, highlight, excerpt } from './search.js';
import { semantic, enabled as semanticOn, status as semStatus } from './semantic.js';
import { importTodoist, describeImport } from './import-todoist.js';
import { hydrate, snapshot, backgroundIsNewer } from './lsmirror.js';
import { adoptLocalWriting } from './migrate.js';
import * as offline from './offline.js';
import { aiOn, keyStatus, saveKey, clearKey } from './ai.js';
import { orgOn, orgModelOn, lessonCount, warmUp as orgWarmUp, AREAS as ORG_AREAS, tagName, tagSlug, contextWordCount } from './organize.js';
import { CONTEXT_ID, CONTEXT_TITLE } from './context-core.js';

const VERSION = '4.9.0';
const WHATS_NEW = `Steward updated to ${VERSION}: new notes open ready to type in the body, Add task closes after each task, and a Sorting context note of your keywords helps file every new entry (Settings → Organize automatically).`;
const $ = s => document.querySelector(s);
let lastRouteKey = '', searchQ = '', installEvt = null;

function parseRoute() {
  const p = location.hash.replace(/^#\/?/, '').split('/');
  const v = p[0] || settings.get('home');
  if (v === 'notes') return { view: 'notes', scope: p[1] === 'nb' ? { kind: 'nb', id: p[2] } : p[1] === 'tag' ? { kind: 'tag', id: decodeURIComponent(p[2] || '') } : { kind: 'all' } };
  return { view: v, id: p[1] };
}
const NOTE_VIEWS = ['notes', 'note', 'trash'];

function render(info = {}) {
  const route = parseRoute(), main = $('#main');
  const key = location.hash;
  drawSidebar(route);
  document.body.dataset.view = route.view;
  $('#fab').setAttribute('aria-label', route.view === 'note' ? 'Add a photo or file to this note' : 'New note');
  if (NOTE_VIEWS.includes(route.view)) { renderNotes(route, main, info); lastRouteKey = key; return; }
  if (route.view === 'settings' && key === lastRouteKey && !info.force && main.querySelector('.settings')) return;
  if (route.view === 'search' && key === lastRouteKey && main.querySelector('.results')) return drawResults();
  // The weekly review: a sync finishing must not take the cursor out of the box being typed in (what is typed is kept as it goes).
  if (route.view === 'review' && key === lastRouteKey && !info.force && main.querySelector('.rv-body') && main.contains(document.activeElement) && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) return;
  leaveNotes();
  if (route.view !== 'focus') leaveFocus();
  const y = key === lastRouteKey ? main.scrollTop : 0;
  main.className = ''; fill(main, );
  if (route.view === 'calendar') renderCalendar(route, main);
  else if (route.view === 'search') viewSearch(main);
  else if (route.view === 'settings') { viewSettings(main); if (route.id === 'blocks') setTimeout(() => document.getElementById('blocks-card')?.scrollIntoView({ block: 'start' }), 30); }
  else if (['goals', 'goal'].includes(route.view)) renderGoals(route, main);
  else if (route.view === 'focus') renderFocus(route, main);
  else if (route.view === 'stats') renderStats(route, main);
  else if (route.view === 'review') renderReview(route, main);
  else if (route.view === 'family-start') { location.replace('#/focus'); setTimeout(() => startFamily(), 60); return; }
  else if (route.view === 'add') { location.replace('#/today'); setTimeout(() => openQuickAdd({}), 50); return; }
  else if (route.view === 'task') { location.replace('#/' + settings.get('home')); const id = decodeURIComponent(route.id || ''); setTimeout(() => openTaskSoon(id), 80); return; }
  else if (route.view === 'new-note') { location.replace('#/notes'); setTimeout(() => newNote(), 60); return; }
  else if (['today', 'upcoming', 'inbox', 'project', 'label', 'filter', 'filters', 'completed'].includes(route.view)) { renderTasks(route, main); const acts = main.querySelector('.vhead > .row'); if (acts && isMobile()) acts.prepend(iconBtn('search', 'Search', () => { location.hash = '#/search'; }, 'hsearch')); }
  else { location.hash = '#/today'; return; }
  main.scrollTop = y; lastRouteKey = key;
}
/** Open a task from a reminder. One this device has not received yet (Claude just added it) is fetched first. */
async function openTaskSoon(id) {
  if (!id) return;
  if (store.get('tasks', id)) return openTask(id);
  if (!sync.connected() || !navigator.onLine) return toast('That task has not reached this device yet. It will be here after the next sync.');
  toast('Getting that task…', null, null, 2500);
  for (let i = 0; i < 2 && !store.get('tasks', id); i++) { await sync.run().catch(() => {}); if (sync.busy) await new Promise(r => setTimeout(r, 1500)); }
  if (store.get('tasks', id)) openTask(id); else toast('That task is not on this device yet. Look in Today after the next sync.');
}
let queued = false, queuedInfo = {};
function schedule(info = {}) {
  queuedInfo = { remote: queuedInfo.remote || info.remote, force: queuedInfo.force || info.force };
  if (queued) return; queued = true;
  requestAnimationFrame(() => { queued = false; const i = queuedInfo; queuedInfo = {}; render(i); });
}

// ---- sidebar ---------------------------------------------------------------------------
function drawSidebar(route) {
  const side = $('#side'), now = today(), open = M.openTasks(), hash = location.hash || '#/' + settings.get('home');
  const link = (href, ic, label, count, extra) => h('a', { class: 'slink' + (hash === href ? ' on' : ''), href, onclick: closeDrawer }, typeof ic === 'string' ? icon(ic, 17) : ic, h('span', { class: 'grow' }, label), count instanceof Node ? count : count ? h('span', { class: 'count' }, count) : null, extra);
  const dot = c => h('span', { class: 'pdot', style: { background: M.COLORS[c] || M.COLORS.stone } });
  const projects = projectTree(), c = M.ctx();
  const favs = [...projects.filter(p => p.favorite).map(p => link('#/project/' + p.id, dot(p.color), p.name, open.filter(t => t.projectId === p.id).length)),
    ...store.all('filters').filter(f => f.favorite).sort((a, b) => a.name.localeCompare(b.name)).map(f => link('#/filter/' + f.id, 'filter', f.name, open.filter(t => compileFilter(f.query, c).some(g => g.test(t))).length))];
  const notes = M.liveNotes(), nbs = store.all('notebooks').sort((a, b) => a.name.localeCompare(b.name)), tags = M.allTags();
  const nbMenu = nb => iconBtn('more', 'Notebook options', e => { e.preventDefault(); e.stopPropagation(); menu(e.currentTarget, [
    { label: 'Rename', icon: 'edit', onclick: async () => { const n = await promptDlg('Rename notebook', nb.name); if (n) store.patch('notebooks', nb.id, { name: n }); } },
    { label: 'Delete notebook', icon: 'trash', danger: true, onclick: async () => { const inside = notes.filter(n => n.notebookId === nb.id); if (await confirmDlg(`Delete "${nb.name}"? Its ${inside.length} notes move to the trash.`)) { for (const n of inside) M.trashNote(n.id); store.remove('notebooks', nb.id); location.hash = '#/notes'; } } },
  ]); }, 'mini');
  const st = sync.status;
  const time = sync.lastSync ? new Date(sync.lastSync).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '';
  // Long label for a full-width sidebar; short one for a narrow window (split screen). Hover shows the long one.
  const [long, short] = st === 'syncing' ? ['Syncing…', 'Syncing…'] : st === 'off' ? (sync.configured() && sync.connected() ? ['Sync', 'Sync'] : ['Not syncing yet', 'Set up']) : st === 'offline' ? ['Offline · saved here', 'Offline'] : st === 'auth' ? (/^Tap once/.test(sync.message) ? ['Tap to stay signed in', 'Tap once'] : sync.code === 'scopes' ? ['Tick every box · tap', 'Tick boxes'] : ['Tap to reconnect', 'Reconnect']) : st === 'error' ? ['Sync problem', 'Problem'] : ['Synced ' + time, time || 'Synced'];
  const pill = h('button', { class: 'syncpill ' + st, title: sync.message || long, onclick: () => { if (!sync.configured()) location.hash = '#/settings'; else sync.run(true); } },
    icon(st === 'offline' || st === 'off' ? 'cloudoff' : 'sync', 14), h('span', { class: 'pl-long' }, long), h('span', { class: 'pl-short' }, short));
  // Sections fold (remembered per device) so a long list of projects or notebooks doesn't bury the rest.
  const folded = k => { try { return localStorage.getItem('steward.fold.' + k) === '1'; } catch { return false; } };
  const sec = (key, title, add, ...body) => {
    const shut = folded(key);
    return h('div', { class: 'ssec' + (shut ? ' shut' : '') },
      h('div', { class: 'shead' }, h('button', { class: 'sfold', type: 'button', 'aria-expanded': String(!shut), onclick: e => { const s = e.currentTarget.closest('.ssec'); const now2 = !s.classList.toggle('shut'); e.currentTarget.setAttribute('aria-expanded', String(now2)); try { localStorage.setItem('steward.fold.' + key, now2 ? '' : '1'); } catch {} } }, icon('down', 12), title), add),
      h('div', { class: 'sbody' }, body));
  };
  const todayCount = open.filter(t => t.due && t.due.date <= now && !t.parentId).length;
  fill(side,
    h('div', { class: 'brand' }, h('img', { src: 'icons/mark.png', alt: '', width: 40, height: 40 }), h('strong', null, 'Steward'), h('span', { class: 'grow' }), pill),
    h('div', { class: 'addline' }, h('button', { class: 'btn primary wide', onclick: () => { closeDrawer(); openQuickAdd(defaultsForRoute()); } }, icon('plus', 16), 'Add task', h('kbd', { class: 'only-desktop' }, 'Q')), canDictate() && iconBtn('mic', 'Speak tasks (D)', () => { closeDrawer(); openQuickAdd({ ...defaultsForRoute(), dictate: true }); }), iconBtn('sidebar', 'Hide sidebar (⌘\\)', toggleSide, 'only-desktop')),
    h('button', { class: 'sside-search', type: 'button', onclick: () => { closeDrawer(); location.hash = '#/search'; } }, icon('search', 16), h('span', { class: 'grow' }, 'Search everything'), h('kbd', { class: 'only-desktop' }, '⌘K')),
    h('nav', null,
      link('#/inbox', 'inbox', 'Inbox', open.filter(t => !t.parentId).length),
      link('#/today', 'today', 'Today', todayCount ? h('span', { class: 'badge' + (open.some(t => t.due && t.due.date < now) ? ' late' : '') }, todayCount) : 0),
      link('#/upcoming', 'upcoming', 'Upcoming'),
      link('#/calendar', 'cal', 'Calendar'),
      link('#/filters', 'filter', 'Filters & labels'),
      link('#/completed', 'done', 'Completed'),
      sec('plan', 'Goals & review', null,
        link('#/goals', 'flag', 'Goals', activeGoals().length),
        link('#/focus', 'clock', 'Focus', runningSession() ? h('span', { class: 'badge' }, 'on') : 0),
        link('#/stats', 'board', 'Stats'),
        link('#/review', 'done', 'Weekly review')),
      favs.length > 0 && sec('favs', 'Favorites', null, favs),
      sec('projects', 'Projects', iconBtn('plus', 'New project', () => editProject(), 'mini'),
        projects.map(p => h('div', { style: { paddingLeft: p.depth * 14 + 'px' } }, link('#/project/' + p.id, dot(p.color), p.name, open.filter(t => t.projectId === p.id).length))),
        !projects.length && h('div', { class: 'snote' }, 'No projects yet')),
      sec('notes', 'Notes', iconBtn('plus', 'New notebook', async () => { const n = await promptDlg('New notebook', '', 'Notebook name'); if (n) { location.hash = '#/notes/nb/' + M.ensureNotebook(n); } }, 'mini'),
        link('#/notes', 'note', 'All notes', notes.length),
        nbs.map(nb => link('#/notes/nb/' + nb.id, 'book', nb.name, notes.filter(n => n.notebookId === nb.id).length, nbMenu(nb))),
        tags.length > 0 && h('details', { class: 'stags', open: localStorage.getItem('steward.tagsOpen') === '1', ontoggle: e => localStorage.setItem('steward.tagsOpen', e.currentTarget.open ? '1' : '0') }, h('summary', null, icon('tag', 17), h('span', { class: 'grow' }, 'Tags'), h('span', { class: 'count' }, tags.length)), tags.map(([t, n]) => link('#/notes/tag/' + encodeURIComponent(t), 'tag', t, n))),
        link('#/trash', 'trash', 'Trash')),
      h('div', { class: 'sfoot' }, link('#/settings', 'gear', 'Settings'))));
  for (const a of document.querySelectorAll('#tabs a')) a.classList.toggle('on', a.getAttribute('href') === hash || !!(a.dataset.match && new RegExp(a.dataset.match).test(hash)));
}
function defaultsForRoute() {
  const r = parseRoute();
  if (r.view === 'today') return { due: { date: today(), time: null, recur: null } };
  if (r.view === 'project') return { projectId: r.id };
  if (r.view === 'label') return { labels: [decodeURIComponent(r.id)] };
  return {};
}
const closeDrawer = () => document.body.classList.remove('drawer');
// Keyboard: "g" then a letter jumps to a screen; "?" shows every shortcut.
let goPending = 0;
const GO = { r: '#/review', a: '#/stats', f: '#/focus', o: '#/goals', t: '#/today', i: '#/inbox', u: '#/upcoming', c: '#/calendar', n: '#/notes', s: '#/settings' };
function shortcuts() {
  const rows = [['Q', 'Add a task'], ['D', 'Speak tasks'], ['N', 'New note'], ['/  or  ⌘K', 'Search everything'], ['⌘\\', 'Show or hide the sidebar'], ['G then T', 'Today'], ['G then I', 'Inbox'], ['G then U', 'Upcoming'], ['G then C', 'Calendar'], ['G then N', 'Notes'], ['G then O', 'Goals'], ['G then F', 'Focus'], ['G then A', 'Stats'], ['G then R', 'Weekly review'], ['Esc', 'Close a window'], ['?', 'This list']];
  modal(() => h('div', { class: 'keys' }, rows.map(([k, l]) => h('div', { class: 'krow' }, h('span', null, l), h('span', null, k.split('  or  ').map((x, i) => [i ? ' or ' : '', ...x.split(' then ').map((y, j) => [j ? ' then ' : '', h('kbd', null, y)])]))))), { title: 'Keyboard shortcuts', cls: 'small' });
}
// Desktop: hide the sidebar for a wider work area (button or ⌘\). Remembered on this computer.
const setSideHidden = on => { document.body.classList.toggle('side-hidden', on); try { localStorage.setItem('steward.sideHidden', on ? '1' : ''); } catch {} };
const toggleSide = () => { setSideHidden(!document.body.classList.contains('side-hidden')); if (parseRoute().view === 'calendar') schedule({ force: true }); };

// ---- search -------------------------------------------------------------------------------
let searchKind = '';
function viewSearch(main) {
  const input = h('input', { class: 'field big', type: 'search', placeholder: 'Search tasks, notes and attachments', value: searchQ, autofocus: true, oninput: debounce(() => { searchQ = input.value; drawResults(); }, 120) });
  const chips = h('div', { class: 'seg skinds' }, [['', 'Everything'], ['task', 'Tasks'], ['note', 'Notes']].map(([k, l]) => h('button', { type: 'button', class: k === searchKind ? 'on' : '', onclick: e => { searchKind = k; chips.querySelectorAll('button').forEach(b => b.classList.remove('on')); e.currentTarget.classList.add('on'); drawResults(); } }, l)));
  main.append(h('header', { class: 'vhead' }, h('div', null, h('h1', null, 'Search'))), input, chips, h('div', { class: 'results' }),
    h('details', { class: 'help' }, h('summary', null, 'Search tips'), h('div', { html: 'Words can be in any order and partly typed. Small typos are forgiven when nothing else matches.<br><code>"exact phrase"</code> <code>-word</code> to leave something out<br><code>tag:receipts</code> <code>notebook:clips</code> <code>has:file</code> <code>in:notes</code><br><code>@promise</code> <code>project:hanel</code> <code>is:done</code> <code>in:tasks</code>' })));
  drawResults();
  if (!isMobile()) setTimeout(() => input.focus(), 30);
}
function drawResults() {
  const el = $('.results'); if (!el) return;
  if (!searchQ.trim()) return fill(el, h('div', { class: 'empty' }, h('strong', null, 'Search everything'), h('p', null, 'Tasks, notes, comments, tags, and the text inside photos and PDFs.')));
  const { q, results, fuzzy } = search(searchQ, { kind: searchKind || undefined });
  const shown = results.slice(0, 80);
  const row = r => r.kind === 'task'
    ? h('button', { class: 'rowlink sres' + (r.item.completedAt ? ' done' : ''), onclick: () => openTask(r.item.id) }, icon(r.item.completedAt ? 'done' : 'check', 16), h('span', { class: 'grow' }, h('span', { class: 'stitle' }, highlight(r.title, (r._terms || q.terms))), (r.where.has('body')) && h('small', null, excerpt(r, (r._terms || q.terms))), h('small', { class: 'smeta' }, `Task · ${M.projectName(r.item.projectId)}${r.item.due ? ' · ' + fmtDate(r.item.due.date) : ''}${r.item.completedAt ? ' · completed' : ''}${(r.item.labels || []).length ? ' · @' + r.item.labels.join(' @') : ''}`)))
    : h('a', { class: 'rowlink sres', href: '#/note/' + r.item.id }, icon('note', 16), h('span', { class: 'grow' }, h('span', { class: 'stitle' }, highlight(r.title, (r._terms || q.terms))), h('small', null, excerpt(r, (r._terms || q.terms))), h('small', { class: 'smeta' }, `Note · ${store.get('notebooks', r.item.notebookId)?.name || ''} · ${new Date(r.item.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}${(r.item.tags || []).length ? ' · ' + r.item.tags.join(', ') : ''}`)));
  fill(el, h('div', { class: 'sub scount' }, results.length ? `${results.length} result${results.length === 1 ? '' : 's'}${results.length > 80 ? ', showing the best 80' : ''}${fuzzy ? ' · including close spellings' : ''}` : ''),
    h('div', { class: 'rows' }, shown.map(row)),
    !results.length && h('div', { class: 'empty nores' }, h('strong', null, 'No exact matches'), h('p', null, semanticOn() ? 'Looking for notes and tasks with a similar meaning…' : 'Try fewer or shorter words.')),
    h('div', { class: 'meaning' }));
  drawMeaning(searchQ, new Set(shown.slice(0, 12).map(r => r.kind + r.item.id)), row);
}
let meaningRun = 0;
async function drawMeaning(query, have, row) {
  const box = $('.results .meaning'); if (!box) return;
  const plain = query.replace(/\b\w+:\S+/g, '').replace(/["@-]/g, ' ').trim();
  if (!semanticOn()) { if (isMobile() || !window.matchMedia('(pointer: fine)').matches) fill(box, h('p', { class: 'sub' }, 'Search by meaning is off on this device. ', h('a', { href: '#/settings' }, 'Turn it on in Settings'), ' (one-time download of about 35 MB).')); return; }
  if (plain.length < 3) return;
  const my = ++meaningRun;
  let hits;
  try { hits = await semantic.query(plain, { kind: searchKind || undefined, limit: 10 }); }
  catch (e) { if (my === meaningRun) fill(box, h('p', { class: 'sub' }, navigator.onLine ? 'Search by meaning is not available right now.' : 'Search by meaning needs one online visit to download. It will work offline after that.')); return; }
  if (my !== meaningRun || !box.isConnected) return;
  hits = hits.filter(r => !have.has(r.kind + r.item.id));
  const progress = semStatus.total && semStatus.done < semStatus.total ? ` Still reading your notes: ${semStatus.done} of ${semStatus.total}.` : '';
  const nores = $('.results .nores p'); if (nores) nores.textContent = hits.length ? 'But these look related.' : 'Nothing similar in meaning either. Try other words.';
  if (!hits.length) return fill(box, progress && h('p', { class: 'sub' }, progress.trim()));
  const terms = plain.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  fill(box, h('section', { class: 'group' }, h('div', { class: 'ghead' }, h('h3', null, 'Related by meaning'), h('span', { class: 'sub' }, progress.trim())),
    h('div', { class: 'rows' }, hits.map(r => row({ ...r, where: new Set(['body']), body: r.text, atts: [], _terms: terms })))));
}
const snippet = (text, w) => { const i = text.toLowerCase().indexOf(w); return text.slice(Math.max(0, i - 30), i + 60).replace(/\s+/g, ' ').trim(); };

// ---- settings --------------------------------------------------------------------------------
// The sorting-context note (js/context-core.js): his keywords by area, checked for every new task and note, on the
// device and by Claude. It is a note in his Drive; the names in it never live in this public code.
const CONTEXT_SKELETON = `Steward checks every new task and note against this note to sort it. Under each area heading, write lines like **Label: word, word, word**. The label is not a keyword; each word after the colon is. Add **(project Name)**, **(notebook Name)** or **(tag a, b)** to a heading or label to file matches there.

## CS Outdoors (project CS Outdoors)
- Customers:
- Crew:
- Suppliers:

## Seminary (project Seminary Fall 2026)
- Courses:

## Church (project Church Life)
- People:

## Home/Family (project Home Life)
- Family:

## Personal
- Words:

## Customer promises
- Phrases:

## Notes for Claude
Anything here is guidance for Claude only, not keywords.`;
function contextRow() {
  const n = store.get('notes', CONTEXT_ID);
  if (!n || n.trashed) return h('p', { class: 'sub' }, 'Sorting context: a note of your keywords by area (customers, crew, family, church, courses) that every new entry is checked against. ',
    btn('Start the sorting-context note', () => { M.addNote({ id: CONTEXT_ID, title: CONTEXT_TITLE, notebook: 'Steward', tags: ['steward'], body: mdToHtml(CONTEXT_SKELETON) }); location.hash = '#/note/' + CONTEXT_ID; }, 'tiny'));
  const c = contextWordCount();
  return h('p', { class: 'sub' }, `Sorting context: ${c} keyword${c === 1 ? '' : 's'} by area, checked for every new task and note (here on the device, and by Claude when it is on). `,
    h('a', { href: '#/note/' + CONTEXT_ID }, 'Open the note to edit it'));
}
// Settings → Organize automatically: on/off, the language model, what it has learned, and the names it knows.
function orgCard(card, again) {
  const on = h('input', { type: 'checkbox', checked: orgOn(), onchange: () => { settings.set('orgOn', on.checked); again(); } });
  const mdl = h('input', { type: 'checkbox', checked: orgModelOn(), onchange: () => settings.set('orgModel', mdl.checked) });
  const words = store.all('orgwords').sort((a, b) => a.word.localeCompare(b.word));
  const areaSel = (v = '') => { const s = h('select', { class: 'field slim', 'aria-label': 'Area' }, h('option', { value: '' }, 'No area'), ORG_AREAS.map(a => h('option', { value: a.id }, a.name))); s.value = v || ''; return s; };
  const w = h('input', { class: 'field', placeholder: 'Name or word, e.g. a customer or family member' });
  const a = areaSel(), t = h('input', { class: 'field', placeholder: 'Tags it brings (comma between), optional' });
  const addWord = () => {
    const word = w.value.trim(); if (word.length < 2) return toast('Type the name or word first');
    const tags = t.value.split(',').map(tagSlug).filter(Boolean);
    const cur = store.all('orgwords').find(x => x.word.toLowerCase() === word.toLowerCase());
    store.put('orgwords', { ...(cur || {}), word, area: a.value || null, tags });
    again();
  };
  const n = lessonCount();
  return card('Organize automatically',
    h('p', { class: 'sub' }, 'As you write a task or note, Steward suggests an area (CS Outdoors, Seminary, Church, Home/Family, Personal), finer tags, “customer promise”, and a project or notebook. Nothing is filed until you press ', h('b', null, 'Confirm'), '. Every confirmation, and every suggestion you take off, teaches it. It all runs on this device.'),
    h('label', { class: 'inline block' }, on, h('span', { class: 'grow' }, 'Suggest organization for new tasks and notes')),
    h('label', { class: 'inline block' }, mdl, h('span', { class: 'grow' }, 'Also compare by meaning with the on-device language model (the same one as Search by meaning; works offline once downloaded)')),
    h('p', { class: 'sub' }, n ? `Learned from ${n} confirmation${n === 1 ? '' : 's'}. ` : 'Nothing learned yet: it starts from built-in rules and gets better with each Confirm. ',
      'What it learns is saved in your Google Drive (Steward/steward-organize.json) and synced, so your phone and Mac make the same suggestions.'),
    contextRow(),
    h('details', null, h('summary', null, `Names and words it knows (${words.length})`),
      h('p', { class: 'sub' }, 'People, customers and places that always mean an area: “Elise” → Home/Family, a customer’s name → CS Outdoors. Synced to all your devices.'),
      h('div', { class: 'orgwords' }, words.map(x => h('div', { class: 'row gap orgword' },
        h('b', null, x.word), h('span', { class: 'sub grow' }, [x.area && ORG_AREAS.find(r => r.id === x.area)?.name, ...(x.tags || []).map(tagName)].filter(Boolean).join(' · ') || '—'),
        h('button', { class: 'linkbtn', onclick: () => { store.remove('orgwords', x.id); again(); } }, 'Remove')))),
      h('div', { class: 'row gap wrap' }, w, a, t, btn('Add', addWord, 'primary'))),
    h('div', { class: 'row gap wrap' }, n > 0 && btn('Forget what it has learned', async () => {
      if (!(await confirmDlg(`Forget all ${n} confirmations on every device? Suggestions go back to the built-in rules. Names and words it knows are kept.`, 'Forget'))) return;
      for (const l of store.all('lessons')) store.remove('lessons', l.id, { silent: true });
      store.emit({ type: 'lessons', local: true }); toast('Forgotten'); again();
    }, 'danger')));
}

// Settings → Claude: Haiku sorts new tasks and notes, Sonnet plans the day. The API key is kept in
// the Steward helper (his Google Apps Script), never on this device or in Steward's public code.
function aiCard(card, again) {
  const intro = h('p', { class: 'sub' }, 'With signal, Claude Haiku sorts each new task and note (area, tags, customer promise, project), and Claude Sonnet can ',
    h('b', null, 'Plan with Claude'), ' on Today. The words you are working on are sent to Anthropic to answer; nothing is filed or changed until you confirm. With no signal, the on-device organizer does the sorting as before.');
  if (!sync.helperUrl()) return card('Claude', intro, h('p', null, 'This needs the Steward helper, which connects once Google sync is set up.'));
  const status = h('p', { class: 'sub' }, 'Checking…');
  const keyIn = h('input', { class: 'field mono', type: 'password', autocomplete: 'off', placeholder: 'sk-ant-…  (from console.anthropic.com → API keys)' });
  const on = h('input', { type: 'checkbox', checked: aiOn(), onchange: () => { settings.set('aiOn', on.checked); toast(on.checked ? 'Claude on' : 'Claude off: sorting stays on this device'); } });
  const keyRow = h('div', { class: 'row gap wrap' }, keyIn, btn('Save key', async () => {
    const k = keyIn.value.trim(); if (!k) return toast('Paste the key first');
    try { const r = await saveKey(k); keyIn.value = ''; settings.set('aiOn', true); toast(r.warning || 'Key saved. Claude is on.'); again(); }
    catch (e) { toast(String(e.message || e).replace(/^Steward helper: /, '')); }
  }, 'primary'));
  const extra = h('div');
  keyStatus().then(r => {
    if (!status.isConnected) return;
    const u = r.usage || {};
    status.textContent = r.hasKey ? `Your key is saved in your Steward helper (shared by your phone and Mac). This month: ${u.calls || 0} request${u.calls === 1 ? '' : 's'}, about $${(u.cost || 0).toFixed(2)}.` : 'No API key yet. Paste one below to turn Claude on.';
    fill(extra, r.hasKey ? h('div', null, h('label', { class: 'inline block' }, on, h('span', { class: 'grow' }, 'Use Claude when there is signal (on all your devices)')),
      h('details', null, h('summary', null, 'Replace or remove the key'), keyRow, btn('Remove key', async () => { await clearKey().catch(() => {}); settings.set('aiOn', false); toast('Key removed'); again(); }, 'danger tiny'))) : keyRow);
  }).catch(e => { if (status.isConnected) status.textContent = /unknown request/.test(e.message) ? 'The Steward helper needs its update before Claude can be used.' : 'The Steward helper could not be reached right now.'; });
  return card('Claude', intro, status, extra);
}

function viewSettings(main) {
  const again = () => render({ force: true });
  const card = (title, ...kids) => h('section', { class: 'card' }, h('h3', null, title), kids);
  const appUrl = location.origin + location.pathname;
  // Google
  const g = [];
  if (!sync.configured()) {
    const id = h('input', { class: 'field mono', placeholder: '1234567890-abc…apps.googleusercontent.com' });
    g.push(h('p', null, 'Steward keeps everything on this device and works without a connection. To sync between your Mac and phone, back up to Google Drive, show Google Calendar and get phone reminders, connect it to your Google account once.'),
      h('p', null, 'Paste the Google client ID from the setup guide:'), h('div', { class: 'row gap' }, id, btn('Save', () => { const v = id.value.trim(); if (!/\.apps\.googleusercontent\.com$/.test(v)) return toast('That does not look like a client ID. It ends in apps.googleusercontent.com'); settings.set('clientId', v); again(); }, 'primary')));
  } else if (!sync.connected()) {
    g.push(h('p', null, 'Ready to connect. Google will ask you to let Steward use the files it makes in your Drive (only its own files, nothing else).'),
      h('div', { class: 'row gap wrap' }, btn('Connect Google account', () => sync.connect().then(again).catch(e => toast('Google sign-in did not finish: ' + e.message)), 'primary')),
      sync.status === 'auth' || sync.status === 'error' ? h('p', { class: 'sub', id: 'sync-line' }, syncLine()) : null);
  } else {
    g.push(h('p', null, 'Connected', sync.email() ? ' as ' + sync.email() : '', '. Data is saved in the ', h('b', null, 'Steward'), ' folder in your Google Drive.'),
      h('p', { class: 'sub', id: 'sync-line' }, syncLine()),
      sync.code === 'no-folder' ? h('div', { class: 'row gap wrap' }, btn('Start a new, empty Steward in this account instead', async () => { if (await confirmDlg('Make a new, empty Steward folder in this Google account? Only do this if you have never used Steward with another account.', 'Start new')) sync.startFresh().then(again); }, 'link')) : null,
      h('p', { class: 'sub', id: 'bg-line' }, bgLine()),
      sync.helperUrl() ? h('p', { class: 'sub' }, '✓ Steward helper connected (Claude’s changes, your calendar and notifications).')
        : h('p', { class: 'sub' }, 'Waiting for the Steward helper: until it is connected, your calendar, notifications and Claude’s note changes will not come through.'),
      sync.staysSignedIn() ? h('p', { class: 'sub' }, '✓ Stays signed in on this device — no reconnecting needed.')
        : sync.secret() ? h('p', { class: 'sub' }, 'One step left on this device: tap ', h('b', null, 'Stay signed in'), ' and allow Steward in the Google window.')
        : h('details', null, h('summary', { class: 'sub' }, 'Stop having to reconnect to Google'),
          h('p', { class: 'sub' }, 'Paste the client secret from the Google Cloud console (APIs & Services → Credentials → the Steward web client). You only do this on one device: your others pick it up from your Drive on their next sync.'),
          (() => { const sec = h('input', { class: 'field mono', placeholder: 'GOCSPX-…', autocomplete: 'off' }); return h('div', { class: 'row gap' }, sec, btn('Save', () => { const v = sec.value.trim(); if (!/^GOCSPX-/.test(v)) return toast('A client secret starts with GOCSPX-'); sync.setSecret(v); sync.run(true).then(again); }, 'primary')); })()),
      h('div', { class: 'row gap' }, sync.secret() && !sync.staysSignedIn() ? btn('Stay signed in', () => sync.run(true).then(again), 'primary') : null, btn('Sync now', () => sync.run(true), sync.secret() && !sync.staysSignedIn() ? '' : 'primary', 'sync'), btn('Disconnect', async () => { if (await confirmDlg('Disconnect this device from Google? Your data stays on this device and in Drive.', 'Disconnect')) { sync.disconnect(); again(); } }, 'link')));
  }
  // Reminders
  const auto = h('input', { type: 'checkbox', checked: settings.get('autoRemind'), onchange: () => { settings.set('autoRemind', auto.checked); if (sync.connected()) sync.run(); } });
  const lead = h('select', { class: 'field slim', onchange: () => { settings.set('remindLead', +lead.value); if (sync.connected()) sync.run(); } }, [[0, 'at the due time'], [10, '10 minutes before'], [30, '30 minutes before'], [60, '1 hour before']].map(([v, l]) => h('option', { value: v }, l)));
  lead.value = settings.get('remindLead');
  // Calendars
  const hidden = settings.get('hidden');
  const cals = sync.calendars().filter(c => c.summary !== 'Steward Reminders');
  const timeIn = k => { const i = h('input', { type: 'time', class: 'field slim', value: settings.get(k), onchange: () => { if (i.value) settings.set(k, i.value); } }); return i; };
  const restSel = h('select', { class: 'field slim', onchange: () => settings.set('restDay', +restSel.value) }, h('option', { value: -1 }, 'none'), ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((d, i) => h('option', { value: i }, d)));
  restSel.value = settings.get('restDay');
  const ws = h('select', { class: 'field slim', onchange: () => settings.set('weekStart', +ws.value) }, h('option', { value: 0 }, 'Sunday'), h('option', { value: 1 }, 'Monday'));
  ws.value = settings.get('weekStart');
  const theme = h('select', { class: 'field slim', onchange: () => { settings.set('theme', theme.value); applyTheme(); } }, [['auto', 'Match my device'], ['light', 'Light'], ['dark', 'Dark']].map(([v, l]) => h('option', { value: v }, l)));
  theme.value = settings.get('theme');
  const home = h('select', { class: 'field slim', onchange: () => settings.set('home', home.value) }, [['today', 'Today'], ['inbox', 'Inbox'], ['upcoming', 'Upcoming'], ['calendar', 'Calendar'], ['notes', 'Notes']].map(([v, l]) => h('option', { value: v }, l)));
  home.value = settings.get('home');
  const semBox = h('input', { type: 'checkbox', checked: semanticOn(), onchange: () => { settings.set('semantic', semBox.checked); if (semBox.checked) semantic.kick(500); const l = $('#sem-line'); if (l) l.textContent = semLine(); } });
  // The "Clip to Steward" bookmark. It opens Steward, waits for Steward to say it is ready, then hands over the whole
  // article and copies of its pictures (fetched by the page itself, which is allowed to read them), so a clip keeps its
  // images even if the website changes. If the hand-over cannot happen, the text still arrives in the address.
  const bookmarklet = `javascript:(()=>{const A=${JSON.stringify(appUrl)},O=${JSON.stringify(location.origin)};const s=getSelection();let r;if(s&&s.rangeCount&&!s.isCollapsed){r=document.createElement('div');r.append(s.getRangeAt(0).cloneContents())}else{r=(document.querySelector('article,main,[role=main]')||document.body).cloneNode(true)}r.querySelectorAll('script,style,noscript,iframe,svg,form,button,nav').forEach(x=>x.remove());r.querySelectorAll('img').forEach(i=>{const u=i.getAttribute('data-src')||i.getAttribute('data-lazy-src')||i.getAttribute('data-original')||i.src;if(u){try{i.setAttribute('src',new URL(u,location.href).href)}catch(_){}}i.removeAttribute('srcset');i.removeAttribute('loading')});const h=r.innerHTML,im=[...new Set([...r.querySelectorAll('img')].map(i=>i.getAttribute('src')).filter(u=>/^https?:/.test(u||'')))].slice(0,40);const w=open(A+'#clip='+encodeURIComponent(JSON.stringify({u:location.href,t:document.title,h:h.slice(0,200000),w:1})));const f=async e=>{if(e.source!==w||e.data!=='steward-ready')return;removeEventListener('message',f);const fs=[];for(const u of im){try{const b=await(await fetch(u)).blob();if(b.size>1500&&b.size<15e6&&/^image\\//.test(b.type))fs.push({src:u,blob:b})}catch(_){}}w.postMessage({steward:'clip',u:location.href,t:document.title,h,files:fs},O)};addEventListener('message',f)})()`;
  const clipLink = h('a', { class: 'btn', onclick: e => { e.preventDefault(); toast('Drag this button onto your bookmarks bar'); } }, 'Clip to Steward');
  clipLink.setAttribute('href', bookmarklet);
  const enex = h('input', { type: 'file', accept: '.enex', multiple: true, hidden: true, onchange: async () => {
    const prog = h('p', null, 'Reading…'); const close = modal(() => prog, { title: 'Importing from Evernote', cls: 'small' });
    let total = 0;
    let already = 0;
    try { for (const f of enex.files) { const r = await importEnex(f, (i, n) => { prog.textContent = `${f.name}: ${i} of ${n} notes`; }); total += r.added; already += r.already; } prog.textContent = `Imported ${total} note${total === 1 ? '' : 's'}.` + (already ? ` ${already} ${already === 1 ? 'was' : 'were'} already here and left as ${already === 1 ? 'it is' : 'they are'}.` : ''); if (sync.connected()) sync.run(); }
    catch (e) { prog.textContent = 'Import stopped: ' + e.message; }
    enex.value = ''; setTimeout(close, 4500);
  } });
  const restore = h('input', { type: 'file', accept: '.json', hidden: true, onchange: async () => { try { const n = store.importAll(JSON.parse(await restore.files[0].text())); toast(`Restored ${n} items`); } catch { toast('That file is not a Steward backup'); } restore.value = ''; } });
  const keepBox = h('input', { type: 'checkbox', checked: offline.keepFiles(), onchange: () => offline.setKeepFiles(keepBox.checked) });
  setTimeout(offLine, 0); setTimeout(speechLine, 0);
  main.append(h('div', { class: 'settings' }, h('header', { class: 'vhead' }, h('div', null, h('h1', null, 'Settings'))),
    card('Google account and sync', g),
    card('Reminders', h('p', { class: 'sub' }, 'These apply on all your devices.'),
      settings.get('remindersPaused') && h('div', { class: 'banner' }, 'Steward’s reminders are on hold so they do not double up with Todoist. ', btn('Turn reminders on', () => { settings.set('remindersPaused', false); if (sync.connected()) sync.run(); again(); }, 'tiny primary')),
      h('label', { class: 'inline nowrap' }, auto, h('span', { class: 'grow' }, 'Remind me about every task that has a time')),
      h('label', { class: 'inline block' }, 'When: ', lead),
      pushPanel(again)),
    card('Calendar', cals.length ? h('div', null, h('p', { class: 'sub' }, 'Calendars to show:'), cals.map(c => { const cb = h('input', { type: 'checkbox', checked: !hidden.includes(c.id), onchange: () => { const hd = new Set(settings.get('hidden')); cb.checked ? hd.delete(c.id) : hd.add(c.id); settings.set('hidden', [...hd]); sync.refreshEvents().catch(() => {}); } }); return h('label', { class: 'inline block' }, cb, h('span', { class: 'pdot', style: { background: c.backgroundColor } }), c.summary); })) : h('p', { class: 'sub' }, 'Your Google calendars appear here once connected.'),
      h('label', { class: 'inline' }, 'Week starts on ', ws)),
    card('Day plan', h('p', { class: 'sub' }, 'Today and Upcoming add up the time on each day’s tasks (and, on Today, anything overdue) and compare it with the hours you can plan in, after your fixed blocks and calendar events. These settings apply on all your devices.'),
      hoursEditor(again), h('label', { class: 'inline block' }, 'Rest day ', restSel)),
    h('section', { class: 'card', id: 'blocks-card' }, h('h3', null, 'Fixed blocks'), blocksEditor(again)),
    card('Weekly review', reviewSettings(again)),
    card('Use with no signal', h('p', { class: 'sub' }, 'Steward keeps your tasks, notes and calendar on this device, so it opens and works with no connection. Changes you make offline sync when the signal comes back. Adding or changing Google Calendar events still needs a connection.'),
      h('label', { class: 'inline nowrap' }, keepBox, h('span', { class: 'grow' }, 'Keep a copy of every photo, PDF and recording on this device')),
      h('div', { class: 'row gap wrap' }, btn('Download everything to this device', async () => { if (!navigator.onLine) return toast('Connect to the internet first (Wi-Fi is best: about 140 MB plus your attachments).'); await offline.downloadAll(); offLine(); }, 'primary', 'download')),
      h('p', { class: 'sub', id: 'off-line' }, 'Checking…'), h('p', { class: 'sub', id: 'off-busy' }, offline.state.line)),
    card('Speak instead of type', h('p', { class: 'sub' }, 'Dictation for tasks and notes. Steward has its own speech model that runs only on this device, so speaking works with no signal and nothing you say leaves the phone or Mac. Chrome’s speech service is a little quicker when there is signal.'),
      ...[['auto', 'Automatic: Chrome’s speech service when there is signal, the model on this device when there is not (switches over by itself if the signal drops)'], ['device', 'Always use the model on this device (private; works anywhere; each phrase appears a moment after you pause)']]
        .map(([v, label]) => h('label', { class: 'inline block' }, h('input', { type: 'radio', name: 'dict-engine', value: v, checked: dictEngine() === v, onchange: () => { setDictEngine(v); speechLine(); } }), h('span', { class: 'grow' }, label))),
      h('div', { class: 'row gap wrap' }, btn('Download the speech model', async () => { if (!navigator.onLine) return toast('Connect to the internet first (Wi-Fi is best: about 77 MB).'); await offline.downloadSpeech(); speechLine(); }, 'primary', 'download')),
      h('p', { class: 'sub', id: 'speech-line' }, 'Checking…')),
    card('Search by meaning', h('label', { class: 'inline' }, semBox, h('span', { class: 'grow' }, 'Find notes and tasks by what they are about, not only the exact words')),
      h('p', { class: 'sub' }, 'Uses a small language model that runs only on this device; nothing you write leaves it. The first use downloads about 35 MB, then it works offline. Each device builds its own index in the background while Steward is open.'),
      h('p', { class: 'sub', id: 'sem-line' }, semLine())),
    orgCard(card, again),
    aiCard(card, again),
    card('Clip from the web and other apps',
      h('p', null, h('b', null, 'On your Mac, best: the Steward Clipper for Chrome. '), 'Clip the article, text only, the full page, a selection, a bookmark, a screenshot or a PDF, choose the notebook and tags, and add a note to yourself. It also adds “Save to Steward” to the right-click menu, and Option+Shift+S opens it.'),
      h('a', { class: 'btn primary', href: 'clipper/steward-clipper.zip', download: 'steward-clipper.zip' }, 'Download the Steward Clipper'),
      h('details', { class: 'help' }, h('summary', null, 'How to install it (one time, about a minute)'), h('ol', null,
        h('li', null, 'Double-click the downloaded ', h('b', null, 'steward-clipper.zip'), ' in your Downloads folder. A ', h('b', null, 'steward-clipper'), ' folder appears. Move it somewhere it can stay, like Documents.'),
        h('li', null, 'In Chrome, type ', h('code', null, 'chrome://extensions'), ' in the address bar and press Return.'),
        h('li', null, 'Turn on ', h('b', null, 'Developer mode'), ' (top right).'),
        h('li', null, 'Click ', h('b', null, 'Load unpacked'), ' and choose the ', h('b', null, 'steward-clipper'), ' folder.'),
        h('li', null, 'Click the puzzle-piece button next to the address bar and pin ', h('b', null, 'Steward Clipper'), '.'))),
      h('p', null, h('b', null, 'Any browser: '), 'drag this button to your bookmarks bar. On any page, select text (or nothing, for the whole article) and click it.'), clipLink,
      h('p', null, h('b', null, 'On your phone: '), 'in any app, tap Share and choose Steward. Shared text asks whether to make a task or a note; links, photos, PDFs and recordings become notes in the Clips notebook.'),
      h('p', null, h('b', null, 'One-tap “Add task” on your phone: '), 'press and hold the Steward icon, then drag “Add task” onto your home screen. Tapping it opens Steward straight to a new task.')),
    card('Bring in your old data',
      h('p', null, h('b', null, 'Evernote: '), 'in the Evernote desktop app, right-click a notebook, choose Export, pick the ENEX format, then load the file here. Notes, tags and attachments come across.'), btn('Import Evernote .enex files', () => enex.click(), '', 'note'), enex,
      h('p', null, h('b', null, 'Todoist: '), 'brings over every open task with its project, section, sub-tasks, dates, repeats, priority, labels, deadlines, comments and reminders, plus your projects and filters. Doing it again later updates what came over instead of making copies, and finishes here whatever you finished in Todoist. Anything you changed, finished or deleted in Steward since stays the way you left it.'), btn('Import from Todoist', () => todoistDialog(again), '', 'check'),
      h('p', null, h('b', null, 'Google Calendar: '), 'needs no import; it shows up as soon as Google is connected.')),
    card('Backup', h('p', { class: 'sub' }, 'Google Drive keeps earlier versions of your data files for 30 days. You can also save a copy yourself.'),
      h('div', { class: 'row gap wrap' }, btn('Download a backup', async () => { const blob = new Blob([JSON.stringify(await store.exportAll())], { type: 'application/json' }); const a = h('a', { href: URL.createObjectURL(blob), download: `steward-backup-${today()}.json` }); a.click(); }), btn('Restore from a backup', () => restore.click()), restore)),
    card('Appearance', h('label', { class: 'inline' }, 'Theme ', theme), h('label', { class: 'inline' }, 'Open Steward on ', home)),
    card('Updates', h('p', { class: 'sub' }, 'Steward updates itself: it checks whenever you come back to it and switches to the new version on its own. You never need to uninstall it to get an update.'),
      h('div', { class: 'row gap wrap' }, btn('Check for updates now', checkForUpdate, 'primary'), btn('Reload Steward fresh', repairApp)),
      h('p', { class: 'sub' }, '“Reload Steward fresh” is for when something looks stuck on an old version. It downloads the app again; your tasks, notes and settings stay right where they are.')),
    card('Install', installEvt ? btn('Install Steward on this device', async () => { installEvt.prompt(); installEvt = null; }, 'primary') : null,
      h('p', { class: 'sub' }, 'Mac (Chrome): click the install icon at the right of the address bar, or the three-dot menu, then "Install Steward". Android (Chrome): three-dot menu, then "Add to Home screen" and "Install".')),
    h('p', { class: 'sub center' }, `Steward ${VERSION}`)));
}
// ---- Todoist import ----------------------------------------------------------------------------------
function todoistDialog(again) {
  modal(close => {
    const tok = h('input', { class: 'field mono', placeholder: 'Todoist API token', autocomplete: 'off', autofocus: true });
    const hold = h('input', { type: 'checkbox', checked: true });
    const out = h('div', { class: 'sub' });
    let busy = false;
    const go = async () => {
      if (busy) return;
      const t = tok.value.trim();
      if (!/^[0-9a-f]{30,}$/i.test(t)) return toast('That does not look like a Todoist API token (a long string of letters and numbers).');
      busy = true; out.textContent = 'Starting…';
      try {
        const r = describeImport(await importTodoist(t, { pauseReminders: hold.checked, onStep: m => { out.textContent = m; } }));
        fill(out, h('p', null, h('b', null, r.line)), r.problems.length > 0 && h('div', null, h('p', null, 'Worth a look:'), h('ul', null, r.problems.map(p => h('li', null, p)))),
          hold.checked && h('p', null, 'Steward’s reminders are on hold until you switch. When you stop using Todoist, turn them on in Settings → Reminders.'));
        tok.value = '';
        if (sync.connected()) sync.run();
      } catch (e) { out.textContent = e.message || 'The import stopped.'; }
      busy = false; again();
    };
    return h('div', { class: 'form' },
      h('p', null, 'In Todoist, open ', h('b', null, 'Settings → Integrations → Developer'), ' and copy your ', h('b', null, 'API token'), '. Paste it here. Steward uses it once for this import and does not keep it.'),
      tok, h('label', { class: 'inline' }, hold, ' Hold Steward’s phone reminders until I stop using Todoist (so you are not reminded twice)'),
      out, h('div', { class: 'row end' }, btn('Close', close), btn('Import', go, 'primary')));
  }, { title: 'Import from Todoist', cls: 'small' });
}

// ---- shared settings: planning hours and fixed blocks ------------------------------------------
const DAYNAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function hoursEditor(again) {
  const hours = [...(settings.get('hours') || [])];
  const save = () => settings.set('hours', hours);
  return h('div', { class: 'hours-grid' }, DAYNAMES.map((name, i) => {
    const w = hours[i];
    const on = h('input', { type: 'checkbox', checked: !!w, onchange: () => { hours[i] = on.checked ? { start: '07:00', end: '22:30' } : null; save(); again(); } });
    const t = k => h('input', { type: 'time', class: 'field slim', value: w?.[k] || '', disabled: !w, 'aria-label': `${name} ${k === 'start' ? 'from' : 'until'}`, onchange: e => {
      if (!e.target.value) return;
      const next = { ...hours[i], [k]: e.target.value };
      if (next.end <= next.start) { e.target.value = hours[i][k]; return toast('The end of the day has to be after its start.'); }
      hours[i] = next; save();
    } });
    return h('div', { class: 'hrow' + (w ? '' : ' off') }, h('span', { class: 'hday' }, name), h('label', { class: 'inline' }, on, ' plan'), h('span', { class: 'htimes' }, t('start'), h('span', { class: 'sub' }, 'to'), t('end')));
  }));
}
function blocksEditor(again) {
  const DN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const list = store.all('blocks').sort((a, b) => (a.days[0] ?? 9) - (b.days[0] ?? 9) || a.start.localeCompare(b.start));
  const edit = (b = { name: '', days: [1, 2, 3, 4, 5], start: '18:00', end: '19:00', every: 1 }) => modal(close => {
    const name = h('input', { class: 'field', value: b.name, placeholder: 'e.g. Family dinner', autofocus: true });
    let days = [...b.days];
    const pick = h('div', { class: 'days-pick' }, DN.map((d, i) => h('button', { type: 'button', class: 'btn tiny' + (days.includes(i) ? ' on' : ''), onclick: e => { days = days.includes(i) ? days.filter(x => x !== i) : [...days, i].sort(); e.currentTarget.classList.toggle('on'); } }, d)));
    const st = h('input', { type: 'time', class: 'field slim', value: b.start }), en = h('input', { type: 'time', class: 'field slim', value: b.end });
    const every = h('select', { class: 'field slim' }, h('option', { value: 1 }, 'every week'), h('option', { value: 2 }, 'every other week'));
    every.value = b.every || 1;
    const anchor = h('input', { type: 'date', class: 'field slim', value: b.anchor || today() });
    const until = h('input', { type: 'date', class: 'field slim', value: b.until || '' });
    // which identity this time belongs to (a Family block offers to start the family timer when it begins)
    const idSel = h('select', { class: 'field slim' }, h('option', { value: '' }, 'Nothing in particular'), M.identities().map(i => h('option', { value: i.id }, i.name)));
    idSel.value = b.identityId && store.get('identities', b.identityId) ? b.identityId : '';
    const save = () => {
      if (!name.value.trim() || !days.length || !st.value || !en.value) return toast('Give it a name, at least one day, and times');
      if (en.value <= st.value) return toast('The block has to end after it starts.');
      store.put('blocks', { ...b, name: name.value.trim(), days, start: st.value, end: en.value, every: +every.value, anchor: +every.value > 1 ? anchor.value : null, until: until.value || null, identityId: idSel.value || null });
      close(); again();
    };
    return h('div', { class: 'form' }, h('label', null, 'Name', name), h('label', null, 'Days', pick), h('div', { class: 'row gap' }, h('label', null, 'From', st), h('label', null, 'To', en)),
      h('div', { class: 'row gap wrap' }, h('label', null, 'Repeats', every), h('label', null, 'Counting from the week of', anchor), h('label', null, 'Ends (optional)', until)),
      M.identities().length > 0 && h('label', null, 'This time belongs to', idSel),
      h('div', { class: 'row between' }, b.id ? btn('Delete', async () => { if (await confirmDlg(`Delete "${b.name}"?`)) { store.remove('blocks', b.id); close(); again(); } }, 'tiny danger') : h('span'), h('div', { class: 'row' }, btn('Cancel', close), btn('Save', save, 'primary'))));
  }, { title: b.id ? 'Edit fixed block' : 'New fixed block', cls: 'small' });
  return h('div', null, h('p', { class: 'sub' }, 'Times that are always taken: devotions, classes, family dinner, church, date night. The day plan never counts them as open, and they show faintly on the calendar.'),
    h('div', { class: 'blocks-list' }, list.map(b => h('div', { class: 'brow' }, h('span', null, h('b', null, b.name), h('br'), h('small', { class: 'sub' }, `${b.days.map(d => DN[d]).join(' ')} · ${fmtTime(b.start)}–${fmtTime(b.end)}${(b.every || 1) > 1 ? ' · every other week' : ''}${b.until ? ' · until ' + fmtDate(b.until) : ''}${b.identityId && store.get('identities', b.identityId) ? ' · ' + store.get('identities', b.identityId).name : ''}`)), btn('Edit', () => edit(b), 'tiny')))),
    !list.length && h('p', { class: 'sub' }, 'None yet.'), btn('Add a fixed block', () => edit(), 'link', 'plus'));
}

const semLine = () => !semanticOn() ? 'Off on this device.' : semStatus.error ? (semStatus.error === 'offline' ? 'Waiting for a connection to download the model.' : 'Problem: ' + semStatus.error) : !semStatus.total ? 'Starts a few seconds after Steward opens.' : semStatus.done < semStatus.total ? `Reading your notes and tasks: ${semStatus.done} of ${semStatus.total}` : `Up to date: ${semStatus.total} notes and tasks indexed.`;
const mb = b => b >= 1e9 ? (b / 1e9).toFixed(1) + ' GB' : Math.max(1, Math.round(b / 1e6)) + ' MB';
async function offLine() {
  const l = $('#off-line'); if (!l) return;
  const s = await offline.status();
  const ok = s.tools === s.toolsTotal && s.files === s.filesTotal;
  l.textContent = (ok ? '✓ Ready for no signal. ' : '') + `Tools: ${s.tools} of ${s.toolsTotal} on this device. Attachments: ${s.files} of ${s.filesTotal}.` + (s.bytes ? ` Using ${mb(s.bytes)}` + (s.quota ? ` of ${mb(s.quota)} available.` : '.') : '') + (s.persisted ? '' : ' (The phone may clear this if it runs very low on space.)');
}
async function speechLine() {
  const l = $('#speech-line'); if (!l) return;
  const ok = await offline.speechHere();
  l.textContent = ok ? '✓ The speech model is on this device. Dictation works with no signal.' : 'The speech model is not on this device yet (about 77 MB). Steward downloads it by itself the next time this device is on Wi-Fi, or tap the button.';
}
offline.onChange(() => { if (/speech model/.test(offline.state.line)) { const l = $('#speech-line'); if (l) l.textContent = offline.state.line; } });
offline.onChange(() => { const b = $('#off-busy'); if (b) b.textContent = offline.state.line; if (!offline.state.busy) offLine(); });
const syncLine = () => sync.status === 'error' ? 'Sync problem: ' + sync.message : sync.status === 'syncing' ? (sync.message || 'Syncing…') : sync.status === 'auth' ? (sync.code || /did not finish|blocked/.test(sync.message) ? sync.message.replace(/Tap here/g, 'Tap Sync now') : 'Google needs you to reconnect. Tap Sync now.') : sync.status === 'offline' ? sync.message : (sync.lastSync ? 'Last synced ' + new Date(sync.lastSync).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Not synced yet') + (sync.helperTrouble ? ` · ${sync.helperTrouble}: Claude’s changes, your calendar and notifications are waiting (tasks and notes still sync)` : '') + (sync.attWaiting ? ` · ${sync.attWaiting} attachment${sync.attWaiting === 1 ? '' : 's'} waiting to upload (Steward keeps trying; tasks and notes still sync)` : '');

function applyTheme() {
  const t = settings.get('theme');
  if (t === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
  // The phone's status bar follows the theme chosen here, not only the phone's own light/dark setting.
  const dark = t === 'dark' || (t === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelectorAll('meta[name=theme-color]').forEach(m => { m.removeAttribute('media'); m.content = dark ? '#171a15' : '#f6f1e5'; });
}

// ---- notifications on this device (Settings → Reminders) -------------------------------------------
let pushAgain = null;
function pushPanel(again) {
  pushAgain = again;
  const p = sync.pushInfo();
  const out = [];
  if (!sync.connected()) return h('p', { class: 'sub', id: 'push-panel' }, 'Connect Google first. Until then, reminders only show while Steward is open.');
  const turnOn = async () => {
    if (Notification.permission !== 'granted' && (await Notification.requestPermission()) !== 'granted') { toast('Notifications were not allowed. Allow them for Steward in this browser’s settings, then try again.', null, null, 8000); return again(); }
    sync.setPushWanted(true); toast('Turning on… a test notification should arrive within about a minute.', null, null, 6000);
    await sync.run(true); again();
  };
  const here = p.mine && p.devices[p.mine.id];
  if (!p.supported) out.push(h('p', { class: 'sub' }, 'This browser cannot show Steward’s notifications. Open Steward in Chrome.'));
  else if (!p.helper) out.push(h('p', { class: 'sub' }, 'Steward’s Google helper has not been updated for notifications yet, so reminders still come through the "Steward Reminders" calendar.'));
  else if (p.permission === 'denied') out.push(h('p', { class: 'sub' }, 'Notifications are blocked for Steward on this device. Allow them in the browser’s site settings for Steward (on the Mac, also System Settings → Notifications → Google Chrome), then come back here.'));
  else if (!p.mine || p.permission !== 'granted' || !p.wanted) out.push(h('p', { class: 'sub' }, `Get reminders on this ${p.name} straight from Steward, even when Steward is closed.`), btn(`Turn on notifications on this ${p.name}`, turnOn, 'primary', 'bell'));
  else out.push(h('p', null, here?.confirmedAt || p.mine.confirmedAt ? `✓ Notifications are on for this ${p.name}.` : `Waiting for the test notification on this ${p.name} (it comes within about a minute)…`),
    h('div', { class: 'row gap wrap' }, btn('Check again', () => sync.run(true).then(again), 'tiny', 'sync'), btn(`Turn off on this ${p.name}`, async () => { await sync.removeDevice(); again(); }, 'tiny link')));
  const devs = Object.entries(p.devices);
  if (devs.length) out.push(h('p', { class: 'sub' }, 'Devices that get reminders:'), h('div', null, devs.map(([id, d]) => h('div', { class: 'row gap' },
    h('span', { class: 'grow' }, (d.confirmedAt ? '✓ ' : '… ') + (d.mine ? `This ${d.name}` : d.name[0].toUpperCase() + d.name.slice(1)) + (d.confirmedAt ? '' : ' (waiting for its test notification)')),
    !d.mine && btn('Remove', async () => { if (await confirmDlg(`Stop sending reminders to the ${d.name}?`, 'Remove')) { await sync.removeDevice(id).catch(e => toast('Could not remove: ' + e.message)); again(); } }, 'tiny link')))));
  if (p.helper) out.push(h('p', { class: 'sub' }, p.active
    ? 'Reminders now come from Steward itself, not Google Calendar. The "Steward Reminders" calendar is no longer used; you can delete it in Google Calendar if you like.'
    : 'Until every device in the list has shown its test notification, Steward also keeps the "Steward Reminders" Google calendar as a backup.'));
  if (p.supported && /Mac/.test(p.name)) out.push(h('p', { class: 'sub' }, 'On the Mac, Chrome must be running to show reminders (no window needs to be open). If none appear, check System Settings → Notifications → Google Chrome.'));
  return h('div', { id: 'push-panel' }, out);
}

// ---- reminders while the app is open -------------------------------------------------------------
function checkReminders() {
  const now = Date.now();
  let seen; try { seen = JSON.parse(localStorage.getItem('steward.notified')) || []; } catch { seen = []; }
  for (const t of M.openTasks()) for (const at of M.reminderTimes(t)) {
    const ms = at.getTime(), key = t.id + ':' + ms;
    if (ms > now || ms < now - 15 * 60000 || seen.includes(key)) continue;
    seen.push(key);
    toast('⏰ ' + t.content, 'Open', () => openTask(t.id), 15000);
    if (!sync.connected() && 'Notification' in window && Notification.permission === 'granted') navigator.serviceWorker?.ready.then(r => r.showNotification(t.content, { body: 'Steward reminder', icon: 'icons/icon-192.png', tag: key })).catch(() => {});
  }
  localStorage.setItem('steward.notified', JSON.stringify(seen.slice(-300)));
}

// ---- things shared into the app ----------------------------------------------------------------
async function intake() {
  const hsh = location.hash;
  if (hsh.startsWith('#clip=')) {
    try {
      const j = JSON.parse(decodeURIComponent(hsh.slice(6))); history.replaceState(null, '', location.pathname);
      // Newer clip button: ask the page for the full article and its pictures; fall back to what came in the address.
      const full = j.w && window.opener ? await new Promise(res => {
        const t = setTimeout(() => { removeEventListener('message', on); res(null); }, 25000);
        const on = e => { if (e.source !== window.opener || e.data?.steward !== 'clip') return; clearTimeout(t); removeEventListener('message', on); res(e.data); };
        addEventListener('message', on);
        toast('Saving the page and its pictures…', null, null, 4000);
        try { window.opener.postMessage('steward-ready', '*'); } catch { clearTimeout(t); res(null); }
      }) : null;
      if (full && typeof full.h === 'string') await createClip({ title: full.t || j.t, url: full.u || j.u, html: full.h, images: Array.isArray(full.files) ? full.files : [] });
      else await createClip({ title: j.t, url: j.u, html: j.h, text: j.x });
    }
    catch { history.replaceState(null, '', location.pathname + '#/notes'); toast('That clip could not be read'); }
    return true;
  }
  if (hsh === '#shared' && 'caches' in window) {
    history.replaceState(null, '', location.pathname);
    try {
      const cache = await caches.open('steward-share'), metaRes = await cache.match('__share/meta');
      if (metaRes) {
        const meta = await metaRes.json(), files = [];
        for (const k of meta.files || []) { const r = await cache.match(k); if (r) files.push(new File([await r.blob()], decodeURIComponent(r.headers.get('X-Name') || 'file'), { type: r.headers.get('Content-Type') || '' })); }
        await caches.delete('steward-share');
        const urlInText = (meta.text || '').match(/https?:\/\/\S+/)?.[0];
        const plain = [meta.title, meta.text].filter(Boolean).join(' ').trim();
        if (!files.length && plain && plain.length <= 500) {
          render();
          modal(close => h('div', { class: 'form' }, h('p', null, plain.length > 140 ? plain.slice(0, 140) + '…' : plain),
            h('div', { class: 'row end' }, btn('Save as a note', () => { close(); createClip({ title: meta.title, text: meta.text, url: meta.url || urlInText, files }); }),
              btn('Make it a task', () => { close(); M.addTask({ content: (meta.text || meta.title || '').split('\n')[0].slice(0, 300), description: [meta.url, plain.length > 300 ? plain : ''].filter(Boolean).join('\n') }); toast('Task added to Inbox'); location.hash = '#/inbox'; }, 'primary'))),
            { title: 'Shared to Steward', cls: 'small' });
          return true;
        }
        await createClip({ title: meta.title, text: meta.text, url: meta.url || urlInText, files });
        return true;
      }
    } catch (e) { console.warn(e); }
    location.hash = '#/notes';
  }
  return false;
}

// ---- the Steward Clipper Chrome extension --------------------------------------------------------
// The extension's helper runs inside this page and passes clips in with postMessage. Steward tells it which notebooks
// and tags exist (for its menus) and which pages are already clipped, then saves each clip and says when it is done.
const dataUrlBlob = d => { const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(d || ''); if (!m) return null; const bin = m[2] ? atob(m[3]) : decodeURIComponent(m[3]); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new Blob([u], { type: m[1] || 'application/octet-stream' }); };
function extMeta() {
  return { version: VERSION, notebooks: store.all('notebooks').filter(n => !n.deleted).map(n => n.name).sort((a, b) => a.localeCompare(b)),
    tags: M.allTags().map(t => t[0]), clipped: M.liveNotes().filter(n => n.sourceUrl).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 3000).map(n => [n.sourceUrl, n.id, (n.title || '').slice(0, 80)]) };
}
const extAnnounce = () => window.postMessage({ steward: 'ext-ready', meta: extMeta() }, location.origin);
function extBridge() {
  const seen = () => { try { return JSON.parse(localStorage.getItem('steward.extClips') || '{}'); } catch { return {}; } };
  window.addEventListener('message', async e => {
    if (e.source !== window || e.origin !== location.origin || !e.data || typeof e.data !== 'object') return;
    if (e.data.steward === 'ext-ping') { extAnnounce(); return; }
    if (e.data.steward !== 'ext-clip' || !e.data.clip?.id) return;
    const c = e.data.clip, answer = r => window.postMessage({ steward: 'ext-saved', id: c.id, ...r }, location.origin);
    const done = seen();
    if (done[c.id] && store.get('notes', done[c.id])) return answer({ ok: true, noteId: done[c.id], notebook: c.notebook }); // sent twice
    if (extBusy.has(c.id)) return; // already being saved; its answer covers this one
    extBusy.add(c.id);
    try {
      const images = (c.images || []).map(i => ({ src: i.src, blob: dataUrlBlob(i.data) })).filter(i => i.blob);
      const files = (c.files || []).map(f => { const b = dataUrlBlob(f.data); return b && new File([b], f.name || 'file', { type: f.mime || b.type }); }).filter(Boolean);
      const n = await createClip({ title: c.title, url: c.url, html: c.html || '', images, files, notebook: c.notebook, tags: c.tags, quiet: true });
      done[c.id] = n.id;
      const keys = Object.keys(done); if (keys.length > 300) for (const k of keys.slice(0, keys.length - 300)) delete done[k];
      try { localStorage.setItem('steward.extClips', JSON.stringify(done)); } catch {}
      // Let the note reach Google Drive before saying it's saved, so a tab the clipper opened can close.
      const until = Date.now() + 25000;
      if (sync.connected()) { await sleep(300); while ((sync.busy || sync.again) && Date.now() < until) await sleep(400); }
      answer({ ok: true, noteId: n.id, notebook: c.notebook || 'Clips' });
      extAnnounce();
    } catch (err) { console.warn('clip', err); answer({ ok: false, error: 'Steward could not save it: ' + (err?.message || err) }); }
    finally { extBusy.delete(c.id); }
  });
}
const extBusy = new Set();
const sleep = ms => new Promise(r => setTimeout(r, ms));

function seed() {
  store.merge('tasks', { filters: [
    { id: 'seed-f-promises', name: 'Customer promises', query: '@promise', favorite: true, updatedAt: 1, createdAt: 1 },
    { id: 'seed-f-week', name: 'Due in the next 7 days', query: 'overdue | 7 days', favorite: false, updatedAt: 1, createdAt: 1 },
    { id: 'seed-f-p1', name: 'Priority 1', query: 'p1', favorite: false, updatedAt: 1, createdAt: 1 }],
  labels: [{ id: 'lb-promise', name: 'promise', color: 'red', updatedAt: 1, createdAt: 1 }] });
  store.merge('notes', { notebooks: [{ id: 'nb-notes', name: 'Notes', updatedAt: 1, createdAt: 1 }] });
}

// ---- background sync (Steward closed) ------------------------------------------------------------------------------
// Chrome wakes Steward's service worker every so often to sync (Android, and the Mac while Chrome is running).
// Chrome decides how often, based on how much the app is used; it needs Steward installed as an app.
let bgState = 'checking';
async function setupBackground(reg) {
  try {
    if (!('periodicSync' in reg)) { bgState = 'unsupported'; return; }
    const st = await navigator.permissions.query({ name: 'periodic-background-sync' });
    if (st.state !== 'granted') { bgState = 'not-installed'; return; }
    await reg.periodicSync.register('steward-sync', { minInterval: 15 * 60000 });
    bgState = 'on';
  } catch (e) { console.warn('periodic sync', e); bgState = 'unsupported'; }
  finally { const l = $('#bg-line'); if (l) l.textContent = bgLine(); }
}
function bgLine() {
  if (!sync.connected()) return '';
  let last = null; try { last = JSON.parse(localStorage.getItem('steward.bgSync')); } catch {}
  const when = last?.at ? ` Last background sync: ${fmtDate(ymd(new Date(last.at)))} ${fmtTime(hm(new Date(last.at)))}.` : '';
  if (bgState === 'on') return (sync.staysSignedIn() ? '✓ Syncs in the background, even while Steward is closed.' : 'Background sync needs “Stay signed in” on this device.') + when;
  if (bgState === 'not-installed') return 'To sync while closed, install Steward as an app from Chrome (menu → Install / Add to Home screen).' + when;
  if (bgState === 'unsupported') return 'This browser cannot sync Steward while it is closed. Use Chrome to sync in the background.';
  return '';
}

// Phone plus button. Tap: a new note (inside a note: add a photo or file). Swipe it left: it turns into
// "Add task" with two quick clicks; let go there to open Add task. Slide back before letting go to cancel.
function fabGestures() {
  const fab = $('#fab'), ARM = 44, MAX = 96;
  let g = null, swallowClick = false;
  const buzz = p => { try { navigator.vibrate?.(p); } catch {} };
  const reset = () => { fab.classList.remove('swiping', 'task-mode'); fab.style.transform = ''; };
  fab.addEventListener('pointerdown', e => {
    if (parseRoute().view === 'note') e.preventDefault(); // keep the keyboard and cursor where they are
    if (e.button > 0) return;
    g = { id: e.pointerId, x: e.clientX, y: e.clientY, far: 0, armed: false, long: false };
    try { fab.setPointerCapture(e.pointerId); } catch {}
    // Press and hold: speak a note or tasks instead of typing.
    const mine = g;
    mine.timer = setTimeout(() => {
      if (g !== mine || mine.far >= 8) return;
      mine.long = true; buzz(15);
      menu(fab, [
        canDictate() && { label: 'Speak a note', icon: 'mic', onclick: () => { closeDrawer(); dictateNote(); } },
        canDictate() && { label: 'Speak tasks', icon: 'check', onclick: () => { closeDrawer(); openQuickAdd({ ...defaultsForRoute(), dictate: true }); } },
        familyIdentity() && { label: 'Start family time', icon: 'pin', onclick: () => { closeDrawer(); startFamily(); } },
        { label: 'Start a focus session', icon: 'clock', onclick: () => { closeDrawer(); openFocusStart({}); } },
      ]);
    }, 450);
  });
  fab.addEventListener('pointermove', e => {
    if (!g || e.pointerId !== g.id) return;
    const dx = e.clientX - g.x, dy = e.clientY - g.y;
    g.far = Math.max(g.far, Math.hypot(dx, dy));
    if (g.far < 8 || g.long) return;
    clearTimeout(g.timer);
    fab.classList.add('swiping');
    fab.style.transform = `translateX(${Math.max(-MAX, Math.min(0, dx))}px)`;
    const armed = dx < -ARM && Math.abs(dy) < 70;
    if (armed !== g.armed) {
      g.armed = armed; fab.classList.toggle('task-mode', armed);
      buzz(armed ? [7, 70, 7] : 5); // two quick clicks: you're on "Add task"; one tiny tick: back to note
    }
  });
  const end = e => {
    if (!g || e.pointerId !== g.id) return;
    const { armed, far, long } = g; clearTimeout(g.timer); g = null; reset();
    if (armed || far > 20 || long) { swallowClick = true; setTimeout(() => { swallowClick = false; }, 450); }
    if (armed && e.type === 'pointerup') { closeDrawer(); openQuickAdd(defaultsForRoute()); }
  };
  fab.addEventListener('pointerup', end);
  fab.addEventListener('pointercancel', end);
  fab.addEventListener('click', e => {
    if (swallowClick) { swallowClick = false; return; }
    parseRoute().view === 'note' ? noteAddMenu(e.currentTarget) : newNote();
  });
}

// A new version of Steward was published: check whenever the app comes back to the screen, and when the new
// version takes over, reload into it right away (or the next time Steward is opened, if you are typing).
let hadController = !!navigator.serviceWorker?.controller, pendingReload = false, swReg = null;
function safeToReload() { const a = document.activeElement; return !noteBusy() && !document.querySelector('.modal') && !(a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName))); }
async function reloadIntoUpdate() { pendingReload = false; try { await store.flush(); } catch {} location.reload(); }
function watchForUpdates(reg) {
  swReg = reg;
  const check = () => reg.update().catch(() => {});
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    if (pendingReload) return reloadIntoUpdate();
    check();
  });
  setInterval(() => { if (!document.hidden) check(); }, 30 * 60 * 1000);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) { hadController = true; return; } // first install, not an update
    if (!document.hidden && safeToReload()) reloadIntoUpdate(); else pendingReload = true;
  });
}

async function checkForUpdate() {
  const reg = swReg || await navigator.serviceWorker?.getRegistration().catch(() => null);
  if (!reg) return toast('Updates work once Steward has been opened with a connection.');
  if (!navigator.onLine) return toast('No connection right now. Steward will check again when you are back online.');
  toast('Checking for a new version…', null, null, 2500);
  try { await reg.update(); } catch { return toast('Could not reach the internet to check. Try again in a minute.'); }
  if (reg.installing || reg.waiting) { pendingReload = false; toast('Downloading the new version. Steward will restart in a moment.', null, null, 8000); reg.waiting?.postMessage({ steward: 'skip-waiting' }); }
  else toast(`You have the newest version (${VERSION}).`);
}
// Throws away the saved copy of the app (never your data) and loads it fresh from the internet.
async function repairApp() {
  if (!navigator.onLine) return toast('Connect to the internet first, so Steward can download itself again.');
  if (!(await confirmDlg('Download Steward again? Your tasks, notes and settings are not touched; only the saved copy of the app itself is replaced.', 'Reload fresh', false))) return;
  try { await store.flush(); } catch {}
  try { for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister(); } catch {}
  try { for (const k of await caches.keys()) if (k.startsWith('steward-') && k !== 'steward-share') await caches.delete(k); } catch {}
  location.reload();
}

async function start() {
  applyTheme();
  const seen = localStorage.getItem('steward.seenVersion');
  if (seen !== VERSION) { localStorage.setItem('steward.seenVersion', VERSION); if (seen) setTimeout(() => toast(WHATS_NEW, null, null, 9000), 1200); }
  await store.init();
  // 4.5: the Writing section is gone. Anything it held on this device becomes a note first (never dropped).
  try { const moved = await adoptLocalWriting(); if (moved) setTimeout(() => toast(`Writing was removed. What it held is now ${moved === 1 ? 'a note' : moved + ' notes'} in the notebook “From Writing”.`, null, null, 12000), 1500); } catch (e) { console.warn('writing move', e); }
  M.purgeGone().catch(() => {});
  M.enforceSeedsGone();
  M.ensureIdentities();
  try { ensureReviewTask(); } catch (e) { console.warn('review task', e); }
  M.repairTasks();
  settings.adoptLocal();
  if (!localStorage.getItem('steward.seeded')) { seed(); localStorage.setItem('steward.seeded', '1'); }
  await sync.loadCachedEvents();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    // updateViaCache 'none': the phone always asks GitHub for a fresh sw.js (and its imports) instead of a saved copy.
    navigator.serviceWorker.register('sw.js', { type: 'module', updateViaCache: 'none' }).then(reg => { watchForUpdates(reg); return setupBackground(reg); }).catch(e => console.warn('sw', e));
    // The background sync asks an open, visible Steward to sync itself rather than doing it behind its back.
    navigator.serviceWorker.addEventListener('message', e => { if (e.data?.steward === 'sync-now' || (e.data?.steward === 'reload' && !document.hidden)) sync.run(); if (e.data?.steward === 'open-task') openTaskSoon(e.data.id); if (e.data?.steward === 'go' && /^#\/[\w-]+$/.test(e.data.url || '')) location.hash = e.data.url; });
  }
  // The background sync ran while this window was hidden: take its work (settings, then data) before syncing again.
  sync.onStale = async () => {
    await store.flush().catch(() => {});
    await hydrate();
    await store.init();
    try { sync.lastSync = JSON.parse(localStorage.getItem('steward.lastSync')) || 0; } catch {}
    await sync.loadCachedEvents();
    store.emit({ remote: true, events: true });
  };
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; if (parseRoute().view === 'settings') render({ force: true }); });
  fabGestures();
  $('#menu-btn').addEventListener('click', e => { e.preventDefault(); document.body.classList.toggle('drawer'); });
  $('#scrim').addEventListener('click', closeDrawer);
  try { if (localStorage.getItem('steward.sideHidden')) document.body.classList.add('side-hidden'); } catch {}
  $('#side-show').addEventListener('click', toggleSide);
  // Resizing the window (split screen, full screen) redraws the calendar so its hour height fits.
  window.addEventListener('resize', debounce(() => { if (parseRoute().view === 'calendar' && !isMobile()) schedule({ force: true }); }, 200));
  // Rotating the phone switches between layouts: redraw so the calendar etc. pick up the new size.
  window.matchMedia(PHONE_MQ).addEventListener('change', () => { closeDrawer(); schedule({ force: true }); });
  window.addEventListener('hashchange', () => { closeDrawer(); if (!location.hash.startsWith('#clip=') && location.hash !== '#shared') render(); else intake(); });
  const pushSoon = debounce(() => sync.run(), 4000);
  let warned = 0;
  store.on(info => { if (info.storageError && Date.now() - warned > 30000) { warned = Date.now(); toast('Steward could not save to this device (' + info.storageError + '). Free up storage space, then make another change so it retries.', null, null, 15000); } });
  store.on(info => { if (info.remote) { M.repairTasks(); M.enforceSeedsGone(); M.purgeGone().catch(() => {}); } });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
  store.on(info => { if (info.ocr) { pushSoon(); semantic.kick(12000); if (parseRoute().view !== 'search') return; } schedule(info); if (info.local) pushSoon(); if (info.remote) ocr.kick(8000); if (info.local || info.remote || info.ocr) semantic.kick(info.local ? 6000 : 12000); });
  initFocus();
  ocr.kick(15000);
  semantic.kick(20000);
  orgWarmUp();
  semantic.on(() => { const l = $('#sem-line'); if (l) l.textContent = semLine(); });
  sync.on(() => { drawSidebar(parseRoute()); const l = $('#sync-line'); if (l) l.textContent = syncLine(); });
  sync.on(() => { if (sync.status === 'idle') offline.keepSoon(); });
  sync.on(() => { const el = $('#push-panel'); if (el && sync.status === 'idle' && pushAgain) el.replaceWith(pushPanel(pushAgain)); });
  offline.keepSoon(20000);
  offline.speechHere().catch(() => {});
  if (!(await intake())) render();
  document.body.classList.add('ready');
  extBridge(); extAnnounce();
  if (sync.connected()) sync.run();
  // Load Google's sign-in script now, so tapping Connect opens Google's window straight away: on phones a window
  // opened after a slow download no longer counts as the tap's, and Chrome blocks it as a pop-up.
  if (sync.configured() && navigator.onLine && !sync.staysSignedIn()) sync.loadGis().catch(() => {});
  window.addEventListener('online', () => sync.run());
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { backgroundIsNewer().then(b => { if (b || Date.now() - sync.lastSync > 60000) sync.run(); }); checkReminders(); schedule(); return; }
    // Leaving Steward: save state for the background sync, and hand it anything not yet sent.
    snapshot().catch(() => {});
    if (sync.connected() && (store.isDirty('tasks') || ['offline', 'error'].includes(sync.status))) {
      if (navigator.onLine && sync.status !== 'offline') sync.run();
      else navigator.serviceWorker?.ready.then(r => r.sync?.register('steward-push')).catch(() => {});
    }
  });
  window.addEventListener('pagehide', () => { snapshot().catch(() => {}); });
  const snapSoon = debounce(() => snapshot().catch(() => {}), 1500);
  store.on(snapSoon); sync.on(snapSoon);
  setInterval(() => { if (!document.hidden) sync.run(); }, 3 * 60000);
  setInterval(checkReminders, 30000); checkReminders();
  let day = today();
  setInterval(() => { if (today() !== day) { day = today(); schedule(); } }, 60000);
  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key === '\\' && !isMobile()) { e.preventDefault(); toggleSide(); return; }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k' && !e.shiftKey) { e.preventDefault(); while (modalOpen()) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); if (location.hash === '#/search') document.querySelector('.field.big')?.select(); else location.hash = '#/search'; return; }
    if (modalOpen() || e.metaKey || e.ctrlKey || e.altKey || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName) || e.target.isContentEditable) return;
    if (Date.now() - goPending < 900 && GO[e.key]) { e.preventDefault(); goPending = 0; location.hash = GO[e.key]; return; }
    if (e.key === 'q') { e.preventDefault(); openQuickAdd(defaultsForRoute()); }
    else if (e.key === 'n') { e.preventDefault(); newNote(); }
    else if (e.key === 'd' && canDictate()) { e.preventDefault(); openQuickAdd({ ...defaultsForRoute(), dictate: true }); }
    else if (e.key === '/') { e.preventDefault(); location.hash = '#/search'; }
    else if (e.key === '?') { e.preventDefault(); shortcuts(); }
    else if (e.key === 'g') { goPending = Date.now(); }
  });
}
start().catch(e => { console.error(e); document.body.classList.add('ready'); $('#main').textContent = 'Steward could not start: ' + e.message; });

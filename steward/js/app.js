// App shell: start-up, navigation, sidebar, search, settings, clipping intake, reminders.
import { h, fill, today, debounce, fmtDate } from './util.js';
import { store, settings } from './store.js';
import * as M from './model.js';
import { sync } from './sync.js';
import { icon, btn, iconBtn, modal, confirmDlg, promptDlg, toast, menu, modalOpen, isMobile } from './ui.js';
import { renderTasks, openQuickAdd, openTask, editProject, projectTree } from './tasks.js';
import { renderNotes, leaveNotes, newNote, createClip, importEnex } from './notes.js';
import { renderCalendar } from './calendar.js';
import { renderWriting, leaveWriting, liveDocs } from './writing.js';
import { compileFilter } from './filters.js';
import { ocr } from './ocr.js';
import { search, highlight, excerpt } from './search.js';
import { semantic, enabled as semanticOn, status as semStatus } from './semantic.js';

const VERSION = '2.3.0';
const $ = s => document.querySelector(s);
let lastRouteKey = '', searchQ = '', installEvt = null;

function parseRoute() {
  const p = location.hash.replace(/^#\/?/, '').split('/');
  const v = p[0] || settings.get('home');
  if (v === 'notes') return { view: 'notes', scope: p[1] === 'nb' ? { kind: 'nb', id: p[2] } : p[1] === 'tag' ? { kind: 'tag', id: decodeURIComponent(p[2] || '') } : { kind: 'all' } };
  return { view: v, id: p[1] };
}
const NOTE_VIEWS = ['notes', 'note', 'trash'];
const WRITING_VIEWS = ['writing', 'doc', 'sources'];

function render(info = {}) {
  const route = parseRoute(), main = $('#main');
  const key = location.hash;
  drawSidebar(route);
  document.body.dataset.view = route.view;
  if (NOTE_VIEWS.includes(route.view)) { leaveWriting(); renderNotes(route, main, info); lastRouteKey = key; return; }
  if (WRITING_VIEWS.includes(route.view)) { leaveNotes(); if (route.view !== 'doc' && key === lastRouteKey && !info.remote && main.children.length) return; renderWriting(route, main, info); lastRouteKey = key; return; }
  leaveWriting();
  if (route.view === 'settings' && key === lastRouteKey && !info.force && main.querySelector('.settings')) return;
  if (route.view === 'search' && key === lastRouteKey && main.querySelector('.results')) return drawResults();
  leaveNotes();
  const y = key === lastRouteKey ? main.scrollTop : 0;
  main.className = ''; fill(main, );
  if (route.view === 'calendar') renderCalendar(route, main);
  else if (route.view === 'search') viewSearch(main);
  else if (route.view === 'settings') viewSettings(main);
  else if (['today', 'upcoming', 'inbox', 'project', 'label', 'filter', 'filters', 'completed'].includes(route.view)) renderTasks(route, main);
  else { location.hash = '#/today'; return; }
  main.scrollTop = y; lastRouteKey = key;
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
  const link = (href, ic, label, count, extra) => h('a', { class: 'slink' + (hash === href ? ' on' : ''), href, onclick: closeDrawer }, typeof ic === 'string' ? icon(ic, 17) : ic, h('span', { class: 'grow' }, label), count ? h('span', { class: 'count' }, count) : null, extra);
  const dot = c => h('span', { class: 'pdot', style: { background: M.COLORS[c] || M.COLORS.stone } });
  const projects = projectTree(), c = M.ctx();
  const favs = [...projects.filter(p => p.favorite).map(p => link('#/project/' + p.id, dot(p.color), p.name, open.filter(t => t.projectId === p.id).length)),
    ...store.all('filters').filter(f => f.favorite).sort((a, b) => a.name.localeCompare(b.name)).map(f => link('#/filter/' + f.id, 'filter', f.name, open.filter(t => compileFilter(f.query, c).some(g => g.test(t))).length))];
  const notes = M.liveNotes(), nbs = store.all('notebooks').sort((a, b) => a.name.localeCompare(b.name)), tags = M.allTags();
  const nbMenu = nb => iconBtn('more', 'Notebook options', e => { e.preventDefault(); e.stopPropagation(); menu(e.currentTarget, [
    { label: 'Rename', icon: 'edit', onclick: async () => { const n = await promptDlg('Rename notebook', nb.name); if (n) store.patch('notebooks', nb.id, { name: n }); } },
    { label: 'Delete notebook', icon: 'trash', danger: true, onclick: async () => { const inside = notes.filter(n => n.notebookId === nb.id); if (await confirmDlg(`Delete "${nb.name}"? Its ${inside.length} notes move to the trash.`)) { for (const n of inside) store.patch('notes', n.id, { trashed: true }, { silent: true }); store.remove('notebooks', nb.id); location.hash = '#/notes'; } } },
  ]); }, 'mini');
  const st = sync.status;
  const pill = h('button', { class: 'syncpill ' + st, title: sync.message || '', onclick: () => { if (!sync.configured()) location.hash = '#/settings'; else sync.run(true); } },
    icon(st === 'offline' || st === 'off' ? 'cloudoff' : 'sync', 14),
    st === 'syncing' ? 'Syncing…' : st === 'off' ? (sync.configured() && sync.connected() ? 'Sync' : 'Not syncing yet') : st === 'offline' ? 'Offline · saved here' : st === 'auth' ? 'Tap to reconnect' : st === 'error' ? 'Sync problem' : 'Synced ' + (sync.lastSync ? new Date(sync.lastSync).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : ''));
  fill(side, 
    h('div', { class: 'brand' }, h('img', { src: 'icons/mark.png', alt: '', width: 44, height: 44 }), h('strong', null, 'Steward'), h('span', { class: 'grow' }), pill),
    h('button', { class: 'btn primary wide', onclick: () => { closeDrawer(); openQuickAdd(defaultsForRoute()); } }, icon('plus', 16), 'Add task'),
    h('nav', null,
      link('#/search', 'search', 'Search'),
      link('#/inbox', 'inbox', 'Inbox', open.filter(t => (t.projectId || 'inbox') === 'inbox' && !t.parentId).length),
      link('#/today', 'today', 'Today', open.filter(t => t.due && t.due.date <= now).length),
      link('#/upcoming', 'upcoming', 'Upcoming'),
      link('#/calendar', 'cal', 'Calendar'),
      link('#/filters', 'filter', 'Filters & labels'),
      link('#/completed', 'done', 'Completed'),
      favs.length > 0 && h('div', { class: 'shead' }, 'Favorites'), favs,
      h('div', { class: 'shead' }, 'Projects', iconBtn('plus', 'New project', () => editProject(), 'mini')),
      projects.map(p => h('div', { style: { paddingLeft: p.depth * 14 + 'px' } }, link('#/project/' + p.id, dot(p.color), p.name, open.filter(t => t.projectId === p.id).length))),
      !projects.length && h('div', { class: 'snote' }, 'No projects yet'),
      h('div', { class: 'shead' }, 'Notes', iconBtn('plus', 'New notebook', async () => { const n = await promptDlg('New notebook', '', 'Notebook name'); if (n) { location.hash = '#/notes/nb/' + M.ensureNotebook(n); } }, 'mini')),
      link('#/notes', 'note', 'All notes', notes.length),
      nbs.map(nb => link('#/notes/nb/' + nb.id, 'book', nb.name, notes.filter(n => n.notebookId === nb.id).length, nbMenu(nb))),
      tags.length > 0 && h('details', { class: 'stags', open: localStorage.getItem('steward.tagsOpen') === '1', ontoggle: e => localStorage.setItem('steward.tagsOpen', e.currentTarget.open ? '1' : '0') }, h('summary', null, 'Tags'), tags.map(([t, n]) => link('#/notes/tag/' + encodeURIComponent(t), 'tag', t, n))),
      link('#/trash', 'trash', 'Trash'),
      h('div', { class: 'shead' }, 'Writing'),
      link('#/writing', 'edit', 'Documents', liveDocs().length),
      link('#/sources', 'book', 'Sources', store.all('sources').length),
      h('div', { class: 'shead' }),
      link('#/settings', 'gear', 'Settings')));
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

// ---- search -------------------------------------------------------------------------------
let searchKind = '';
function viewSearch(main) {
  const input = h('input', { class: 'field big', type: 'search', placeholder: 'Search tasks, notes, writing and attachments', value: searchQ, autofocus: true, oninput: debounce(() => { searchQ = input.value; drawResults(); }, 120) });
  const chips = h('div', { class: 'seg skinds' }, [['', 'Everything'], ['task', 'Tasks'], ['note', 'Notes'], ['doc', 'Writing']].map(([k, l]) => h('button', { type: 'button', class: k === searchKind ? 'on' : '', onclick: e => { searchKind = k; chips.querySelectorAll('button').forEach(b => b.classList.remove('on')); e.currentTarget.classList.add('on'); drawResults(); } }, l)));
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
    : r.kind === 'doc' ? h('a', { class: 'rowlink sres', href: '#/doc/' + r.item.id }, icon('edit', 16), h('span', { class: 'grow' }, h('span', { class: 'stitle' }, highlight(r.title, (r._terms || q.terms))), h('small', null, excerpt(r, (r._terms || q.terms))), h('small', { class: 'smeta' }, `Writing · ${new Date(r.item.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`)))
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
    g.push(h('p', null, 'Ready to connect. Google will ask you to allow Steward to use your Drive and Calendar.'),
      h('div', { class: 'row gap' }, btn('Connect Google account', () => sync.connect().then(again).catch(e => toast('Google sign-in did not finish: ' + e.message)), 'primary'), btn('Change client ID', () => { settings.set('clientId', ''); again(); }, 'link')));
  } else {
    g.push(h('p', null, 'Connected', sync.email() ? ' as ' + sync.email() : '', '. Data is saved in the ', h('b', null, 'Steward'), ' folder in your Google Drive.'),
      h('p', { class: 'sub', id: 'sync-line' }, syncLine()),
      h('div', { class: 'row gap' }, btn('Sync now', () => sync.run(true), 'primary', 'sync'), btn('Disconnect', async () => { if (await confirmDlg('Disconnect this device from Google? Your data stays on this device and in Drive.', 'Disconnect')) { sync.disconnect(); again(); } }, 'link')));
  }
  // Reminders
  const auto = h('input', { type: 'checkbox', checked: settings.get('autoRemind'), onchange: () => { settings.set('autoRemind', auto.checked); if (sync.connected()) sync.run(); } });
  const lead = h('select', { class: 'field slim', onchange: () => { settings.set('remindLead', +lead.value); if (sync.connected()) sync.run(); } }, [[0, 'at the due time'], [10, '10 minutes before'], [30, '30 minutes before'], [60, '1 hour before']].map(([v, l]) => h('option', { value: v }, l)));
  lead.value = settings.get('remindLead');
  const perm = 'Notification' in window ? Notification.permission : 'unsupported';
  // Calendars
  const hidden = settings.get('hidden');
  const cals = sync.calendars().filter(c => c.summary !== 'Steward Reminders');
  const ws = h('select', { class: 'field slim', onchange: () => settings.set('weekStart', +ws.value) }, h('option', { value: 0 }, 'Sunday'), h('option', { value: 1 }, 'Monday'));
  ws.value = settings.get('weekStart');
  const theme = h('select', { class: 'field slim', onchange: () => { settings.set('theme', theme.value); applyTheme(); } }, [['auto', 'Match my device'], ['light', 'Light'], ['dark', 'Dark']].map(([v, l]) => h('option', { value: v }, l)));
  theme.value = settings.get('theme');
  const home = h('select', { class: 'field slim', onchange: () => settings.set('home', home.value) }, [['today', 'Today'], ['inbox', 'Inbox'], ['upcoming', 'Upcoming'], ['calendar', 'Calendar'], ['notes', 'Notes']].map(([v, l]) => h('option', { value: v }, l)));
  home.value = settings.get('home');
  const semBox = h('input', { type: 'checkbox', checked: semanticOn(), onchange: () => { settings.set('semantic', semBox.checked); if (semBox.checked) semantic.kick(500); const l = $('#sem-line'); if (l) l.textContent = semLine(); } });
  const bookmarklet = `javascript:(()=>{const s=getSelection();let h='';if(s&&s.rangeCount&&!s.isCollapsed){const d=document.createElement('div');d.append(s.getRangeAt(0).cloneContents());h=d.innerHTML}else{const a=document.querySelector('article,main,[role=main]')||document.body;h=a.innerHTML}open('${appUrl}#clip='+encodeURIComponent(JSON.stringify({u:location.href,t:document.title,h:h.slice(0,300000)})))})()`;
  const clipLink = h('a', { class: 'btn', onclick: e => { e.preventDefault(); toast('Drag this button onto your bookmarks bar'); } }, 'Clip to Steward');
  clipLink.setAttribute('href', bookmarklet);
  const enex = h('input', { type: 'file', accept: '.enex', multiple: true, hidden: true, onchange: async () => {
    const prog = h('p', null, 'Reading…'); const close = modal(() => prog, { title: 'Importing from Evernote', cls: 'small' });
    let total = 0;
    try { for (const f of enex.files) total += await importEnex(f, (i, n) => { prog.textContent = `${f.name}: ${i} of ${n} notes`; }); prog.textContent = `Imported ${total} notes.`; if (sync.connected()) sync.run(); }
    catch (e) { prog.textContent = 'Import stopped: ' + e.message; }
    enex.value = ''; setTimeout(close, 2500);
  } });
  const restore = h('input', { type: 'file', accept: '.json', hidden: true, onchange: async () => { try { const n = store.importAll(JSON.parse(await restore.files[0].text())); toast(`Restored ${n} items`); } catch { toast('That file is not a Steward backup'); } restore.value = ''; } });
  main.append(h('div', { class: 'settings' }, h('header', { class: 'vhead' }, h('div', null, h('h1', null, 'Settings'))),
    card('Google account and sync', g),
    card('Reminders', h('label', { class: 'inline' }, auto, ' Remind me about every task that has a time, ', lead),
      h('p', { class: 'sub' }, sync.connected() ? 'Reminders are placed on a Google calendar named "Steward Reminders", so your phone buzzes through Google Calendar even when Steward is closed. Keep notifications on for that calendar in the Google Calendar app.' : 'Until Google is connected, reminders only show while Steward is open.'),
      perm === 'default' && btn('Allow notifications on this device', () => Notification.requestPermission().then(again), 'tiny', 'bell'), perm === 'denied' && h('p', { class: 'sub' }, 'Notifications are blocked for Steward in this browser’s settings.')),
    card('Calendar', cals.length ? h('div', null, h('p', { class: 'sub' }, 'Calendars to show:'), cals.map(c => { const cb = h('input', { type: 'checkbox', checked: !hidden.includes(c.id), onchange: () => { const hd = new Set(settings.get('hidden')); cb.checked ? hd.delete(c.id) : hd.add(c.id); settings.set('hidden', [...hd]); sync.refreshEvents().catch(() => {}); } }); return h('label', { class: 'inline block' }, cb, h('span', { class: 'pdot', style: { background: c.backgroundColor } }), c.summary); })) : h('p', { class: 'sub' }, 'Your Google calendars appear here once connected.'),
      h('label', { class: 'inline' }, 'Week starts on ', ws)),
    card('Search by meaning', h('label', { class: 'inline' }, semBox, h('span', { class: 'grow' }, 'Find notes and tasks by what they are about, not only the exact words')),
      h('p', { class: 'sub' }, 'Uses a small language model that runs only on this device; nothing you write leaves it. The first use downloads about 35 MB, then it works offline. Each device builds its own index in the background while Steward is open.'),
      h('p', { class: 'sub', id: 'sem-line' }, semLine())),
    card('Clip from the web and other apps',
      h('p', null, h('b', null, 'On your Mac: '), 'drag this button to your browser’s bookmarks bar. On any page, select text (or nothing, for the whole article) and click it.'), clipLink,
      h('p', null, h('b', null, 'On your phone: '), 'in any app, tap Share and choose Steward. Links, text, photos, PDFs and recordings all become notes in the Clips notebook.')),
    card('Bring in your old data',
      h('p', null, h('b', null, 'Evernote: '), 'in the Evernote desktop app, right-click a notebook, choose Export, pick the ENEX format, then load the file here. Notes, tags and attachments come across.'), btn('Import Evernote .enex files', () => enex.click(), '', 'note'), enex,
      h('p', null, h('b', null, 'Todoist and Google Calendar: '), 'ask Claude to copy your Todoist tasks across. Google Calendar needs no import; it shows up as soon as Google is connected.')),
    card('Backup', h('p', { class: 'sub' }, 'Google Drive keeps earlier versions of your data files for 30 days. You can also save a copy yourself.'),
      h('div', { class: 'row gap wrap' }, btn('Download a backup', async () => { const blob = new Blob([JSON.stringify(await store.exportAll())], { type: 'application/json' }); const a = h('a', { href: URL.createObjectURL(blob), download: `steward-backup-${today()}.json` }); a.click(); }), btn('Restore from a backup', () => restore.click()), restore)),
    card('Appearance', h('label', { class: 'inline' }, 'Theme ', theme), h('label', { class: 'inline' }, 'Open Steward on ', home)),
    card('Install', installEvt ? btn('Install Steward on this device', async () => { installEvt.prompt(); installEvt = null; }, 'primary') : null,
      h('p', { class: 'sub' }, 'Mac (Chrome): click the install icon at the right of the address bar, or the three-dot menu, then "Install Steward". Android (Chrome): three-dot menu, then "Add to Home screen" and "Install".')),
    h('p', { class: 'sub center' }, `Steward ${VERSION}`)));
}
const semLine = () => !semanticOn() ? 'Off on this device.' : semStatus.error ? (semStatus.error === 'offline' ? 'Waiting for a connection to download the model.' : 'Problem: ' + semStatus.error) : !semStatus.total ? 'Starts a few seconds after Steward opens.' : semStatus.done < semStatus.total ? `Reading your notes and tasks: ${semStatus.done} of ${semStatus.total}` : `Up to date: ${semStatus.total} notes and tasks indexed.`;
const syncLine = () => sync.status === 'error' ? 'Sync problem: ' + sync.message : sync.status === 'syncing' ? 'Syncing…' : sync.status === 'auth' ? 'Google needs you to reconnect. Tap Sync now.' : sync.status === 'offline' ? sync.message : sync.lastSync ? 'Last synced ' + new Date(sync.lastSync).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Not synced yet';

function applyTheme() { const t = settings.get('theme'); if (t === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t; }

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
    try { const j = JSON.parse(decodeURIComponent(hsh.slice(6))); history.replaceState(null, '', location.pathname); await createClip({ title: j.t, url: j.u, html: j.h, text: j.x }); }
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
        await createClip({ title: meta.title, text: meta.text, url: meta.url || urlInText, files });
        return true;
      }
    } catch (e) { console.warn(e); }
    location.hash = '#/notes';
  }
  return false;
}

function seed() {
  store.merge('tasks', { filters: [
    { id: 'seed-f-promises', name: 'Customer promises', query: '@promise', favorite: true, updatedAt: 1, createdAt: 1 },
    { id: 'seed-f-week', name: 'Due in the next 7 days', query: 'overdue | 7 days', favorite: false, updatedAt: 1, createdAt: 1 },
    { id: 'seed-f-p1', name: 'Priority 1', query: 'p1', favorite: false, updatedAt: 1, createdAt: 1 }],
  labels: [{ id: 'lb-promise', name: 'promise', color: 'red', updatedAt: 1, createdAt: 1 }] });
  store.merge('notes', { notebooks: [{ id: 'nb-notes', name: 'Notes', updatedAt: 1, createdAt: 1 }] });
}

async function start() {
  applyTheme();
  await store.init();
  if (!localStorage.getItem('steward.seeded')) { seed(); localStorage.setItem('steward.seeded', '1'); }
  await sync.loadCachedEvents();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(e => console.warn('sw', e));
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; if (parseRoute().view === 'settings') render({ force: true }); });
  $('#fab').addEventListener('click', () => (NOTE_VIEWS.includes(parseRoute().view) ? newNote() : openQuickAdd(defaultsForRoute())));
  $('#menu-btn').addEventListener('click', e => { e.preventDefault(); document.body.classList.toggle('drawer'); });
  $('#scrim').addEventListener('click', closeDrawer);
  window.addEventListener('hashchange', () => { closeDrawer(); if (!location.hash.startsWith('#clip=') && location.hash !== '#shared') render(); else intake(); });
  const pushSoon = debounce(() => sync.run(), 4000);
  let warned = 0;
  store.on(info => { if (info.storageError && Date.now() - warned > 30000) { warned = Date.now(); toast('Steward could not save to this device (' + info.storageError + '). Free up storage space, then make another change so it retries.', null, null, 15000); } });
  store.on(info => { if (info.ocr) { pushSoon(); semantic.kick(12000); if (parseRoute().view !== 'search') return; } schedule(info); if (info.local) pushSoon(); if (info.remote) ocr.kick(8000); if (info.local || info.remote || info.ocr) semantic.kick(info.local ? 6000 : 12000); });
  ocr.kick(15000);
  semantic.kick(20000);
  semantic.on(() => { const l = $('#sem-line'); if (l) l.textContent = semLine(); });
  sync.on(() => { drawSidebar(parseRoute()); const l = $('#sync-line'); if (l) l.textContent = syncLine(); });
  if (!(await intake())) render();
  document.body.classList.add('ready');
  if (sync.connected()) sync.run();
  window.addEventListener('online', () => sync.run());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { if (Date.now() - sync.lastSync > 60000) sync.run(); checkReminders(); schedule(); } });
  setInterval(() => { if (!document.hidden) sync.run(); }, 3 * 60000);
  setInterval(checkReminders, 30000); checkReminders();
  let day = today();
  setInterval(() => { if (today() !== day) { day = today(); schedule(); } }, 60000);
  document.addEventListener('keydown', e => {
    if (modalOpen() || e.metaKey || e.ctrlKey || e.altKey || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName) || e.target.isContentEditable) return;
    if (e.key === 'q') { e.preventDefault(); openQuickAdd(defaultsForRoute()); }
    else if (e.key === 'n') { e.preventDefault(); newNote(); }
    else if (e.key === '/') { e.preventDefault(); location.hash = '#/search'; }
  });
}
start().catch(e => { console.error(e); document.body.classList.add('ready'); $('#main').textContent = 'Steward could not start: ' + e.message; });

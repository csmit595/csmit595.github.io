// App shell: start-up, navigation, sidebar, search, settings, clipping intake, reminders.
import { h, fill, today, debounce, fmtDate } from './util.js';
import { store, settings } from './store.js';
import * as M from './model.js';
import { sync } from './sync.js';
import { icon, btn, iconBtn, modal, confirmDlg, promptDlg, toast, menu, modalOpen, isMobile } from './ui.js';
import { renderTasks, openQuickAdd, openTask, editProject, projectTree } from './tasks.js';
import { renderNotes, leaveNotes, newNote, createClip, importEnex } from './notes.js';
import { renderCalendar } from './calendar.js';
import { compileFilter } from './filters.js';
import { ocr } from './ocr.js';

const VERSION = '1.4.0';
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
  if (NOTE_VIEWS.includes(route.view)) { renderNotes(route, main, info); lastRouteKey = key; return; }
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
function viewSearch(main) {
  const input = h('input', { class: 'field big', type: 'search', placeholder: 'Search tasks and notes', value: searchQ, autofocus: true, oninput: debounce(() => { searchQ = input.value; drawResults(); }, 150) });
  main.append(h('header', { class: 'vhead' }, h('div', null, h('h1', null, 'Search'))), input, h('div', { class: 'results' }));
  drawResults();
  if (!isMobile()) setTimeout(() => input.focus(), 30);
}
function drawResults() {
  const el = $('.results'); if (!el) return;
  const words = searchQ.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return fill(el, h('div', { class: 'empty' }, h('strong', null, 'Search everything'), h('p', null, 'Tasks, notes, tags and attachment names.')));
  const hit = s => words.every(w => s.toLowerCase().includes(w));
  const tasks = store.all('tasks').filter(t => hit(`${t.content} ${t.description || ''} ${(t.labels || []).map(l => '@' + l).join(' ')} ${M.projectName(t.projectId)}`)).sort((a, b) => (a.completedAt ? 1 : 0) - (b.completedAt ? 1 : 0)).slice(0, 60);
  const strip = html => html.replace(/<[^>]+>/g, ' ');
  const inBody = n => `${n.title} ${strip(n.body || '')} ${(n.tags || []).join(' ')} ${(n.attachments || []).map(a => a.name).join(' ')}`;
  const notes = M.liveNotes().filter(n => hit(inBody(n) + ocr.textFor(n))).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 60);
  fill(el, 
    h('section', { class: 'group' }, h('div', { class: 'ghead' }, h('h3', null, `Tasks (${tasks.length})`)), h('div', { class: 'rows' }, tasks.map(t => h('button', { class: 'rowlink' + (t.completedAt ? ' done' : ''), onclick: () => openTask(t.id) }, icon(t.completedAt ? 'done' : 'check', 16), h('span', { class: 'grow' }, t.content, h('small', null, `${M.projectName(t.projectId)}${t.due ? ' · ' + fmtDate(t.due.date) : ''}`)))))),
    h('section', { class: 'group' }, h('div', { class: 'ghead' }, h('h3', null, `Notes (${notes.length})`)), h('div', { class: 'rows' }, notes.map(n => h('a', { class: 'rowlink', href: '#/note/' + n.id }, icon('note', 16), h('span', { class: 'grow' }, n.title || 'Untitled', h('small', null, hit(inBody(n)) ? strip(n.body || '').replace(/\s+/g, ' ').trim().slice(0, 90) : 'Found inside an attachment: ' + snippet(ocr.textFor(n), words[0]))))))));
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
  store.on(info => { if (info.ocr) { pushSoon(); if (parseRoute().view !== 'search') return; } schedule(info); if (info.local) pushSoon(); if (info.remote) ocr.kick(8000); });
  ocr.kick(15000);
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

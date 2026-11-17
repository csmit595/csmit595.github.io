// Task screens: Today, Inbox, Upcoming, projects (list and board), labels, filters, completed; quick add; task details.
import { h, fill, today, addDays, fmtDate, fmtTime, fromYmd } from './util.js';
import { store, settings } from './store.js';
import * as M from './model.js';
import { parseQuickAdd, parseDue, describeDue, looksRepeating } from './dates.js';
import { compileFilter } from './filters.js';
import { planCard, planLine } from './dayplan.js';
import { icon, btn, iconBtn, modal, confirmDlg, promptDlg, toast, menu } from './ui.js';

const go = hash => { location.hash = hash; };
const byDue = (a, b) => ((a.due?.date || '9999') + (a.due?.time || '99')).localeCompare((b.due?.date || '9999') + (b.due?.time || '99')) || (a.priority || 4) - (b.priority || 4) || M.byOrder(a, b);
const byPri = (a, b) => (a.priority || 4) - (b.priority || 4) || byDue(a, b);
const byName = (a, b) => a.content.localeCompare(b.content);
const SORTS = { manual: M.byOrder, due: byDue, priority: byPri, name: byName };
const mins = n => (n >= 60 ? `${Math.floor(n / 60)}h${n % 60 ? ' ' + (n % 60) + 'm' : ''}` : `${n}m`);

export function projectTree() {
  const all = store.all('projects').filter(p => !p.archived).sort(M.byOrder);
  const out = [];
  const walk = (parent, depth) => { for (const p of all) if ((p.parentId || null) === parent) { out.push({ ...p, depth }); if (depth < 4) walk(p.id, depth + 1); } };
  walk(null, 0);
  for (const p of all) if (!out.find(x => x.id === p.id)) out.push({ ...p, depth: 0 });
  return out;
}
function projectSelect(value, onchange) {
  const s = h('select', { class: 'field', onchange: () => onchange(s.value) },
    h('option', { value: 'inbox' }, 'Inbox'), projectTree().map(p => h('option', { value: p.id }, '  '.repeat(p.depth) + p.name)));
  s.value = value || 'inbox';
  return s;
}
function linkify(text) {
  const parts = String(text).split(/(https?:\/\/[^\s]+)/g);
  return parts.map((p, i) => i % 2 ? h('a', { href: p, target: '_blank', rel: 'noopener', onclick: e => e.stopPropagation() }, p.replace(/^https?:\/\/(www\.)?/, '').slice(0, 40)) : p);
}

function dueChip(t) {
  if (!t.due) return null;
  const now = today();
  const cls = t.due.date < now ? 'overdue' : t.due.date === now ? 'today' : t.due.date === addDays(now, 1) ? 'tomorrow' : '';
  return h('span', { class: 'meta due ' + cls }, icon('upcoming', 12), fmtDate(t.due.date) + (t.due.time ? ' ' + fmtTime(t.due.time) : ''), t.due.recur && icon('repeat', 11));
}
function deadlineChip(t) {
  if (!t.deadline) return null;
  const now = today(), late = t.deadline < now, close = t.deadline <= addDays(now, 2);
  return h('span', { class: 'meta deadline' + (late || close ? ' late' : ''), title: 'Deadline' }, icon('flag', 12), (late ? 'Past deadline ' : 'Deadline ') + fmtDate(t.deadline));
}
function toggle(t, row) {
  if (t.completedAt) return M.uncompleteTask(t.id);
  const before = structuredClone(t);
  row?.classList.add('completing');
  setTimeout(() => {
    const r = M.completeTask(t.id);
    toast(r?.recurring ? `Done. Next on ${fmtDate(r.next, true)}` : 'Completed', 'Undo', () => store.put('tasks', before));
  }, 160);
}

let dragId = null;
const finePointer = () => window.matchMedia('(pointer: fine)').matches;
function orderFor(tasks, id, targetId, before) {
  const sibs = tasks.filter(x => x.id !== id);
  const idx = sibs.findIndex(x => x.id === targetId);
  if (idx < 0) return sibs.length ? Math.max(...sibs.map(x => x.order ?? 0)) + 1000 : Date.now();
  const prev = sibs[before ? idx - 1 : idx], next = sibs[before ? idx : idx + 1];
  return prev && next ? ((prev.order ?? 0) + (next.order ?? 0)) / 2 : prev ? (prev.order ?? 0) + 1000 : (next.order ?? 0) - 1000;
}
const clearMarks = () => document.querySelectorAll('.drop-before,.drop-after,.drop-into').forEach(n => n.classList.remove('drop-before', 'drop-after', 'drop-into'));
/** Phones: press and hold a task, then drag it to a new spot or section. */
function touchDrag(row, t) {
  row.addEventListener('touchstart', e => {
    if (e.touches.length !== 1 || e.target.closest('.check')) return;
    const start = e.touches[0]; let active = false, ghost = null, target = null, last = start;
    const timer = setTimeout(() => {
      active = true; navigator.vibrate?.(15);
      const r = row.getBoundingClientRect();
      ghost = row.cloneNode(true); ghost.classList.add('ghost');
      Object.assign(ghost.style, { width: r.width + 'px', left: r.left + 'px', top: r.top + 'px' });
      ghost._dy = start.clientY - r.top; document.body.append(ghost); row.classList.add('dragging');
    }, 380);
    const move = ev => {
      const p = ev.touches[0]; last = p;
      if (!active) { if (Math.hypot(p.clientX - start.clientX, p.clientY - start.clientY) > 10) end(); return; }
      ev.preventDefault();
      ghost.style.top = p.clientY - ghost._dy + 'px';
      const main = document.getElementById('main');
      if (p.clientY < 90) main.scrollTop -= 14; else if (p.clientY > window.innerHeight - 130) main.scrollTop += 14;
      const el = document.elementFromPoint(p.clientX, p.clientY);
      const list = el?.closest('.tlist'); clearMarks(); target = null;
      if (!list?._dnd) { const col = el?.closest('.group')?.querySelector('.tlist'); if (col?._dnd) { col.classList.add('drop-into'); target = { list: col }; } return; }
      const item = el.closest('.titem');
      if (item && item.dataset.id !== t.id && item.parentElement === list) { const r = item.getBoundingClientRect(), before = p.clientY < r.top + r.height / 2; item.classList.add(before ? 'drop-before' : 'drop-after'); target = { list, id: item.dataset.id, before }; }
      else if (!item) { list.classList.add('drop-into'); target = { list }; }
    };
    const end = () => {
      clearTimeout(timer); document.removeEventListener('touchmove', move); document.removeEventListener('touchend', end); document.removeEventListener('touchcancel', end);
      if (!active) return;
      ghost?.remove(); row.classList.remove('dragging'); clearMarks();
      const swallow = ev => { ev.stopPropagation(); ev.preventDefault(); };
      row.addEventListener('click', swallow, { capture: true, once: true }); setTimeout(() => row.removeEventListener('click', swallow, true), 400);
      if (target) target.list._dnd.onDrop?.(t.id, orderFor(target.list._dnd.tasks, t.id, target.id, target.before));
    };
    document.addEventListener('touchmove', move, { passive: false }); document.addEventListener('touchend', end); document.addEventListener('touchcancel', end);
  }, { passive: true });
}
function taskRow(t, o = {}) {
  const kids = o.flat ? [] : M.childrenOf(t.id).sort(M.byOrder);
  const allKids = M.childrenOf(t.id);
  const doneKids = allKids.filter(k => k.completedAt).length;
  const nComments = store.all('comments').filter(c => c.taskId === t.id).length;
  const done = !!t.completedAt;
  const row = h('div', { class: `task pri${t.priority || 4}${done ? ' done' : ''}`, dataset: { id: t.id }, draggable: o.drag && finePointer() ? 'true' : null },
    h('button', { class: 'check', 'aria-label': done ? 'Mark not done' : 'Complete', onclick: e => { e.stopPropagation(); toggle(t, row); } }, icon('check', 13)),
    h('div', { class: 'tbody', onclick: () => openTask(t.id) },
      h('div', { class: 'tcontent' }, linkify(t.content)),
      t.description && h('div', { class: 'tdesc' }, t.description.split('\n')[0]),
      h('div', { class: 'tmeta' },
        dueChip(t),
        deadlineChip(t),
        t.duration && h('span', { class: 'meta' }, mins(t.duration)),
        allKids.length > 0 && h('span', { class: 'meta' }, icon('sub', 12), `${doneKids}/${allKids.length}`),
        nComments > 0 && h('span', { class: 'meta' }, icon('comment', 12), nComments),
        (t.reminders || []).length > 0 && h('span', { class: 'meta' }, icon('bell', 12)),
        t.noteId && store.get('notes', t.noteId) && h('span', { class: 'meta' }, icon('note', 12)),
        (t.labels || []).map(l => h('span', { class: 'meta label' }, '@' + l)),
        o.showProject && h('span', { class: 'meta proj' }, M.projectName(t.projectId)))));
  if (o.drag && !finePointer()) touchDrag(row, t);
  if (o.drag && finePointer()) {
    row.addEventListener('dragstart', e => { dragId = t.id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', t.content); row.classList.add('dragging'); });
    row.addEventListener('dragend', () => { dragId = null; row.classList.remove('dragging'); document.querySelectorAll('.drop-before,.drop-after,.drop-into').forEach(n => n.classList.remove('drop-before', 'drop-after', 'drop-into')); });
  }
  const shownKids = kids.filter(k => !k.completedAt || o.showDone);
  return h('div', { class: 'titem', dataset: { id: t.id } }, row, shownKids.length > 0 && h('div', { class: 'kids' }, shownKids.map(k => taskRow(k, { ...o, drag: false }))));
}
function taskList(tasks, o = {}) {
  const list = h('div', { class: 'tlist' }, tasks.map(t => taskRow(t, o)));
  if (o.drag) list._dnd = { tasks, onDrop: o.onDrop };
  if (o.drag) {
    const clear = () => list.querySelectorAll('.drop-before,.drop-after').forEach(n => n.classList.remove('drop-before', 'drop-after'));
    list.addEventListener('dragover', e => {
      if (!dragId) return; e.preventDefault(); clear(); list.classList.remove('drop-into');
      const item = e.target.closest('.titem');
      if (item && item.dataset.id !== dragId && item.parentElement === list) { const r = item.getBoundingClientRect(); item.classList.add(e.clientY < r.top + r.height / 2 ? 'drop-before' : 'drop-after'); }
      else list.classList.add('drop-into');
    });
    list.addEventListener('dragleave', e => { if (!list.contains(e.relatedTarget)) { clear(); list.classList.remove('drop-into'); } });
    list.addEventListener('drop', e => {
      if (!dragId) return; e.preventDefault();
      const item = e.target.closest('.titem');
      const sibs = tasks.filter(x => x.id !== dragId);
      let order = Date.now();
      if (item && item.dataset.id !== dragId && item.parentElement === list) {
        const idx = sibs.findIndex(s => s.id === item.dataset.id), r = item.getBoundingClientRect(), before = e.clientY < r.top + r.height / 2;
        const prev = sibs[before ? idx - 1 : idx], next = sibs[before ? idx : idx + 1];
        order = prev && next ? ((prev.order ?? 0) + (next.order ?? 0)) / 2 : prev ? (prev.order ?? 0) + 1000 : (next.order ?? 0) - 1000;
      } else if (sibs.length) order = Math.max(...sibs.map(s => s.order ?? 0)) + 1000;
      o.onDrop?.(dragId, order);
    });
  }
  return list;
}
const addRow = (label, defaults) => h('button', { class: 'addrow', onclick: () => openQuickAdd(defaults) }, icon('plus', 16), label);
const header = (title, sub, ...actions) => h('header', { class: 'vhead' }, h('div', null, h('h1', null, title), sub && h('div', { class: 'sub' }, sub)), h('div', { class: 'row' }, actions));
const empty = (title, text) => h('div', { class: 'empty' }, h('strong', null, title), h('p', null, text));
const group = (title, body, extra) => h('section', { class: 'group' }, h('div', { class: 'ghead' }, h('h3', null, title), extra), body);

// ---- screens ------------------------------------------------------------------
export function renderTasks(route, main) {
  const v = route.view;
  if (v === 'today') return viewToday(main);
  if (v === 'upcoming') return viewUpcoming(main);
  if (v === 'inbox') return viewProject(main, 'inbox');
  if (v === 'project') return viewProject(main, route.id);
  if (v === 'label') return viewLabel(main, decodeURIComponent(route.id));
  if (v === 'filter') return viewFilter(main, route.id);
  if (v === 'filters') return viewFilters(main);
  if (v === 'completed') return viewCompleted(main);
}

function viewToday(main) {
  const now = today(), tasks = M.openTasks();
  const overdue = tasks.filter(t => t.due && t.due.date < now).sort(byDue);
  const todays = tasks.filter(t => t.due?.date === now).sort((a, b) => (a.due.time || '99').localeCompare(b.due.time || '99') || byPri(a, b));
  const planned = todays.reduce((n, t) => n + (t.duration || 0), 0);
  const d = new Date();
  main.append(header('Today', `${d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })} · ${todays.length} task${todays.length === 1 ? '' : 's'}${planned ? ' · ' + mins(planned) + ' planned' : ''}`));
  main.append(planCard(now, { openTask, editHours: () => go('#/settings') }));
  if (overdue.length) main.append(group(`Overdue (${overdue.length})`, taskList(overdue, { showProject: true, flat: true }),
    btn('Move all to today', () => { for (const t of overdue) store.patch('tasks', t.id, { due: { ...t.due, date: now } }, { silent: true }); store.emit({ local: true }); }, 'link')));
  main.append(group('Today', h('div', null, todays.length ? taskList(todays, { showProject: true, flat: true }) : (!overdue.length && empty('Nothing due today', 'Add a task, or enjoy the margin.')), addRow('Add task', { due: { date: now, time: null, recur: null } }))));
  // deadlines in the coming week for work not already on today's list
  const soon = tasks.filter(t => t.deadline && t.deadline <= addDays(now, 7) && !(t.due && t.due.date <= now)).sort((a, b) => a.deadline.localeCompare(b.deadline));
  if (soon.length) main.append(group(`Deadlines this week (${soon.length})`, taskList(soon, { showProject: true, flat: true })));
}

function viewUpcoming(main) {
  const now = today(), tasks = M.openTasks().filter(t => t.due);
  main.append(header('Upcoming', 'The next two weeks, day by day'));
  const overdue = tasks.filter(t => t.due.date < now).sort(byDue);
  if (overdue.length) main.append(group(`Overdue (${overdue.length})`, taskList(overdue, { showProject: true, flat: true })));
  for (let i = 0; i < 14; i++) {
    const day = addDays(now, i), list = tasks.filter(t => t.due.date === day).sort((a, b) => (a.due.time || '99').localeCompare(b.due.time || '99') || byPri(a, b));
    const total = list.reduce((n, t) => n + (t.duration || 0), 0);
    main.append(group(fmtDate(day, true) + (i < 2 ? ' · ' + fromYmd(day).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) : ''),
      h('div', null, taskList(list, { showProject: true, flat: true }), addRow('Add task', { due: { date: day, time: null, recur: null } })), planLine(day) || (total ? h('span', { class: 'sub' }, mins(total)) : null)));
  }
  const later = tasks.filter(t => t.due.date > addDays(now, 13)).sort(byDue);
  if (later.length) main.append(group(`Later (${later.length})`, taskList(later, { showProject: true, flat: true })));
}

function viewProject(main, pid) {
  const proj = pid === 'inbox' ? { id: 'inbox', name: 'Inbox', view: settings.get('inboxView') || 'list', sort: settings.get('inboxSort') || 'manual' } : store.get('projects', pid);
  if (!proj) { main.append(empty('Project not found', 'It may have been deleted on another device.')); return; }
  const setP = f => { if (pid === 'inbox') { for (const [k, v] of Object.entries(f)) settings.set('inbox' + k[0].toUpperCase() + k.slice(1), v); store.emit({}); } else store.patch('projects', pid, f); };
  const showDone = !!proj.showDone, sort = SORTS[proj.sort] ? proj.sort : 'manual', board = proj.view === 'board';
  const all = store.all('tasks').filter(t => (t.projectId || 'inbox') === pid);
  const ids = new Set(all.map(t => t.id));
  const top = all.filter(t => (!t.parentId || !ids.has(t.parentId)) && (showDone || !t.completedAt)).sort(SORTS[sort]);
  const sections = store.all('sections').filter(s => s.projectId === pid).sort(M.byOrder);
  const openCount = all.filter(t => !t.completedAt).length;
  const more = e => menu(e.currentTarget, [
    { label: board ? 'Show as list' : 'Show as board', icon: board ? 'list' : 'board', onclick: () => setP({ view: board ? 'list' : 'board' }) },
    { label: `Sort: ${sort}`, icon: 'filter', onclick: () => menu(document.querySelector('.vhead .ibtn:last-child'), Object.keys(SORTS).map(k => ({ label: 'Sort by ' + (k === 'manual' ? 'my own order' : k === 'due' ? 'due date' : k), onclick: () => setP({ sort: k }) }))) },
    { label: showDone ? 'Hide completed' : 'Show completed', icon: 'done', onclick: () => setP({ showDone: !showDone }) },
    pid !== 'inbox' && '-',
    pid !== 'inbox' && { label: 'Edit project', icon: 'edit', onclick: () => editProject(proj) },
    pid !== 'inbox' && { label: proj.favorite ? 'Remove from favorites' : 'Add to favorites', icon: 'star', onclick: () => setP({ favorite: !proj.favorite }) },
    pid !== 'inbox' && { label: 'Delete project', icon: 'trash', danger: true, onclick: async () => { if (await confirmDlg(`Delete "${proj.name}" and its ${all.length} tasks? This cannot be undone.`)) { M.deleteProject(pid); go('#/today'); } } },
  ]);
  main.append(header(proj.name, `${openCount} open`, iconBtn('plus', 'Add section', async () => { const n = await promptDlg('New section', '', 'Section name'); if (n) store.put('sections', { projectId: pid, name: n, order: Date.now() }); }), iconBtn('more', 'More', more)));
  const drop = sectionId => (id, order) => { store.patch('tasks', id, { projectId: pid, sectionId, parentId: null, order }); if (sort !== 'manual') setP({ sort: 'manual' }); };
  const secHead = s => iconBtn('more', 'Section options', e => menu(e.currentTarget, [
    { label: 'Rename', icon: 'edit', onclick: async () => { const n = await promptDlg('Rename section', s.name); if (n) store.patch('sections', s.id, { name: n }); } },
    { label: 'Delete section', icon: 'trash', danger: true, onclick: async () => { if (await confirmDlg(`Delete section "${s.name}"? Its tasks stay in the project.`)) { for (const t of all) if (t.sectionId === s.id) store.patch('tasks', t.id, { sectionId: null }, { silent: true }); store.remove('sections', s.id); } } },
  ]));
  const cols = [{ id: null, name: board ? 'No section' : '' }, ...sections];
  const wrap = h('div', { class: board ? 'board' : 'plist' });
  for (const s of cols) {
    const list = top.filter(t => (t.sectionId || null) === s.id || (s.id === null && t.sectionId && !sections.find(x => x.id === t.sectionId)));
    if (s.id === null && board && !list.length && sections.length) continue;
    const body = h('div', null, taskList(list, { drag: true, showDone, onDrop: drop(s.id) }), addRow('Add task', { projectId: pid, sectionId: s.id }));
    wrap.append(s.id === null && !board ? h('section', { class: 'group' }, body) : h('section', { class: 'group' + (board ? ' col' : '') }, h('div', { class: 'ghead' }, h('h3', null, s.name, h('span', { class: 'count' }, list.length)), s.id && secHead(s)), body));
  }
  main.append(wrap);
  if (!all.length && !sections.length) main.append(empty(pid === 'inbox' ? 'Inbox is clear' : 'No tasks yet', pid === 'inbox' ? 'Anything you capture without a project lands here.' : 'Add the first task above.'));
}

function viewLabel(main, name) {
  const list = M.openTasks().filter(t => (t.labels || []).includes(name)).sort(byDue);
  main.append(header('@' + name, `${list.length} open`));
  main.append(list.length ? taskList(list, { showProject: true, flat: true }) : empty('No open tasks with this label', ''), addRow('Add task', { labels: [name] }));
}
function viewFilter(main, id) {
  const f = store.get('filters', id);
  if (!f) { main.append(empty('Filter not found', '')); return; }
  main.append(header(f.name, f.query, iconBtn('edit', 'Edit filter', () => editFilter(f))));
  const groups = compileFilter(f.query, M.ctx()), tasks = M.openTasks();
  for (const g of groups) {
    const list = tasks.filter(g.test).sort(byDue);
    const body = list.length ? taskList(list, { showProject: true, flat: true }) : empty('Nothing matches', '');
    main.append(groups.length > 1 ? group(`${g.title} (${list.length})`, body) : body);
  }
}
function editFilter(f = {}) {
  modal(close => {
    const name = h('input', { class: 'field', value: f.name || '', placeholder: 'Name, e.g. Customer promises this week', autofocus: true });
    const q = h('input', { class: 'field mono', value: f.query || '', placeholder: '(today | overdue) & @promise' });
    const preview = h('div', { class: 'sub' });
    const upd = () => { try { const n = M.openTasks().filter(t => compileFilter(q.value, M.ctx()).some(g => g.test(t))).length; preview.textContent = q.value.trim() ? `${n} open task${n === 1 ? '' : 's'} match right now` : ''; } catch { preview.textContent = ''; } };
    q.addEventListener('input', upd); upd();
    return h('div', { class: 'form' }, h('label', null, 'Name', name), h('label', null, 'Query', q), preview,
      h('details', { class: 'help' }, h('summary', null, 'How to write a query'),
        h('div', { html: 'Combine with <code>&amp;</code> (and), <code>|</code> (or), <code>!</code> (not) and brackets. A comma makes separate lists.<br><code>today</code> <code>tomorrow</code> <code>overdue</code> <code>no date</code> <code>7 days</code> <code>due before: dec 1</code> <code>fri</code><br><code>p1</code>…<code>p4</code> <code>@label</code> <code>no labels</code> <code>#Project</code> <code>##Project</code> (with sub-projects) <code>/Section</code><br><code>recurring</code> <code>subtask</code> <code>search: mulch</code>' })),
      h('div', { class: 'row end' }, f.id && btn('Delete', async () => { if (await confirmDlg('Delete this filter?')) { store.remove('filters', f.id); close(); go('#/filters'); } }, 'danger'), btn('Cancel', close),
        btn('Save', () => { if (!name.value.trim() || !q.value.trim()) return; store.put('filters', { ...f, name: name.value.trim(), query: q.value.trim(), favorite: f.favorite ?? true }); close(); }, 'primary')));
  }, { title: f.id ? 'Edit filter' : 'New filter' });
}
function viewFilters(main) {
  main.append(header('Filters & labels', 'Saved views of your tasks'));
  const filters = store.all('filters').sort((a, b) => a.name.localeCompare(b.name)), tasks = M.openTasks(), c = M.ctx();
  main.append(group('Filters', h('div', { class: 'rows' }, filters.map(f => h('a', { class: 'rowlink', href: '#/filter/' + f.id }, icon('filter', 16), h('span', { class: 'grow' }, f.name, h('small', null, f.query)), h('span', { class: 'count' }, tasks.filter(t => compileFilter(f.query, c).some(g => g.test(t))).length))),
    !filters.length && empty('No filters yet', 'A filter is a saved view, such as every promise due this week.')), btn('New filter', () => editFilter(), 'link', 'plus')));
  const labels = store.all('labels').sort((a, b) => a.name.localeCompare(b.name));
  main.append(group('Labels', h('div', { class: 'rows' }, labels.map(l => h('div', { class: 'rowlink' }, icon('tag', 16), h('a', { class: 'grow', href: '#/label/' + encodeURIComponent(l.name) }, '@' + l.name), h('span', { class: 'count' }, tasks.filter(t => (t.labels || []).includes(l.name)).length),
    iconBtn('more', 'Label options', e => menu(e.currentTarget, [
      { label: 'Rename', icon: 'edit', onclick: async () => { const n = (await promptDlg('Rename label', l.name))?.replace(/\s+/g, '-'); if (n && n !== l.name) { for (const t of store.all('tasks')) if ((t.labels || []).includes(l.name)) store.patch('tasks', t.id, { labels: t.labels.map(x => x === l.name ? n : x) }, { silent: true }); store.patch('labels', l.id, { name: n }); } } },
      { label: 'Delete', icon: 'trash', danger: true, onclick: async () => { if (await confirmDlg(`Delete label @${l.name}? It is removed from all tasks.`)) { for (const t of store.all('tasks')) if ((t.labels || []).includes(l.name)) store.patch('tasks', t.id, { labels: t.labels.filter(x => x !== l.name) }, { silent: true }); store.remove('labels', l.id); } } },
    ]))))), btn('New label', async () => { const n = (await promptDlg('New label', '', 'e.g. promise'))?.replace(/^@/, '').replace(/\s+/g, '-'); if (n) M.ensureLabels([n]); }, 'link', 'plus')));
}
function viewCompleted(main) {
  const done = store.all('tasks').filter(t => t.completedAt).sort((a, b) => b.completedAt - a.completedAt).slice(0, 400);
  main.append(header('Completed', `${done.length} shown`));
  const gone = store.raw('tasks').filter(x => x.deleted && x.was && !x.was.parentId).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 50);
  if (gone.length) main.append(h('details', { class: 'group' }, h('summary', { class: 'ghead' }, h('h3', null, `Recently deleted (${gone.length})`)),
    h('div', { class: 'rows' }, gone.map(x => h('div', { class: 'rowlink' }, icon('trash', 16), h('span', { class: 'grow' }, x.was.content, h('small', null, 'Deleted ' + new Date(x.updatedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))),
      btn('Restore', () => { store.put('tasks', { ...x.was }); for (const k of store.raw('tasks')) if (k.deleted && k.was?.parentId === x.id) store.put('tasks', { ...k.was }, { silent: true }); toast('Restored'); }, 'tiny')))),
    h('p', { class: 'sub' }, 'Deleted tasks can be brought back for 90 days.')));
  if (!done.length) return main.append(empty('Nothing completed yet', ''));
  let day = '', list = [];
  const flush = () => { if (list.length) main.append(group(day, taskList(list, { showProject: true, flat: true }))); list = []; };
  for (const t of done) { const d = new Date(t.completedAt).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' }); if (d !== day) { flush(); day = d; } list.push(t); }
  flush();
}

export function editProject(p = {}) {
  modal(close => {
    const name = h('input', { class: 'field', value: p.name || '', placeholder: 'Project name', autofocus: true });
    let color = p.color || 'green';
    const sw = h('div', { class: 'swatches' }, Object.entries(M.COLORS).map(([k, v]) => h('button', { type: 'button', class: 'swatch' + (k === color ? ' on' : ''), style: { background: v }, title: k, onclick: e => { color = k; sw.querySelectorAll('.swatch').forEach(n => n.classList.remove('on')); e.currentTarget.classList.add('on'); } })));
    const parent = h('select', { class: 'field' }, h('option', { value: '' }, 'None (top level)'), projectTree().filter(x => x.id !== p.id).map(x => h('option', { value: x.id }, '  '.repeat(x.depth) + x.name)));
    parent.value = p.parentId || '';
    const save = () => { if (!name.value.trim()) return; const saved = store.put('projects', { order: Date.now(), ...p, name: name.value.trim(), color, parentId: parent.value || null }); close(); if (!p.id) go('#/project/' + saved.id); };
    name.addEventListener('keydown', e => { if (e.key === 'Enter') save(); });
    return h('div', { class: 'form' }, h('label', null, 'Name', name), h('label', null, 'Color', sw), h('label', null, 'Inside project', parent), h('div', { class: 'row end' }, btn('Cancel', close), btn('Save', save, 'primary')));
  }, { title: p.id ? 'Edit project' : 'New project', cls: 'small' });
}

// ---- quick add ------------------------------------------------------------------
export function openQuickAdd(defaults = {}) {
  modal(close => {
    const input = h('input', { class: 'qa-input', placeholder: 'Call Linda about the patio fri 8am p1', autofocus: true, autocomplete: 'off' });
    const desc = h('textarea', { class: 'field', placeholder: 'Details (optional)', rows: 2 });
    const chips = h('div', { class: 'chips' });
    let picked = defaults.projectId || 'inbox';
    const proj = projectSelect(picked, v => { picked = v; });
    const parse = () => parseQuickAdd(input.value, M.ctx());
    const refresh = () => {
      const p = parse();
      const list = [...p.chips];
      if (!p.due && defaults.due) list.unshift(describeDue(defaults.due));
      for (const l of defaults.labels || []) list.push('@' + l);
      fill(chips, list.map(c => h('span', { class: 'chip' }, c)));
      if (p.projectId) proj.value = picked = p.projectId;
    };
    const add = () => {
      const p = parse();
      if (!p.content) return input.focus();
      if (p.repeatProblem && !input.dataset.warned) { input.dataset.warned = '1'; toast('Steward could not read that repeat. Press Add again to save it without repeating, or reword it (e.g. "every first mon").', null, null, 7000); return; }
      delete input.dataset.warned;
      const projectId = p.projectId || picked;
      M.addTask({ ...p, projectId, sectionId: p.sectionId || (projectId === (defaults.projectId || 'inbox') ? defaults.sectionId : null), due: p.due || defaults.due || null,
        deadline: p.deadline || defaults.deadline || null, parentId: defaults.parentId || null, labels: [...new Set([...(defaults.labels || []), ...p.labels])], description: desc.value.trim(), noteId: defaults.noteId || null });
      input.value = ''; desc.value = ''; refresh(); toast('Task added'); input.focus();
    };
    input.addEventListener('input', refresh);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
    refresh();
    return h('div', { class: 'form' }, input, chips, desc,
      h('div', { class: 'row between' }, h('label', { class: 'inline' }, 'Project', proj), h('div', { class: 'row' }, btn('Done', close), btn('Add task', add, 'primary'))),
      h('p', { class: 'hint' }, 'Type dates and details in plain words: ', h('code', null, 'tomorrow 3pm'), ' ', h('code', null, 'every other fri'), ' ', h('code', null, 'p1'), ' ', h('code', null, '#Project'), ' ', h('code', null, '@label'), ' ', h('code', null, 'for 45m'), ' ', h('code', null, '{nov 20}'), ' deadline'));
  }, { title: defaults.parentId ? 'Add sub-task' : 'Add task', cls: 'qa' });
}

// ---- task details ------------------------------------------------------------------
const REM_OPTS = [[0, 'At the due time'], [10, '10 minutes before'], [30, '30 minutes before'], [60, '1 hour before'], [1440, '1 day before']];
export function openTask(id) {
  if (!store.get('tasks', id)) return;
  modal((close, body) => {
    const get = () => store.get('tasks', id);
    const set = f => store.patch('tasks', id, f);
    const draw = () => {
      const t = get();
      if (!t) return close();
      const content = h('textarea', { class: 'td-title', rows: 1, value: t.content, onchange: () => content.value.trim() && set({ content: content.value.trim() }), onkeydown: e => { if (e.key === 'Enter') { e.preventDefault(); content.blur(); } } });
      const descr = h('textarea', { class: 'field', rows: 3, placeholder: 'Details', value: t.description || '', onchange: () => set({ description: descr.value }) });
      const dueText = h('input', { class: 'field', placeholder: 'e.g. fri 8am, every mon', value: t.due ? describeDue(t.due).replace(' ↻ ', ' ') : '',
        onchange: () => { const v = dueText.value.trim(); if (!v) set({ due: null }); else { const d = parseDue(v); if (d) { set({ due: d.due }); if (looksRepeating(v) && !d.due.recur) toast('The date was saved, but Steward could not read the repeat. Try wording like "every first mon" or "every 2 weeks".', null, null, 7000); } else toast("I couldn't read that date"); } draw(); },
        onkeydown: e => { if (e.key === 'Enter') dueText.blur(); } });
      const dateIn = h('input', { type: 'date', class: 'field', value: t.due?.date || '', onchange: () => { set({ due: dateIn.value ? { time: null, recur: null, ...(t.due || {}), date: dateIn.value } : null }); draw(); } });
      const timeIn = h('input', { type: 'time', class: 'field', value: t.due?.time || '', onchange: () => { set({ due: { date: today(), recur: null, ...(t.due || {}), time: timeIn.value || null } }); draw(); } });
      const quick = (label, date) => btn(label, () => { set({ due: { time: null, recur: null, ...(t.due || {}), date } }); draw(); }, 'tiny');
      const sections = store.all('sections').filter(s => s.projectId === t.projectId).sort(M.byOrder);
      const secSel = h('select', { class: 'field', onchange: () => set({ sectionId: secSel.value || null }) }, h('option', { value: '' }, 'No section'), sections.map(s => h('option', { value: s.id }, s.name)));
      secSel.value = t.sectionId || '';
      const pri = h('div', { class: 'pris' }, [1, 2, 3, 4].map(n => h('button', { type: 'button', class: `pri pri${n}` + ((t.priority || 4) === n ? ' on' : ''), onclick: () => { set({ priority: n }); draw(); } }, icon('flag', 14), 'P' + n)));
      const labelIn = h('input', { class: 'field', placeholder: 'Add label', list: 'label-list', onkeydown: e => { if (e.key === 'Enter' && labelIn.value.trim()) { const n = labelIn.value.trim().replace(/^@/, '').replace(/\s+/g, '-'); M.ensureLabels([n]); set({ labels: [...new Set([...(t.labels || []), n])] }); draw(); } } });
      const labels = h('div', null, h('div', { class: 'chips' }, (t.labels || []).map(l => h('span', { class: 'chip' }, '@' + l, h('button', { 'aria-label': 'Remove label', onclick: () => { set({ labels: t.labels.filter(x => x !== l) }); draw(); } }, '×')))), labelIn,
        h('datalist', { id: 'label-list' }, store.all('labels').map(l => h('option', { value: l.name }))));
      const deadlineIn = h('input', { type: 'date', class: 'field', value: t.deadline || '', onchange: () => { set({ deadline: deadlineIn.value || null }); draw(); } });
      const FIELD_NAMES = { content: 'name', description: 'details', due: 'date', deadline: 'deadline', priority: 'priority', labels: 'labels', projectId: 'project', sectionId: 'section', duration: 'time needed', reminders: 'reminders', completedAt: 'done', parentId: 'parent', noteId: 'note' };
      const histRows = [...(t.hist || [])].reverse().slice(0, 10).map(e => h('div', { class: 'hrow' },
        h('span', null, new Date(e.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }), e.by ? ' · ' + e.by : '', ' — changed ', Object.keys(e.old).map(k => FIELD_NAMES[k] || k).join(', ')),
        btn('Undo', () => { set({ ...e.old }); toast('Put back how it was'); draw(); }, 'tiny')));
      const dur = h('input', { type: 'number', class: 'field', min: 0, step: 5, placeholder: 'minutes', value: t.duration || '', onchange: () => set({ duration: +dur.value || null }) });
      const remList = h('div', { class: 'chips' }, (t.reminders || []).map((r, i) => h('span', { class: 'chip' }, icon('bell', 12), r.at ? new Date(r.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : (REM_OPTS.find(o => o[0] === r.before)?.[1] || `${r.before} min before`),
        h('button', { 'aria-label': 'Remove reminder', onclick: () => { set({ reminders: t.reminders.filter((_, j) => j !== i) }); draw(); } }, '×'))),
      !(t.reminders || []).length && t.due?.time && settings.get('autoRemind') && h('span', { class: 'sub' }, 'Automatic reminder at the due time'));
      const remAdd = btn('Add reminder', e => menu(e.currentTarget, [...REM_OPTS.map(([before, label]) => ({ label, onclick: () => { set({ reminders: [...(t.reminders || []), { before }] }); draw(); } })),
        { label: 'Pick a date and time…', onclick: () => modal(c2 => { const dt = h('input', { type: 'datetime-local', class: 'field', autofocus: true }); return h('div', null, dt, h('div', { class: 'row end' }, btn('Cancel', c2), btn('Add', () => { if (dt.value) { set({ reminders: [...(t.reminders || []), { at: dt.value }] }); c2(); draw(); } }, 'primary'))); }, { title: 'Remind me at', cls: 'small' }) }]), 'tiny', 'bell');
      const note = t.noteId && store.get('notes', t.noteId);
      const kids = M.childrenOf(id).sort(M.byOrder);
      const subIn = h('input', { class: 'field', placeholder: 'Add a sub-task and press Enter', onkeydown: e => { if (e.key === 'Enter' && subIn.value.trim()) { const p = parseQuickAdd(subIn.value, M.ctx()); M.addTask({ ...p, content: p.content || subIn.value.trim(), projectId: t.projectId, sectionId: t.sectionId, parentId: id }); draw(); body.querySelector('.sub-in')?.focus(); } } });
      subIn.classList.add('sub-in');
      const comments = store.all('comments').filter(c => c.taskId === id).sort((a, b) => a.createdAt - b.createdAt);
      const cIn = h('textarea', { class: 'field', rows: 2, placeholder: 'Add a comment' });
      const parent = t.parentId && store.get('tasks', t.parentId);
      fill(body, 
        parent && h('button', { class: 'crumb', onclick: () => { close(); openTask(parent.id); } }, icon('back', 14), parent.content),
        h('div', { class: 'td-top' }, h('button', { class: `check big pri${t.priority || 4}${t.completedAt ? ' on' : ''}`, 'aria-label': 'Complete', onclick: () => { if (t.completedAt) { M.uncompleteTask(id); draw(); } else { toggle(t); close(); } } }, icon('check', 15)), content),
        descr,
        h('div', { class: 'td-grid' },
          h('label', null, 'Project'), h('div', { class: 'row wrap' }, projectSelect(t.projectId, v => { set({ projectId: v, sectionId: null }); for (const k of M.childrenOf(id)) store.patch('tasks', k.id, { projectId: v, sectionId: null }, { silent: true }); draw(); }), sections.length > 0 && secSel),
          h('label', null, 'Due'), h('div', null, dueText, h('div', { class: 'row wrap gap' }, quick('Today', today()), quick('Tomorrow', addDays(today(), 1)), quick('Next week', addDays(today(), 7)), t.due && btn('No date', () => { set({ due: null }); draw(); }, 'tiny')), h('div', { class: 'row gap' }, dateIn, timeIn)),
          h('label', null, 'Deadline'), h('div', { class: 'row gap' }, deadlineIn, t.deadline && btn('Clear', () => { set({ deadline: null }); draw(); }, 'tiny')),
          h('label', null, 'Priority'), pri,
          h('label', null, 'Labels'), labels,
          h('label', null, 'Time needed'), dur,
          h('label', null, 'Reminders'), h('div', null, remList, remAdd),
          h('label', null, 'Note'), note ? h('a', { class: 'rowlink', href: '#/note/' + note.id, onclick: close }, icon('note', 16), note.title || 'Untitled note') : btn('Create a linked note', () => { const n = M.addNote({ title: t.content, notebook: 'Notes' }); set({ noteId: n.id }); close(); go('#/note/' + n.id); }, 'tiny', 'note')),
        h('h4', null, `Sub-tasks${kids.length ? ` (${kids.filter(k => k.completedAt).length}/${kids.length})` : ''}`),
        h('div', { class: 'tlist' }, kids.map(k => h('div', { class: `task pri${k.priority || 4}${k.completedAt ? ' done' : ''}` },
          h('button', { class: 'check', 'aria-label': 'Complete', onclick: () => { k.completedAt ? M.uncompleteTask(k.id) : M.completeTask(k.id); draw(); } }, icon('check', 13)),
          h('div', { class: 'tbody', onclick: () => { close(); openTask(k.id); } }, h('div', { class: 'tcontent' }, k.content), h('div', { class: 'tmeta' }, dueChip(k)))))), subIn,
        h('h4', null, 'Comments'),
        h('div', { class: 'comments' }, comments.map(c => h('div', { class: 'comment' }, h('div', { class: 'sub' }, (c.author ? c.author + ' · ' : '') + new Date(c.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }), h('button', { class: 'linkbtn', onclick: () => { store.remove('comments', c.id); draw(); } }, 'Delete')), h('div', null, linkify(c.text))))),
        cIn, h('div', { class: 'row end' }, btn('Comment', () => { if (cIn.value.trim()) { store.put('comments', { taskId: id, text: cIn.value.trim() }); draw(); } }, 'tiny')),
        histRows.length > 0 && h('details', null, h('summary', null, h('h4', { style: { display: 'inline' } }, 'History')), h('div', { class: 'hist' }, histRows)),
        h('div', { class: 'td-foot' }, h('span', { class: 'sub' }, 'Added ' + new Date(t.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })),
          h('div', { class: 'row' }, btn('Duplicate', () => { const { id: _i, createdAt: _c, ...rest } = t; M.addTask({ ...rest, content: t.content + ' (copy)' }); close(); }, 'tiny'),
            btn('Delete', async () => { if (await confirmDlg(`Delete "${t.content}"?`)) { M.deleteTask(id); close(); } }, 'tiny danger'))));
    };
    draw();
  }, { title: 'Task', cls: 'task-modal' });
}

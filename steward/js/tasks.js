// Task screens: Today, Inbox, Upcoming, projects (list and board), labels, filters, completed; quick add; task details.
import { h, fill, today, addDays, fmtDate, fmtTime, fromYmd } from './util.js';
import { store, settings } from './store.js';
import * as M from './model.js';
import { parseQuickAdd, parseDue, describeDue, looksRepeating } from './dates.js';
import { compileFilter } from './filters.js';
import { planCard, planLine, planFor } from './dayplan.js';
import { verseEl, pick as pickVerse } from './scripture.js';
import { icon, btn, iconBtn, modal, confirmDlg, promptDlg, toast, menu } from './ui.js';
import { canDictate, listen, spokenTask, splitTasks, saysStop, withoutStop } from './dictate.js';
import { orgPanel, readOrg, mergeList, hasArea, projectIdByName, orgOn } from './organize.js';
import { extractGoal } from './goals-core.js';
import { goalStrip, goalSelect } from './goals.js';
import { openFocusStart, todayStarts, startFamily } from './focus.js';
import { pickControl, sortHeadButtons } from './inbox-sort.js';

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
/** A project's sub-projects at every level, in the sidebar's order, each with its depth below `pid` (1 = direct child). */
export function subProjects(pid) {
  const tree = projectTree(), i = tree.findIndex(p => p.id === pid);
  if (i < 0) return [];
  const out = [], base = tree[i].depth;
  for (let j = i + 1; j < tree.length && tree[j].depth > base; j++) out.push({ ...tree[j], depth: tree[j].depth - base });
  return out;
}
function projectSelect(value, onchange) {
  const s = h('select', { class: 'field', onchange: () => onchange(s.value) },
    h('option', { value: 'inbox' }, 'Inbox'), projectTree().map(p => h('option', { value: p.id }, '  '.repeat(p.depth) + p.name)));
  s.value = value || 'inbox';
  return s;
}
function linkify(text) {
  const parts = String(text).split(/(https?:\/\/[^\s]*[^\s.,;:!?)])/g);
  return parts.map((p, i) => i % 2 ? h('a', { href: p, target: '_blank', rel: 'noopener', onclick: e => e.stopPropagation() }, p.replace(/^https?:\/\/(www\.)?/, '').slice(0, 40)) : p);
}

const allUnder = id => M.childrenOf(id).flatMap(c => [c, ...allUnder(c.id)]);
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
  // Completing a task also completes its open sub-tasks (or, for a repeating task, reopens them): Undo puts all of it back.
  const before = structuredClone([t, ...allUnder(t.id)]);
  row?.classList.add('completing');
  setTimeout(() => {
    if (!store.get('tasks', t.id) || store.get('tasks', t.id).completedAt) return; // changed meanwhile (double tap, sync)
    const r = M.completeTask(t.id);
    toast(r?.recurring ? `Done. Next on ${fmtDate(r.next, true)}` : 'Completed', 'Undo', () => { for (const x of before) { const cur = store.get('tasks', x.id); if (cur) store.patch('tasks', x.id, { completedAt: x.completedAt ?? null, due: x.due ?? null, lastDoneAt: x.lastDoneAt ?? null, doneCount: x.doneCount ?? 0, doneLog: x.doneLog ?? [], remindedFor: x.remindedFor ?? null }, { silent: true }); } store.emit({ local: true }); });
  }, 160);
}

// ---- quick rescheduling (hover buttons on a Mac, swipe on a phone) ----------------------------
const nextDow = (dow, from = today()) => { const d = fromYmd(from).getDay(); return addDays(from, ((dow - d + 7) % 7) || 7); };
function setDate(t, date) {
  const before = t.due;
  store.patch('tasks', t.id, { due: date ? { time: null, recur: null, ...(t.due || {}), date } : null });
  toast(date ? `Moved to ${fmtDate(date, true)}` : 'Date removed', 'Undo', () => store.patch('tasks', t.id, { due: before }));
}
export function scheduleMenu(anchor, t) {
  const now = today();
  menu(anchor, [
    { label: 'Today', icon: 'today', onclick: () => setDate(t, now) },
    { label: 'Tomorrow', icon: 'upcoming', onclick: () => setDate(t, addDays(now, 1)) },
    { label: 'Saturday', icon: 'upcoming', onclick: () => setDate(t, nextDow(6)) },
    { label: 'Next Monday', icon: 'upcoming', onclick: () => setDate(t, nextDow(1)) },
    '-',
    { label: 'Pick a date…', icon: 'cal', onclick: () => openTask(t.id) },
    t.due && { label: 'No date', icon: 'x', onclick: () => setDate(t, null) },
  ]);
}
function moreMenu(anchor, t) {
  menu(anchor, [
    ...[1, 2, 3, 4].map(n => ({ label: n === 4 ? 'No priority' : `Priority ${n}`, icon: 'flag', onclick: () => store.patch('tasks', t.id, { priority: n }) })),
    '-',
    { label: 'Open details', icon: 'edit', onclick: () => openTask(t.id) },
    { label: 'Focus on this', icon: 'clock', onclick: () => openFocusStart({ taskId: t.id }) },
    ...goalItems(t),
    { label: 'Delete', icon: 'trash', danger: true, onclick: async () => { if (await confirmDlg(`Delete "${t.content}"?`)) M.deleteTask(t.id); } },
  ]);
}
/** Menu lines for a task that sits under a goal: choose it as the goal's next task, or open the goal. */
function goalItems(t) {
  const g = t.goalId && store.get('goals', t.goalId);
  if (!g) return [];
  return [g.nextTaskId === t.id ? { label: 'No longer the goal’s next task', icon: 'star', onclick: () => store.patch('goals', g.id, { nextTaskId: null }) } : { label: 'Make this the goal’s next task', icon: 'star', onclick: () => store.patch('goals', g.id, { nextTaskId: t.id }) },
    { label: 'Open goal', icon: 'flag', onclick: () => go('#/goal/' + g.id) }];
}
/** Phones: swipe a task right to complete it, left to give it a new day. */
function swipe(row, t) {
  row.addEventListener('touchstart', e => {
    if (e.touches.length !== 1 || e.target.closest('.check, a, .sortpick')) return;
    const s = e.touches[0]; let dx = 0, on = false, dead = false;
    const move = ev => {
      const p = ev.touches[0], x = p.clientX - s.clientX, y = p.clientY - s.clientY;
      if (dead || row.classList.contains('dragging')) { dead = true; return; }
      if (!on) { if (Math.abs(y) > 10 && Math.abs(y) > Math.abs(x)) { dead = true; return; } if (Math.abs(x) < 14) return; on = true; row.classList.add('swiping'); }
      dx = Math.max(-140, Math.min(140, x));
      row.style.transform = `translateX(${dx}px)`;
      row.dataset.swipe = dx > 70 ? 'done' : dx < -70 ? 'later' : dx > 0 ? 'done-pre' : 'later-pre';
    };
    const end = () => {
      document.removeEventListener('touchmove', move); document.removeEventListener('touchend', end); document.removeEventListener('touchcancel', end);
      if (!on) return;
      row.classList.remove('swiping'); row.style.transform = ''; delete row.dataset.swipe;
      const swallow = ev => { ev.stopPropagation(); ev.preventDefault(); };
      row.addEventListener('click', swallow, { capture: true, once: true }); setTimeout(() => row.removeEventListener('click', swallow, true), 400);
      if (dx > 70) { navigator.vibrate?.(10); toggle(t, row); }
      else if (dx < -70) { navigator.vibrate?.(10); scheduleMenu(row.querySelector('.tbody') || row, t); }
    };
    document.addEventListener('touchmove', move, { passive: true }); document.addEventListener('touchend', end); document.addEventListener('touchcancel', end);
  }, { passive: true });
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
    if (e.touches.length !== 1 || e.target.closest('.check, .sortpick')) return;
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
      if (target) target.list._dnd.onDrop?.(t.id, orderFor(target.list._dnd.tasks, t.id, target.id, target.before), target.id, target.before);
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
        t.goalId && store.get('goals', t.goalId) && h('span', { class: 'meta goal', title: 'Goal' }, icon('flag', 11), store.get('goals', t.goalId).title),
        (t.labels || []).map(l => h('span', { class: 'meta label' + (l === 'promise' ? ' promise' : '') }, '@' + l)),
        o.showProject && h('span', { class: 'meta proj' }, h('span', { class: 'pdot', style: { background: M.COLORS[store.get('projects', t.projectId)?.color] || 'var(--line)' } }), M.projectName(t.projectId)))),
    !done && o.sortPicks && pickControl(t, projectTree),
    !done && finePointer() && h('div', { class: 'tacts' },
      iconBtn('upcoming', 'New date', e => { e.stopPropagation(); scheduleMenu(e.currentTarget, t); }, 'mini'),
      iconBtn('more', 'More', e => { e.stopPropagation(); moreMenu(e.currentTarget, t); }, 'mini')));
  if (!done && !finePointer()) swipe(row, t);
  if (o.drag && !finePointer()) touchDrag(row, t);
  if (o.drag && finePointer()) {
    row.addEventListener('dragstart', e => { dragId = t.id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', t.content); row.classList.add('dragging'); });
    row.addEventListener('dragend', () => { dragId = null; row.classList.remove('dragging'); document.querySelectorAll('.drop-before,.drop-after,.drop-into').forEach(n => n.classList.remove('drop-before', 'drop-after', 'drop-into')); });
  }
  const shownKids = kids.filter(k => !k.completedAt || o.showDone);
  return h('div', { class: 'titem', dataset: { id: t.id } }, row, shownKids.length > 0 && h('div', { class: 'kids' }, shownKids.map(k => taskRow(k, { ...o, drag: false }))));
}
export function taskList(tasks, o = {}) {
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
      let targetId, before;
      if (item && item.dataset.id !== dragId && item.parentElement === list) { const r = item.getBoundingClientRect(); targetId = item.dataset.id; before = e.clientY < r.top + r.height / 2; }
      o.onDrop?.(dragId, orderFor(tasks, dragId, targetId, before), targetId, before);
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
  if (v === 'inbox') return viewInbox(main);
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
  const d = new Date(), n = todays.length + overdue.length, hr = d.getHours();
  // 5.0: on the rest day Today is the Lord's Day; from 6 PM it is Evening. Work is folded away (never hidden for good).
  const rest = d.getDay() === settings.get('restDay'), evening = !rest && (hr >= 18 || hr < 4);
  main.append(header(rest ? 'The Lord’s Day' : evening ? 'Evening' : 'Today', `${d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}${n ? ` · ${n} task${n === 1 ? '' : 's'}` : ''}`));
  const v = verseEl(pickVerse(rest ? 'lordsday' : evening ? 'evening' : 'today'), { cls: 'view-verse' }); if (v) main.append(v);
  if (rest) main.append(lordsDayCard(now));
  else if (evening) main.append(eveningCard(now));
  main.append(planCard(now, { openTask, editHours: () => go('#/settings') }));
  const fold = (rest || evening) && n > 0;
  const outer = main;
  if (fold) main = h('div');
  main.append(todayStarts());
  const strip = goalStrip(); if (strip) main.append(strip);
  if (overdue.length) main.append(group(`Overdue (${overdue.length})`, taskList(overdue, { showProject: true, flat: true }),
    btn('Move all to today', () => { for (const t of overdue) store.patch('tasks', t.id, { due: { ...t.due, date: now } }, { silent: true }); store.emit({ local: true }); }, 'link')));
  main.append(group('Today', h('div', null, todays.length ? taskList(todays, { showProject: true, flat: true }) : (!overdue.length && empty('Nothing due today', 'Add a task, or enjoy the margin.')), addRow('Add task', { due: { date: now, time: null, recur: null } }))));
  // deadlines in the coming week for work not already on today's list
  const soon = tasks.filter(t => t.deadline && t.deadline <= addDays(now, 7) && !(t.due && t.due.date <= now)).sort((a, b) => a.deadline.localeCompare(b.deadline));
  if (soon.length) main.append(group(`Deadlines this week (${soon.length})`, taskList(soon, { showProject: true, flat: true })));
  if (fold) {
    const nd = M.nextPlanDay(now), when = nd === addDays(now, 1) ? (rest ? 'tomorrow' : 'morning') : fromYmd(nd).toLocaleDateString(undefined, { weekday: 'long' });
    let open = false; try { open = sessionStorage.getItem('steward.foldOpen.' + now) === '1'; } catch {}
    outer.append(h('details', { class: 'rest-fold', open, ontoggle: e => { try { sessionStorage.setItem('steward.foldOpen.' + now, e.currentTarget.open ? '1' : ''); } catch {} } },
      h('summary', null, icon('down', 16), h('span', { class: 'grow' }, `${n} task${n === 1 ? '' : 's'} resting until ${when}`), h('span', { class: 'sub' }, 'Show')), main));
  }
}
// The evening: a shutdown check (his three conditions for a free evening), family time, and the work put away.
function eveningCard(now) {
  const key = 'steward.shutdown.' + now;
  let st = {}; try { st = JSON.parse(localStorage.getItem(key)) || {}; } catch {}
  const save = () => { try { localStorage.setItem(key, JSON.stringify(st)); } catch {} };
  const next = M.nextPlanDay(now), q = planFor(next);
  const nextName = next === addDays(now, 1) ? 'Tomorrow' : fromYmd(next).toLocaleDateString(undefined, { weekday: 'long' });
  const promises = M.openTasks().filter(t => (t.labels || []).includes('promise') && t.due && t.due.date <= next).length;
  const row = (k, label, hint, auto) => {
    const c = h('input', { type: 'checkbox', checked: !!(st[k] ?? auto), onchange: () => { st[k] = c.checked; save(); } });
    return h('label', null, c, h('span', { class: 'grow' }, label), hint && h('small', { class: 'sub' }, hint));
  };
  return h('section', { class: 'card tl-card' },
    h('h2', null, 'Shutdown check'),
    h('p', { class: 'sub' }, 'When these three are done, the rest of the night is free.'),
    h('div', { class: 'shut' },
      row('plan', `${nextName} is planned`, q.count ? `${q.count} task${q.count === 1 ? '' : 's'} · ${q.state === 'over' ? 'over' : q.state === 'rest' ? 'rest day' : 'fits'}` : 'nothing on it yet', q.count > 0 && q.state !== 'over'),
      row('supplies', 'Supplies ordered'),
      row('customers', 'Customers answered', promises ? `${promises} open promise${promises === 1 ? '' : 's'}` : '')),
    h('div', { class: 'row gap wrap' }, btn('Start family time', () => startFamily(), 'warm', 'star'), h('a', { class: 'btn', href: '#/upcoming' }, icon('upcoming', 16), 'See ' + nextName.toLowerCase())),
    verseEl(pickVerse('family'), { small: true }));
}
// The rest day: church and rest; work waits for tomorrow, and anything captured lands in the Inbox.
function lordsDayCard() {
  const god = M.identities().find(i => /christ|worship|god/i.test(i.name));
  return h('section', { class: 'card tl-card' },
    h('h2', null, 'No work today'),
    h('p', { class: 'sub' }, 'Work lists rest until tomorrow. Anything you capture today waits in the Inbox.'),
    verseEl(pickVerse('lilies'), { small: true }),
    h('div', { class: 'row gap wrap' }, btn('Time with God', () => openFocusStart(god ? { identityId: god.id } : {}), 'warm', 'book'), btn('Family time', () => startFamily(), '', 'star')));
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

// Inbox shows every task: the ones with no project first, then each project in the sidebar's order (or one list).
function viewInbox(main) {
  const showDone = !!settings.get('inboxShowDone'), sort = SORTS[settings.get('inboxSort')] ? settings.get('inboxSort') : 'manual';
  const grouped = settings.get('inboxGrouped') !== false;
  const setS = (k, v) => { settings.set(k, v); store.emit({}); };
  const all = store.all('tasks');
  const ids = new Set(all.map(t => t.id));
  const top = all.filter(t => (!t.parentId || !ids.has(t.parentId)) && (showDone || !t.completedAt));
  const openCount = all.filter(t => !t.completedAt && (!t.parentId || !ids.has(t.parentId))).length;
  const more = e => menu(e.currentTarget, [
    { label: grouped ? 'Show as one list' : 'Group by project', icon: grouped ? 'list' : 'board', onclick: () => setS('inboxGrouped', !grouped) },
    { label: `Sort: ${sort}`, icon: 'filter', onclick: () => menu(document.querySelector('.vhead .ibtn:last-child'), Object.keys(SORTS).map(k => ({ label: 'Sort by ' + (k === 'manual' ? 'my own order' : k === 'due' ? 'due date' : k), onclick: () => setS('inboxSort', k) }))) },
    { label: showDone ? 'Hide completed' : 'Show completed', icon: 'done', onclick: () => setS('inboxShowDone', !showDone) },
  ]);
  main.append(header('Inbox', `All tasks · ${openCount} open`, iconBtn('more', 'More', more)));
  if (!top.length) { main.append(empty('No tasks', 'Anything you capture lands here.'), addRow('Add task', {})); return; }
  if (!grouped) {
    const list = top.slice().sort(SORTS[sort === 'manual' ? 'due' : sort]);
    main.append(h('section', { class: 'group' }, h('div', null, taskList(list, { showProject: true, showDone }), addRow('Add task', {}))));
    return;
  }
  // Drag reorders within a project only; it never moves a task to another project.
  const drop = (pid, list) => (id, order, targetId, before) => {
    const t = store.get('tasks', id); if (!t || (t.projectId || 'inbox') !== pid) return;
    if (sort !== 'manual') {
      list.forEach((x, i) => { if (x.id !== id && x.order !== (i + 1) * 1000) store.patch('tasks', x.id, { order: (i + 1) * 1000 }, { silent: true, noHistory: true }); });
      order = orderFor(list.map(x => store.get('tasks', x.id)).filter(Boolean), id, targetId, before);
      setS('inboxSort', 'manual');
    }
    store.patch('tasks', id, { parentId: null, order });
  };
  const projects = [{ id: 'inbox', name: 'Inbox', depth: 0 }, ...projectTree()];
  const known = new Set(projects.map(p => p.id));
  const wrap = h('div', { class: 'plist' });
  for (const p of projects) {
    const list = top.filter(t => (known.has(t.projectId || 'inbox') ? (t.projectId || 'inbox') : 'inbox') === p.id).sort(SORTS[sort]);
    if (!list.length && p.id !== 'inbox') continue;
    const title = p.id === 'inbox' ? 'No project' : h('a', { href: '#/project/' + p.id }, p.name);
    wrap.append(h('section', { class: 'group' },
      h('div', { class: 'ghead' }, h('h3', null, title, h('span', { class: 'count' }, list.filter(t => !t.completedAt).length)), p.id === 'inbox' && sortHeadButtons()),
      h('div', null, taskList(list, { drag: true, showDone, onDrop: drop(p.id, list), sortPicks: p.id === 'inbox' }), addRow('Add task', p.id === 'inbox' ? {} : { projectId: p.id }))));
  }
  main.append(wrap);
}

function viewProject(main, pid) {
  const proj = pid === 'inbox' ? { id: 'inbox', name: 'Inbox', view: settings.get('inboxView') || 'list', sort: settings.get('inboxSort') || 'manual', showDone: !!settings.get('inboxShowDone') } : store.get('projects', pid);
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
  const drop = sectionId => (id, order, targetId, before) => {
    if (sort !== 'manual') {
      // Sorted by date, priority or name: first make "my own order" the order on the screen, so the task lands where
      // it was dropped and the rest stay where they are.
      top.forEach((t, i) => { if (t.id !== id && t.order !== (i + 1) * 1000) store.patch('tasks', t.id, { order: (i + 1) * 1000 }, { silent: true, noHistory: true }); });
      const shown = top.map(t => store.get('tasks', t.id)).filter(t => t && ((t.sectionId || null) === sectionId || (sectionId === null && t.sectionId && !sections.find(x => x.id === t.sectionId))));
      order = orderFor(shown, id, targetId, before);
    }
    store.patch('tasks', id, { projectId: pid, sectionId, parentId: null, order });
    if (sort !== 'manual') setP({ sort: 'manual' });
  };
  const secHead = s => iconBtn('more', 'Section options', e => menu(e.currentTarget, [
    { label: 'Rename', icon: 'edit', onclick: async () => { const n = await promptDlg('Rename section', s.name); if (n) store.patch('sections', s.id, { name: n }); } },
    { label: 'Delete section', icon: 'trash', danger: true, onclick: async () => { if (await confirmDlg(`Delete section "${s.name}"? Its tasks stay in the project.`)) { for (const t of all) if (t.sectionId === s.id) store.patch('tasks', t.id, { sectionId: null }, { silent: true }); store.remove('sections', s.id); } } },
  ]));
  const subs = pid === 'inbox' ? [] : subProjects(pid);
  if (subs.length) {
    // A parent project also shows every task in its sub-projects, one group per sub-project (like the Inbox).
    const subIds = new Set(subs.map(p => p.id));
    const subAll = store.all('tasks').filter(t => subIds.has(t.projectId));
    const subTaskIds = new Set(subAll.map(t => t.id));
    const subTop = subAll.filter(t => (!t.parentId || !subTaskIds.has(t.parentId)) && (showDone || !t.completedAt));
    const subOpen = subAll.filter(t => !t.completedAt && (!t.parentId || !subTaskIds.has(t.parentId))).length;
    main.querySelector('.vhead .sub').textContent = `${openCount + subOpen} open across ${subs.length} sub-project${subs.length === 1 ? '' : 's'}`;
    // Drag reorders within a sub-project only; it never moves a task to another project.
    const subDrop = (spid, list) => (id, order, targetId, before) => {
      const t = store.get('tasks', id); if (!t || t.projectId !== spid) return;
      if (sort !== 'manual') {
        list.forEach((x, i) => { if (x.id !== id && x.order !== (i + 1) * 1000) store.patch('tasks', x.id, { order: (i + 1) * 1000 }, { silent: true, noHistory: true }); });
        order = orderFor(list.map(x => store.get('tasks', x.id)).filter(Boolean), id, targetId, before);
        setP({ sort: 'manual' });
      }
      store.patch('tasks', id, { parentId: null, order });
    };
    const wrap = h('div', { class: board ? 'board' : 'plist' });
    const ownList = top;
    if (ownList.length) wrap.append(h('section', { class: 'group' + (board ? ' col' : '') }, h('div', { class: 'ghead' }, h('h3', null, proj.name, h('span', { class: 'count' }, ownList.filter(t => !t.completedAt).length))),
      h('div', null, taskList(ownList, { drag: true, showDone, onDrop: drop(null) }))));
    for (const sp of subs) {
      const list = subTop.filter(t => t.projectId === sp.id).sort(SORTS[sort]);
      const n = list.filter(t => !t.completedAt).length;
      const title = h('a', { href: '#/project/' + sp.id }, h('span', { class: 'pdot', style: { background: M.COLORS[sp.color] || 'var(--line)', marginRight: '6px' } }), sp.name);
      wrap.append(h('section', { class: 'group' + (board ? ' col' : '') + (sp.depth > 1 && !board ? ' subgroup' : ''), style: sp.depth > 1 && !board ? { marginLeft: (sp.depth - 1) * 14 + 'px' } : null },
        h('div', { class: 'ghead' }, h('h3', null, title, h('span', { class: 'count' }, n))),
        h('div', null, list.length ? taskList(list, { drag: true, showDone, onDrop: subDrop(sp.id, list) }) : null, addRow('Add task', { projectId: sp.id }))));
    }
    main.append(wrap);
    return;
  }
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
      { label: 'Rename', icon: 'edit', onclick: async () => { const n = (await promptDlg('Rename label', l.name))?.replace(/^@/, '').replace(/\s+/g, '-'); if (n && n !== l.name) renameLabel(l, n); } },
      { label: 'Delete', icon: 'trash', danger: true, onclick: async () => { if (await confirmDlg(`Delete label @${l.name}? It is removed from all tasks.`)) { for (const t of store.all('tasks')) if ((t.labels || []).includes(l.name)) store.patch('tasks', t.id, { labels: t.labels.filter(x => x !== l.name) }, { silent: true }); store.remove('labels', l.id); } } },
    ]))))), btn('New label', async () => { const n = (await promptDlg('New label', '', 'e.g. promise'))?.replace(/^@/, '').replace(/\s+/g, '-'); if (n) M.ensureLabels(M.canonLabels([n])); }, 'link', 'plus')));
}
/** Rename a label everywhere: on its tasks and in saved filters. A name already in use joins the two labels into one. */
function renameLabel(l, name) {
  const other = store.all('labels').find(x => x.id !== l.id && x.name.toLowerCase() === name.toLowerCase());
  const to = other ? other.name : name;
  for (const t of store.all('tasks')) if ((t.labels || []).includes(l.name)) store.patch('tasks', t.id, { labels: [...new Set(t.labels.map(x => x === l.name ? to : x))] }, { silent: true, noHistory: true });
  const esc = l.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('@' + esc + '(?![\\w-])', 'gi');
  for (const f of store.all('filters')) { const q = String(f.query || '').replace(re, '@' + to); if (q !== f.query) store.patch('filters', f.id, { query: q }, { silent: true }); }
  if (other) { store.remove('labels', l.id, { silent: true }); toast(`Joined with the label @${other.name}`); } else store.patch('labels', l.id, { name: to }, { silent: true });
  store.emit({ local: true });
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
  let dict = null;
  modal(close => {
    const input = h('input', { class: 'qa-input', placeholder: 'Call Linda about the patio fri 8am p1', autofocus: true, autocomplete: 'off', 'aria-label': 'Task name' });
    const desc = h('textarea', { class: 'field', placeholder: 'Details (optional)', rows: 2, hidden: true });
    const chips = h('div', { class: 'chips' });
    let picked = defaults.projectId || 'inbox';
    // Suggested organization (area, tags, customer promise, project): filed only when Confirm is pressed.
    const org = orgPanel({ kind: 'task', text: () => [parse().content, desc.value].filter(Boolean).join('. '),
      current: () => { const p = parse(); const pid = p.projectId || (picked !== 'inbox' ? picked : null); return readOrg([...(defaults.labels || []), ...p.labels], { project: pid ? M.projectName(pid).toLowerCase() : null }); } });
    const proj = projectSelect(picked, v => { picked = v; });
    proj.classList.add('slim', 'qa-proj'); proj.setAttribute('aria-label', 'Project');
    // One-tap pickers. Words typed in the name still win; these fill in what the words leave out.
    let pick = { due: defaults.due || null, priority: null, duration: null };
    let typedDue = false;
    const now0 = today();
    const tool = (ic, label, onclick, cls = '') => h('button', { type: 'button', class: 'qa-tool ' + cls, onclick }, icon(ic, 14), h('span', null, label));
    const toolbar = h('div', { class: 'qa-tools' });
    const drawTools = () => fill(toolbar,
      tool('today', 'Today', () => { pick.due = pick.due?.date === now0 ? null : { date: now0, time: null, recur: null }; drawTools(); refresh(); input.focus(); }, !typedDue && pick.due?.date === now0 ? 'on' : ''),
      tool('upcoming', 'Tomorrow', () => { const d = addDays(now0, 1); pick.due = pick.due?.date === d ? null : { date: d, time: null, recur: null }; drawTools(); refresh(); input.focus(); }, !typedDue && pick.due?.date === addDays(now0, 1) ? 'on' : ''),
      tool('flag', pick.priority ? 'P' + pick.priority : 'Priority', e => menu(e.currentTarget, [1, 2, 3, 4].map(n => ({ label: n === 4 ? 'No priority' : 'Priority ' + n, icon: 'flag', onclick: () => { pick.priority = n === 4 ? null : n; drawTools(); refresh(); input.focus(); } }))), pick.priority ? 'on pri' + pick.priority : ''),
      tool('clock', pick.duration ? mins(pick.duration) : 'Time', e => menu(e.currentTarget, [15, 30, 45, 60, 90, 120, 180, 240].map(m => ({ label: mins(m), onclick: () => { pick.duration = m; drawTools(); refresh(); input.focus(); } })).concat(pick.duration ? ['-', { label: 'No estimate', icon: 'x', onclick: () => { pick.duration = null; drawTools(); refresh(); } }] : [])), pick.duration ? 'on' : ''),
      tool('note', 'Details', () => { desc.hidden = !desc.hidden; if (!desc.hidden) desc.focus(); }, ''),
      h('span', { class: 'grow' }), proj);
    drawTools();
    // Like Todoist: tap the date chip when Steward mistook words in the name for a date ("full sun", "3/4 gravel").
    let keepDate = false;
    // "goal:<name>" files the task under a goal (dictation: "goal <name>")
    const parse = () => { const g = extractGoal(input.value, store.all('goals')); const p = parseQuickAdd(g ? g.rest : input.value, M.ctx(), { keepDate }); if (g) { p.goalId = g.goalId; p.chips.push('⚑ goal: ' + g.title); } return p; };
    const refresh = () => {
      if (!input.value.trim()) keepDate = false;
      const p = parse();
      if (!!p.due !== typedDue) { typedDue = !!p.due; drawTools(); }
      const would = keepDate && parseQuickAdd(input.value, M.ctx()).dueChip;
      const list = p.chips.map(c => h('span', { class: 'chip' }, c));
      if (p.dueChip) list.unshift(h('button', { type: 'button', class: 'chip chip-due', title: 'Not a date? Tap to keep these words in the name', onclick: () => { keepDate = true; refresh(); input.focus(); } }, icon('upcoming', 12), p.dueChip, h('span', { class: 'chip-x', 'aria-label': 'Not a date' }, '×')));
      else if (would) list.unshift(h('button', { type: 'button', class: 'chip chip-off', title: 'Tap to read it as a date again', onclick: () => { keepDate = false; refresh(); input.focus(); } }, 'Kept as words, not a date · undo'));
      else if (pick.due) list.unshift(h('span', { class: 'chip' }, icon('upcoming', 12), describeDue(pick.due)));
      if (pick.priority && p.priority === 4) list.push(h('span', { class: 'chip' }, 'Priority ' + pick.priority));
      if (pick.duration && !p.duration) list.push(h('span', { class: 'chip' }, mins(pick.duration)));
      for (const l of defaults.labels || []) list.push(h('span', { class: 'chip' }, '@' + l));
      if (defaults.goalId && !p.goalId && store.get('goals', defaults.goalId)) list.push(h('span', { class: 'chip' }, '⚑ goal: ' + store.get('goals', defaults.goalId).title));
      fill(chips, list);
      if (p.projectId) proj.value = picked = p.projectId;
      org.refresh();
    };
    const add = (o = {}) => {
      const p = parse();
      if (!p.content) { if (!o.quiet) input.focus(); return false; }
      if (p.repeatProblem && !input.dataset.warned) { input.dataset.warned = '1'; toast('Steward could not read that repeat. Press Add again to save it without repeating, or reword it (e.g. "every first mon").', null, null, 7000); return; }
      delete input.dataset.warned;
      let projectId = p.projectId || picked;
      let labels = [...new Set([...(defaults.labels || []), ...p.labels])];
      const fin = org.confirmed() ? org.final() : null;
      if (fin) { labels = mergeList(labels, fin, org.removedTags()); if (fin.project && projectId === 'inbox' && !defaults.parentId) projectId = projectIdByName(fin.project) || projectId; }
      const learnText = [p.content, desc.value.trim()].filter(Boolean).join('. ');
      M.addTask({ ...p, projectId, sectionId: p.sectionId || (projectId === (defaults.projectId || 'inbox') ? defaults.sectionId : null), due: p.due || pick.due || null,
        priority: p.priority !== 4 ? p.priority : (pick.priority || 4), duration: p.duration || pick.duration || null,
        deadline: p.deadline || defaults.deadline || null, parentId: defaults.parentId || null, labels, description: desc.value.trim(), noteId: defaults.noteId || null, goalId: p.goalId || defaults.goalId || null });
      if (fin) org.commit(learnText);
      org.reset();
      input.value = ''; desc.value = ''; keepDate = false; pick = { due: defaults.due || null, priority: null, duration: null }; typed = ''; heard = ''; heardNow = ''; added++;
      // One task per window: a typed task closes it. Only dictation keeps it open ("next task" starts another).
      if (!dict) { toast('Task added'); close(); return true; }
      drawTools(); refresh(); toast(`Task added (${added}) · keep talking`);
      return true;
    };
    // ---- dictation: speak the task; say "next task" to add it and start another, "that's all" to stop ----
    let typed = '', heard = '', heardNow = '', added = 0;
    const names = () => ({ projects: store.all('projects').filter(p => !p.deleted).map(p => p.name), labels: store.all('labels').filter(l => !l.deleted).map(l => l.name), goals: store.all('goals') });
    const show = () => { const said = spokenTask([heard, heardNow].filter(Boolean).join(' '), names()); input.value = [typed, said].filter(Boolean).join(' '); refresh(); };
    const dictStatus = h('b', { class: 'qa-dict-status' });
    const dictLine = h('div', { class: 'qa-dict', hidden: true }, h('span', { class: 'dict-dot' }), h('span', null, 'Listening. Say the task the way you would type it, like ', h('i', null, '“call Linda Friday at 8 a.m. priority one”'), '. Say ', h('b', null, '“next task”'), ' to add it and start another, ', h('b', null, '“that’s all”'), ' to add the last one and stop. Tap the microphone to stop without adding.', dictStatus));
    const micBtn = canDictate() ? h('button', { type: 'button', class: 'qa-mic', title: 'Speak the task', 'aria-label': 'Speak the task', onpointerdown: e => e.preventDefault(), onclick: () => toggleDict() }, icon('mic', 20)) : null;
    const toggleDict = () => {
      if (dict) { dict.stop(); return; }
      typed = input.value.trim(); heard = ''; heardNow = '';
      dict = listen({
        onFinal: raw => {
          let parts = splitTasks(raw), stop = false;
          const last = parts.length - 1;
          if (saysStop(parts[last])) { stop = true; parts[last] = withoutStop(parts[last]); }
          parts.forEach((part, i) => {
            if (part.trim()) heard = [heard, part.trim()].filter(Boolean).join(' ');
            heardNow = '';
            if (i < last) { show(); add({ quiet: true }); }
          });
          show();
          if (stop) { add({ quiet: true }); dict?.stop(); }
        },
        onInterim: t => { heardNow = t; show(); },
        onStatus: t => { dictStatus.textContent = t ? ' ' + t : ''; },
        onEnd: () => { dict = null; heardNow = ''; if (input.isConnected) { show(); micBtn?.classList.remove('recording'); dictLine.hidden = true; if (added) { toast(`${added} task${added === 1 ? '' : 's'} added by voice`); if (!input.value.trim()) close(); } } },
      });
      micBtn?.classList.add('recording'); dictLine.hidden = false;
    };
    // Typing while listening: keep what was typed, and add newly heard words after it.
    input.addEventListener('input', () => { if (dict) { typed = input.value.trim(); heard = ''; heardNow = ''; } });
    if (defaults.dictate && micBtn) setTimeout(toggleDict, 80);
    input.addEventListener('input', refresh);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
    refresh();
    desc.addEventListener('input', () => org.refresh());
    return h('div', { class: 'form qa-form' }, h('div', { class: 'qa-line' }, input, micBtn), dictLine, chips, org.el, toolbar, desc,
      verseEl(pickVerse('capture'), { small: true }),
      h('div', { class: 'row between qa-foot' },
        h('details', { class: 'qa-help' }, h('summary', null, 'Typing shortcuts'),
          h('p', { class: 'hint' }, 'Write it the way you would say it: ', h('code', null, 'tomorrow 3pm'), ' ', h('code', null, 'every other fri'), ' ', h('code', null, 'p1'), ' ', h('code', null, '#Project'), ' ', h('code', null, '@promise'), ' ', h('code', null, 'for 45m'), ' ', h('code', null, '{nov 20}'), ' deadline, ', h('code', null, 'goal:name'), ' a goal. If a word is mistaken for a date, tap the date chip to keep it in the name.')),
        h('div', { class: 'row' }, btn('Close', close), btn('Add task', () => add(), 'primary'))));
  }, { title: defaults.parentId ? 'Add sub-task' : 'Add task', cls: 'qa', onClose: () => dict?.stop() });
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
      const labelIn = h('input', { class: 'field', placeholder: 'Add label', list: 'label-list', onkeydown: e => { if (e.key === 'Enter' && labelIn.value.trim()) { const n = M.canonLabels([labelIn.value.trim().replace(/^@/, '').replace(/\s+/g, '-')])[0]; M.ensureLabels([n]); set({ labels: [...new Set([...(t.labels || []), n])] }); draw(); } } });
      const labels = h('div', null, h('div', { class: 'chips' }, (t.labels || []).map(l => h('span', { class: 'chip' }, '@' + l, h('button', { 'aria-label': 'Remove label', onclick: () => { set({ labels: t.labels.filter(x => x !== l) }); draw(); } }, '×')))), labelIn,
        h('datalist', { id: 'label-list' }, store.all('labels').map(l => h('option', { value: l.name }))));
      const deadlineIn = h('input', { type: 'date', class: 'field', value: t.deadline || '', onchange: () => { set({ deadline: deadlineIn.value || null }); draw(); } });
      const FIELD_NAMES = { goalId: 'goal', content: 'name', description: 'details', due: 'date', deadline: 'deadline', priority: 'priority', labels: 'labels', projectId: 'project', sectionId: 'section', duration: 'time needed', reminders: 'reminders', completedAt: 'done', parentId: 'parent', noteId: 'note' };
      const histRows = [...(t.hist || [])].reverse().slice(0, 10).map(e => h('div', { class: 'hrow' },
        h('span', null, new Date(e.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }), e.by ? ' · ' + e.by : '', ' — changed ', Object.keys(e.old).map(k => FIELD_NAMES[k] || k).join(', ')),
        btn('Undo', () => { set({ ...e.old }); toast('Put back how it was'); draw(); }, 'tiny')));
      const dur = h('input', { type: 'number', class: 'field slim dur-in', min: 0, step: 5, placeholder: 'min', value: t.duration || '', 'aria-label': 'Minutes needed', onchange: () => { set({ duration: +dur.value || null }); draw(); } });
      const durPick = h('div', { class: 'row wrap seg-chips' }, [15, 30, 60, 120, 240].map(m => h('button', { type: 'button', class: 'schip' + (t.duration === m ? ' on' : ''), onclick: () => { set({ duration: t.duration === m ? null : m }); draw(); } }, mins(m))), dur);
      const remList = h('div', { class: 'chips' }, (t.reminders || []).map((r, i) => h('span', { class: 'chip' }, icon('bell', 12), r.at ? new Date(r.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : (REM_OPTS.find(o => o[0] === r.before)?.[1] || `${r.before} min before`),
        h('button', { 'aria-label': 'Remove reminder', onclick: () => { set({ reminders: t.reminders.filter((_, j) => j !== i) }); draw(); } }, '×'))),
      !(t.reminders || []).length && t.due?.time && settings.get('autoRemind') && h('span', { class: 'sub' }, 'Automatic reminder at the due time'));
      const remAdd = btn('Add reminder', e => menu(e.currentTarget, [...REM_OPTS.map(([before, label]) => ({ label, onclick: () => { set({ reminders: [...(t.reminders || []), { before }] }); draw(); } })),
        { label: 'Pick a date and time…', onclick: () => modal(c2 => { const dt = h('input', { type: 'datetime-local', class: 'field', autofocus: true }); return h('div', null, dt, h('div', { class: 'row end' }, btn('Cancel', c2), btn('Add', () => { if (dt.value) { set({ reminders: [...(t.reminders || []), { at: dt.value }] }); c2(); draw(); } }, 'primary'))); }, { title: 'Remind me at', cls: 'small' }) }]), 'tiny', 'bell');
      const note = t.noteId && store.get('notes', t.noteId);
      // Organize: suggestions for a task not yet filed under an area; one Confirm files it and teaches Steward.
      const org = orgPanel({ kind: 'task', text: () => [get()?.content, get()?.description].filter(Boolean).join('. '),
        current: () => { const x = get() || t; return readOrg(x.labels, { project: x.projectId && x.projectId !== 'inbox' ? M.projectName(x.projectId).toLowerCase() : null }); },
        apply: (fin, removed) => {
          const x = get(); if (!x) return;
          const f = { labels: mergeList(x.labels, fin, removed) };
          if (fin.project && x.projectId === 'inbox' && !x.parentId) { const pid = projectIdByName(fin.project); if (pid) { f.projectId = pid; f.sectionId = null; } }
          f.labels = M.canonLabels(f.labels); M.ensureLabels(f.labels); set(f); setTimeout(draw, 0);
        } });
      if (hasArea(t.labels)) org.showDone(readOrg(t.labels)); else org.refresh(true);
      const kids = M.childrenOf(id).sort(M.byOrder);
      const subIn = h('input', { class: 'field', placeholder: 'Add a sub-task and press Enter', onkeydown: e => { if (e.key === 'Enter' && subIn.value.trim()) { const p = parseQuickAdd(subIn.value, M.ctx()); M.addTask({ ...p, content: p.content || subIn.value.trim(), projectId: t.projectId, sectionId: t.sectionId, parentId: id }); draw(); body.querySelector('.sub-in')?.focus(); } } });
      subIn.classList.add('sub-in');
      const comments = store.all('comments').filter(c => c.taskId === id).sort((a, b) => a.createdAt - b.createdAt);
      const cIn = h('textarea', { class: 'field', rows: 2, placeholder: 'Add a comment' });
      const parent = t.parentId && store.get('tasks', t.parentId);
      const prop = (ic, label, ...kids) => h('div', { class: 'tprop' }, h('div', { class: 'tprop-l' }, icon(ic, 14), label), h('div', { class: 'tprop-v' }, kids));
      const side = h('aside', { class: 'td-side' },
        orgOn() && prop('tag', 'Organize', org.el),
        prop('inbox', 'Project', projectSelect(t.projectId, v => { set({ projectId: v, sectionId: null }); for (const k of M.childrenOf(id)) store.patch('tasks', k.id, { projectId: v, sectionId: null }, { silent: true }); draw(); }), sections.length > 0 && secSel),
        prop('upcoming', 'Date', dueText, h('div', { class: 'row wrap seg-chips' }, quick('Today', today()), quick('Tomorrow', addDays(today(), 1)), quick('Next week', nextDow(1)), t.due && btn('None', () => { set({ due: null }); draw(); }, 'tiny')), h('div', { class: 'row gap dt-row' }, dateIn, timeIn)),
        prop('flag', 'Deadline', h('div', { class: 'row gap' }, deadlineIn, t.deadline && btn('Clear', () => { set({ deadline: null }); draw(); }, 'tiny'))),
        prop('flag', 'Priority', pri),
        store.all('goals').length > 0 && prop('flag', 'Goal', goalSelect(t.goalId, v => { set({ goalId: v }); draw(); }), t.goalId && store.get('goals', t.goalId) && h('a', { class: 'sub', href: '#/goal/' + t.goalId, onclick: close }, 'Open goal')),
        prop('clock', 'Time needed', durPick),
        prop('tag', 'Labels', labels),
        prop('bell', 'Reminders', remList, remAdd),
        prop('note', 'Linked note', note ? h('a', { class: 'rowlink', href: '#/note/' + note.id, onclick: close }, icon('note', 16), note.title || 'Untitled note') : btn('Create a linked note', () => { const n = M.addNote({ title: t.content, notebook: 'Notes' }); set({ noteId: n.id }); close(); go('#/note/' + n.id); }, 'tiny', 'note')));
      // Save: commit anything still being typed (name, details, date words, a comment, a sub-task, a label), then close.
      // pointerdown keeps the cursor where it is, so a half-typed box is not blurred and redrawn before the tap lands.
      const save = () => {
        const c = content.value.trim(); if (c && c !== t.content) set({ content: c });
        if (descr.value !== (t.description || '')) set({ description: descr.value });
        const dv = dueText.value.trim(), was = t.due ? describeDue(t.due).replace(' ↻ ', ' ') : '';
        if (dv !== was.trim()) { if (!dv) set({ due: null }); else { const d = parseDue(dv); if (d) set({ due: d.due }); else { toast("I couldn't read that date"); return; } } }
        if (labelIn.value.trim()) { const n = M.canonLabels([labelIn.value.trim().replace(/^@/, '').replace(/\s+/g, '-')])[0]; M.ensureLabels([n]); set({ labels: [...new Set([...(get().labels || []), n])] }); }
        if (subIn.value.trim()) { const p = parseQuickAdd(subIn.value, M.ctx()); M.addTask({ ...p, content: p.content || subIn.value.trim(), projectId: t.projectId, sectionId: t.sectionId, parentId: id }); }
        if (cIn.value.trim()) store.put('comments', { taskId: id, text: cIn.value.trim() });
        close(); toast('Saved');
      };
      const focusBtn = !t.completedAt && btn('Focus', () => { close(); openFocusStart({ taskId: id }); }, '', 'clock');
      const saveBtn = btn('Save', save, 'primary', 'check');
      saveBtn.addEventListener('pointerdown', e => e.preventDefault());
      fill(body, h('div', { class: 'td-savebar' }, h('span', { class: 'sub grow' }, 'Changes save as you go — tap Save to finish.'), focusBtn, saveBtn), h('div', { class: 'td-layout' },
        h('div', { class: 'td-head' },
        parent && h('button', { class: 'crumb', onclick: () => { close(); openTask(parent.id); } }, icon('back', 14), parent.content),
        h('div', { class: 'td-top' }, h('button', { class: `check big pri${t.priority || 4}${t.completedAt ? ' on' : ''}`, 'aria-label': 'Complete', onclick: () => { if (t.completedAt) { M.uncompleteTask(id); draw(); } else { toggle(t); close(); } } }, icon('check', 15)), content),
        descr),
        side,
        h('div', { class: 'td-rest' },
        h('h4', null, `Sub-tasks${kids.length ? ` (${kids.filter(k => k.completedAt).length}/${kids.length})` : ''}`),
        h('div', { class: 'tlist' }, kids.map(k => h('div', { class: `task pri${k.priority || 4}${k.completedAt ? ' done' : ''}` },
          h('button', { class: 'check', 'aria-label': 'Complete', onclick: () => { k.completedAt ? M.uncompleteTask(k.id) : M.completeTask(k.id); draw(); } }, icon('check', 13)),
          h('div', { class: 'tbody', onclick: () => { close(); openTask(k.id); } }, h('div', { class: 'tcontent' }, k.content), h('div', { class: 'tmeta' }, dueChip(k)))))), subIn,
        h('h4', null, 'Comments'),
        h('div', { class: 'comments' }, comments.map(c => h('div', { class: 'comment' }, h('div', { class: 'sub' }, (c.author ? c.author + ' · ' : '') + new Date(c.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }), h('button', { class: 'linkbtn', onclick: () => { store.remove('comments', c.id); draw(); } }, 'Delete')), h('div', null, linkify(c.text))))),
        cIn, h('div', { class: 'row end' }, btn('Comment', () => { if (cIn.value.trim()) { store.put('comments', { taskId: id, text: cIn.value.trim() }); draw(); } }, 'tiny')),
        histRows.length > 0 && h('details', null, h('summary', null, h('h4', { style: { display: 'inline' } }, 'History')), h('div', { class: 'hist' }, histRows)))),
        h('div', { class: 'td-foot' }, h('span', { class: 'sub' }, 'Added ' + new Date(t.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })),
          h('div', { class: 'row' }, btn('Duplicate', () => { const { id: _i, createdAt: _c, ...rest } = t; M.addTask({ ...rest, content: t.content + ' (copy)' }); close(); }, 'tiny'),
            btn('Delete', async () => { if (await confirmDlg(`Delete "${t.content}"?`)) { M.deleteTask(id); close(); } }, 'tiny danger'))));
    };
    draw();
  }, { title: 'Task', cls: 'task-modal' });
}

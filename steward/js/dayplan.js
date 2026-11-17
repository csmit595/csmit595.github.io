// Day plan: does the day's work fit in the hours left after fixed calendar blocks?
// Shown at the top of Today (full card) and on each day in Upcoming (one line).
import { h, today, fromYmd, pad, fmtTime, addDays } from './util.js';
import { store, settings } from './store.js';
import * as M from './model.js';
import { sync } from './sync.js';
import { icon, btn, toast } from './ui.js';

export const hm = n => { n = Math.max(0, Math.round(n)); return n >= 60 ? `${Math.floor(n / 60)}h${n % 60 ? ' ' + (n % 60) + 'm' : ''}` : `${n}m`; };
const toMin = s => { const [a, b] = String(s || '0:0').split(':').map(Number); return a * 60 + (b || 0); };
const clock = n => fmtTime(`${pad(Math.floor(n / 60) % 24)}:${pad(n % 60)}`);
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Timed calendar events on a day, as minute ranges clipped to the day.
function eventsOn(day, events) {
  const s0 = fromYmd(day), s1 = new Date(s0); s1.setDate(s1.getDate() + 1);
  const out = [];
  for (const e of events) {
    if (e.allDay) continue;
    const s = new Date(e.start), en = new Date(e.end);
    if (!(s < s1 && en > s0) || en - s >= 864e5) continue;
    out.push({ e, start: s < s0 ? 0 : s.getHours() * 60 + s.getMinutes(), end: en >= s1 ? 1440 : en.getHours() * 60 + en.getMinutes() });
  }
  return out.sort((a, b) => a.start - b.start);
}
const overlap = (a, b) => a.start < b.end && b.start < a.end;

// Pure computation (exported for tests). nowMin is minutes past midnight when `day` is today, else null.
// window: {start,end} hours tasks may be planned in that day, or null (rest / no planning).
// blocks: fixed blocks that day as {b, start, end} in minutes. overdue: tasks past due, counted on today only.
export function computePlan({ day, tasks, events, window, blocks = [], restDay, nowMin = null, overdue = [] }) {
  const evs = eventsOn(day, events);
  const rest = fromYmd(day).getDay() === restDay || !window;
  const ws = window ? toMin(window.start) : 0, we = window ? toMin(window.end) : 0;
  const from = nowMin == null ? ws : Math.min(we, Math.max(ws, nowMin));
  // Merge the busy time (calendar events and fixed blocks) inside what is left of the window.
  const ranges = [...evs.map(x => [x.start, x.end]), ...blocks.map(x => [x.start, x.end])].sort((a, b) => a[0] - b[0]);
  const busy = [];
  for (const [start, end] of ranges) {
    const a = Math.max(start, from), b = Math.min(end, we);
    if (b <= a) continue;
    const last = busy[busy.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b); else busy.push([a, b]);
  }
  const blocked = busy.reduce((n, [a, b]) => n + b - a, 0);
  const open = rest ? 0 : Math.max(0, we - from - blocked);
  const dayTasks = tasks.filter(t => t.due?.date === day);
  const load = [...dayTasks, ...overdue];
  const planned = load.reduce((n, t) => n + (t.duration || 0), 0);
  const unestimated = load.filter(t => !t.duration).length;
  const clashes = [];
  const fixed = [...evs.map(x => ({ start: x.start, end: x.end, title: x.e.title })), ...blocks.map(x => ({ start: x.start, end: x.end, title: x.b.name }))];
  for (const t of dayTasks) {
    if (!t.due.time) continue;
    const r = { start: toMin(t.due.time), end: toMin(t.due.time) + (t.duration || 30) };
    const hit = fixed.find(x => overlap(x, r));
    if (hit) clashes.push({ t, e: { title: hit.title } });
  }
  const after = nowMin != null && window && nowMin >= we;
  const state = rest ? 'rest' : !load.length ? 'empty' : after ? 'after' : planned <= open ? 'fits' : 'over';
  return { evs, blocks, open, planned, unestimated, clashes, rest, state, count: dayTasks.length, overdue: overdue.length, overdueMin: overdue.reduce((n, t) => n + (t.duration || 0), 0), margin: open - planned, from, we };
}

export function planFor(day) {
  const d = new Date(), isToday = day === today(), nowMin = isToday ? d.getHours() * 60 + d.getMinutes() : null;
  const tasks = M.openTasks();
  const hours = settings.get('hours') || [];
  return computePlan({ day, tasks, events: sync.events || [], window: hours[fromYmd(day).getDay()] || null, blocks: M.blocksOn(day), restDay: settings.get('restDay'), nowMin,
    overdue: isToday ? tasks.filter(t => t.due && t.due.date < day && !t.parentId) : [] });
}

function verdict(p) {
  if (p.state === 'rest') return p.count ? `Rest day · ${p.count} task${p.count === 1 ? '' : 's'} scheduled` : 'Rest day';
  if (p.state === 'empty') return p.open ? `${hm(p.open)} open` : 'Planning hours are done';
  if (p.state === 'after') return `Planning hours are done · ${p.count + p.overdue} task${p.count + p.overdue === 1 ? '' : 's'} left`;
  if (p.state === 'fits') return `Fits · ${hm(p.planned)} of ${hm(p.open)} open · ${hm(p.margin)} margin`;
  return `Over by ${hm(-p.margin)} · ${hm(p.planned)} planned, ${hm(p.open)} open`;
}

// One line for each day in Upcoming.
export function planLine(day) {
  const p = planFor(day);
  if (p.state === 'empty' && !p.evs.length) return null;
  return h('span', { class: 'plan-line ' + p.state, title: 'Planned work (with time estimates) vs. open hours after fixed blocks and calendar events' }, verdict(p) + (p.clashes.length ? ` · ${p.clashes.length} clash${p.clashes.length === 1 ? '' : 'es'}` : ''));
}

// Full card for Today.
export function planCard(day, { openTask, editHours } = {}) {
  const p = planFor(day);
  const pct = p.open ? Math.min(100, Math.round(p.planned / p.open * 100)) : (p.planned ? 100 : 0);
  const notes = [];
  if (p.state === 'after') notes.push('Move what is left to tomorrow, so the evening stays free.');
  if (p.overdue) notes.push(`Includes ${p.overdue} overdue task${p.overdue === 1 ? '' : 's'}${p.overdueMin ? ` (${hm(p.overdueMin)})` : ''}: they need doing today or a new date.`);
  if (p.state === 'over') notes.push('Move something to another day, or let the customer know early that the date is at risk.');
  if (p.state === 'rest' && p.count) notes.push(`${DAYS[fromYmd(day).getDay()]} is set as a rest day.`);
  if (p.unestimated) notes.push(`${p.unestimated} task${p.unestimated === 1 ? ' has' : 's have'} no time estimate, so ${p.unestimated === 1 ? 'it isn’t' : 'they aren’t'} counted. Open a task to add minutes.`);
  for (const c of p.clashes) notes.push(`“${c.t.content}” at ${fmtTime(c.t.due.time)} overlaps ${c.e.title}.`);
  // Fixed blocks and timed tasks, in order.
  const rows = [
    ...p.blocks.map(x => ({ start: x.start, el: h('li', { class: 'pl-ev pl-block' }, h('span', { class: 'pl-t' }, clock(x.start) + '–' + clock(x.end)), h('span', { class: 'pdot', style: { background: 'var(--muted)' } }), h('span', { class: 'grow' }, x.b.name)) })),
    ...p.evs.map(x => ({ start: x.start, el: h('li', { class: 'pl-ev' }, h('span', { class: 'pl-t' }, clock(x.start) + '–' + clock(x.end)), h('span', { class: 'pdot', style: { background: x.e.color } }), h('span', { class: 'grow' }, x.e.title)) })),
    ...M.openTasks().filter(t => t.due?.date === day && t.due.time).map(t => ({ start: toMin(t.due.time), el: h('li', { class: 'pl-task', onclick: () => openTask && openTask(t.id) }, h('span', { class: 'pl-t' }, fmtTime(t.due.time) + (t.duration ? '–' + clock(toMin(t.due.time) + t.duration) : '')), icon('done', 13), h('span', { class: 'grow' }, t.content)) })),
  ].sort((a, b) => a.start - b.start);
  const win = (settings.get('hours') || [])[fromYmd(day).getDay()];
  const hoursLbl = win ? `Hours ${clock(toMin(win.start))}–${clock(toMin(win.end))}` : 'No planning hours';
  return h('section', { class: 'plan ' + p.state },
    h('div', { class: 'row between' }, h('strong', null, verdict(p)), editHours && h('button', { class: 'linkbtn sub', onclick: editHours, title: 'Change work hours' }, hoursLbl)),
    !['rest', 'after'].includes(p.state) && h('div', { class: 'pl-bar', role: 'img', 'aria-label': `${pct}% of open hours planned` }, h('span', { style: { width: pct + '%' } })),
    p.state === 'after' && btn('Move what’s left to tomorrow', () => {
      const left = M.openTasks().filter(t => t.due?.date === day && !t.due.recur);
      for (const t of left) store.patch('tasks', t.id, { due: { ...t.due, date: addDays(day, 1) } }, { silent: true });
      store.emit({ local: true }); toast(`Moved ${left.length} task${left.length === 1 ? '' : 's'} to tomorrow`);
    }, 'tiny', 'upcoming'),
    notes.length ? h('ul', { class: 'pl-notes' }, notes.map(n => h('li', null, n))) : null,
    rows.length ? h('ul', { class: 'pl-day' }, rows.map(r => r.el)) : null);
}

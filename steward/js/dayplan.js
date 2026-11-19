// Day plan: does the day's work fit in the hours left after fixed calendar blocks?
// Shown at the top of Today (full card) and on each day in Upcoming (one line).
import { h, today, fromYmd, pad, fmtTime, addDays } from './util.js';
import { store, settings } from './store.js';
import * as M from './model.js';
import { sync } from './sync.js';
import { icon, btn, toast } from './ui.js';
import { aiReady, planWithClaude, planStatus } from './ai.js';

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
// The Today card's headline: short, calm, and says what it means.
function headline(p) {
  const left = p.count + p.overdue;
  if (p.state === 'rest') return { big: 'Rest day', small: p.count ? `${p.count} task${p.count === 1 ? ' is' : 's are'} on it. They can wait.` : 'Nothing planned. Rest well.' };
  if (p.state === 'empty') return p.open ? { big: `${hm(p.open)} open`, small: 'Nothing is planned yet.' } : { big: 'Workday is done', small: 'Nothing left on today’s list.' };
  if (p.state === 'after') return { big: 'Workday is done', small: `${left} task${left === 1 ? '' : 's'} still on today. Give ${left === 1 ? 'it' : 'them'} a new day so the evening stays free.` };
  if (p.state === 'fits') return { big: 'The work fits', small: `${hm(p.planned)} planned in ${hm(p.open)} open · ${hm(p.margin)} to spare` };
  return { big: `Over by ${hm(-p.margin)}`, small: `${hm(p.planned)} planned in ${hm(p.open)} open. Move something, or tell the customer early.` };
}

// One line for each day in Upcoming.
export function planLine(day) {
  const p = planFor(day);
  if (p.state === 'empty' && !p.evs.length) return null;
  return h('span', { class: 'plan-line ' + p.state, title: 'Planned work (with time estimates) vs. open hours after fixed blocks and calendar events' }, verdict(p) + (p.clashes.length ? ` · ${p.clashes.length} clash${p.clashes.length === 1 ? '' : 'es'}` : ''));
}

// Full card for Today: a calm headline, a capacity meter, what needs attention, and the day's timeline (folds away).
export function planCard(day, { openTask, editHours } = {}) {
  const p = planFor(day);
  const pct = p.open ? Math.min(100, Math.round(p.planned / p.open * 100)) : (p.planned ? 100 : 0);
  const notes = [];
  if (p.overdue) notes.push({ ic: 'flag', text: `${p.overdue} overdue task${p.overdue === 1 ? '' : 's'}${p.overdueMin ? ` (${hm(p.overdueMin)})` : ''} counted in today. Do ${p.overdue === 1 ? 'it' : 'them'} today or give ${p.overdue === 1 ? 'it' : 'them'} a new date.` });
  for (const c of p.clashes) notes.push({ ic: 'x', text: `“${c.t.content}” at ${fmtTime(c.t.due.time)} overlaps ${c.e.title}.` });
  if (p.state === 'rest' && p.count) notes.push({ ic: 'bell', text: `${DAYS[fromYmd(day).getDay()]} is set as your rest day.` });
  if (p.unestimated) notes.push({ ic: 'more', text: `${p.unestimated} task${p.unestimated === 1 ? ' has' : 's have'} no time estimate, so ${p.unestimated === 1 ? 'it isn’t' : 'they aren’t'} counted.`, quiet: true });
  // Fixed blocks and timed tasks, in order.
  const rows = [
    ...p.blocks.map(x => ({ start: x.start, el: h('li', { class: 'pl-ev pl-block' }, h('span', { class: 'pl-t' }, clock(x.start) + '–' + clock(x.end)), h('span', { class: 'pdot', style: { background: 'var(--muted)' } }), h('span', { class: 'grow' }, x.b.name)) })),
    ...p.evs.map(x => ({ start: x.start, el: h('li', { class: 'pl-ev' }, h('span', { class: 'pl-t' }, clock(x.start) + '–' + clock(x.end)), h('span', { class: 'pdot', style: { background: x.e.color } }), h('span', { class: 'grow' }, x.e.title)) })),
    ...M.openTasks().filter(t => t.due?.date === day && t.due.time).map(t => ({ start: toMin(t.due.time), el: h('li', { class: 'pl-task', onclick: () => openTask && openTask(t.id) }, h('span', { class: 'pl-t' }, fmtTime(t.due.time) + (t.duration ? '–' + clock(toMin(t.due.time) + t.duration) : '')), icon('done', 13), h('span', { class: 'grow' }, t.content)) })),
  ].sort((a, b) => a.start - b.start);
  const win = (settings.get('hours') || [])[fromYmd(day).getDay()];
  const hoursLbl = win ? `${clock(toMin(win.start))}–${clock(toMin(win.end))}` : 'No planning hours';
  const hd = headline(p);
  const moveLeft = () => {
    const left = M.openTasks().filter(t => t.due && t.due.date <= day && !t.due.recur && !t.parentId);
    const before = left.map(t => ({ id: t.id, due: t.due }));
    for (const t of left) store.patch('tasks', t.id, { due: { ...t.due, date: addDays(day, 1) } }, { silent: true });
    store.emit({ local: true });
    toast(`Moved ${left.length} task${left.length === 1 ? '' : 's'} to tomorrow`, 'Undo', () => { for (const b of before) store.patch('tasks', b.id, { due: b.due }, { silent: true }); store.emit({ local: true }); });
  };
  // Timeline folds away (remembered per device) so the task list stays near the top on a phone.
  let tlOpen; try { tlOpen = localStorage.getItem('steward.planOpen'); } catch {}
  tlOpen = tlOpen == null ? !window.matchMedia('(max-width: 560px)').matches : tlOpen === '1';
  // After 3 PM, a look at tomorrow: an evening is only free when tomorrow is already planned.
  const d = new Date(), isToday = day === today();
  let tomorrow = null;
  if (isToday && d.getHours() >= 15) {
    const t2 = addDays(day, 1), q = planFor(t2);
    const label = q.state === 'rest' ? 'rest day' : q.state === 'empty' ? 'nothing planned yet' : q.state === 'fits' ? `${q.count} task${q.count === 1 ? '' : 's'} · fits with ${hm(q.margin)} to spare` : `${q.count} task${q.count === 1 ? '' : 's'} · over by ${hm(-q.margin)}`;
    tomorrow = h('a', { class: 'pl-tomorrow ' + q.state, href: '#/upcoming' }, icon('upcoming', 14), h('span', { class: 'grow' }, h('b', null, 'Tomorrow '), label), icon('right', 14));
  }
  const over = p.state === 'over', after = p.state === 'after';
  return h('section', { class: 'plan ' + p.state },
    h('div', { class: 'pl-head' },
      h('div', { class: 'grow' }, h('div', { class: 'pl-big' }, hd.big), h('div', { class: 'pl-small' }, hd.small)),
      editHours && h('button', { class: 'pl-hours', onclick: editHours, title: 'Change the hours you plan in' }, icon('gear', 13), hoursLbl)),
    !['rest', 'after'].includes(p.state) && p.open > 0 && h('div', { class: 'pl-meter', role: 'img', 'aria-label': `${pct}% of open hours planned` },
      h('div', { class: 'pl-bar' }, h('span', { style: { width: pct + '%' } })),
      h('div', { class: 'pl-legend' }, h('span', null, h('i', { class: 'sw planned' }), hm(p.planned) + ' planned'), h('span', null, h('i', { class: 'sw open' }), hm(Math.max(0, p.margin)) + ' free'), over && h('span', { class: 'pl-over' }, hm(-p.margin) + ' too much'))),
    aiReady() && p.state !== 'rest' && p.state !== 'after' && (p.count + p.overdue) > 0 && h('div', { class: 'pl-actions' }, btn(planStatus(day) === 'running' ? 'Claude is planning…' : planStatus(day) === 'ready' ? 'See Claude’s plan' : 'Plan with Claude', () => planWithClaude(day, p), planStatus(day) === 'ready' ? 'primary tiny' : 'tiny', 'spark')),
    (after || over) && h('div', { class: 'pl-actions' }, btn(after ? 'Move what’s left to tomorrow' : 'Move unfinished to tomorrow', moveLeft, after ? 'primary tiny' : 'tiny', 'upcoming'),
      over && h('a', { class: 'btn tiny', href: '#/upcoming' }, icon('cal', 14), 'See the week')),
    notes.length ? h('ul', { class: 'pl-notes' }, notes.map(n => h('li', { class: n.quiet ? 'quiet' : '' }, icon(n.ic, 13), h('span', null, n.text)))) : null,
    rows.length ? h('details', { class: 'pl-tl', open: tlOpen, ontoggle: e => { try { localStorage.setItem('steward.planOpen', e.currentTarget.open ? '1' : '0'); } catch {} } },
      h('summary', null, icon('down', 14), `Today’s timeline`, h('span', { class: 'count' }, rows.length)),
      h('ul', { class: 'pl-day' }, rows.map(r => r.el))) : null,
    tomorrow);
}

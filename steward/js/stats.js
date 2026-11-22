// Stats (#/stats): the true state of the week or the quarter, in simple bars. Numbers come from stats-core.js.
import { h, today, fromYmd, fmtDate } from './util.js';
import { store, settings } from './store.js';
import * as M from './model.js';
import * as ST from './stats-core.js';
import { fmtHours, quarterRange } from './goals-core.js';
import { computePlan } from './dayplan.js';
import { icon, btn, iconBtn } from './ui.js';
import { openTask } from './tasks.js';
import { startFamily, logTime } from './focus.js';

const colorOf = c => M.COLORS[c] || M.COLORS.stone;
let mode = 'week', anchor = null; // anchor: a day inside the week or quarter shown

/** Did the day's planned work fit in its hours? Looked at afterwards: what was due that day, finished or not. */
function fitOf(day) {
  const dayStart = fromYmd(day).getTime();
  const tasks = store.all('tasks').filter(t => !t.parentId && t.due?.date === day && (!t.completedAt || t.completedAt >= dayStart));
  return computePlan({ day, tasks, window: (settings.get('hours') || [])[fromYmd(day).getDay()] || null, blocks: M.blocksOn(day), restDay: settings.get('restDay') }).state;
}
/** Everything stats-core needs, read from the store. */
export function statsFor(days, now = today(), opts = {}) {
  return ST.periodStats({ ...opts, days, today: now, restDay: settings.get('restDay'), identities: store.all('identities'), goals: store.all('goals'), tasks: store.all('tasks'), sessions: store.all('sessions'), blocksOn: M.blocksOn, fitOf });
}
export const weekStats = (day = today()) => statsFor(ST.weekOf(day));

const card = (title, sub, ...body) => h('section', { class: 'card stcard' }, h('div', { class: 'row between' }, h('h3', null, title), sub && h('span', { class: 'sub' }, sub)), body);
/** One labelled bar: name on the left, the value in words on the right, the bar between. Text stays in ink; only the bar wears the color. */
function barRow(name, pct, color, value, o = {}) {
  return h('div', { class: 'strow' + (o.quiet ? ' quiet' : ''), title: o.title || `${name}: ${value}` }, h('span', { class: 'stname' }, o.dot !== false && h('span', { class: 'pdot idot', style: { background: color } }), name),
    h('div', { class: 'stbar' + (o.noTarget ? ' open' : '') }, h('span', { style: { width: Math.round(Math.max(0, Math.min(1, pct || 0)) * 100) + '%', background: color } })), h('span', { class: 'stval' }, value));
}
const tile = (n, label, cls = '') => h('div', { class: 'sttile ' + cls }, h('b', null, n), h('span', null, label));
const line = (ic, text, cls = '') => h('li', { class: cls }, icon(ic, 15), h('span', null, text));
const DAY1 = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** The cards, for the Stats screen and for the first step of the weekly review. */
export function statsCards(st, { week = true, now = today(), label = '' } = {}) {
  const q = st.quiet, out = [];
  const maxOpen = Math.max(60, ...st.time.filter(t => !t.targetMin).map(t => t.min));
  out.push(card('Time by identity', label || (week ? 'this week' : 'this quarter so far'),
    st.time.map(t => barRow(t.name, t.targetMin ? t.pct : t.min / maxOpen, colorOf(t.color), t.targetMin ? `${fmtHours(t.min)} of ${fmtHours(t.targetMin)}` : fmtHours(t.min), { noTarget: !t.targetMin, title: `${t.name}: ${fmtHours(t.min)}${t.targetMin ? ` of ${fmtHours(t.targetMin)}` : ', tracked without a target'}${t.timed ? ' (timed, Monday to Saturday; Sunday is never counted)' : ''}` })),
    h('p', { class: 'sub' }, 'Focus sessions, the family timer and time added by hand. Bars with a target fill toward it; the others only show the time.')));
  const restLine = q.restDays ? (q.restKept === q.restDays ? (week ? 'Sunday rest kept' : `Sunday rest kept ${q.restKept} of ${q.restDays} weeks`) : (week ? 'Work was done on the rest day' : `Sunday rest kept ${q.restKept} of ${q.restDays} weeks`)) : 'Sunday rest is still ahead';
  out.push(card('The quiet priorities', null, h('ul', { class: 'stquiet' },
    line('star', `Time with God on ${q.devotionDays} of ${q.devotionOf} day${q.devotionOf === 1 ? '' : 's'}${q.worshipMin ? ` · ${fmtHours(q.worshipMin)}` : ''}`),
    (q.familyTargetMin > 0 || q.familyMin > 0) && line('pin', `Family time ${fmtHours(q.familyMin)}${q.familyTargetMin ? ` of ${fmtHours(q.familyTargetMin)}` : ''}, Monday to Saturday${week && q.familyOpenMin > 0 && q.familyTargetMin ? ` · ${fmtHours(q.familyOpenMin)} still open by Saturday evening` : ''}`),
    q.familyBlocks > 0 && line('today', q.familyBlocksKept === q.familyBlocks ? `Family evenings and Saturdays protected: all ${q.familyBlocks}` : `Family evenings and Saturdays protected: ${q.familyBlocksKept} of ${q.familyBlocks}`, ''),
    q.familyBlocksWorked.length > 0 && week && h('li', { class: 'sub stsubline' }, 'Work ran into: ' + q.familyBlocksWorked.map(b => `${b.name} (${DAY1[fromYmd(b.day).getDay()]})`).join(', ')),
    line('bell', restLine),
    line('book', `Seminary and church ${fmtHours(q.studyMin)}${q.studyTargetMin ? ` of ${fmtHours(q.studyTargetMin)}` : ''}`),
    line('spark', `Health ${fmtHours(q.healthMin)}${q.healthDone ? ` · ${q.healthDone} task${q.healthDone === 1 ? '' : 's'} finished` : ''}`)),
    week && h('div', { class: 'row wrap' }, btn('Start family time', () => startFamily(), 'tiny', 'clock'), btn('Add time by hand', () => logTime({}), 'tiny', 'plus'))));
  const p = st.promises;
  out.push(card('Customer promises', null, h('div', { class: 'sttiles' }, tile(p.onTime, 'kept on time'), tile(p.late, 'finished late', p.late ? 'warn' : ''), tile(p.openPastDue, 'past due, still open', p.openPastDue ? 'warn' : '')),
    p.openTasks.length > 0 && h('div', null, p.openTasks.slice(0, 8).map(t => h('button', { type: 'button', class: 'rowlink', onclick: () => openTask(t.id) }, icon('flag', 15), h('span', { class: 'grow' }, t.content, h('small', null, `promised for ${fmtDate(t.deadline || t.due.date, true)} · ${M.projectName(t.projectId)}`)), icon('right', 14)))),
    !(p.onTime + p.late + p.openPastDue) && h('p', { class: 'sub' }, 'No promises fell in this stretch. Tasks labeled @promise are counted here.')));
  if (st.goals.length) out.push(card('Goals', 'by the calendar', st.goals.map(g => { const i = store.get('identities', g.identityId); return h('a', { class: 'stgoal', href: '#/goal/' + g.id }, barRow(g.title, g.pct, colorOf(i?.color), g.label, { title: `${g.title}: ${g.label}` }), g.pace !== 'open' && h('span', { class: 'gpace ' + g.pace }, g.pace === 'on-track' ? 'On track' : 'Behind the calendar')); })));
  if (st.fit) out.push(card('Did the work fit?', null, st.fit.days ? h('p', { class: 'stbig' }, h('b', null, `${st.fit.fits} of ${st.fit.days}`), ` day${st.fit.days === 1 ? '' : 's'} the planned work fit in your hours`) : h('p', { class: 'sub' }, 'No days with planned work yet.'),
    week && h('div', { class: 'stdays' }, st.days.map(d => { const s = d > now ? 'ahead' : fitOf(d); const lbl = { fits: 'fit', over: 'over', rest: 'rest', empty: 'nothing planned', after: 'fit', ahead: '' }[s]; return h('div', { class: 'stday ' + s, title: `${fmtDate(d, true)}: ${lbl || 'not yet'}` }, h('b', null, DAY1[fromYmd(d).getDay()]), h('span', null, { fits: 'fit', over: 'over', rest: 'rest', empty: '–', after: 'fit', ahead: '' }[s])); })),
    h('p', { class: 'sub' }, 'Looked at afterwards: what was due each day, finished or not, against the hours left after fixed blocks.')));
  const maxA = Math.max(1, ...st.areas.map(a => a.n));
  out.push(card('Tasks finished', `${st.completed} in all`, st.areas.length ? st.areas.map(a => barRow(a.name, a.n / maxA, 'var(--accent)', String(a.n), { dot: false, noTarget: true })) : h('p', { class: 'sub' }, 'None yet.')));
  return out;
}

export function renderStats(route, main) {
  main.classList.add('stats-view');
  const now = today();
  if (!anchor) anchor = now;
  const week = mode === 'week', days = week ? ST.weekOf(anchor) : ST.quarterDays(anchor);
  const st = statsFor(days, now);
  const step = dir => { anchor = week ? ST.addDays(days[0], dir * 7) : ST.addDays(dir < 0 ? days[0] : days[days.length - 1], dir); location.hash = '#/stats'; store.emit({}); };
  const isNow = days.includes(now);
  const label = week ? (isNow ? 'This week' : `Week of ${fmtDate(days[0], true)}`) + ` · ${fmtDate(days[0], true)} to ${fmtDate(days[6], true)}` : quarterRange(anchor).label + (isNow ? ' so far' : '');
  main.append(h('header', { class: 'vhead' }, h('div', null, h('h1', null, 'Stats'), h('div', { class: 'sub' }, label)),
    h('div', { class: 'row' }, h('div', { class: 'seg' }, [['week', 'Week'], ['quarter', 'Quarter']].map(([k, l]) => h('button', { type: 'button', class: mode === k ? 'on' : '', onclick: () => { mode = k; anchor = now; store.emit({}); } }, l))),
      iconBtn('left', week ? 'Earlier week' : 'Earlier quarter', () => step(-1)), iconBtn('right', week ? 'Later week' : 'Later quarter', () => { if (!isNow) step(1); }, isNow ? 'off' : ''))));
  main.append(h('p', { class: 'verse' }, '“Be thou diligent to know the state of thy flocks, and look well to thy herds.” ', h('span', null, 'Proverbs 27:23')));
  main.append(h('div', { class: 'stgrid' }, statsCards(st, { week, now })));
  if (week) main.append(h('p', { class: 'sub center' }, h('a', { href: '#/review' }, 'Open the weekly review')));
}

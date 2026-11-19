// Identities and goals: the rules, with no browser APIs (tests/goals-core.test.mjs).
// An identity is a role Charles lives in; a goal is a 90-day "quest" under one identity, with the tasks that move it.
// "A man's heart deviseth his way: but the LORD directeth his steps." (Prov. 16:9): goals are planned humbly and
// held loosely, so dropping or changing one is an ordinary choice here, never a failure state.
import { AREA_IDS } from './organize-core.js';

/**
 * The starting identities, in his order of priority (God and family first everywhere they are listed).
 * areas: organizer areas; labels: finer tags that mark a task as this identity's. An identity with labels claims only
 * tasks carrying one of them; an identity without labels claims its whole area. firstTags: tags that sort first
 * inside the identity (his wife and child above the rest of the family; set from his own data, names stay out of
 * this public code). timed: time is counted with a start/stop timer, Monday to Saturday.
 */
export const SEED_IDENTITIES = [
  { id: 'id-christ', name: 'Christ Worship', color: 'gold', icon: 'star', purpose: '“But seek ye first the kingdom of God, and his righteousness” (Matt. 6:33)', areas: ['personal'], labels: ['devotions', 'prayer', 'scripture', 'worship'], weeklyTargetMin: 270, order: 1 },
  { id: 'id-family', name: 'Family', color: 'rose', icon: 'pin', purpose: 'Present at home: husband first, then father, son and brother.', areas: ['home-family'], labels: [], firstTags: ['baby', 'date-night'], weeklyTargetMin: 1080, timed: true, order: 2 },
  { id: 'id-health', name: 'Health', color: 'teal', icon: 'spark', purpose: 'Sleep, exercise and food that keep me useful.', areas: ['personal'], labels: ['health', 'exercise'], order: 3 },
  { id: 'id-work', name: 'Work: CS Outdoors', color: 'green', icon: 'flag', purpose: '“Be thou diligent to know the state of thy flocks” (Prov. 27:23)', areas: ['cs-outdoors'], labels: [], order: 4 },
  { id: 'id-seminary', name: 'Seminary & Church', color: 'indigo', icon: 'book', purpose: 'Study to shew thyself approved; serve the church.', areas: ['seminary', 'church'], labels: [], weeklyTargetMin: 600, order: 5 },
  { id: 'id-friends', name: 'Friends', color: 'orange', icon: 'comment', purpose: 'Iron sharpeneth iron (Prov. 27:17).', areas: ['personal'], labels: ['friends'], order: 6 },
];
export const SOFT_LIMIT = 4;
export const KINDS = { milestones: 'Checklist of tasks', count: 'A number to reach', hours: 'Hours of focused time' };
export const byOrder = (a, b) => (a.order ?? 99) - (b.order ?? 99) || String(a.name || a.title || '').localeCompare(String(b.name || b.title || ''));
const lower = list => (list || []).map(x => String(x).toLowerCase());

/**
 * Which identity a task belongs to, with no extra tagging:
 *   1. its goal's identity;  2. an identity that lists its project;  3. an identity whose labels it carries;
 *   4. an identity that takes the whole of its organizer area;  5. its parent task's identity.
 * ctx: { identities, goals, tasks? } (arrays of live items). Returns the identity or null.
 */
export function identityOf(task, ctx, depth = 0) {
  if (!task) return null;
  const ids = [...(ctx.identities || [])].sort(byOrder);
  if (task.goalId) { const g = (ctx.goals || []).find(x => x.id === task.goalId); const i = g && ids.find(x => x.id === g.identityId); if (i) return i; }
  if (task.projectId && task.projectId !== 'inbox') { const i = ids.find(x => (x.projectIds || []).includes(task.projectId)); if (i) return i; }
  const labels = lower(task.labels);
  const byLabel = ids.find(x => lower(x.labels).some(l => labels.includes(l)));
  if (byLabel) return byLabel;
  const area = labels.find(l => AREA_IDS.includes(l));
  if (area) { const i = ids.find(x => (x.areas || []).includes(area) && !(x.labels || []).length); if (i) return i; }
  if (task.parentId && depth < 4 && ctx.tasks) { const p = ctx.tasks.find(x => x.id === task.parentId); if (p) return identityOf(p, ctx, depth + 1); }
  return null;
}
/** Where a list of labels sorts inside an identity: 0 for its first "comes first" tag, then 1, 2…; a large number for none. */
export function firstRank(labels, identity) {
  const first = lower(identity?.firstTags), have = lower(labels);
  const i = first.findIndex(t => have.includes(t));
  return i < 0 ? 999 : i;
}
/** Goals in the order to show them: active first, "comes first" tags first inside the identity, then his own order. */
export function sortGoals(goals, identity) {
  const st = { active: 0, done: 1, dropped: 2 };
  return [...goals].sort((a, b) => (st[a.status] ?? 0) - (st[b.status] ?? 0) || firstRank(a.tags, identity) - firstRank(b.tags, identity) || (a.order ?? 0) - (b.order ?? 0) || (a.createdAt || 0) - (b.createdAt || 0));
}

// ---- dates -------------------------------------------------------------------------------------------------------
const pad = n => String(n).padStart(2, '0');
const parts = s => s.split('-').map(Number);
const toDate = s => { const [y, m, d] = parts(s); return new Date(y, m - 1, d); };
/** The calendar quarter a day falls in: { start, end, label } with YYYY-MM-DD dates. */
export function quarterRange(day) {
  const [y, m] = parts(day), q = Math.floor((m - 1) / 3), endM = q * 3 + 3;
  return { start: `${y}-${pad(q * 3 + 1)}-01`, end: `${y}-${pad(endM)}-${pad(new Date(y, endM, 0).getDate())}`, label: `Q${q + 1} ${y}` };
}
export const nextQuarter = day => { const [y, m] = parts(quarterRange(day).end); return quarterRange(m === 12 ? `${y + 1}-01-01` : `${y}-${pad(m + 1)}-01`); };
/** True in the last 10 days of a quarter (the weekly review then adds its quarter step). */
export function quarterEnding(day) { const end = toDate(quarterRange(day).end); return Math.round((end - toDate(day)) / 864e5) < 10; }

// ---- progress ----------------------------------------------------------------------------------------------------
/**
 * How far along a goal is. tasks: every live task; sessions: every live focus session.
 * milestones: linked tasks done / linked tasks.  count: his own tally + completed linked tasks, toward target.
 * hours: minutes of focus time tagged to the goal, toward target hours.
 */
export function goalProgress(goal, { tasks = [], sessions = [] } = {}) {
  const linked = tasks.filter(t => t.goalId === goal.id && !t.parentId);
  const doneTasks = linked.filter(t => t.completedAt).length;
  if (goal.kind === 'hours') {
    const min = sessions.filter(s => s.goalId === goal.id && s.endedAt).reduce((n, s) => n + (s.actualMin || 0), 0);
    const total = Math.max(0, Number(goal.target) || 0) * 60;
    return { kind: 'hours', done: min, total, pct: total ? Math.min(1, min / total) : 0, label: `${fmtHours(min)} of ${goal.target || 0} h`, linked: linked.length, doneTasks };
  }
  if (goal.kind === 'count') {
    const done = Math.max(0, Number(goal.manual) || 0) + doneTasks, total = Math.max(0, Number(goal.target) || 0);
    return { kind: 'count', done, total, pct: total ? Math.min(1, done / total) : 0, label: `${done} of ${total}${goal.unit ? ' ' + goal.unit : ''}`, linked: linked.length, doneTasks };
  }
  return { kind: 'milestones', done: doneTasks, total: linked.length, pct: linked.length ? doneTasks / linked.length : 0, label: linked.length ? `${doneTasks} of ${linked.length} done` : 'No tasks linked yet', linked: linked.length, doneTasks };
}
export const fmtHours = min => { const h = Math.round(min / 6) / 10; return (Number.isInteger(h) ? h : h.toFixed(1)) + ' h'; };
/** How much of the goal's time has passed (0–1), by the calendar. */
export function expectedPct(goal, day) {
  if (!goal.start || !goal.end) return null;
  // a goal added part-way through its quarter is paced from the day it was added, not from the quarter's first day
  const made = goal.createdAt > 1e11 ? new Date(goal.createdAt) : null;
  const madeDay = made ? new Date(made.getFullYear(), made.getMonth(), made.getDate()) : null;
  let a = toDate(goal.start); const b = toDate(goal.end), d = toDate(day);
  if (madeDay && madeDay > a && madeDay <= b) a = madeDay;
  if (b <= a) return d >= b ? 1 : 0;
  return Math.max(0, Math.min(1, (d - a + 864e5) / (b - a + 864e5)));
}
/** 'done' | 'dropped' | 'on-track' | 'behind' | 'open' (nothing to measure yet). Behind = more than 15 points short of the calendar. */
export function goalPace(goal, progress, day) {
  if (goal.status === 'done' || goal.status === 'dropped') return goal.status;
  const exp = expectedPct(goal, day);
  if (exp == null || !progress.total) return 'open';
  return progress.pct + 0.15 >= exp ? 'on-track' : 'behind';
}
/** The task to do next for a goal: the one he chose, else the open linked task due soonest. */
export function nextTask(goal, tasks) {
  const open = tasks.filter(t => t.goalId === goal.id && !t.completedAt);
  const chosen = goal.nextTaskId && open.find(t => t.id === goal.nextTaskId);
  if (chosen) return chosen;
  return open.sort((a, b) => ((a.due?.date || '9999') + (a.due?.time || '99')).localeCompare((b.due?.date || '9999') + (b.due?.time || '99')) || (a.priority || 4) - (b.priority || 4) || (a.order ?? 0) - (b.order ?? 0))[0] || null;
}

// ---- quick add: "goal:<name>" ------------------------------------------------------------------------------------
const squash = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
/**
 * Find "goal:<name>" in what was typed. The name may be the goal's whole title or just how it starts, with or without
 * spaces ("goal:read 12 sermons", "goal:read12"). Returns { goalId, title, rest } or null; rest is the text without it.
 */
export function extractGoal(text, goals) {
  const m = /(^|\s)goal:\s*(\S.*)$/i.exec(String(text || ''));
  if (!m) return null;
  const words = m[2].split(/\s+/);
  const live = (goals || []).filter(g => g.status !== 'dropped' && g.status !== 'done');
  // the longest run of words after "goal:" that names exactly one goal (whole title first, then how a title starts)
  for (let n = words.length; n > 0; n--) {
    const key = squash(words.slice(0, n).join(' '));
    if (!key) continue;
    const exact = live.filter(g => squash(g.title) === key);
    const starts = exact.length ? exact : key.length >= 3 ? live.filter(g => squash(g.title).startsWith(key)) : [];
    if (starts.length === 1) return { goalId: starts[0].id, title: starts[0].title, rest: (text.slice(0, m.index) + ' ' + words.slice(n).join(' ')).replace(/\s{2,}/g, ' ').trim() };
  }
  return null;
}
/** Spoken "goal read twelve sermons" → "goal:Read 12 sermons", only for a goal that exists. */
export function spokenGoal(text, goals) {
  return String(text || '').replace(/\s(?:(?:for|under|toward|towards) )?(?:the )?goal\s+(.+)$/i, (all, rest) => { const hit = extractGoal('goal:' + rest, goals); return hit ? ` goal:${hit.title} ${extractGoal('goal:' + rest, goals).rest}` : all; });
}

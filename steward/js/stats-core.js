// Stats and the weekly review: every number, with no browser APIs (tests/stats-core.test.mjs).
// "Be thou diligent to know the state of thy flocks, and look well to thy herds." (Prov. 27:23): these numbers are
// for knowing the true state of things. There are no points, no streaks to break, and nothing here is a verdict.
// Sunday (the rest day) never counts against any target.
import { identityOf, goalProgress, goalPace, byOrder, quarterRange } from './goals-core.js';
import { byDay, dayOf, weekOf } from './session-core.js';
import { AREAS, AREA_IDS } from './organize-core.js';

const pad = n => String(n).padStart(2, '0');
const dow = day => { const [y, m, d] = day.split('-').map(Number); return new Date(y, m - 1, d).getDay(); };
const addDays = (day, n) => { const [y, m, d] = day.split('-').map(Number); const t = new Date(y, m - 1, d + n); return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`; };
export { weekOf, addDays };
/** Every day from start to end, inclusive. */
export function daysBetween(start, end) { const out = []; for (let d = start; d <= end && out.length < 400; d = addDays(d, 1)) out.push(d); return out; }
export const quarterDays = day => { const q = quarterRange(day); return daysBetween(q.start, q.end); };

/** Every moment a task was finished: once for a one-time task, each round for a repeating one. */
export function doneTimes(t) { return [...new Set([t.completedAt, t.lastDoneAt, ...(t.doneLog || [])].filter(Boolean))]; }
/** The identities that play a part in the quiet-priority checks, found by id first and by their settings after. */
export function roles(identities) {
  const ids = [...identities].sort(byOrder), by = id => ids.find(i => i.id === id);
  return {
    worship: by('id-christ') || ids[0] || null,
    family: (by('id-family')?.timed && by('id-family')) || ids.find(i => i.timed) || by('id-family') || null,
    health: by('id-health') || ids.find(i => (i.labels || []).includes('health')) || null,
    work: by('id-work') || ids.find(i => (i.areas || []).includes('cs-outdoors')) || null,
    study: by('id-seminary') || ids.find(i => (i.areas || []).includes('seminary')) || null,
  };
}
const minOfDay = ms => { const d = new Date(ms); return d.getHours() * 60 + d.getMinutes(); };

/**
 * The state of things over a set of days (a week, Monday to Sunday, or a quarter).
 * in: { days, today, restDay (0 = Sunday, -1 none), identities, goals, tasks, sessions, blocksOn(day) -> [{ b, start, end }],
 *       fitOf(day) -> 'fits' | 'over' | 'rest' | 'empty' | 'after' (optional), now }
 */
export function periodStats({ days, today, restDay = 0, identities = [], goals = [], tasks = [], sessions = [], blocksOn = () => [], fitOf = null, now = Date.now(), targetWeeks = null }) {
  const want = new Set(days), past = days.filter(d => d <= today);
  const ctx = { identities, goals, tasks }, r = roles(identities);
  const idOf = new Map(); const identOf = t => { if (!idOf.has(t.id)) idOf.set(t.id, identityOf(t, ctx)?.id || null); return idOf.get(t.id); };
  const weeks = Math.max(1, Math.round(days.length / 7)), weeksSoFar = Math.max(1, Math.ceil(past.length / 7));

  // ---- time by identity (God and family first) ----
  const minutes = new Map(), minByDay = new Map(); // identity -> minutes; identity|day -> minutes
  for (const s of sessions) {
    if (!s.identityId) continue;
    const timed = identities.find(i => i.id === s.identityId)?.timed;
    for (const part of byDay(s, now)) {
      if (!want.has(part.day)) continue;
      minByDay.set(s.identityId + '|' + part.day, (minByDay.get(s.identityId + '|' + part.day) || 0) + part.min);
      if (timed && dow(part.day) === 0) continue; // family time on Sunday is kept, never counted toward the target
      minutes.set(s.identityId, (minutes.get(s.identityId) || 0) + part.min);
    }
  }
  const time = [...identities].sort(byOrder).map(i => { const min = minutes.get(i.id) || 0, target = (i.weeklyTargetMin || 0) * (targetWeeks || (days.length > 7 ? weeksSoFar : 1)); return { id: i.id, name: i.name, color: i.color, timed: !!i.timed, min, targetMin: target || 0, pct: target ? Math.min(1, min / target) : null }; });

  // ---- finished tasks ----
  const done = []; // { t, at, day, identityId }
  for (const t of tasks) for (const at of doneTimes(t)) { const day = dayOf(at); if (want.has(day)) done.push({ t, at, day, identityId: identOf(t) }); }
  const byArea = new Map(AREAS.map(a => [a.id, 0]));
  let unfiled = 0;
  for (const d of done) { if (d.t.parentId) continue; const a = (d.t.labels || []).find(l => AREA_IDS.includes(l)); if (a) byArea.set(a, byArea.get(a) + 1); else unfiled++; }
  const areas = [...AREAS.map(a => ({ id: a.id, name: a.name, n: byArea.get(a.id) })), { id: '', name: 'Not filed', n: unfiled }].filter(a => a.n > 0);

  // ---- the quiet priorities ----
  const isWork = id => !!r.work && id === r.work.id;
  const workDone = done.filter(d => isWork(d.identityId));
  const workSessions = sessions.filter(s => r.work && s.identityId === r.work.id && s.kind !== 'family');
  const workMinOn = day => minByDay.get((r.work?.id || '') + '|' + day) || 0;
  // devotion days: a Christ Worship task finished, or time spent there
  const devotionDays = past.filter(day => r.worship && (done.some(d => d.day === day && d.identityId === r.worship.id) || (minByDay.get(r.worship.id + '|' + day) || 0) > 0));
  // family blocks (dinner, date night, Saturday family time) kept free of work
  const blocks = [];
  if (r.family) for (const day of past) {
    if (dow(day) === 0) continue;
    for (const x of blocksOn(day)) {
      if (x.b.identityId !== r.family.id) continue;
      const [y, m, d] = day.split('-').map(Number), from = new Date(y, m - 1, d, 0, x.start).getTime(), to = new Date(y, m - 1, d, 0, x.end).getTime();
      if (from > now) continue; // has not happened yet
      const worked = workDone.some(w => w.at >= from && w.at < to) || workSessions.some(s => s.startedAt < to && (s.endedAt || now) > from);
      blocks.push({ day, name: x.b.name, kept: !worked });
    }
  }
  const fam = time.find(t => r.family && t.id === r.family.id);
  // the rest day: no work tasks finished and no work sessions
  const restDays = past.filter(day => restDay >= 0 && dow(day) === restDay).map(day => ({ day, kept: !workDone.some(w => w.day === day) && workMinOn(day) === 0 }));
  const quiet = {
    devotionDays: devotionDays.length, devotionOf: past.length,
    familyBlocksKept: blocks.filter(b => b.kept).length, familyBlocks: blocks.length, familyBlocksWorked: blocks.filter(b => !b.kept),
    familyMin: fam?.min || 0, familyTargetMin: fam?.targetMin || 0, familyOpenMin: Math.max(0, (fam?.targetMin || 0) - (fam?.min || 0)),
    restKept: restDays.filter(x => x.kept).length, restDays: restDays.length, restAhead: days.some(d => d > today && restDay >= 0 && dow(d) === restDay),
    studyMin: r.study ? minutes.get(r.study.id) || 0 : 0, studyTargetMin: time.find(t => r.study && t.id === r.study.id)?.targetMin || 0,
    healthMin: r.health ? minutes.get(r.health.id) || 0 : 0, healthDone: r.health ? done.filter(d => d.identityId === r.health.id).length : 0,
    worshipMin: r.worship ? minutes.get(r.worship.id) || 0 : 0,
  };

  // ---- customer promises ----
  const isPromise = t => (t.labels || []).includes('promise') && !t.parentId;
  const promisedBy = t => t.deadline || t.due?.date || null;
  const kept = [], late = [];
  for (const d of done) { if (!isPromise(d.t)) continue; const by = d.t.due?.recur ? null : promisedBy(d.t); (by && d.day > by ? late : kept).push(d.t); }
  const openLate = tasks.filter(t => isPromise(t) && !t.completedAt && promisedBy(t) && promisedBy(t) < today);
  const promises = { onTime: kept.length, late: late.length, lateTasks: late, openPastDue: openLate.length, openTasks: openLate };

  // ---- goals ----
  const d2 = { tasks, sessions };
  const goalRows = goals.filter(g => g.status === 'active' && (!g.start || g.start <= today)).map(g => { const p = goalProgress(g, d2); return { id: g.id, title: g.title, identityId: g.identityId, pct: p.pct, label: p.label, pace: goalPace(g, p, today) }; })
    .sort((a, b) => (identities.find(i => i.id === a.identityId)?.order ?? 99) - (identities.find(i => i.id === b.identityId)?.order ?? 99));

  // ---- did the planned work fit in his hours? ----
  let fit = null;
  if (fitOf) { const states = past.map(day => [day, fitOf(day)]); const counted = states.filter(([, s]) => s === 'fits' || s === 'over'); fit = { fits: counted.filter(([, s]) => s === 'fits').length, days: counted.length, over: counted.filter(([, s]) => s === 'over').map(([d]) => d) }; }

  return { days, weeks, time, quiet, promises, goals: goalRows, fit, areas, completed: done.filter(d => !d.t.parentId).length, focusMin: time.reduce((n, t) => n + t.min, 0) };
}

const h1 = min => { const h = Math.round(min / 6) / 10; return `${Number.isInteger(h) ? h : h.toFixed(1)} hour${h === 1 ? '' : 's'}`; };
/** The week in plain words, for the first step of the review and the saved note. Calm and honest; no scolding. */
export function plainSummary(st) {
  const out = [], q = st.quiet;
  const w = st.time[0];
  if (w) out.push(`${w.name}: ${h1(w.min)}${w.targetMin ? ` of ${h1(w.targetMin)}` : ''}, with time or a finished task on ${q.devotionDays} of ${q.devotionOf} day${q.devotionOf === 1 ? '' : 's'}.`);
  if (q.familyTargetMin || q.familyMin) out.push(`Family time: ${h1(q.familyMin)} timed, Monday to Saturday${q.familyTargetMin ? `, toward ${h1(q.familyTargetMin)}` : ''}${q.familyOpenMin > 0 && q.familyTargetMin ? ` (${h1(q.familyOpenMin)} still open)` : ''}.`);
  if (q.familyBlocks) out.push(q.familyBlocksKept === q.familyBlocks ? `All ${q.familyBlocks} family blocks were kept free of work.` : `${q.familyBlocksKept} of ${q.familyBlocks} family blocks were kept free of work.`);
  if (q.restDays) out.push(q.restKept === q.restDays ? 'Sunday rest was kept.' : 'Work was done on the rest day.');
  else if (q.restAhead) out.push('Sunday rest is still ahead.');
  for (const t of st.time.slice(1)) { if (t.timed) continue; if (t.targetMin) out.push(`${t.name}: ${h1(t.min)} of ${h1(t.targetMin)}.`); else if (t.min) out.push(`${t.name}: ${h1(t.min)}.`); }
  const p = st.promises;
  if (p.onTime + p.late + p.openPastDue) out.push(`Customer promises: ${p.onTime} kept on time${p.late ? `, ${p.late} finished late` : ''}${p.openPastDue ? `, ${p.openPastDue} past due and still open` : ''}.`);
  if (st.fit && st.fit.days) out.push(`The planned work fit in your hours on ${st.fit.fits} of ${st.fit.days} day${st.fit.days === 1 ? '' : 's'}.`);
  out.push(`${st.completed} task${st.completed === 1 ? '' : 's'} finished.`);
  return out;
}

/**
 * The days a weekly review looks back over: from the day of the last review through today, so the evening after a
 * Friday review, Saturday's family time and Sunday's rest are all in the next one. With no earlier review (or one
 * outside 5 to 10 days ago) it is the last seven days.
 */
export function reviewDays(today, lastReviewDay = null) {
  const span = lastReviewDay && lastReviewDay < today ? daysBetween(lastReviewDay, today) : [];
  return span.length >= 6 && span.length <= 11 ? span : daysBetween(addDays(today, -6), today);
}
/**
 * Is this a sound time for the weekly review? It must not be the rest day, and its 15 minutes must not land on a
 * fixed block (Saturday family time included). Returns '' when fine, else what is in the way.
 * blocks: that weekday's fixed blocks as [{ name, start, end }] in minutes.
 */
export function reviewSlotProblem({ day, time, restDay = 0, blocks = [], lengthMin = 15 }) {
  if (day === restDay || day === 0) return 'The review never lands on Sunday. Pick another day.';
  const [h, m] = String(time || '').split(':').map(Number);
  if (!(h >= 0 && h < 24 && m >= 0 && m < 60)) return 'Pick a time.';
  const a = h * 60 + m, b = a + lengthMin;
  const hit = blocks.find(x => x.start < b && x.end > a);
  return hit ? `That lands on ${hit.name}. Pick a time outside it.` : '';
}
/** The first free quarter-hour at or after `time` on that weekday (used when the default slot is taken). */
export function freeReviewSlot({ day, time, restDay = 0, blocks = [] }) {
  const [h, m] = time.split(':').map(Number);
  for (let t = h * 60 + m; t <= 21 * 60; t += 15) { const hm = `${pad(Math.floor(t / 60))}:${pad(t % 60)}`; if (!reviewSlotProblem({ day, time: hm, restDay, blocks })) return hm; }
  return time;
}

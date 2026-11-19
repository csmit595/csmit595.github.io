// Focus sessions and the family-time timer: the rules, with no browser APIs (tests/session-core.test.mjs).
// A session's time is always worked out from saved moments (startedAt, pauses, endedAt), never from a running
// counter, so it survives the screen locking, the app closing, or picking it up on the other device.
//   session: { id, kind: 'focus' | 'family' | 'manual', taskId, goalId, identityId, startedAt, endsAt, pauses: [{ at, until }],
//              endedAt, plannedMin, actualMin, format: 'standard' | '5-50-5', rating, note, interruptions, device }
const MIN = 60000;
export const LENGTHS = [25, 50, 90];
export const FAMILY_STALE_MS = 5 * 3600e3;
const pad = n => String(n).padStart(2, '0');
export const dayOf = ms => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

export const isRunning = s => !!s && !s.endedAt && !s.deleted && !!s.startedAt;
export const isPaused = s => isRunning(s) && (s.pauses || []).some(p => !p.until);
/** Milliseconds spent paused up to `now` (or up to the end, for a finished session). */
export function pausedMs(s, now = Date.now()) {
  const stop = s.endedAt || now;
  return (s.pauses || []).reduce((n, p) => n + Math.max(0, Math.min(p.until || stop, stop) - Math.min(p.at, stop)), 0);
}
export const elapsedMs = (s, now = Date.now()) => Math.max(0, (s.endedAt || now) - s.startedAt - pausedMs(s, now));
/** Time left in a timed session (never below zero). Family time counts up and has none. */
export const remainingMs = (s, now = Date.now()) => s.plannedMin ? Math.max(0, s.plannedMin * MIN - elapsedMs(s, now)) : null;
export const isOver = (s, now = Date.now()) => isRunning(s) && !!s.plannedMin && remainingMs(s, now) === 0;
/** When a running, timed session will end if nothing changes (so the helper can send the end alert); null when paused. */
export const endsAtOf = (s, now = Date.now()) => (!isRunning(s) || isPaused(s) || !s.plannedMin) ? null : now + remainingMs(s, now);

export function start({ kind = 'focus', taskId = null, goalId = null, identityId = null, plannedMin = 50, format = 'standard', device = '', now = Date.now() }) {
  const s = { kind, taskId, goalId, identityId, startedAt: now, endsAt: null, pauses: [], endedAt: null, plannedMin: kind === 'family' ? null : Math.max(1, Math.round(plannedMin)), actualMin: null, format: kind === 'family' ? 'standard' : format, rating: null, note: '', interruptions: 0, device };
  s.endsAt = endsAtOf(s, now);
  return s;
}
export function pause(s, now = Date.now()) { if (!isRunning(s) || isPaused(s)) return s; return { ...s, pauses: [...(s.pauses || []), { at: now, until: null }], endsAt: null }; }
export function resume(s, now = Date.now()) {
  if (!isPaused(s)) return s;
  const out = { ...s, pauses: s.pauses.map(p => p.until ? p : { ...p, until: now }) };
  out.endsAt = endsAtOf(out, now);
  return out;
}
/** End a session at `at` (default now). A timed session never counts more than its planned length plus what he chose to add. */
export function finish(s, at = Date.now()) {
  if (!isRunning(s)) return s;
  const end = Math.max(s.startedAt, at);
  const closed = { ...s, pauses: (s.pauses || []).filter(p => p.at < end).map(p => p.until && p.until <= end ? p : { ...p, until: end }), endedAt: end, endsAt: null };
  closed.actualMin = Math.round(elapsedMs(closed, end) / MIN);
  return closed;
}
/** A timed session whose time ran out while nobody was looking: close it at the moment it ran out. */
export function finishAtPlanned(s, now = Date.now()) {
  if (!isOver(s, now)) return s;
  const over = elapsedMs(s, now) - s.plannedMin * MIN; // how long ago it ran out (it cannot have been paused since)
  return finish(s, now - over);
}
/** Time entered by hand, for a timer he forgot to start. */
export function manual({ kind = 'manual', identityId = null, goalId = null, taskId = null, minutes, day, note = '', device = '', now = Date.now() }) {
  const [y, m, d] = (day || dayOf(now)).split('-').map(Number);
  const at = day && day !== dayOf(now) ? new Date(y, m - 1, d, 12).getTime() : now - minutes * MIN;
  return { kind, taskId, goalId, identityId, startedAt: at, endsAt: null, pauses: [], endedAt: at + minutes * MIN, plannedMin: null, actualMin: Math.max(0, Math.round(minutes)), format: 'standard', rating: null, note, interruptions: 0, device, byHand: true };
}

/** 5-50-5: five minutes to plan, the middle to work, five to review. Returns { name: 'plan' | 'focus' | 'review', leftMs }. */
export function phase(s, now = Date.now()) {
  if (s.format !== '5-50-5' || !s.plannedMin || s.plannedMin < 15) return { name: 'focus', leftMs: remainingMs(s, now) };
  const e = elapsedMs(s, now), total = s.plannedMin * MIN, edge = 5 * MIN;
  if (e < edge) return { name: 'plan', leftMs: edge - e };
  if (e < total - edge) return { name: 'focus', leftMs: total - edge - e };
  return { name: 'review', leftMs: Math.max(0, total - e) };
}

/**
 * Before starting: would this session run into something fixed?
 * nowMin: minutes past midnight now; busy: [{ start, end, title }] (fixed blocks and calendar events today, in minutes).
 * Returns { clash: null } or { clash: { title, start, end }, fitMin } where fitMin is how long a session could run
 * and still end in time (0 when the block has already begun).
 */
export function guard({ nowMin, lengthMin, busy = [] }) {
  const end = nowMin + lengthMin;
  const hit = busy.filter(b => b.start < end && b.end > nowMin).sort((a, b) => a.start - b.start)[0];
  if (!hit) return { clash: null, fitMin: lengthMin };
  return { clash: { title: hit.title, start: hit.start, end: hit.end }, fitMin: Math.max(0, hit.start - nowMin) };
}

/** A family timer that was probably forgotten: still running five hours on, or into the next day. */
export function familyStale(s, now = Date.now()) {
  if (!isRunning(s) || s.kind !== 'family' || s.staleAsked) return false;
  return now - s.startedAt >= FAMILY_STALE_MS || dayOf(now) !== dayOf(s.startedAt);
}

/** A session's counted minutes, day by day (a session that crosses midnight is split). [{ day, min }] */
export function byDay(s, now = Date.now()) {
  if (!s || !s.startedAt) return [];
  if (s.byHand || (s.endedAt && s.actualMin != null && !(s.pauses || []).length && dayOf(s.startedAt) === dayOf(s.endedAt))) return [{ day: dayOf(s.startedAt), min: s.actualMin || 0 }];
  const stop = s.endedAt || now, out = new Map();
  // walk the active stretches (between pauses), cutting each at midnight
  const cuts = [...(s.pauses || [])].sort((a, b) => a.at - b.at);
  let from = s.startedAt;
  const add = (a, b) => { while (a < b) { const d = new Date(a); const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime(); const to = Math.min(b, midnight); out.set(dayOf(a), (out.get(dayOf(a)) || 0) + (to - a)); a = to; } };
  for (const p of cuts) { add(from, Math.min(p.at, stop)); from = Math.min(p.until || stop, stop); }
  add(from, stop);
  return [...out].map(([day, ms]) => ({ day, min: Math.round(ms / MIN) })).filter(x => x.min > 0);
}
/** The session that is running now, if any (the newest, should two devices each have started one). */
export const running = sessions => (sessions || []).filter(isRunning).sort((a, b) => b.startedAt - a.startedAt)[0] || null;
export const clock = ms => { const t = Math.max(0, Math.round(ms / 1000)), h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = t % 60; return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`; };

// ---- weeks -------------------------------------------------------------------------------------------------------
const ymdOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** The seven days of the week a day falls in, Monday first: ['2026-11-16', …, '2026-11-22']. */
export function weekOf(day) {
  const [y, m, d] = day.split('-').map(Number), dt = new Date(y, m - 1, d), back = (dt.getDay() + 6) % 7;
  return Array.from({ length: 7 }, (_, i) => ymdOf(new Date(y, m - 1, d - back + i)));
}
const dow = day => { const [y, m, d] = day.split('-').map(Number); return new Date(y, m - 1, d).getDay(); };
/**
 * Minutes of sessions on the given days. opts.skipSunday: leave Sunday out (family time is counted Monday to
 * Saturday; Sunday's minutes are kept on the session but never counted toward the target).
 */
export function minutesOn(sessions, days, { skipSunday = false, now = Date.now() } = {}) {
  const want = new Set(days);
  let n = 0;
  for (const s of sessions) for (const part of byDay(s, now)) if (want.has(part.day) && !(skipSunday && dow(part.day) === 0)) n += part.min;
  return n;
}

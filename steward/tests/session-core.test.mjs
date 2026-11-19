import test from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../js/session-core.js';

const MIN = 60000, T0 = new Date(2026, 10, 19, 14, 0).getTime(); // Thu Nov 19 2026, 2:00 PM local

test('time comes from saved moments, through pauses', () => {
  let s = S.start({ plannedMin: 50, now: T0 });
  assert.equal(s.endsAt, T0 + 50 * MIN);
  assert.equal(S.elapsedMs(s, T0 + 10 * MIN), 10 * MIN);
  s = S.pause(s, T0 + 10 * MIN);
  assert.equal(S.isPaused(s), true); assert.equal(s.endsAt, null, 'no end alert while paused');
  assert.equal(S.elapsedMs(s, T0 + 25 * MIN), 10 * MIN, 'paused time does not count');
  assert.equal(S.pause(s, T0 + 12 * MIN), s, 'pausing twice changes nothing');
  s = S.resume(s, T0 + 25 * MIN);
  assert.equal(S.isPaused(s), false); assert.equal(s.endsAt, T0 + 65 * MIN, 'the end moves by the length of the pause');
  assert.equal(S.remainingMs(s, T0 + 30 * MIN), 35 * MIN);
  const done = S.finish(s, T0 + 40 * MIN);
  assert.equal(done.actualMin, 25); assert.equal(done.endedAt, T0 + 40 * MIN); assert.equal(S.isRunning(done), false);
  assert.equal(S.elapsedMs(done, T0 + 999 * MIN), 25 * MIN, 'a finished session never grows');
});
test('ending while paused closes the pause', () => {
  let s = S.pause(S.start({ plannedMin: 25, now: T0 }), T0 + 5 * MIN);
  s = S.finish(s, T0 + 20 * MIN);
  assert.equal(s.actualMin, 5); assert.equal(s.pauses[0].until, T0 + 20 * MIN);
});
test('a session that ran out unseen is closed at the moment it ran out', () => {
  const s = S.start({ plannedMin: 25, now: T0 });
  assert.equal(S.isOver(s, T0 + 24 * MIN), false); assert.equal(S.isOver(s, T0 + 3 * 60 * MIN), true);
  const closed = S.finishAtPlanned(s, T0 + 3 * 60 * MIN);
  assert.equal(closed.endedAt, T0 + 25 * MIN); assert.equal(closed.actualMin, 25);
  assert.equal(S.finishAtPlanned(s, T0 + 5 * MIN), s);
});
test('5-50-5 phases', () => {
  const s = S.start({ plannedMin: 60, format: '5-50-5', now: T0 });
  assert.deepEqual(S.phase(s, T0 + 2 * MIN), { name: 'plan', leftMs: 3 * MIN });
  assert.deepEqual(S.phase(s, T0 + 30 * MIN), { name: 'focus', leftMs: 25 * MIN });
  assert.deepEqual(S.phase(s, T0 + 57 * MIN), { name: 'review', leftMs: 3 * MIN });
  assert.equal(S.phase(S.start({ plannedMin: 25, now: T0 }), T0 + MIN).name, 'focus');
});
test('fixed-block guard: says what it would run into and how long still fits', () => {
  const busy = [{ start: 18 * 60, end: 19 * 60 + 30, title: 'Family dinner' }, { start: 9 * 60 + 30, end: 10 * 60 + 45, title: 'SCH 601' }];
  assert.deepEqual(S.guard({ nowMin: 15 * 60, lengthMin: 50, busy }), { clash: null, fitMin: 50 });
  assert.deepEqual(S.guard({ nowMin: 17 * 60 + 30, lengthMin: 50, busy }), { clash: { title: 'Family dinner', start: 1080, end: 1170 }, fitMin: 30 });
  assert.equal(S.guard({ nowMin: 18 * 60 + 10, lengthMin: 25, busy }).fitMin, 0, 'the block has already begun');
  assert.equal(S.guard({ nowMin: 17 * 60 + 10, lengthMin: 50, busy }).clash, null, 'ending exactly when dinner starts is fine');
});
test('family timer: counts up, and a forgotten one is noticed', () => {
  let s = S.start({ kind: 'family', identityId: 'id-family', now: T0 });
  assert.equal(s.plannedMin, null); assert.equal(s.endsAt, null); assert.equal(S.remainingMs(s, T0 + MIN), null);
  assert.equal(S.familyStale(s, T0 + 4 * 60 * MIN), false);
  assert.equal(S.familyStale(s, T0 + 5 * 60 * MIN), true, 'five hours on');
  const evening = S.start({ kind: 'family', now: new Date(2026, 10, 19, 21, 30).getTime() });
  assert.equal(S.familyStale(evening, new Date(2026, 10, 19, 23, 59).getTime()), false);
  assert.equal(S.familyStale(evening, new Date(2026, 10, 20, 0, 1).getTime()), true, 'past midnight');
  assert.equal(S.familyStale({ ...evening, staleAsked: true }, new Date(2026, 10, 20, 0, 1).getTime()), false, 'asked only once');
  assert.equal(S.familyStale(S.start({ plannedMin: 50, now: T0 }), T0 + 9 * 60 * MIN), false, 'only family time');
  s = S.finish(s, T0 + 95 * MIN); assert.equal(s.actualMin, 95);
});
test('minutes by day: split at midnight, pauses left out, hand entries on their day', () => {
  const a = new Date(2026, 10, 21, 23, 30).getTime(); // Sat 11:30 PM
  let s = S.finish(S.start({ kind: 'family', now: a }), a + 75 * MIN);
  assert.deepEqual(S.byDay(s), [{ day: '2026-11-21', min: 30 }, { day: '2026-11-22', min: 45 }]);
  s = S.start({ plannedMin: 90, now: T0 }); s = S.pause(s, T0 + 20 * MIN); s = S.resume(s, T0 + 50 * MIN); s = S.finish(s, T0 + 80 * MIN);
  assert.deepEqual(S.byDay(s), [{ day: '2026-11-19', min: 50 }]);
  const m = S.manual({ kind: 'family', identityId: 'id-family', minutes: 120, day: '2026-11-17', now: T0 });
  assert.deepEqual(S.byDay(m), [{ day: '2026-11-17', min: 120 }]); assert.equal(m.actualMin, 120); assert.equal(S.isRunning(m), false);
  assert.deepEqual(S.byDay(S.start({ plannedMin: 50, now: T0 }), T0 + 10 * MIN), [{ day: '2026-11-19', min: 10 }], 'a running session counts so far');
});
test('running: the newest unfinished session', () => {
  const a = S.start({ now: T0 }), b = S.start({ now: T0 + MIN });
  assert.equal(S.running([S.finish(a, T0 + 5), b]), b); assert.equal(S.running([a, b]), b); assert.equal(S.running([S.finish(a, T0 + 5)]), null);
  assert.equal(S.clock(65 * 1000), '1:05'); assert.equal(S.clock(3725 * 1000), '1:02:05');
});

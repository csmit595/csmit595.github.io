import test from 'node:test';
import assert from 'node:assert/strict';
import * as ST from '../js/stats-core.js';
import { SEED_IDENTITIES } from '../js/goals-core.js';
import * as S from '../js/session-core.js';

const at = (day, h, m = 0) => { const [y, mo, d] = day.split('-').map(Number); return new Date(y, mo - 1, d, h, m).getTime(); };
const week = ST.weekOf('2026-11-19'); // Mon Nov 16 … Sun Nov 22
const sess = (identityId, day, h, min, extra = {}) => ({ id: identityId + day + h, kind: extra.kind || 'focus', identityId, startedAt: at(day, h), endedAt: at(day, h) + min * 60000, actualMin: min, pauses: [], ...extra });
const dinner = { b: { id: 'b1', name: 'Family dinner', identityId: 'id-family' }, start: 18 * 60, end: 19 * 60 + 30 };
const blocksOn = day => { const d = new Date(at(day, 12)).getDay(); return d >= 1 && d <= 5 ? [dinner] : d === 6 ? [{ b: { id: 'b2', name: 'Date night', identityId: 'id-family' }, start: 18 * 60, end: 21 * 60 + 30 }, { b: { id: 'b3', name: 'Errands' }, start: 600, end: 660 }] : []; };
const base = { days: week, today: '2026-11-22', restDay: 0, identities: SEED_IDENTITIES, goals: [], blocksOn, now: at('2026-11-22', 22) };

test('week is Monday to Sunday', () => { assert.equal(week[0], '2026-11-16'); assert.equal(week[6], '2026-11-22'); assert.equal(ST.weekOf('2026-11-22')[0], '2026-11-16'); assert.equal(ST.weekOf('2026-11-23')[0], '2026-11-23'); });

test('time by identity, God and family first; Sunday family minutes kept but not counted', () => {
  const sessions = [sess('id-christ', '2026-11-16', 6, 45), sess('id-christ', '2026-11-17', 6, 45), sess('id-family', '2026-11-18', 18, 90, { kind: 'family' }), sess('id-family', '2026-11-22', 14, 180, { kind: 'family' }),
    sess('id-seminary', '2026-11-19', 13, 120), sess('id-work', '2026-11-19', 8, 50), sess('id-christ', '2026-11-10', 6, 45)];
  const st = ST.periodStats({ ...base, sessions });
  assert.deepEqual(st.time.map(t => t.name), ['Christ Worship', 'Family', 'Health', 'Work: CS Outdoors', 'Seminary & Church', 'Friends']);
  assert.deepEqual(st.time.map(t => t.min), [90, 90, 0, 50, 120, 0]);
  assert.equal(st.time[1].targetMin, 1080); assert.equal(st.time[0].pct, 90 / 270); assert.equal(st.time[3].pct, null, 'work is tracked without a target');
  assert.equal(st.quiet.familyMin, 90); assert.equal(st.quiet.familyOpenMin, 990);
  assert.equal(st.quiet.studyMin, 120); assert.equal(st.quiet.devotionDays, 2); assert.equal(st.quiet.devotionOf, 7);
});

test('devotion days count finished tasks too, including each round of a repeating task', () => {
  const tasks = [{ id: 'dv', content: 'Devotions', labels: ['personal', 'devotions'], due: { date: '2026-11-23', recur: { text: 'every day' } }, lastDoneAt: at('2026-11-20', 6), doneLog: [at('2026-11-16', 6), at('2026-11-18', 6), at('2026-11-20', 6)] }];
  const st = ST.periodStats({ ...base, tasks, sessions: [sess('id-christ', '2026-11-18', 21, 20)] });
  assert.equal(st.quiet.devotionDays, 3);
  assert.equal(st.completed, 3);
});

test('family blocks and Sunday rest: kept unless work was done in them', () => {
  const work = (id, when, extra = {}) => ({ id, content: id, labels: ['cs-outdoors'], completedAt: when, ...extra });
  let st = ST.periodStats({ ...base, tasks: [work('a', at('2026-11-17', 10)), work('b', at('2026-11-21', 9))], sessions: [] });
  assert.equal(st.quiet.familyBlocks, 6, 'five dinners and date night; the Saturday errand block is not family'); assert.equal(st.quiet.familyBlocksKept, 6);
  assert.equal(st.quiet.restDays, 1); assert.equal(st.quiet.restKept, 1);
  st = ST.periodStats({ ...base, tasks: [work('a', at('2026-11-17', 18, 30)), work('c', at('2026-11-22', 15)), { id: 'p', content: 'Read', labels: ['seminary'], completedAt: at('2026-11-18', 18, 20) }], sessions: [sess('id-work', '2026-11-21', 19, 30)] });
  assert.equal(st.quiet.familyBlocksKept, 4); assert.deepEqual(st.quiet.familyBlocksWorked.map(b => b.day), ['2026-11-17', '2026-11-21'], 'seminary reading at dinner is not counted as work');
  assert.equal(st.quiet.restKept, 0);
  // mid-week: blocks and the rest day that have not happened yet are not judged
  st = ST.periodStats({ ...base, today: '2026-11-18', now: at('2026-11-18', 12), tasks: [], sessions: [] });
  assert.equal(st.quiet.familyBlocks, 2); assert.equal(st.quiet.restDays, 0); assert.equal(st.quiet.restAhead, true); assert.equal(st.quiet.devotionOf, 3);
});

test('customer promises: on time, late, and still open past due', () => {
  const p = (id, f) => ({ id, content: id, labels: ['promise', 'cs-outdoors'], ...f });
  const st = ST.periodStats({ ...base, tasks: [p('ontime', { due: { date: '2026-11-18' }, completedAt: at('2026-11-18', 16) }), p('early', { deadline: '2026-11-20', due: { date: '2026-11-17' }, completedAt: at('2026-11-19', 9) }),
    p('late', { due: { date: '2026-11-17' }, completedAt: at('2026-11-19', 9) }), p('open-late', { due: { date: '2026-11-18' } }), p('open-fine', { due: { date: '2026-11-25' } }), p('lastweek', { due: { date: '2026-11-10' }, completedAt: at('2026-11-10', 9) }),
    { id: 'notpromise', content: 'x', labels: ['cs-outdoors'], due: { date: '2026-11-01' } }], sessions: [] });
  assert.equal(st.promises.onTime, 2); assert.equal(st.promises.late, 1); assert.equal(st.promises.openPastDue, 1); assert.equal(st.promises.openTasks[0].id, 'open-late');
});

test('goals, fit and tasks by area', () => {
  const goals = [{ id: 'g1', identityId: 'id-seminary', title: 'A in SCH 601', status: 'active', kind: 'milestones', start: '2026-10-01', end: '2026-12-31' }, { id: 'g2', identityId: 'id-christ', title: '45 min', status: 'active', kind: 'hours', target: 58, start: '2026-10-01', end: '2026-12-31' }, { id: 'g3', identityId: 'id-work', title: 'Dropped', status: 'dropped' }];
  const tasks = [{ id: 1, goalId: 'g1', labels: ['seminary'], completedAt: at('2026-11-17', 9) }, { id: 2, goalId: 'g1', labels: ['seminary'], completedAt: at('2026-11-18', 9) }, { id: 3, goalId: 'g1', labels: [] }, { id: 4, labels: ['cs-outdoors'], completedAt: at('2026-11-18', 9) }, { id: 5, labels: [], completedAt: at('2026-11-18', 9) }, { id: 6, parentId: 4, labels: ['cs-outdoors'], completedAt: at('2026-11-18', 9) }];
  const fit = { '2026-11-16': 'fits', '2026-11-17': 'over', '2026-11-18': 'fits', '2026-11-19': 'empty', '2026-11-20': 'fits', '2026-11-21': 'fits', '2026-11-22': 'rest' };
  const st = ST.periodStats({ ...base, goals, tasks, sessions: [], fitOf: d => fit[d] });
  assert.deepEqual(st.goals.map(g => [g.title, g.pace]), [['45 min', 'behind'], ['A in SCH 601', 'on-track']], 'God first; dropped goals are not listed');
  assert.deepEqual(st.fit, { fits: 4, days: 5, over: ['2026-11-17'] }, 'rest and empty days are not counted either way');
  assert.deepEqual(st.areas, [{ id: 'cs-outdoors', name: 'CS Outdoors', n: 1 }, { id: 'seminary', name: 'Seminary', n: 2 }, { id: '', name: 'Not filed', n: 1 }]);
  assert.equal(st.completed, 4, 'sub-tasks are not counted twice');
});

test('plain words: calm, and Sunday still ahead is said as such', () => {
  const st = ST.periodStats({ ...base, today: '2026-11-20', now: at('2026-11-20', 16), tasks: [], sessions: [sess('id-christ', '2026-11-16', 6, 45), sess('id-family', '2026-11-18', 18, 120, { kind: 'family' })] });
  const lines = ST.plainSummary(st);
  assert.equal(lines[0], 'Christ Worship: 0.8 hours of 4.5 hours, with time or a finished task on 1 of 5 days.');
  assert.ok(lines.includes('Family time: 2 hours timed, Monday to Saturday, toward 18 hours (16 hours still open).'));
  assert.ok(lines.includes('Sunday rest is still ahead.'));
  assert.ok(!lines.join(' ').match(/fail|missed|streak|!/i));
});

test('quarter view scales targets by the weeks so far', () => {
  const days = ST.quarterDays('2026-11-19');
  assert.equal(days[0], '2026-10-01'); assert.equal(days[days.length - 1], '2026-12-31');
  const st = ST.periodStats({ ...base, days, today: '2026-10-14', now: at('2026-10-14', 20), sessions: [sess('id-christ', '2026-10-05', 6, 270)] });
  assert.equal(st.time[0].targetMin, 540, 'two weeks so far'); assert.equal(st.time[0].pct, 0.5);
});

test('weekly review time: never Sunday, never on a fixed block', () => {
  const fri = [{ name: 'United Prayer devotional', start: 720, end: 750 }, { name: 'Family dinner', start: 1080, end: 1170 }];
  assert.equal(ST.reviewSlotProblem({ day: 5, time: '16:00', blocks: fri }), '');
  assert.match(ST.reviewSlotProblem({ day: 0, time: '16:00' }), /never lands on Sunday/);
  assert.match(ST.reviewSlotProblem({ day: 5, time: '17:50', blocks: fri }), /Family dinner/);
  assert.match(ST.reviewSlotProblem({ day: 6, time: '18:30', blocks: [{ name: 'Date night', start: 1080, end: 1290 }] }), /Date night/);
  assert.equal(ST.freeReviewSlot({ day: 5, time: '12:00', blocks: fri }), '12:30');
  assert.equal(ST.freeReviewSlot({ day: 5, time: '16:00', blocks: fri }), '16:00');
});

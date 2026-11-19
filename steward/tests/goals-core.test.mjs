import test from 'node:test';
import assert from 'node:assert/strict';
import * as G from '../js/goals-core.js';

const ids = G.SEED_IDENTITIES, goals = [{ id: 'g1', identityId: 'id-seminary', title: 'A in SCH 601', status: 'active' }, { id: 'g2', identityId: 'id-family', title: 'Nursery ready', status: 'active' }];
const ctx = { identities: ids, goals };
const idOf = t => G.identityOf(t, ctx)?.id || null;

test('seed identities: his order, God and family first, targets as settled', () => {
  assert.deepEqual(ids.map(i => i.name), ['Christ Worship', 'Family', 'Health', 'Work: CS Outdoors', 'Seminary & Church', 'Friends']);
  assert.deepEqual(ids.map(i => i.weeklyTargetMin || 0), [270, 1080, 0, 0, 600, 0]);
  assert.equal(ids[1].timed, true);
});
test('identityOf: goal, then project, then label, then area', () => {
  assert.equal(idOf({ goalId: 'g1', labels: ['cs-outdoors'] }), 'id-seminary', 'a goal wins over the area');
  assert.equal(idOf({ labels: ['cs-outdoors', 'mowing'] }), 'id-work');
  assert.equal(idOf({ labels: ['personal', 'devotions'] }), 'id-christ');
  assert.equal(idOf({ labels: ['personal', 'health'] }), 'id-health');
  assert.equal(idOf({ labels: ['friends'] }), 'id-friends');
  assert.equal(idOf({ labels: ['personal', 'finances'] }), null, 'plain personal tasks belong to no identity');
  assert.equal(idOf({ labels: ['home-family', 'house-project'] }), 'id-family');
  assert.equal(idOf({ labels: ['church', 'embrace-english'] }), 'id-seminary');
  assert.equal(idOf({ labels: ['seminary'] }), 'id-seminary');
  assert.equal(idOf({ labels: [] }), null);
  assert.equal(idOf({ goalId: 'gone', labels: ['cs-outdoors'] }), 'id-work', 'a deleted goal falls through');
  const withProject = { ...ctx, identities: ids.map(i => i.id === 'id-work' ? { ...i, projectIds: ['pj-hanel'] } : i) };
  assert.equal(G.identityOf({ projectId: 'pj-hanel', labels: ['personal', 'health'] }, withProject).id, 'id-work', 'project before label');
  const tasks = [{ id: 'p', labels: ['seminary'] }];
  assert.equal(G.identityOf({ parentId: 'p', labels: [] }, { ...ctx, tasks }).id, 'id-seminary', 'a sub-task follows its parent');
});
test('wife and child sort first inside Family', () => {
  const fam = { ...ids[1], firstTags: ['elise', 'chloe', 'baby'] };
  assert.equal(G.firstRank(['home-family', 'Elise'], fam), 0);
  assert.equal(G.firstRank(['chloe'], fam), 1);
  assert.equal(G.firstRank(['home-family'], fam), 999);
  const sorted = G.sortGoals([{ id: 'a', title: 'Visit parents', status: 'active', order: 1 }, { id: 'b', title: 'Nursery', status: 'active', tags: ['chloe'], order: 2 }, { id: 'c', title: 'Weekly date', status: 'active', tags: ['elise'], order: 3 }, { id: 'd', title: 'Old', status: 'done', tags: ['elise'], order: 0 }], fam);
  assert.deepEqual(sorted.map(g => g.id), ['c', 'b', 'a', 'd']);
});
test('quarters', () => {
  assert.deepEqual(G.quarterRange('2026-11-19'), { start: '2026-10-01', end: '2026-12-31', label: 'Q4 2026' });
  assert.deepEqual(G.quarterRange('2027-02-28'), { start: '2027-01-01', end: '2027-03-31', label: 'Q1 2027' });
  assert.equal(G.nextQuarter('2026-11-19').start, '2027-01-01');
  assert.equal(G.quarterEnding('2026-12-20'), false); assert.equal(G.quarterEnding('2026-12-23'), true);
});
test('progress for each kind of goal', () => {
  const tasks = [{ id: 1, goalId: 'g', completedAt: 5 }, { id: 2, goalId: 'g' }, { id: 3, goalId: 'g' }, { id: 4, goalId: 'g', completedAt: 9 }, { id: 5, goalId: 'g', parentId: 1 }, { id: 6, goalId: 'x', completedAt: 1 }];
  let p = G.goalProgress({ id: 'g', kind: 'milestones' }, { tasks });
  assert.equal(p.done, 2); assert.equal(p.total, 4); assert.equal(p.pct, 0.5); assert.equal(p.label, '2 of 4 done');
  assert.equal(G.goalProgress({ id: 'none', kind: 'milestones' }, { tasks }).label, 'No tasks linked yet');
  p = G.goalProgress({ id: 'g', kind: 'count', target: 12, manual: 3, unit: 'sermons' }, { tasks });
  assert.equal(p.done, 5); assert.equal(p.label, '5 of 12 sermons'); assert.ok(Math.abs(p.pct - 5 / 12) < 1e-9);
  const sessions = [{ goalId: 'g', endedAt: 1, actualMin: 50 }, { goalId: 'g', endedAt: 2, actualMin: 100 }, { goalId: 'g', actualMin: 500 }, { goalId: 'other', endedAt: 1, actualMin: 60 }];
  p = G.goalProgress({ id: 'g', kind: 'hours', target: 10 }, { tasks, sessions });
  assert.equal(p.done, 150); assert.equal(p.pct, 0.25); assert.equal(p.label, '2.5 h of 10 h');
});
test('pace: on track unless well behind the calendar; dropped is just dropped', () => {
  const g = { status: 'active', start: '2026-10-01', end: '2026-12-31' };
  assert.equal(G.goalPace(g, { pct: 0.5, total: 4 }, '2026-11-19'), 'on-track');
  assert.equal(G.goalPace(g, { pct: 0.2, total: 4 }, '2026-11-19'), 'behind');
  assert.equal(G.goalPace(g, { pct: 0, total: 0 }, '2026-11-19'), 'open');
  assert.equal(G.goalPace({ ...g, status: 'dropped' }, { pct: 0, total: 4 }, '2026-11-19'), 'dropped');
  const late = { ...g, createdAt: new Date(2026, 10, 19, 15).getTime() };
  assert.equal(G.goalPace(late, { pct: 0, total: 4 }, '2026-11-19'), 'on-track', 'a goal added today is not already behind');
  assert.equal(G.goalPace(late, { pct: 0, total: 4 }, '2026-12-20'), 'behind');
  assert.equal(G.expectedPct(g, '2026-09-01'), 0); assert.equal(G.expectedPct(g, '2027-01-05'), 1);
});
test('next task: the chosen one, else the soonest', () => {
  const tasks = [{ id: 'a', goalId: 'g', due: { date: '2026-12-01' } }, { id: 'b', goalId: 'g', due: { date: '2026-11-20' } }, { id: 'c', goalId: 'g', completedAt: 1 }, { id: 'd', goalId: 'g' }];
  assert.equal(G.nextTask({ id: 'g' }, tasks).id, 'b');
  assert.equal(G.nextTask({ id: 'g', nextTaskId: 'd' }, tasks).id, 'd');
  assert.equal(G.nextTask({ id: 'g', nextTaskId: 'c' }, tasks).id, 'b', 'a finished choice falls back');
  assert.equal(G.nextTask({ id: 'zz' }, tasks), null);
});
test('quick add goal:<name>', () => {
  const gs = [{ id: 'g1', title: 'Read 12 sermons', status: 'active' }, { id: 'g2', title: 'Nursery ready', status: 'active' }, { id: 'g3', title: 'Read Calvin', status: 'active' }, { id: 'g4', title: 'Old one', status: 'dropped' }];
  assert.deepEqual(G.extractGoal('Read Spurgeon on Psalm 23 goal:read 12 sermons', gs), { goalId: 'g1', title: 'Read 12 sermons', rest: 'Read Spurgeon on Psalm 23' });
  assert.equal(G.extractGoal('Paint crib goal:nursery fri 3pm', gs).goalId, 'g2');
  assert.equal(G.extractGoal('Paint crib goal:nursery fri 3pm', gs).rest, 'Paint crib fri 3pm');
  assert.equal(G.extractGoal('x goal:read12', gs).goalId, 'g1');
  assert.equal(G.extractGoal('x goal:read', gs), null, 'two goals start that way: no guess');
  assert.equal(G.extractGoal('x goal:old one', gs), null, 'dropped goals are not offered');
  assert.equal(G.extractGoal('no goal here', gs), null);
  assert.equal(G.spokenGoal(' paint the crib goal nursery ready', gs).trim(), 'paint the crib goal:Nursery ready');
  assert.equal(G.spokenGoal(' my goal is rest', gs), ' my goal is rest');
});

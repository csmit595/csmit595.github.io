// Steward 4.8.1: one test for each fix that can be checked without a browser.
import test from 'node:test';
import assert from 'node:assert/strict';

// model.js keeps small settings in localStorage and store.js saves on a timer: simple stand-ins are enough here.
const mem = new Map();
globalThis.localStorage = { getItem: k => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => { mem.set(k, String(v)); }, removeItem: k => { mem.delete(k); }, key: i => [...mem.keys()][i] ?? null, get length() { return mem.size; } };
const warn = console.warn; console.warn = () => {}; // "save failed": there is no IndexedDB in this test
const { store, settings, clampFuture } = await import('../js/store.js');
const D = await import('../js/dates.js');
const M = await import('../js/model.js');
const ST = await import('../js/stats-core.js');
const S = await import('../js/session-core.js');
const { needsApp } = await import('../../steward-helper/needs-app.js');
test.after(() => { console.warn = warn; });

const ctx = { projects: [], sections: [] }, NOW = '2026-11-19'; // a Thursday
const qa = s => D.parseQuickAdd(s, ctx);

test('a bare clock time in the afternoon hours is PM; a leading zero or am/pm is kept as written', () => {
  assert.equal(D.parseDue('fri 4:15', NOW).due.time, '16:15');
  assert.equal(D.parseDue('at 3:30', NOW).due.time, '15:30');
  assert.equal(D.parseDue('at 3', NOW).due.time, '15:00');
  assert.equal(D.parseDue('fri 04:15', NOW).due.time, '04:15');
  assert.equal(D.parseDue('fri 4:15am', NOW).due.time, '04:15');
  assert.equal(D.parseDue('fri 6:30', NOW).due.time, '06:30', 'an early start stays in the morning');
  assert.equal(D.parseDue('fri 9:45', NOW).due.time, '09:45');
  assert.equal(D.parseDue('fri 14:10', NOW).due.time, '14:10');
});

test('names and ordinary words are not read as dates', () => {
  assert.equal(qa('Call Tom about mulch').due, null);
  assert.equal(qa('Call Tom about mulch').content, 'Call Tom about mulch');
  assert.equal(qa('call tom about mulch').due, null);
  assert.equal(qa('Plan weekend trip with Elise').due, null);
  assert.equal(qa('Buy a tod for the porch').due, null);
  assert.ok(qa('Call Linda tom').due, '"tom" as the last word still means tomorrow');
  assert.ok(qa('Call Linda tom 3pm').due?.time === '15:00');
  assert.ok(qa('Call Linda tomorrow about mulch').due);
  assert.ok(qa('Mulch Hanel this weekend').due);
  assert.ok(qa('Mulch Hanel weekend').due, '"weekend" as the last word still counts');
  assert.ok(qa('Mow Wenger today').due && qa('Mow Wenger Today').due);
});

test('"every!" repeats count from the day the task was finished', () => {
  const m = D.parseDue('every! month', '2026-11-05').due;
  assert.equal(D.nextOccurrence(m, '2026-11-19'), '2026-12-19');
  const y = D.parseDue('every! year', '2026-03-01').due;
  assert.equal(D.nextOccurrence(y, '2026-11-19'), '2027-11-19');
  // a task saved before 4.8.1 still carries the day of the month: it is ignored for "every!"
  assert.equal(D.nextOccurrence({ date: '2026-11-05', recur: { n: 1, unit: 'month', fromDone: true, dom: 5, anchor: '2026-11-05' } }, '2026-11-19'), '2026-12-19');
  // ordinary repeats keep their day
  assert.equal(D.nextOccurrence(D.parseDue('every month', '2026-11-05').due, '2026-11-19'), '2026-12-05');
});

test('a change file with curly quotes inside its text is read as it stands', () => {
  const text = JSON.stringify({ ops: [{ op: 'upsert', type: 'task', item: { content: 'Tell Linda the “patio” date moved' } }] });
  assert.equal(M.parseChangeFile(text)[0].item.content, 'Tell Linda the “patio” date moved');
  assert.equal(M.parseChangeFile('﻿[{“op”: “complete”, “id”: “x”}]')[0].op, 'complete', 'a hand-typed file with curly quotes for JSON quotes still works');
  assert.throws(() => M.parseChangeFile('{ not json'));
  assert.throws(() => M.parseChangeFile('{"ops": 3}'), /not a list/);
});

test('the helper leaves to the app everything that does not live in the task file', () => {
  for (const o of [{ op: 'upsert', type: 'ocr', item: { id: 'a', text: 't' } }, { op: 'upsert', type: 'notebook', item: { name: 'Jobs' } }, { op: 'delete', type: 'note', id: 'n1' }, { op: 'upsert', type: 'note', item: {} },
    { op: 'upsert', type: 'orgword', item: {} }, { op: 'delete', type: 'orgword', id: 'x' }, { op: 'upsert', type: 'goal', item: {} }, { op: 'upsert', type: 'session', item: {} }, { op: 'upsert', type: 'task', item: { content: 'x', goal: 'A' } }, { op: 'upsert', type: 'something-new', item: {} }]) assert.equal(needsApp(o), true, JSON.stringify(o));
  for (const o of [{ op: 'upsert', type: 'task', item: { content: 'x' } }, { op: 'complete', id: 't' }, { op: 'restore', id: 't' }, { op: 'upsert', type: 'comment', item: {} }, { op: 'upsert', type: 'project', item: {} }, { op: 'upsert', type: 'block', item: {} },
    { op: 'upsert', type: 'prefs', item: {} }, { op: 'upsert', type: 'doc', item: {} }, { op: 'delete', type: 'task', id: 't' }]) assert.equal(needsApp(o), false, JSON.stringify(o));
});

test('a clock that runs ahead wins once, not every time its copy comes back', () => {
  const fut = Date.now() + 3 * 864e5;
  const ahead = () => ({ id: 'clk', content: 'from the wrong clock', updatedAt: fut, createdAt: fut, _f: { content: fut } });
  store.merge('tasks', { tasks: [ahead()] });
  assert.equal(store.get('tasks', 'clk').content, 'from the wrong clock');
  assert.ok(store.get('tasks', 'clk')._f.content <= Date.now(), 'its time was brought back to now');
  const t0 = store.get('tasks', 'clk')._f.content;
  while (Date.now() <= t0) { /* the next edit must be later */ }
  store.patch('tasks', 'clk', { content: 'edited later on a good clock' });
  store.merge('tasks', { tasks: [ahead()] }); // the same copy, uploaded again by the device with the wrong clock
  assert.equal(store.get('tasks', 'clk').content, 'edited later on a good clock');
  const t1 = Date.now(); while (Date.now() <= t1) { /* and a new edit there comes later still */ }
  const again = { id: 'clk', content: 'a new edit there', updatedAt: fut + 5000, createdAt: fut, _f: { content: fut + 5000 } };
  store.merge('tasks', { tasks: [again] });
  assert.equal(store.get('tasks', 'clk').content, 'a new edit there', 'a genuinely new change from that device still arrives');
  assert.ok(clampFuture({ id: 'z', updatedAt: 5, _f: { a: 5 } })._ahead === undefined, 'ordinary times are left alone');
});

test('a starting identity deleted on purpose stays deleted after its 90-day record is forgotten', () => {
  M.ensureIdentities();
  assert.ok(store.get('identities', 'id-friends'));
  M.deleteIdentity('id-friends');
  store.rawGet('identities', 'id-friends').updatedAt = Date.now() - 91 * 864e5;
  store.merge('goals', {}); // forgets records of deletes older than 90 days
  assert.equal(store.rawGet('identities', 'id-friends'), null);
  assert.equal(M.ensureIdentities(), 0);
  assert.equal(store.get('identities', 'id-friends'), null);
  // a new device seeds all six before its first sync; once the shared settings arrive, the deleted one goes again
  store.put('identities', { id: 'id-friends', name: 'Friends', createdAt: 1, updatedAt: 1 }, { silent: true, keepTimes: true });
  M.enforceSeedsGone();
  assert.equal(store.get('identities', 'id-friends'), null);
  // "Add the starting six" brings it back for good
  assert.equal(M.ensureIdentities(true), 1);
  assert.ok(store.get('identities', 'id-friends').updatedAt > 1);
  M.enforceSeedsGone();
  assert.ok(store.get('identities', 'id-friends'));
});

test('a delete made before 4.8.1 is remembered too', () => {
  store.remove('identities', 'id-health'); // the old way: only the 90-day record
  M.enforceSeedsGone();
  assert.ok(M.seedGone('id-health'));
});

test('moving work to "tomorrow" skips the rest day and days with no planning hours', () => {
  settings.set('restDay', 0);
  settings.set('hours', [null, ...Array(6).fill({ start: '07:00', end: '18:00' })]);
  assert.equal(M.nextPlanDay('2026-11-21'), '2026-11-23', 'Saturday → Monday');
  assert.equal(M.nextPlanDay('2026-11-19'), '2026-11-20');
  settings.set('hours', [null, { start: '07:00', end: '18:00' }, null, null, null, null, null]);
  assert.equal(M.nextPlanDay('2026-11-19'), '2026-11-23', 'only Mondays are planned');
});

test('labels keep one spelling, and "@Promise" is the promise label', () => {
  M.ensureLabels(['church']);
  assert.deepEqual(M.canonLabels(['Promise', 'Church', 'new-one', 'promise']), ['promise', 'church', 'new-one']);
  const t = M.addTask({ content: 'Call Linda', labels: ['Promise'] });
  assert.deepEqual(t.labels, ['promise']);
  assert.deepEqual(M.taskFixes({ content: 'x', labels: ['PROMISE', 'a'] }).labels, ['promise', 'a']);
  const r = M.applyOps([{ op: 'upsert', type: 'task', item: { content: 'Quote Stephens', labels: ['Promise'] } }]);
  assert.match(r[0], /^ok/);
  assert.ok(store.all('tasks').find(x => x.content === 'Quote Stephens').labels.includes('promise'));
});

test('a project change with no name is refused, and a nameless one already saved is mended', () => {
  const r = M.applyOps([{ op: 'upsert', type: 'project', item: { color: 'red' } }, { op: 'upsert', type: 'project', item: { id: 'nope', color: 'red' } }, { op: 'upsert', type: 'task', item: { content: 'Quote wall', project: 'Stephens' } }]);
  assert.match(r[0], /^problem .*needs a name/); assert.match(r[1], /^problem/); assert.match(r[2], /^ok/);
  assert.ok(store.all('projects').every(p => typeof p.name === 'string' && p.name));
  store.put('projects', { id: 'bad', color: 'red' }, { silent: true });
  assert.ok(M.repairTasks() >= 1);
  assert.equal(store.get('projects', 'bad').name, 'Untitled');
  assert.match(M.applyOps([{ op: 'upsert', type: 'task', item: { content: 'After the mend', project: 'Hanel' } }])[0], /^ok/);
});

test('finishing a repeating task records one moment, so Stats counts it once', () => {
  const t = M.addTask({ content: 'Mow Wenger', due: D.parseDue('every week').due });
  M.completeTask(t.id);
  assert.equal(ST.doneTimes(store.get('tasks', t.id)).length, 1);
});

test('the weekly review looks back to the last review, weekend included', () => {
  assert.deepEqual(ST.reviewDays('2026-11-20', '2026-11-13'), ST.daysBetween('2026-11-13', '2026-11-20'));
  assert.ok(ST.reviewDays('2026-11-20', '2026-11-13').includes('2026-11-15'), 'last Sunday is in it');
  assert.deepEqual(ST.reviewDays('2026-11-20', null), ST.daysBetween('2026-11-14', '2026-11-20'));
  assert.equal(ST.reviewDays('2026-11-20', '2026-10-01').length, 7, 'a long gap: the last seven days');
  assert.equal(ST.reviewDays('2026-11-20', '2026-11-19').length, 7, 'reviewed yesterday: the last seven days');
  const id = { id: 'id-family', name: 'Family', timed: true, weeklyTargetMin: 1080, order: 2 };
  const st = ST.periodStats({ days: ST.reviewDays('2026-11-20', '2026-11-13'), today: '2026-11-20', identities: [id], targetWeeks: 1 });
  assert.equal(st.time[0].targetMin, 1080, 'eight days are still measured against one week of the target');
  assert.equal(st.quiet.restDays, 1, 'and Sunday is looked at');
});

test('two timers running at once: the older one is closed when the newer began', () => {
  const a = S.start({ kind: 'family', identityId: 'id-family', now: 1000 }), b = S.start({ kind: 'focus', plannedMin: 25, now: 61000 });
  const closed = S.finish(a, Math.max(a.startedAt, b.startedAt));
  assert.equal(closed.endedAt, 61000); assert.equal(closed.actualMin, 1);
});

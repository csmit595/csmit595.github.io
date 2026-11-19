import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../js/versions-core.js';

const DAY = 864e5, NOW = Date.UTC(2026, 10, 19, 20);
const snap = (at, body = '<div>text ' + at + '</div>', device = 'Mac') => ({ at, title: 'T', body, device });

test('addSnap skips blanks and repeats', () => {
  let s = C.addSnap([], { at: 1, title: ' ', body: '<div><br></div>' }, NOW); assert.equal(s.length, 0);
  s = C.addSnap([], { at: 1, title: '', body: '' }, NOW); assert.equal(s.length, 0);
  s = C.addSnap(s, snap(NOW - 10, '<div>a</div>'), NOW); assert.equal(s.length, 1);
  const same = C.addSnap(s, snap(NOW - 5, '<div>a</div>'), NOW); assert.equal(same, s, 'identical text adds nothing');
  assert.equal(C.addSnap(s, snap(NOW - 5, '<div>b</div>'), NOW).length, 2);
  assert.equal(C.addSnap([], { at: 1, title: '', body: '<img data-att="x">' }, NOW).length, 1, 'a note with only a photo is kept');
});
test('prune keeps the newest 20 plus the last of each day for 30 days', () => {
  const list = [];
  for (let d = 40; d >= 1; d--) { list.push(snap(NOW - d * DAY + 1000)); list.push(snap(NOW - d * DAY + 2000)); } // two a day for 40 days
  for (let i = 0; i < 25; i++) list.push(snap(NOW - 25 * 60000 + i * 60000)); // 25 today
  const kept = C.prune(list, NOW);
  const today = kept.filter(s => C.dayKey(s.at) === C.dayKey(NOW));
  assert.equal(today.length, 20, 'newest 20 are all from today');
  for (let d = 1; d <= 29; d++) { const day = kept.filter(s => C.dayKey(s.at) === C.dayKey(NOW) - d); assert.equal(day.length, 1, 'one for day -' + d); assert.equal(day[0].at, NOW - d * DAY + 2000, 'and it is the last of that day'); }
  assert.equal(kept.filter(s => C.dayKey(NOW) - C.dayKey(s.at) >= 30).length, 0, 'older than 30 days are dropped');
  assert.deepEqual(C.prune(kept, NOW), kept, 'pruning twice changes nothing');
});
test('union merges both devices, and is the same either way round', () => {
  const a = [snap(1), snap(3)], b = [snap(2, undefined, 'phone'), snap(3), snap(3, '<div>other</div>', 'phone')];
  const u = C.union(a, b);
  assert.deepEqual(u.map(s => s.at + s.device), ['1Mac', '2phone', '3Mac', '3phone']);
  assert.deepEqual(C.union(b, a), u);
});
test('shrunk and veryDifferent', () => {
  const long = '<div>' + 'word '.repeat(40) + '</div>';
  assert.equal(C.shrunk(long, '<div>word word</div>'), true);
  assert.equal(C.shrunk(long, long.replace('word ', '')), false);
  assert.equal(C.shrunk('<div>short</div>', ''), false, 'tiny notes are not worth a copy on every delete');
  assert.equal(C.veryDifferent(long, long + '<div>one more line</div>'), false, 'adding to the end is not a replacement');
  assert.equal(C.veryDifferent(long, '<div>' + 'other '.repeat(40) + '</div>'), true);
  assert.equal(C.veryDifferent(long, '<div><b>' + 'word '.repeat(40) + '</b></div>'), false, 'formatting only');
  assert.equal(C.veryDifferent(long, ''), true);
});
test('diffWords marks what was added and removed', () => {
  assert.deepEqual(C.diffWords('the quick brown fox', 'the slow brown fox jumps'), [{ t: 'same', s: 'the' }, { t: 'del', s: 'quick' }, { t: 'add', s: 'slow' }, { t: 'same', s: 'brown fox' }, { t: 'add', s: 'jumps' }]);
  assert.deepEqual(C.diffWords('a b', 'a b'), [{ t: 'same', s: 'a b' }]);
  assert.deepEqual(C.diffWords('', 'new'), [{ t: 'add', s: 'new' }]);
  assert.equal(C.diffWords('x '.repeat(3000), 'y'), null, 'too long to compare simply');
});
test('textOf and words', () => {
  assert.equal(C.textOf('<div>One&nbsp;two</div><div>three &amp; four</div>'), 'One two\nthree & four');
  assert.equal(C.words(C.textOf('<h1>A b</h1><ul><li>c</li><li>d</li></ul>')), 4);
});
test('emptied-trash notes are kept 30 days', () => {
  assert.equal(C.goneExpired({ gone: NOW - 29 * DAY }, NOW), false);
  assert.equal(C.goneExpired({ gone: NOW - 31 * DAY }, NOW), true);
  assert.equal(C.goneExpired({}, NOW), false);
});

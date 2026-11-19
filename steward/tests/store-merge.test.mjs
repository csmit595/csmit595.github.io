import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeFields } from '../js/store.js';

const NOW = Date.now();
test('saved note versions from two devices are combined, not overwritten', () => {
  const mac = { id: 'n1', updatedAt: NOW - 10, createdAt: 1, snaps: [{ at: NOW - 3000, device: 'Mac', title: 'T', body: '<div>one</div>' }, { at: NOW - 1000, device: 'Mac', title: 'T', body: '<div>three</div>' }] };
  const phone = { id: 'n1', updatedAt: NOW - 5, createdAt: 1, snaps: [{ at: NOW - 3000, device: 'Mac', title: 'T', body: '<div>one</div>' }, { at: NOW - 2000, device: 'phone', title: 'T', body: '<div>two</div>' }] };
  const a = mergeFields(mac, phone), b = mergeFields(phone, mac);
  assert.deepEqual(a.snaps.map(s => s.body), ['<div>one</div>', '<div>two</div>', '<div>three</div>']);
  assert.deepEqual(b.snaps, a.snaps, 'both devices end with the same list');
  assert.deepEqual(mergeFields(a, b).snaps, a.snaps, 'and merging again changes nothing');
});
test('fields still merge one by one, newest wins', () => {
  const l = { id: 'x', title: 'old', body: 'mine', updatedAt: 20, createdAt: 1, _f: { title: 5, body: 20 } };
  const r = { id: 'x', title: 'new', body: 'theirs', updatedAt: 15, createdAt: 1, _f: { title: 15, body: 10 } };
  const m = mergeFields(l, r);
  assert.equal(m.title, 'new'); assert.equal(m.body, 'mine');
});

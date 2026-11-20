import test from 'node:test';
import assert from 'node:assert/strict';
import * as X from '../js/context-core.js';
import * as C from '../js/organize-core.js';

const NOTE = `<p>Steward checks every new entry against this note.</p>
<h2>CS Outdoors (project CS Outdoors)</h2>
<ul><li>Customers: Ashford, Brightwater; Nora Pell</li><li>Suppliers (tag materials): Stonebrook Supply, Fernway's</li></ul>
<h2>Seminary (project Seminary Fall 2026)</h2>
<ul><li>Professors: Dr. Quill, Dr. Vance</li><li>Books (tag reading): Hollis, Marlowe</li></ul>
<h2>Home/Family (project Home Life)</h2>
<ul><li>Family (tag family): Rosalind, Tobias</li></ul>
<h2>Customer promises</h2>
<ul><li>Phrases: let her know, I'd swing by</li></ul>
<h2>Notes for Claude</h2>
<p>Jethro: crew member on Wednesdays, but also a book of the Bible.</p>`;

test('contextText keeps headings and list items as lines', () => {
  const t = X.contextText(NOTE);
  assert.match(t, /^# CS Outdoors \(project CS Outdoors\)$/m);
  assert.match(t, /^- Customers: Ashford, Brightwater; Nora Pell$/m);
});

test('parseContext reads areas, options, promises, and skips guidance', () => {
  const { words } = X.parseContext(X.contextText(NOTE));
  const w = k => words.find(x => x.word.toLowerCase() === k.toLowerCase());
  assert.equal(w('Ashford').area, 'cs-outdoors');
  assert.equal(w('Ashford').project, 'CS Outdoors');
  assert.equal(w('Nora Pell').area, 'cs-outdoors');
  assert.deepEqual(w("Fernway's").tags, ['materials']);
  assert.equal(w('Customers'), undefined, 'the label is not a keyword');
  assert.equal(w('Dr. Quill').area, 'seminary');
  assert.equal(w('Marlowe').project, 'Seminary Fall 2026');
  assert.deepEqual(w('Rosalind').tags, ['family']);
  assert.equal(w('Rosalind').area, 'home-family');
  assert.equal(w('let her know').promise, true);
  assert.equal(w('let her know').area, 'cs-outdoors');
  assert.equal(w('Jethro'), undefined, 'lines under "Notes for Claude" are not keywords');
});

test('plain-text headings (no #) and duplicate words', () => {
  const { words } = X.parseContext('Church\nPeople: Owen Marsh, Silas Reed\nHome/Family\nFamily: Rosalind\nPersonal\nWords: rosalind, gym');
  assert.equal(words.find(x => x.word === 'Owen Marsh').area, 'church');
  assert.equal(words.filter(x => x.word.toLowerCase() === 'rosalind').length, 1);
  assert.equal(words.find(x => x.word === 'Rosalind').area, 'home-family', 'the first area wins');
});

test('the organizer uses context words: area, project and promise', () => {
  const { words } = X.parseContext(X.contextText(NOTE));
  const m = C.train({ lessons: [], words, projects: ['CS Outdoors', 'Seminary Fall 2026', 'Home Life'], notebooks: [] });
  const s = C.suggest(m, 'Call Brightwater about Saturday', { kind: 'task' });
  assert.equal(s.area, 'cs-outdoors');
  assert.equal(s.project?.name, 'cs outdoors');
  const e = C.suggest(m, 'Email Dr. Quill', { kind: 'task' });
  assert.equal(e.area, 'seminary');
  assert.equal(e.project?.name, 'seminary fall 2026');
  const p = C.suggest(m, 'Ashford: let her know Tuesday', { kind: 'task' });
  assert.equal(p.promise.on, true);
});

test('contextForClaude trims long notes', () => {
  assert.equal(X.contextForClaude('a'.repeat(10), 5), 'aaaaa\n…');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { hasRealText, docToNote, sourcesToNote, convert, sourceLine } from '../js/legacy-writing.js';

test('an empty test document holds nothing to keep', () => {
  assert.equal(hasRealText({ id: 'a', title: 'Untitled', body: '<p><br></p>', footnotes: {} }), false);
  assert.equal(hasRealText({ id: 'a', title: '', body: '<h3>Passage</h3><p><br></p>', footnotes: {} }), true); // template headings count as text: kept, never dropped
  assert.equal(hasRealText({ id: 'a', body: '<p>&nbsp; </p>' }), false);
  assert.equal(hasRealText({ id: 'a', body: '<p><br></p>', footnotes: { x: { html: 'See Calvin.' } } }), true);
  assert.equal(hasRealText({ id: 'a', deleted: true, body: '<p>text</p>' }), false);
});
test('a document becomes a note with its title, body and footnotes', () => {
  const src = { id: 's1', type: 'book', authors: 'John Calvin', title: 'Institutes', city: 'Philadelphia', publisher: 'Westminster', year: 1960 };
  const n = docToNote({ id: 'd1', title: 'Paper', body: '<p>Grace<sup class="fn" data-fn="f1" contenteditable="false"></sup> alone<sup class="fn" data-fn="f2"></sup>.</p>',
    footnotes: { f1: { cite: { sourceId: 's1', pages: '35' } }, f2: { html: 'A plain <i>note</i>.' } }, createdAt: 5, updatedAt: 9 }, [src]);
  assert.equal(n.id, 'fw-d1'); assert.equal(n.title, 'Paper'); assert.equal(n.notebook, 'From Writing');
  assert.match(n.body, /Grace<sup>1<\/sup> alone<sup>2<\/sup>/);
  assert.match(n.body, /<h3>Footnotes<\/h3><ol><li>John Calvin\. Institutes\. Philadelphia\. Westminster\. 1960, 35<\/li><li>A plain <i>note<\/i>\.<\/li><\/ol>/);
  assert.equal(n.createdAt, 5); assert.equal(n.updatedAt, 9);
  assert.equal(docToNote({ id: 'd2', body: '<p>x</p>', trashed: true }).trashed, true);
  assert.equal(docToNote({ id: 'd2', body: '<p>x</p>' }).title, 'Untitled document');
});
test('sources become one note; none means no note', () => {
  assert.equal(sourcesToNote([]), null);
  assert.equal(sourcesToNote([{ id: 'x', deleted: true, title: 'Gone' }]), null);
  const n = sourcesToNote([{ id: 'b', authors: 'Zed', title: 'Last' }, { id: 'a', authors: 'Abe', title: 'First <1>' }]);
  assert.equal(n.id, 'fw-sources');
  assert.ok(n.body.indexOf('Abe') < n.body.indexOf('Zed'));
  assert.match(n.body, /First &lt;1&gt;/);
  assert.equal(sourceLine({ id: 'q', type: 'book', title: 'T', degree: 'PhD diss.', short: 'skip' }), 'T. PhD diss.');
});
test('convert sorts documents into notes and empties, the same way on every device', () => {
  const docs = [{ id: 'd1', body: '<p>Real</p>' }, { id: 'd2', body: '<p><br></p>' }, { id: 'd3', deleted: true }];
  const a = convert({ docs, sources: [] }), b = convert({ docs: [...docs].reverse(), sources: [] });
  assert.deepEqual(a.notes.map(n => n.id), ['fw-d1']); assert.deepEqual(a.empty, ['d2']); assert.equal(a.sourcesNote, null);
  assert.deepEqual(b.notes.map(n => n.id), ['fw-d1']);
});

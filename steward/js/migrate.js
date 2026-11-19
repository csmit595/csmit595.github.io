// One-time moves when Steward drops a feature. 4.5: the Writing section (documents and sources) became notes.
import { store } from './store.js';
import { ensureNotebook } from './model.js';
import { snapshot } from './versions.js';
import { convert, NOTEBOOK } from './legacy-writing.js';

/**
 * Turn old Writing items into notes. Safe to run on both devices and more than once: each document always becomes the
 * note with the same id, an existing note is only replaced by a NEWER copy of the document (its old text is kept in
 * its version history), and empty test documents make nothing. Returns how many notes were made or updated.
 */
export function adoptWriting({ docs = [], sources = [] }) {
  const { notes, sourcesNote } = convert({ docs, sources });
  let n = 0;
  const put = (note, newer) => {
    const raw = store.rawGet('notes', note.id);
    if (raw?.deleted) return; // already removed for good on purpose
    const { notebook, ...rest } = note;
    if (!raw) { store.put('notes', { ...rest, notebookId: ensureNotebook(NOTEBOOK) }, { silent: true, keepTimes: true }); n++; return; }
    if (raw.body === note.body || !newer(raw)) return;
    snapshot(raw, 'before Writing update');
    store.patch('notes', note.id, { body: note.body, title: note.title }, { silent: true }); n++;
  };
  for (const note of notes) put(note, raw => (note.updatedAt || 0) > (raw.updatedAt || 0));
  if (sourcesNote) put(sourcesNote, raw => (sourcesNote.body.match(/<li>/g) || []).length > (String(raw.body).match(/<li>/g) || []).length);
  if (n) store.emit({ local: true });
  return n;
}
/** This device's own copies of old Writing items (left in its storage by Steward 4.4 and earlier). */
export async function adoptLocalWriting() {
  const rows = await store.legacy(['docs', 'sources']);
  if (!rows.length) return 0;
  const n = adoptWriting({ docs: rows.filter(r => r.t === 'docs').map(r => r.v), sources: rows.filter(r => r.t === 'sources').map(r => r.v) });
  await store.flush();
  await store.dropLegacy(rows.map(r => r.key));
  const map = await store.driveAll();
  await store.drivePut([...map.keys()].filter(k => /^(docs|sources)\|/.test(k)).map(k => [k, null]));
  return n;
}

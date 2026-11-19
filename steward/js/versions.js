// Note version history: copies of a note's title and text, kept in Steward/library as versions.<noteId>.json so the
// phone and the Mac share one history. The rules live in versions-core.js; this file only reads and writes the store.
import { store } from './store.js';
import * as C from './versions-core.js';

const device = () => { const u = typeof navigator !== 'undefined' ? navigator.userAgent || '' : ''; return !u ? 'Google helper' : /Android|iPhone/i.test(u) ? 'phone' : /iPad/i.test(u) ? 'iPad' : /Macintosh/i.test(u) ? 'Mac' : /Windows/i.test(u) ? 'PC' : 'computer'; };
const snapsOf = id => { const v = store.rawGet('versions', id); return v && !v.deleted ? v.snaps || [] : []; };

/** Keep a copy of this note as it is now. why: a short reason shown in the list. Returns true if a copy was added. */
export function snapshot(note, why = 'edit') {
  if (!note || !note.id || note.deleted) return false;
  const snaps = snapsOf(note.id);
  const next = C.addSnap(snaps, { at: Date.now(), title: note.title || '', body: note.body || '', device: device(), words: C.words(C.textOf(note.body)), why });
  if (next === snaps) return false;
  store.put('versions', { id: note.id, snaps: next }, { silent: true });
  return true;
}
/** Saved versions of a note, newest first. */
export const history = id => [...snapsOf(id)].sort((a, b) => b.at - a.at);
/** Put a saved version back. The text as it is now is saved first, so the restore itself can be undone. */
export function restore(noteId, at) {
  const cur = store.get('notes', noteId), snap = snapsOf(noteId).find(s => s.at === at);
  if (!cur || !snap) return false;
  snapshot(cur, 'before restoring');
  store.patch('notes', noteId, { title: snap.title, body: snap.body });
  return true;
}
/** Forget a note's history (when the note itself is removed for good). */
export const forget = id => { if (store.get('versions', id)) store.remove('versions', id, { silent: true }); };
// Before a sync replaces this device's text with a very different one from Drive, keep this device's text.
store.onReplace = (type, mine, merged) => { if (type === 'notes' && !mine.deleted && !merged.deleted && (mine.body || '') !== (merged.body || '') && C.veryDifferent(mine.body, merged.body)) snapshot(mine, 'before sync'); };

// Which of Claude's changes the Google helper applies itself, and which it leaves for the app (tests: steward/tests/fixes-481.test.mjs).
// The helper holds steward-tasks.json and nothing else, so it may only apply changes to what lives in that file.
// Anything else (notes and their deletes, notebooks, text read from scans, organizer words, identities, goals,
// sessions, reviews) is left for the app: applied here it would be reported as done and then thrown away.
// (doc, document and source are answered here with the "Writing was removed" report.)
const HELPER_TYPES = ['task', 'comment', 'project', 'section', 'label', 'filter', 'block', 'prefs', 'settings', 'doc', 'document', 'source'];
export const needsApp = o => !!o && typeof o === 'object' && (!HELPER_TYPES.includes(String(o.type || 'task').toLowerCase()) || (!!o.item && typeof o.item === 'object' && (o.item.goal !== undefined || !!o.item.goalId)));

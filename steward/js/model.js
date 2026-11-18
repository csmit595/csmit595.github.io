// Business rules shared by the screens and by sync (completing, repeating, reminders, changes sent by Claude).
import { store, settings, TYPES, SHARED } from './store.js';
import { today, mdToHtml, sanitize, esc } from './util.js';
import { nextOccurrence, parseDue, looksRepeating } from './dates.js';

export const COLORS = { green: '#3f7d4e', moss: '#7a8f3c', teal: '#2f8f8a', blue: '#3b74c4', indigo: '#5b5fc7', plum: '#8e4fa8', rose: '#c2527a', red: '#c8473b', orange: '#d17a2a', gold: '#b8962e', stone: '#7b756a', slate: '#55606e' };
export const PRI_COLORS = { 1: '#c8473b', 2: '#d17a2a', 3: '#3b74c4', 4: 'var(--muted)' };

export const ctx = () => ({ projects: store.all('projects'), sections: store.all('sections') });
export const projectName = id => (!id || id === 'inbox' ? 'Inbox' : store.get('projects', id)?.name || 'Inbox');
export const openTasks = () => store.all('tasks').filter(t => !t.completedAt);
export const byOrder = (a, b) => (a.order ?? 0) - (b.order ?? 0) || (a.createdAt || 0) - (b.createdAt || 0);

const slug = s => String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'x';
export function ensureProject(name) {
  if (!name || /^inbox$/i.test(name)) return 'inbox';
  const p = store.all('projects').find(p => p.name.toLowerCase() === name.toLowerCase());
  return p ? p.id : store.put('projects', { id: 'pj-' + slug(name), name, color: 'green', order: Date.now() }).id;
}
export function ensureSection(projectId, name) {
  if (!name) return null;
  const s = store.all('sections').find(s => s.projectId === projectId && s.name.toLowerCase() === name.toLowerCase());
  return s ? s.id : store.put('sections', { id: `sc-${projectId}-${slug(name)}`, projectId, name, order: Date.now() }).id;
}
export function ensureNotebook(name) {
  if (!name) name = 'Notes';
  const n = store.all('notebooks').find(n => n.name.toLowerCase() === name.toLowerCase());
  return n ? n.id : store.put('notebooks', { id: 'nb-' + slug(name), name }).id;
}
export function ensureLabels(names) {
  const have = new Set(store.all('labels').map(l => l.name.toLowerCase()));
  for (const n of names || []) if (n && !have.has(n.toLowerCase())) { store.put('labels', { id: 'lb-' + slug(n), name: n, color: 'stone' }); have.add(n.toLowerCase()); }
}

export function addTask(f, opts) {
  ensureLabels(f.labels);
  return store.put('tasks', {
    ...(f.id ? { id: f.id } : {}), content: f.content, description: f.description || '', projectId: f.projectId || 'inbox', sectionId: f.sectionId || null,
    parentId: f.parentId || null, priority: f.priority || 4, labels: f.labels || [], due: f.due || null, deadline: f.deadline || null,
    duration: f.duration || null, reminders: f.reminders || [], noteId: f.noteId || null, order: Date.now(), completedAt: null,
  }, opts);
}
export function childrenOf(id) { return store.all('tasks').filter(t => t.parentId === id); }

export function completeTask(id) {
  const t = store.get('tasks', id);
  if (!t) return;
  if (t.due?.recur) {
    const next = nextOccurrence(t.due);
    store.put('tasks', { ...t, due: { ...t.due, date: next }, lastDoneAt: Date.now(), doneCount: (t.doneCount || 0) + 1, remindedFor: null });
    for (const c of childrenOf(id)) if (c.completedAt) store.patch('tasks', c.id, { completedAt: null }, { silent: true });
    return { recurring: true, next };
  }
  store.put('tasks', { ...t, completedAt: Date.now() });
  for (const c of childrenOf(id)) if (!c.completedAt) completeTask(c.id);
  return { recurring: false };
}
export function uncompleteTask(id) { store.patch('tasks', id, { completedAt: null }); }
export function deleteTask(id) {
  for (const c of childrenOf(id)) deleteTask(c.id);
  for (const c of store.all('comments')) if (c.taskId === id) store.remove('comments', c.id, { silent: true });
  store.remove('tasks', id);
}
export function deleteProject(id) {
  for (const t of store.all('tasks')) if (t.projectId === id) store.remove('tasks', t.id, { silent: true });
  for (const s of store.all('sections')) if (s.projectId === id) store.remove('sections', s.id, { silent: true });
  for (const p of store.all('projects')) if (p.parentId === id) store.patch('projects', p.id, { parentId: null }, { silent: true });
  store.remove('projects', id);
}

/** All moments a task should alert, as Date objects. */
export function reminderTimes(t) {
  const out = [];
  if (t.completedAt || settings.get('remindersPaused')) return out;
  const dueAt = t.due?.date ? new Date(`${t.due.date}T${t.due.time || '09:00'}:00`) : null;
  for (const r of t.reminders || []) {
    if (r.at) out.push(new Date(r.at));
    else if (dueAt && r.before != null) out.push(new Date(dueAt.getTime() - r.before * 60000));
  }
  if (!out.length && t.due?.time && settings.get('autoRemind')) out.push(new Date(dueAt.getTime() - (settings.get('remindLead') || 0) * 60000));
  return out.filter(d => !isNaN(d));
}

// ---- notes -----------------------------------------------------------------
export function addNote(f) {
  return store.put('notes', {
    ...(f.id ? { id: f.id } : {}), title: f.title || '', body: f.body || '', notebookId: f.notebookId || ensureNotebook(f.notebook), tags: f.tags || [],
    pinned: !!f.pinned, sourceUrl: f.sourceUrl || '', attachments: f.attachments || [], trashed: false,
  });
}
export const liveNotes = () => store.all('notes').filter(n => !n.trashed);
export const allTags = () => { const m = new Map(); for (const n of liveNotes()) for (const t of n.tags || []) m.set(t, (m.get(t) || 0) + 1); return [...m].sort((a, b) => a[0].localeCompare(b[0])); };

// ---- changes written by Claude (files dropped in the Drive "inbox" folder) --
function dueFrom(v) {
  if (v === null) return null;
  if (typeof v === 'string') { const p = parseDue(v); return p ? p.due : v.trim() ? undefined : null; } // words that are not a date are reported, not treated as "no date"
  if (v && v.date) return { date: String(v.date), time: v.time || null, recur: v.recur ? (typeof v.recur === 'string' ? parseDue(v.recur)?.due.recur || null : v.recur) : null };
  return undefined;
}
const realDate = s => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ''); if (!m) return false; const d = new Date(+m[1], +m[2] - 1, +m[3]); return d.getFullYear() === +m[1] && d.getMonth() === +m[2] - 1 && d.getDate() === +m[3]; };
const realTime = s => /^([01]\d|2[0-3]):[0-5]\d$/.test(s || '');
const dateOnly = v => { const d = v === null ? null : typeof v === 'string' ? (/^\d{4}-\d{2}-\d{2}$/.test(v) ? v : parseDue(v)?.due.date || undefined) : v?.date || undefined; return d && !realDate(d) ? undefined : d; };
/** Labels as a clean list of names, whatever shape they arrived in ("promise", "@a, b", ["a", "@b"]). */
const labelList = v => [...new Set((Array.isArray(v) ? v : String(v ?? '').split(/[,\s]+/)).map(x => String(x ?? '').trim().replace(/^@/, '').replace(/\s+/g, '-')).filter(Boolean))];
/**
 * Put a task's fields into the shapes the screens rely on. Returns only the fields that had to change, or null.
 * One wrong shape (labels as a word instead of a list, a date that does not exist) used to stop Search, filters
 * and whole screens from drawing.
 */
export function taskFixes(t, partial = false) {
  const f = {};
  if (typeof t.content !== 'string' && !(partial && t.content === undefined)) f.content = String(t.content ?? '').trim() || 'Untitled';
  if (t.description != null && typeof t.description !== 'string') f.description = String(t.description);
  if (t.labels != null && (!Array.isArray(t.labels) || t.labels.some(l => typeof l !== 'string' || !l || l[0] === '@'))) f.labels = labelList(t.labels);
  if (t.priority != null && ![1, 2, 3, 4].includes(t.priority)) { const p = Math.round(Number(t.priority)); f.priority = p >= 1 && p <= 4 ? p : 4; }
  if (t.duration != null && (typeof t.duration !== 'number' || !(t.duration > 0))) { const n = Math.round(Number(t.duration)); f.duration = n > 0 && n <= 1440 ? n : null; }
  if (t.reminders != null && !Array.isArray(t.reminders)) f.reminders = [];
  if (t.due != null) {
    if (typeof t.due !== 'object' || !realDate(t.due.date)) f.due = null;
    else if (t.due.time != null && !realTime(t.due.time)) f.due = { ...t.due, time: null };
  }
  if (t.deadline != null && !realDate(t.deadline)) f.deadline = null;
  return Object.keys(f).length ? f : null;
}
/** Mend any stored task with a wrong shape (run when Steward starts and after data arrives from Drive). */
export function repairTasks() {
  let n = 0;
  for (const t of store.all('tasks')) { const f = taskFixes(t); if (f) { store.patch('tasks', t.id, f, { silent: true, noHistory: true }); n++; } }
  return n;
}
/** Apply a list of changes. Returns one line per change; lines starting with "problem" need attention. */
export function applyOps(ops) {
  const results = [];
  const BY = { by: 'Claude' };
  for (const [i, o] of (ops || []).entries()) {
    if (!o || typeof o !== 'object') { results.push(`problem #${i + 1}: not a change (expected {"op": ...})`); continue; }
    const where = `#${i + 1} (${o.op || '?'} ${o.type || 'task'}${o.item?.content ? ' "' + String(o.item.content).slice(0, 60) + '"' : o.id ? ' ' + o.id : ''})`;
    try {
      const type = String(o.type || 'task').toLowerCase();
      if (!['upsert', 'complete', 'uncomplete', 'restore', 'delete'].includes(o.op)) throw new Error(`unknown op "${o.op ?? ''}"; nothing was changed (use upsert, complete, uncomplete, restore or delete)`);
      if (o.op === 'upsert' && (!o.item || typeof o.item !== 'object' || Array.isArray(o.item))) throw new Error('an upsert needs an "item"');
      if (o.op === 'complete') { const t = store.get('tasks', o.id); if (!t) throw new Error('no task with that id'); if (t.completedAt) { results.push('ok ' + where + ' (already done)'); continue; } completeTask(o.id); results.push('ok ' + where); continue; }
      if (o.op === 'uncomplete') { if (!store.rawGet('tasks', o.id)) throw new Error('no task with that id'); uncompleteTask(o.id); results.push('ok ' + where); continue; }
      if (o.op === 'restore') { const x = store.rawGet('tasks', o.id); if (!x?.was) throw new Error('nothing to restore'); store.put('tasks', { ...x.was }, BY); results.push('ok ' + where); continue; }
      if (o.op === 'delete') {
        const kind = type === 'task' ? 'tasks' : type === 'doc' || type === 'document' ? 'docs' : type + 's';
        if (!TYPES.includes(kind)) throw new Error(`cannot delete a "${type}"`);
        if (!store.get(kind, o.id)) throw new Error(`no ${type} with that id; nothing was deleted`);
        if (type === 'task') deleteTask(o.id);
        else if (type === 'project') deleteProject(o.id);
        else if (kind === 'notes' || kind === 'docs') store.patch(kind, o.id, { trashed: true });
        else store.remove(kind, o.id);
        results.push('ok ' + where);
        continue;
      }
      const it = { ...(o.item || {}) };
      if (type === 'task') {
        const cur = it.id ? store.get('tasks', it.id) : null;
        if (it.project !== undefined) { it.projectId = ensureProject(it.project); delete it.project; }
        if (it.section !== undefined) { it.sectionId = ensureSection(it.projectId || cur?.projectId || 'inbox', it.section); delete it.section; }
        if (it.due !== undefined) {
          const raw = typeof it.due === 'string' ? it.due : it.due?.recur && typeof it.due.recur === 'string' ? it.due.recur : '';
          const d = dueFrom(it.due);
          if (d === undefined) { results.push(`problem ${where}: could not read the date "${typeof it.due === 'string' ? it.due : JSON.stringify(it.due)}"; date left unchanged`); delete it.due; }
          else { it.due = d; if (raw && looksRepeating(raw) && !d?.recur) results.push(`problem ${where}: the repeat in "${raw}" was not understood, so it was saved as a one-time date`); }
        }
        if (it.deadline !== undefined) { const d = dateOnly(it.deadline); if (d === undefined) { results.push(`problem ${where}: could not read the deadline`); delete it.deadline; } else it.deadline = d; }
        if (it.id != null && !/^[\w-]{1,80}$/.test(String(it.id))) throw new Error('a task id may only use letters, digits and hyphens');
        if (it.due && !realDate(it.due.date)) { results.push(`problem ${where}: "${it.due.date}" is not a real date; date left unchanged`); delete it.due; }
        else if (it.due?.time && !realTime(it.due.time)) { results.push(`problem ${where}: "${it.due.time}" is not a time (use HH:MM); saved without a time`); it.due = { ...it.due, time: null }; }
        if (it.parentId && !store.get('tasks', it.parentId)) { results.push(`problem ${where}: no parent task with id ${it.parentId}; saved as a top-level task`); it.parentId = null; }
        Object.assign(it, taskFixes(it, true) || {});
        if (it.labels) ensureLabels(it.labels);
        if (it.id && !cur && store.rawGet('tasks', it.id)?.deleted) throw new Error('that task was deleted; use {"op":"restore"} first');
        // A change to a task this device does not have (yet) must never create a blank copy under that id: the copy's
        // empty name, project and labels would be newer than the real task's and overwrite it everywhere.
        if (it.id && !cur && !String(it.content || '').trim()) throw new Error('no task with that id on this device yet; nothing was changed (to create a new task, include its content)');
        if (!cur && !String(it.content || '').trim()) throw new Error('a new task needs "content"');
        if (cur) store.put('tasks', { ...cur, ...it, remindedFor: it.due ? null : cur.remindedFor }, BY);
        else addTask(it, BY);
      } else if (type === 'note') {
        const cur = it.id ? store.get('notes', it.id) : null;
        // Same rule as tasks: adding to, or patching, a note this device does not hold would build a blank note that
        // overwrites the real one. Only a full new note (title or text) may be created under a new id.
        if (it.id && !cur) {
          if (store.rawGet('notes', it.id)?.deleted) throw new Error('that note was deleted for good');
          if (it.appendMarkdown !== undefined) throw new Error('no note with that id on this device yet; nothing was added');
          if (![it.title, it.markdown, it.body, it.text].some(v => String(v || '').trim()) && !it.files?.length) throw new Error('no note with that id on this device yet; nothing was changed');
        }
        if (it.notebook !== undefined) { it.notebookId = ensureNotebook(it.notebook); delete it.notebook; }
        if (it.markdown !== undefined) { it.body = mdToHtml(it.markdown); delete it.markdown; }
        if (it.appendMarkdown !== undefined) { it.body = (cur?.body || '') + mdToHtml(it.appendMarkdown); delete it.appendMarkdown; }
        if (it.text !== undefined) { it.body = esc(it.text).replace(/\n/g, '<br>'); delete it.text; }
        if (Array.isArray(it.files)) { // files Claude uploaded to Steward/attachments: [{driveId, name, mime, size, text}]
          const atts = [...(cur?.attachments || [])]; let add = '';
          for (const f of it.files) {
            if (!f?.driveId) continue;
            const a = { id: 'g' + String(f.driveId).replace(/[^\w-]/g, '').slice(0, 40), name: f.name || 'file', mime: f.mime || 'application/octet-stream', size: f.size || 0, driveId: f.driveId };
            if (!atts.find(x => x.id === a.id)) { atts.push(a); add += (a.mime.startsWith('image/') ? `<img data-att="${a.id}" alt="${esc(a.name)}">` : a.mime.startsWith('audio/') ? `<audio controls data-att="${a.id}"></audio>` : `<a class="att" data-att="${a.id}" contenteditable="false">${esc(a.name)}</a>`) + '<div><br></div>'; }
            if (f.text) store.put('ocr', { id: a.id, name: a.name, text: String(f.text).slice(0, 30000), by: 'claude' }, { silent: true });
          }
          it.attachments = atts; it.body = (it.body ?? cur?.body ?? '') + add; delete it.files;
        }
        if (it.body !== undefined) it.body = sanitize(it.body);
        if (cur) store.put('notes', { ...cur, ...it });
        else addNote(it);
      } else if (type === 'doc' || type === 'document') {
        const cur = it.id ? store.get('docs', it.id) : null;
        if (it.markdown !== undefined) { it.body = mdToHtml(it.markdown).replace(/<div>/g, '<p>').replace(/<\/div>/g, '</p>'); delete it.markdown; }
        if (it.body !== undefined) it.body = sanitize(it.body);
        store.put('docs', cur ? { ...cur, ...it } : { kind: 'other', footnotes: {}, meta: {}, trashed: false, title: 'Untitled', body: '<p><br></p>', ...it });
      } else if (type === 'source') {
        const cur = it.id ? store.get('sources', it.id) : null;
        if (!cur && !String(it.title || '').trim()) throw new Error('a new source needs a title');
        store.put('sources', cur ? { ...cur, ...it } : { type: 'book', ...it });
      } else if (type === 'project') {
        const cur = it.id ? store.get('projects', it.id) : store.all('projects').find(p => p.name.toLowerCase() === String(it.name || '').toLowerCase());
        store.put('projects', cur ? { ...cur, ...it, id: cur.id } : { color: 'green', order: Date.now(), ...it });
      } else if (type === 'block') {
        // a fixed block: {name, days:[0-6], start:"HH:MM", end:"HH:MM", every:1|2, anchor:"YYYY-MM-DD", until:"YYYY-MM-DD"}
        const cur = it.id ? store.get('blocks', it.id) : store.all('blocks').find(b => b.name.toLowerCase() === String(it.name || '').toLowerCase());
        const b = { every: 1, ...(cur || {}), ...it, id: cur?.id || it.id || undefined };
        if (!b.name || !Array.isArray(b.days) || !realTime(b.start) || !realTime(b.end)) throw new Error('a block needs name, days, start and end (HH:MM)');
        b.days = [...new Set(b.days.map(Number))].filter(d => d >= 0 && d <= 6 && Number.isInteger(d)).sort();
        if (!b.days.length) throw new Error('a block needs at least one day (0 = Sunday … 6 = Saturday)');
        if (b.end <= b.start) throw new Error('a block must end after it starts (same day)');
        if (b.anchor && !realDate(b.anchor)) throw new Error('anchor must be a real YYYY-MM-DD date');
        if (b.until && !realDate(b.until)) throw new Error('until must be a real YYYY-MM-DD date');
        b.every = b.every === 2 || b.every === '2' ? 2 : 1;
        store.put('blocks', b);
      } else if (type === 'prefs' || type === 'settings') {
        const cur = store.get('prefs', 'shared');
        if (it.hours !== undefined) {
          const okDay = w => w === null || (w && realTime(w.start) && realTime(w.end) && w.end > w.start);
          if (!Array.isArray(it.hours) || it.hours.length !== 7 || !it.hours.every(okDay)) throw new Error('hours must list 7 days (Sunday first), each null or {start:"HH:MM", end:"HH:MM"} with end after start');
        }
        if (it.restDay !== undefined && ![-1, 0, 1, 2, 3, 4, 5, 6].includes(it.restDay)) throw new Error('restDay must be 0 (Sunday) to 6, or -1 for none');
        if (it.remindLead !== undefined && !(Number(it.remindLead) >= 0)) throw new Error('remindLead must be minutes, 0 or more');
        const bad = Object.keys(it).filter(k => k !== 'id' && !SHARED.includes(k));
        if (bad.length) throw new Error(`unknown setting${bad.length > 1 ? 's' : ''}: ${bad.join(', ')}`);
        store.put('prefs', { ...(cur || {}), ...it, id: 'shared' });
      } else if (type === 'ocr') {
        // text Claude read from a photo or PDF already attached to a note: {id: attachment id, text}
        if (!it.id || typeof it.text !== 'string') throw new Error('ocr needs id and text');
        const cur = store.rawGet('ocr', it.id);
        store.put('ocr', { ...(cur && !cur.deleted ? cur : {}), id: it.id, text: it.text.slice(0, 30000), by: 'claude', failed: false, needsReading: false });
      } else if (type === 'comment') {
        if (!it.id && !store.get('tasks', it.taskId)) throw new Error('no task with that taskId; the comment was not added');
        if (!it.id && !String(it.text || '').trim()) throw new Error('a comment needs text');
        const curC = it.id ? store.get('comments', it.id) : null;
        store.put('comments', { ...(curC || {}), taskId: it.taskId, text: String(it.text ?? curC?.text ?? ''), author: it.author || curC?.author || 'Claude', ...it });
      } else if (type === 'orgword') {
        // a name or word the organizer should know: {word, area, tags:[...]} (area: cs-outdoors, seminary, church, home-family, personal)
        const word = String(it.word || '').trim();
        const cur = it.id ? store.get('orgwords', it.id) : store.all('orgwords').find(w => w.word.toLowerCase() === word.toLowerCase());
        if (!cur && word.length < 2) throw new Error('an orgword needs a word');
        const AREAS = ['cs-outdoors', 'seminary', 'church', 'home-family', 'personal'];
        if (it.area != null && !AREAS.includes(it.area)) throw new Error(`area must be one of ${AREAS.join(', ')}`);
        if (it.tags !== undefined) it.tags = labelList(it.tags).map(t => t.toLowerCase());
        store.put('orgwords', { ...(cur || { area: null, tags: [] }), ...it, ...(word ? { word } : {}), id: cur?.id || it.id || undefined });
      } else if (['section', 'label', 'filter', 'notebook'].includes(type)) {
        const cur = it.id ? store.get(type + 's', it.id) : null;
        if (!cur && !String(it.name || '').trim()) throw new Error(`a new ${type} needs a name`);
        if (!cur && type === 'filter' && !String(it.query || '').trim()) throw new Error('a new filter needs a query');
        if (type === 'label' && it.name) it.name = labelList(it.name)[0] || it.name;
        store.put(type + 's', cur ? { ...cur, ...it } : it);
      } else throw new Error(`unknown type "${type}"; nothing was changed`);
      results.push('ok ' + where);
    } catch (e) { results.push(`problem ${where}: ${e.message}`); }
  }
  return results;
}

// ---- fixed blocks (devotions, classes, dinner, church): synced, used by the day plan and calendar ----
/** Blocks that happen on a day, as {b, start, end} in minutes after midnight. */
export function blocksOn(day) {
  const [y, mo, d] = day.split('-').map(Number), dow = new Date(y, mo - 1, d).getDay();
  const toMin = s => { const [a, c] = s.split(':').map(Number); return a * 60 + c; };
  const out = [];
  for (const b of store.all('blocks')) {
    if (b.paused || !(b.days || []).includes(dow)) continue;
    if (b.from && day < b.from) continue;
    if (b.until && day > b.until) continue;
    if ((b.every || 1) > 1 && b.anchor) {
      const weeks = Math.round((new Date(y, mo - 1, d - dow) - (() => { const [ay, am, ad] = b.anchor.split('-').map(Number); const a = new Date(ay, am - 1, ad); return new Date(ay, am - 1, ad - a.getDay()); })()) / (7 * 864e5));
      if (((weeks % b.every) + b.every) % b.every !== 0) continue;
    }
    out.push({ b, start: toMin(b.start), end: toMin(b.end) });
  }
  return out.sort((a, c) => a.start - c.start);
}

/** The id Steward gives the reminder event for a task at a moment. Claude uses the same rule (see the Steward skill). */
export const reminderKey = (taskId, at) => `st${Array.from(String(taskId), c => c.charCodeAt(0).toString(16).padStart(2, '0')).join('')}t${Math.floor(at.getTime() / 60000).toString(32)}`;

/** Plain-text digest written to Drive on every save so Claude can read the plan quickly. */
export function buildSummary() {
  const now = today();
  const tasks = openTasks().filter(t => !t.parentId);
  const line = t => `- ${t.content}${t.due ? ` — due ${t.due.date}${t.due.time ? ' ' + t.due.time : ''}${t.due.recur ? ' (repeats ' + t.due.recur.text + ')' : ''}` : ''}${t.deadline ? ' — deadline ' + t.deadline : ''}${t.duration ? ' — ' + t.duration + 'm' : ''} — p${t.priority || 4} — ${projectName(t.projectId)}${(t.labels || []).length ? ' — @' + t.labels.join(' @') : ''} [id:${t.id}]`;
  const sortDue = (a, b) => (a.due.date + (a.due.time || '')).localeCompare(b.due.date + (b.due.time || ''));
  const overdue = tasks.filter(t => t.due && t.due.date < now).sort(sortDue);
  const tod = tasks.filter(t => t.due?.date === now).sort(sortDue);
  const soon = tasks.filter(t => t.due && t.due.date > now).sort(sortDue).slice(0, 150);
  const none = tasks.filter(t => !t.due);
  const out = [`# Steward summary`, `Written ${new Date().toString()}`, `Open tasks: ${tasks.length}. Notes: ${liveNotes().length}.`, ''];
  out.push(`## Overdue (${overdue.length})`, ...overdue.map(line), '', `## Today ${now} (${tod.length})`, ...tod.map(line), '', `## Upcoming`, ...soon.map(line), '', `## No date (${none.length})`);
  const byProj = new Map();
  for (const t of none) { const k = projectName(t.projectId); if (!byProj.has(k)) byProj.set(k, []); byProj.get(k).push(t); }
  for (const [k, list] of byProj) out.push(`### ${k}`, ...list.map(line));
  out.push('', '## Projects', ...store.all('projects').map(p => `- ${p.name} [id:${p.id}]`), '', '## Notebooks', ...store.all('notebooks').map(n => `- ${n.name} (${liveNotes().filter(x => x.notebookId === n.id).length} notes) [id:${n.id}]`));
  out.push('', '## Writing (documents)', ...store.all('docs').filter(d => !d.trashed).map(d => `- ${d.title || 'Untitled'} (${d.kind || 'document'}) [id:${d.id}]`), '', `Sources saved: ${store.all('sources').length}`);
  const DAYN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  out.push('', '## Fixed blocks (never schedule over these)', ...store.all('blocks').filter(b => !b.paused).map(b => `- ${b.name}: ${(b.days || []).map(d => DAYN[d]).join(' ')} ${b.start}–${b.end}${(b.every || 1) > 1 ? ` every ${b.every} weeks from ${b.anchor}` : ''}${b.until ? ' until ' + b.until : ''} [id:${b.id}]`));
  const toRead = [];
  for (const n of liveNotes()) for (const a of n.attachments || []) { const o = store.get('ocr', a.id); if (o?.needsReading && a.driveId) toRead.push(`- "${a.name}" in note "${n.title || 'Untitled'}" — Drive file ${a.driveId} [attachment:${a.id}]`); }
  if (toRead.length) out.push('', `## Pages for Claude to read (${toRead.length})`, 'Steward could not read these well (handwriting or a poor photo). Transcribe each and send {"op":"upsert","type":"ocr","item":{"id":"<attachment>","text":"..."}}.', ...toRead);
  out.push('', '## Recent notes', ...liveNotes().sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 60).map(n => `- ${n.title || 'Untitled'} — ${new Date(n.updatedAt).toISOString().slice(0, 10)}${(n.tags || []).length ? ' — tags: ' + n.tags.join(', ') : ''} [id:${n.id}]`));
  return out.join('\n');
}

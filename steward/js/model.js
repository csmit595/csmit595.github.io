// Business rules shared by the screens and by sync (completing, repeating, reminders, changes sent by Claude).
import { store, settings } from './store.js';
import { today, uid, mdToHtml, sanitize, esc } from './util.js';
import { nextOccurrence, parseDue } from './dates.js';

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

export function addTask(f) {
  ensureLabels(f.labels);
  return store.put('tasks', {
    ...(f.id ? { id: f.id } : {}), content: f.content, description: f.description || '', projectId: f.projectId || 'inbox', sectionId: f.sectionId || null,
    parentId: f.parentId || null, priority: f.priority || 4, labels: f.labels || [], due: f.due || null,
    duration: f.duration || null, reminders: f.reminders || [], noteId: f.noteId || null, order: Date.now(), completedAt: null,
  });
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
  if (t.completedAt) return out;
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
  if (typeof v === 'string') return parseDue(v)?.due || null;
  if (v && v.date) return { date: v.date, time: v.time || null, recur: v.recur ? (typeof v.recur === 'string' ? parseDue(v.recur)?.due.recur || null : v.recur) : null };
  return undefined;
}
export function applyOps(ops) {
  const results = [];
  for (const o of ops || []) {
    try {
      const type = (o.type || 'task').toLowerCase();
      if (o.op === 'complete') { completeTask(o.id); results.push('completed ' + o.id); continue; }
      if (o.op === 'uncomplete') { uncompleteTask(o.id); continue; }
      if (o.op === 'delete') {
        if (type === 'task') deleteTask(o.id);
        else if (type === 'project') deleteProject(o.id);
        else if (type === 'note') store.patch('notes', o.id, { trashed: true });
        else store.remove(type + 's', o.id);
        continue;
      }
      const it = { ...(o.item || {}) };
      if (type === 'task') {
        const cur = it.id ? store.get('tasks', it.id) : null;
        if (it.project !== undefined) { it.projectId = ensureProject(it.project); delete it.project; }
        if (it.section !== undefined) { it.sectionId = ensureSection(it.projectId || cur?.projectId || 'inbox', it.section); delete it.section; }
        if (it.due !== undefined) { const d = dueFrom(it.due); if (d !== undefined) it.due = d; else delete it.due; }
        if (it.labels) ensureLabels(it.labels);
        if (cur) store.put('tasks', { ...cur, ...it, remindedFor: it.due ? null : cur.remindedFor });
        else addTask({ content: 'Untitled', ...it });
      } else if (type === 'note') {
        const cur = it.id ? store.get('notes', it.id) : null;
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
        store.put('sources', cur ? { ...cur, ...it } : { type: 'book', ...it });
      } else if (type === 'project') {
        const cur = it.id ? store.get('projects', it.id) : store.all('projects').find(p => p.name.toLowerCase() === String(it.name || '').toLowerCase());
        store.put('projects', cur ? { ...cur, ...it, id: cur.id } : { color: 'green', order: Date.now(), ...it });
      } else if (type === 'comment') {
        store.put('comments', { taskId: it.taskId, text: it.text || '', author: it.author || 'Claude', ...it });
      } else if (['section', 'label', 'filter', 'notebook'].includes(type)) {
        const cur = it.id ? store.get(type + 's', it.id) : null;
        store.put(type + 's', cur ? { ...cur, ...it } : it);
      }
      results.push('ok');
    } catch (e) { results.push('error: ' + e.message); }
  }
  return results;
}

/** Plain-text digest written to Drive on every save so Claude can read the plan quickly. */
export function buildSummary() {
  const now = today();
  const tasks = openTasks().filter(t => !t.parentId);
  const line = t => `- ${t.content}${t.due ? ` — due ${t.due.date}${t.due.time ? ' ' + t.due.time : ''}${t.due.recur ? ' (repeats ' + t.due.recur.text + ')' : ''}` : ''} — p${t.priority || 4} — ${projectName(t.projectId)}${(t.labels || []).length ? ' — @' + t.labels.join(' @') : ''} [id:${t.id}]`;
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
  out.push('', '## Recent notes', ...liveNotes().sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 60).map(n => `- ${n.title || 'Untitled'} — ${new Date(n.updatedAt).toISOString().slice(0, 10)}${(n.tags || []).length ? ' — tags: ' + n.tags.join(', ') : ''} [id:${n.id}]`));
  return out.join('\n');
}

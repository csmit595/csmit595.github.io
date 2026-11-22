// Sort the Inbox's no-project tasks with Claude Sonnet. Pressing "Sort tasks" asks Claude (in batches, in the
// background) which project each task belongs in. Nothing moves until a task's Confirm is pressed: each task shows its
// suggested project on the right, which can be changed before confirming. With no Claude, the on-device organizer
// suggests what it can. Suggestions are kept on this device (setting `inboxSortPicks`) until confirmed or cleared.
import { h } from './util.js';
import { store, settings } from './store.js';
import * as M from './model.js';
import { btn, iconBtn, toast } from './ui.js';
import { ask, aiReady, aiOn, _test } from './ai.js';
import * as X from './context-core.js';
import { learn, readOrg, suggestNow } from './organize.js';

const KEY = 'inboxSortPicks';
const BATCH = 40;
const NEW = 'new:';
let job = null; // { status: 'running', done, total }

const redraw = () => store.emit({}); // redraw only; not a change to sync
const loadPicks = () => { const p = settings.get(KEY); return p && typeof p === 'object' ? p : {}; };
const savePicks = p => settings.set(KEY, p);
const inInbox = t => t && !t.completedAt && !t.deleted && (!t.projectId || t.projectId === 'inbox' || !store.get('projects', t.projectId));

/** The tasks the button sorts: open, top-level, no project. */
export const unsortedTasks = () => {
  const ids = new Set(store.all('tasks').map(t => t.id));
  return store.all('tasks').filter(t => inInbox(t) && (!t.parentId || !ids.has(t.parentId)));
};
/** Claude's (or the device's) suggestion for a task still in the Inbox, or null. */
export function pickFor(id) {
  const p = loadPicks()[id];
  if (!p || !inInbox(store.get('tasks', id))) return null;
  if (p.projectId && p.projectId !== 'inbox' && !store.get('projects', p.projectId)) return null; // project deleted since
  return p;
}
export const sorting = () => job?.status === 'running';
const livePicks = () => Object.keys(loadPicks()).filter(id => pickFor(id));

// ---- asking Claude ------------------------------------------------------------------------------------------------
function projectFacts() {
  const projects = store.all('projects').filter(p => !p.archived && p.name && !/^inbox$/i.test(p.name));
  const open = M.openTasks();
  return projects.map(p => {
    const parent = p.parentId && store.get('projects', p.parentId)?.name;
    const sections = store.all('sections').filter(s => s.projectId === p.id && !s.deleted).map(s => s.name).filter(Boolean);
    const examples = open.filter(t => t.projectId === p.id && !t.parentId).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 6).map(t => t.content.slice(0, 80));
    return { name: p.name, ...(parent ? { inside: parent } : {}), ...(sections.length ? { sections } : {}), ...(examples.length ? { examples } : {}) };
  });
}

const SYSTEM = (projects, context) => [
  'You sort tasks into projects in Steward, the task app of Charles, who owns CS Outdoors (a landscape management company in Greenville, SC: mowing, leaf cleanups, mulch, plantings, patios, sod and other customer jobs), is a first-year BJU Seminary student, serves at church (including ESL teaching at Embrace English on Wednesdays), and is married to Elise with a baby due January 2027.',
  'His projects (with sections and a few example tasks already in each):\n' + JSON.stringify(projects),
  context ? 'His sorting context. A customer, crew member, supplier, family member, church person or course named here decides where a task goes:\n<context>\n' + context + '\n</context>' : '',
  'For each task, choose the one project it belongs in, using the exact project name. Use a section only if it clearly fits, with its exact name. If no project fits well, either set "project" to null (it stays in the Inbox) or, only when several tasks clearly share a customer job or topic with no project yet, suggest a short new project name in "newProject". Never invent a project for a single loose task.',
  'Reply with JSON only, no Markdown, no words before or after, and no double-quote characters inside text values: {"picks":[{"id":"t1","project":"Exact name"|null,"section":"Exact name"|null,"newProject":"Name"|null,"why":"a few words"}]}',
].filter(Boolean).join('\n\n');

async function askBatch(batch, projects, context) {
  const rows = batch.map((t, i) => ({ id: 't' + (i + 1), task: t.content.slice(0, 200), ...(t.description ? { notes: t.description.slice(0, 160) } : {}), ...(t.labels?.length ? { labels: t.labels } : {}) }));
  const reply = await ask('sonnet', { system: SYSTEM(projects, context), max_tokens: 4000, messages: [{ role: 'user', content: JSON.stringify({ tasks: rows }) }] });
  const j = _test.firstJson(reply);
  const out = {};
  const byName = n => store.all('projects').find(p => !p.archived && p.name.toLowerCase() === String(n || '').trim().toLowerCase());
  for (const r of Array.isArray(j?.picks) ? j.picks : []) {
    const t = batch[Number(String(r?.id || '').replace(/^t/, '')) - 1];
    if (!t) continue;
    const p = byName(r.project);
    const why = typeof r.why === 'string' ? r.why.slice(0, 80) : '';
    if (p) {
      const sec = r.section && store.all('sections').find(s => s.projectId === p.id && !s.deleted && s.name.toLowerCase() === String(r.section).toLowerCase());
      out[t.id] = { projectId: p.id, sectionId: sec?.id || null, why, by: 'claude', at: Date.now() };
    } else if (r.newProject && typeof r.newProject === 'string' && r.newProject.trim()) {
      out[t.id] = { newProject: r.newProject.trim().slice(0, 60), why, by: 'claude', at: Date.now() };
    } else out[t.id] = { projectId: 'inbox', why: why || 'no project fits', by: 'claude', at: Date.now() };
  }
  return out;
}

/** With no Claude: what the on-device organizer thinks, for tasks it is fairly sure about. */
function deviceSort(tasks) {
  const out = {};
  for (const t of tasks) {
    let s = null; try { s = suggestNow(t.content, 'task'); } catch {}
    const p = s?.project && store.all('projects').find(x => x.name.toLowerCase() === s.project.name);
    if (p && s.project.p >= 0.5) out[t.id] = { projectId: p.id, sectionId: null, why: 'suggested on this device', by: 'device', at: Date.now() };
  }
  return out;
}

/** Start sorting every no-project task. Runs in the background; the list redraws as each batch comes back. */
export async function startSort() {
  if (sorting()) return toast('Claude is still sorting. Keep working; the suggestions appear as they come in.');
  const tasks = unsortedTasks();
  if (!tasks.length) return toast('No tasks without a project to sort.');
  if (!store.all('projects').some(p => !p.archived && p.name && !/^inbox$/i.test(p.name))) return toast('Make a project or two first, so there is somewhere to sort tasks into.');
  // Drop old suggestions for these tasks so a fresh sort replaces them.
  const picks = loadPicks(); for (const t of tasks) delete picks[t.id]; savePicks(picks);
  if (!aiReady()) {
    const found = deviceSort(tasks);
    savePicks({ ...loadPicks(), ...found });
    redraw();
    const n = Object.keys(found).length;
    return toast(`${!aiOn() ? 'Claude is off (Settings → Claude).' : !navigator.onLine ? 'No signal for Claude.' : 'Claude cannot be reached right now.'} ${n ? `Suggested projects for ${n} task${n === 1 ? '' : 's'} on this device instead.` : 'The device could not place any of them with confidence.'}`, null, null, 7000);
  }
  const projects = projectFacts();
  const cn = store.get('notes', X.CONTEXT_ID);
  const context = cn && !cn.trashed && !cn.deleted ? X.contextForClaude(X.contextText(cn.body), 8000) : '';
  const me = job = { status: 'running', done: 0, total: tasks.length };
  redraw();
  toast(`Claude is sorting ${tasks.length} task${tasks.length === 1 ? '' : 's'}. Nothing moves until you confirm each one.`, null, null, 4000);
  let failed = null;
  for (let i = 0; i < tasks.length; i += BATCH) {
    if (job !== me) return;
    const batch = tasks.slice(i, i + BATCH).filter(t => inInbox(store.get('tasks', t.id)));
    try { if (batch.length) savePicks({ ...loadPicks(), ...(await askBatch(batch, projects, context)) }); }
    catch (e) { failed = e.message || String(e); break; }
    me.done = Math.min(tasks.length, i + BATCH);
    redraw();
  }
  if (job !== me) return;
  job = null;
  redraw();
  const n = tasks.filter(t => pickFor(t.id)).length;
  if (failed) toast(`Claude stopped sorting: ${failed}${n ? ` (${n} suggestion${n === 1 ? '' : 's'} kept)` : ''}`, 'Try again', startSort, 15000);
  else toast(`Claude suggested a place for ${n} task${n === 1 ? '' : 's'}. Confirm or change each one.`, null, null, 6000);
}

// ---- confirming -----------------------------------------------------------------------------------------------------
const dropPick = id => { const p = loadPicks(); delete p[id]; savePicks(p); };
const allUnder = id => M.childrenOf(id).flatMap(c => [c, ...allUnder(c.id)]);

/** File a task where its pick says (pick may have been changed with the picker). Returns an undo function. */
function apply(id, pick) {
  const t = store.get('tasks', id); if (!t) return null;
  let projectId = pick.projectId || 'inbox', sectionId = pick.sectionId || null;
  if (pick.newProject) { projectId = M.ensureProject(pick.newProject); sectionId = null; }
  const moved = [t, ...allUnder(id)].map(x => ({ id: x.id, projectId: x.projectId, sectionId: x.sectionId }));
  dropPick(id);
  if (projectId !== 'inbox') {
    for (const m of moved) store.patch('tasks', m.id, { projectId, sectionId: m.id === id ? sectionId : null }, { silent: true });
    // Teach the on-device organizer too, keeping the area and tags the task already has.
    try { const name = M.projectName(projectId).toLowerCase(); const cur = readOrg(t.labels, { project: name }); learn('task', t.content, { ...cur, project: name }); } catch (e) { console.warn('learn', e); }
  }
  return () => { for (const m of moved) store.patch('tasks', m.id, { projectId: m.projectId, sectionId: m.sectionId }, { silent: true }); savePicks({ ...loadPicks(), [id]: pick }); store.emit({ local: true }); };
}
const where = pick => pick.newProject ? pick.newProject : M.projectName(pick.projectId);

export function confirmPick(id) {
  const pick = pickFor(id); if (!pick) return;
  const undo = apply(id, pick);
  store.emit({ local: true });
  if (undo) toast(pick.newProject || (pick.projectId && pick.projectId !== 'inbox') ? `Moved to ${where(pick)}` : 'Kept in the Inbox', 'Undo', undo);
}
export function confirmAll() {
  const ids = livePicks(); if (!ids.length) return;
  const undos = ids.map(id => apply(id, pickFor(id) || loadPicks()[id])).filter(Boolean);
  store.emit({ local: true });
  toast(`Confirmed ${undos.length} task${undos.length === 1 ? '' : 's'}`, 'Undo', () => undos.forEach(u => u()));
}
export function clearPicks() {
  const was = loadPicks(); savePicks({}); job = null; redraw();
  toast('Suggestions cleared', 'Undo', () => { savePicks(was); redraw(); });
}
function changePick(id, value) {
  const p = loadPicks(), cur = p[id] || {};
  p[id] = value.startsWith(NEW) ? { ...cur, newProject: value.slice(NEW.length), projectId: null, sectionId: null, adjusted: true }
    : { ...cur, newProject: null, projectId: value, sectionId: value === cur.projectId ? cur.sectionId : null, adjusted: true };
  savePicks(p);
}

// ---- UI -------------------------------------------------------------------------------------------------------------
/** The suggested-project picker and Confirm button shown on the right of a task, or null. */
export function pickControl(t, projectTree) {
  const pick = pickFor(t.id); if (!pick) return null;
  const stop = e => e.stopPropagation();
  const sel = h('select', { class: 'field slim', title: pick.why ? (pick.by === 'claude' ? 'Claude: ' : '') + pick.why : 'Suggested project', 'aria-label': 'Project for this task', onclick: stop, onchange: () => { changePick(t.id, sel.value); } },
    pick.newProject && h('option', { value: NEW + pick.newProject }, `New: ${pick.newProject}`),
    h('option', { value: 'inbox' }, 'No project (keep in Inbox)'),
    projectTree().map(p => h('option', { value: p.id }, '  '.repeat(p.depth) + p.name)));
  sel.value = pick.newProject ? NEW + pick.newProject : (pick.projectId || 'inbox');
  const sec = pick.sectionId && !pick.adjusted && store.get('sections', pick.sectionId)?.name;
  return h('div', { class: 'sortpick', draggable: 'false', onclick: stop, ondragstart: e => { e.preventDefault(); e.stopPropagation(); } },
    h('div', { class: 'sp-pick' }, sel, (sec || pick.why) && h('span', { class: 'sp-why' }, [sec && '› ' + sec, pick.why].filter(Boolean).join(' · '))),
    btn('Confirm', e => { stop(e); confirmPick(t.id); }, 'tiny primary', 'check'));
}

/** Buttons for the "No project" heading: Sort tasks, then (once there are suggestions) Confirm all and Clear. */
export function sortHeadButtons() {
  if (!unsortedTasks().length) return null;
  const n = livePicks().length;
  if (sorting()) return h('span', { class: 'sorthead' }, h('span', { class: 'sub sp-busy' }, `Claude is sorting… ${job.done}/${job.total}`));
  return h('span', { class: 'sorthead' },
    n > 0 && btn(`Confirm all (${n})`, confirmAll, 'tiny', 'check'),
    n > 0 && iconBtn('x', 'Clear suggestions', clearPicks, 'mini'),
    btn(n ? 'Sort again' : 'Sort tasks', startSort, 'tiny' + (n ? '' : ' primary'), 'spark'));
}

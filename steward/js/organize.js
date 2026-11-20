// Organizer, the part you see: the "Suggested" row under a new task or note, with one Confirm button.
// Nothing is filed until Confirm is pressed. Each confirmation (and each suggestion taken off) is saved as a lesson,
// synced through Google Drive (steward-organize.json), and every device retrains from the same lessons, so the phone
// and the Mac learn together. The device's own organizer answers first and always works offline; when Claude is set up
// and there is signal, Claude Haiku (js/ai.js) refines the suggestion once typing pauses.
import { h, fill, debounce } from './util.js';
import { store, settings } from './store.js';
import { icon, menu, promptDlg, toast } from './ui.js';
import * as C from './organize-core.js';
import * as X from './context-core.js';
import { embed } from './semantic.js';
import { sortWithClaude, aiReady } from './ai.js';

export const { AREAS, AREA_IDS, tagName, tagSlug, PROMISE } = C;
export const orgOn = () => settings.get('orgOn') !== false;
export const orgModelOn = () => settings.get('orgModel') !== false;
const areaName = id => AREAS.find(a => a.id === id)?.name || id;

// ---- the model: rebuilt only when lessons, words, projects or notebooks change --------------------------------------
let model = null;
const WATCH = new Set(['lessons', 'orgwords', 'projects', 'notebooks']);
store.on(info => {
  if (info.remote || WATCH.has(info.type)) { model = null; vecDirty = true; }
  else if (info.type === 'notes' && contextBody() !== ctx.body) model = null; // the sorting-context note was edited
});
// The sorting-context note (js/context-core.js): his keywords, read again whenever the note changes.
const ctx = { body: null, words: [], text: '' };
const contextBody = () => { const n = store.get('notes', X.CONTEXT_ID); return n && !n.trashed && !n.deleted ? n.body || '' : ''; };
function readContext() {
  const b = contextBody();
  if (b !== ctx.body) { ctx.body = b; ctx.text = X.contextText(b); ctx.words = X.parseContext(ctx.text).words; }
  return ctx;
}
/** The sorting-context note as plain text, for Claude ('' when there is none). */
export const contextNoteText = () => readContext().text;
export const contextWordCount = () => readContext().words.length;
export function getModel() {
  if (!model) model = C.train({
    lessons: store.all('lessons'), words: [...store.all('orgwords'), ...readContext().words],
    projects: store.all('projects').map(p => p.name).filter(Boolean),
    notebooks: store.all('notebooks').map(n => n.name).filter(Boolean),
  });
  return model;
}
export const lessonCount = () => store.all('lessons').length;

// ---- meaning: past lessons closest to the text (on-device language model, when available) ------------------------------
const vecs = new Map(); // "org:<lesson id>" or "org:seed:<n>" -> { hash, v, keys }
let vecLoaded = false, vecDirty = true, vecBusy = null, modelDown = 0;
const hash = s => { let x = 2166136261; for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619); } return (x >>> 0).toString(36) + s.length; };
async function ensureVecs() {
  if (vecBusy) return vecBusy;
  if (!vecDirty && vecLoaded) return;
  vecBusy = (async () => {
    if (!vecLoaded) { for (const [k, v] of await store.vecAll()) if (String(k).startsWith('org:')) vecs.set(k, v); vecLoaded = true; }
    vecDirty = false;
    const want = new Map();
    C.SEEDS.forEach((s, i) => want.set('org:seed:' + i, { text: s.text, keys: C.lessonKeys(s) }));
    for (const l of store.all('lessons')) if (l.text) want.set('org:' + l.id, { text: l.text, keys: C.lessonKeys(l) });
    for (const k of [...vecs.keys()]) if (!want.has(k)) { vecs.delete(k); store.vecDel(k).catch(() => {}); }
    const todo = [...want].filter(([k, w]) => vecs.get(k)?.hash !== hash(w.text));
    for (const [k, w] of want) { const v = vecs.get(k); if (v && v.hash === hash(w.text)) v.keys = w.keys; }
    for (let i = 0; i < todo.length; i += 8) {
      const part = todo.slice(i, i + 8);
      const out = await embed(part.map(([, w]) => w.text));
      part.forEach(([k, w], j) => { const rec = { hash: hash(w.text), v: out[j] }; store.vecPut(k, rec).catch(() => {}); vecs.set(k, { ...rec, keys: w.keys }); });
    }
  })().finally(() => { vecBusy = null; });
  return vecBusy;
}
async function nearest(text) {
  if (!orgModelOn() || Date.now() < modelDown || text.length < 8) return [];
  try {
    await ensureVecs();
    const [q] = await embed([text.slice(0, 600)]);
    const out = [];
    for (const r of vecs.values()) { if (!r.keys) continue; let s = 0; const v = r.v; for (let i = 0; i < v.length; i++) s += v[i] * q[i]; out.push({ keys: r.keys, sim: s }); }
    return out.sort((a, b) => b.sim - a.sim).slice(0, 8);
  } catch (e) { console.warn('organizer model', e); modelDown = Date.now() + 10 * 60000; return []; }
}

/** Suggestions for a text: instant (rules and learned words), then refined by meaning when that answers. */
export function suggestNow(text, kind) { return C.suggest(getModel(), text, { kind }); }
export async function suggestFull(text, kind) { const near = await nearest(text); return C.suggest(getModel(), text, { kind, near }); }
/** Claude Haiku's suggestion when online and set up (null otherwise: the on-device one stands). */
export const suggestClaude = (text, kind) => sortWithClaude(getModel(), text, kind);

// ---- what an item already carries -------------------------------------------------------------------------------------
/** Read an item's current organization from its labels (task) or tags (note). */
export function readOrg(list, { project = null, notebook = null } = {}) {
  const l = (list || []).map(String);
  return { area: l.find(x => AREA_IDS.includes(x)) || null, tags: l.filter(x => !AREA_IDS.includes(x) && x !== PROMISE), promise: l.includes(PROMISE), project, notebook };
}
export const hasArea = list => (list || []).some(x => AREA_IDS.includes(x));
/** The label/tag list after confirming: other areas and a removed promise come off; everything else stays. */
export function mergeList(list, fin, removed = []) {
  const keep = (list || []).filter(x => !AREA_IDS.includes(x) && x !== PROMISE && !removed.includes(x));
  return [...new Set([...(fin.area ? [fin.area] : []), ...keep, ...fin.tags, ...(fin.promise ? [PROMISE] : [])])];
}
/** Save what was confirmed, so every device learns it. */
export function learn(kind, text, fin, suggested) {
  if (!String(text || '').trim()) return;
  store.put('lessons', C.makeLesson({ kind, text, ...fin, suggested }));
}

// ---- the Suggested row ----------------------------------------------------------------------------------------------
/**
 * opts.kind 'task'|'note'; opts.text(): the words to read; opts.current(): {area,tags,promise,project,notebook} already on
 * the item; opts.apply(fin, removed): file it (omit for Add task, which files on adding); opts.minWords: wait for this many.
 * Returns { el, refresh(now), confirmed(), final(), commit(text), reset() }.
 */
export function orgPanel(opts) {
  const kind = opts.kind;
  const el = h('div', { class: 'org', hidden: true });
  let sug = null, fin = null, touched = false, removed = new Set(), isConfirmed = false, seq = 0, collapsed = false, thinking = false;
  const blank = () => ({ area: null, tags: [], promise: false, project: null, notebook: null });
  const cur = () => opts.current?.() || blank();
  // Start from what the item already carries, add suggestions on top, never bring back what he took off.
  const compose = s => {
    const c = cur(), f = { ...blank(), ...c, tags: [...(c.tags || [])] };
    if (!f.area && s.area) f.area = s.area;
    for (const t of s.tags) if (!removed.has('t:' + t.id) && !f.tags.includes(t.id) && (!f.area || !C.areaOfTag(getModel(), t.id) || C.areaOfTag(getModel(), t.id) === f.area || t.p > 0.85)) f.tags.push(t.id);
    if (!f.promise && s.promise.on && !removed.has(PROMISE)) f.promise = true;
    if (kind === 'task' && !f.project && s.project && !removed.has('p:' + s.project.name)) f.project = s.project.name;
    if (kind === 'note' && !f.notebook && s.notebook && !removed.has('n:' + s.notebook.name)) f.notebook = s.notebook.name;
    if (removed.has('a:' + f.area) && !c.area) f.area = null;
    f.tags = f.tags.slice(0, 6);
    return f;
  };
  const words = () => (opts.text() || '').trim().split(/\s+/).filter(Boolean).length;
  const run = async now => {
    if (!orgOn()) { el.hidden = true; return; }
    if (isConfirmed && !now) return;
    const text = opts.text() || '';
    if (words() < (opts.minWords || 1)) { if (!touched) { sug = null; fin = null; } draw(); return; }
    const my = ++seq;
    sug = suggestNow(text, kind);
    if (!touched) fin = compose(sug);
    draw();
    const full = await suggestFull(text, kind);
    if (my !== seq || isConfirmed) return;
    sug = full;
    if (!touched) fin = compose(full);
    else { const add = compose(full); for (const t of add.tags) if (!fin.tags.includes(t) && !removed.has('t:' + t)) fin.tags.push(t); }
    draw();
    // Online: Claude Haiku has the last word, once he pauses typing. Offline or on any trouble the device's stands.
    if (!aiReady()) return;
    await new Promise(r => setTimeout(r, now ? 0 : 700));
    if (my !== seq || isConfirmed) return;
    thinking = true; draw();
    const ai = await suggestClaude(text, kind);
    thinking = false;
    if (my !== seq || isConfirmed) { draw(); return; }
    if (!ai) { draw(); return; }
    sug = ai;
    if (!touched) fin = compose(ai);
    else { const add = compose(ai); for (const t of add.tags) if (!fin.tags.includes(t) && !removed.has('t:' + t)) fin.tags.push(t); }
    draw();
    opts.onKind?.(ai.kind);
  };
  const later = debounce(() => run(), opts.delay ?? 350);
  const touch = () => { touched = true; isConfirmed = false; draw(); };
  const chip = (label, cls, onclick, onx, title) => h('span', { class: 'ochip ' + cls },
    h('button', { type: 'button', class: 'ochip-main', title: title || '', onpointerdown: e => e.preventDefault(), onclick }, label),
    onx && h('button', { type: 'button', class: 'ochip-x', 'aria-label': 'Take off', onpointerdown: e => e.preventDefault(), onclick: onx }, '×'));
  const pickArea = e => menu(e.currentTarget, [
    ...AREAS.map(a => ({ label: (fin.area === a.id ? '✓ ' : '') + a.name, onclick: () => { if (fin.area && fin.area !== a.id) removed.add('a:' + fin.area); fin.area = a.id; fin.tags = fin.tags.filter(t => { const ta = C.areaOfTag(getModel(), t); return !ta || ta === a.id; }); touch(); } })),
    '-', { label: 'No area', icon: 'x', onclick: () => { if (fin.area) removed.add('a:' + fin.area); fin.area = null; touch(); } },
  ]);
  const addTag = e => {
    const m = getModel(), have = new Set(fin.tags);
    const pool = [...new Set([...(fin.area ? C.DETAILS[fin.area] || [] : []), ...[...m.keys].filter(k => k.startsWith('t:')).map(k => k.slice(2)).filter(t => !fin.area || (C.areaOfTag(m, t) || fin.area) === fin.area)])].filter(t => !have.has(t)).slice(0, 14);
    menu(e.currentTarget, [
      !fin.promise && { label: 'Customer promise', icon: 'flag', onclick: () => { fin.promise = true; removed.delete(PROMISE); touch(); } },
      ...pool.map(t => ({ label: tagName(t), icon: 'tag', onclick: () => { fin.tags.push(t); removed.delete('t:' + t); touch(); } })),
      '-', { label: 'New tag…', icon: 'plus', onclick: async () => { const v = tagSlug(await promptDlg('New tag', '', 'e.g. Sunday School, house project')); if (v && !fin.tags.includes(v)) { fin.tags.push(v); touch(); } } },
    ]);
  };
  const confirm = () => {
    if (!fin) return;
    isConfirmed = true; collapsed = false;
    if (opts.apply) { opts.apply(fin, [...removed].filter(k => k.startsWith('t:')).map(k => k.slice(2))); learn(kind, opts.text(), fin, sugAsFinal()); toast('Organized'); collapsed = true; }
    draw();
  };
  const sugAsFinal = () => sug ? { area: sug.area, tags: sug.tags.map(t => t.id), promise: sug.promise.on, project: sug.project?.name || null, notebook: sug.notebook?.name || null } : null;
  const draw = () => {
    if (!orgOn() || (!fin && !collapsed)) { el.hidden = true; return; }
    el.hidden = false;
    if (collapsed && fin) {
      const parts = [fin.area && areaName(fin.area), ...fin.tags.map(tagName), fin.promise && 'Customer promise'].filter(Boolean);
      fill(el, h('div', { class: 'org-done' }, icon('check', 14), h('span', { class: 'grow' }, parts.length ? parts.join(' · ') : 'Organized'),
        h('button', { type: 'button', class: 'linkbtn', onclick: () => { collapsed = false; isConfirmed = false; touched = false; removed = new Set(); run(true); } }, 'Re-check')));
      return;
    }
    const m = getModel();
    const list = [
      chip(h('span', null, icon('inbox', 12), fin.area ? areaName(fin.area) : 'Pick area'), 'area' + (fin.area ? '' : ' empty'), pickArea, null, 'Change the area'),
      ...fin.tags.map(t => chip(tagName(t), 'tag', null, () => { fin.tags = fin.tags.filter(x => x !== t); removed.add('t:' + t); touch(); })),
      fin.promise && chip(h('span', null, icon('flag', 12), 'Customer promise'), 'promise', null, () => { fin.promise = false; removed.add(PROMISE); touch(); }),
      kind === 'task' && fin.project && chip('→ ' + projectLabel(fin.project), 'proj', null, () => { removed.add('p:' + fin.project); fin.project = null; touch(); }, 'Move to this project'),
      kind === 'note' && fin.notebook && chip('→ ' + notebookLabel(fin.notebook), 'proj', null, () => { removed.add('n:' + fin.notebook); fin.notebook = null; touch(); }, 'Move to this notebook'),
      h('button', { type: 'button', class: 'ochip-add', title: 'Add a tag', 'aria-label': 'Add a tag', onpointerdown: e => e.preventDefault(), onclick: addTag }, icon('plus', 13)),
    ];
    const ok = h('button', { type: 'button', class: 'org-ok' + (isConfirmed ? ' on' : ''), onpointerdown: e => e.preventDefault(), onclick: () => { if (isConfirmed && !opts.apply) { isConfirmed = false; draw(); } else confirm(); } }, icon('check', 14), isConfirmed ? 'Confirmed' : 'Confirm');
    fill(el, h('div', { class: 'org-head' }, h('span', { class: 'org-title' }, isConfirmed ? 'Will be filed as' : 'Suggested'),
        !isConfirmed && (thinking ? h('span', { class: 'sub' }, ' · asking Claude…') : sug?.by === 'claude' ? h('span', { class: 'sub' }, ' · by Claude') : !m.n ? h('span', { class: 'sub' }, ' · learns from what you confirm') : null)),
      h('div', { class: 'org-row' + (isConfirmed ? ' confirmed' : '') }, h('div', { class: 'org-chips' }, list), ok));
  };
  return {
    el,
    refresh(now) { if (now) run(); else later(); },
    confirmed: () => isConfirmed && !!fin,
    final: () => fin,
    /** For Add task: after the task is saved, learn from the confirmed choice. */
    commit(text) { if (isConfirmed && fin) learn(kind, text, fin, sugAsFinal()); },
    reset() { sug = null; fin = null; touched = false; removed = new Set(); isConfirmed = false; collapsed = false; seq++; draw(); },
    /** Show "Organized ✓ …" (with Re-check) instead of suggestions, for items already filed. */
    showDone(f) { fin = f; collapsed = true; isConfirmed = true; draw(); },
    removedTags: () => [...removed].filter(k => k.startsWith('t:')).map(k => k.slice(2)),
  };
}
const projectLabel = lower => store.all('projects').find(p => p.name.toLowerCase() === lower)?.name || lower;
const notebookLabel = lower => store.all('notebooks').find(n => n.name.toLowerCase() === lower)?.name || lower;
export const projectIdByName = lower => store.all('projects').find(p => p.name.toLowerCase() === String(lower || '').toLowerCase())?.id || null;
export const notebookIdByName = lower => store.all('notebooks').find(n => n.name.toLowerCase() === String(lower || '').toLowerCase())?.id || null;

/** Warm up in the background a little after Steward opens, so the first suggestion is quick. */
export function warmUp() { if (orgOn() && orgModelOn()) setTimeout(() => ensureVecs().catch(() => {}), 25000); }

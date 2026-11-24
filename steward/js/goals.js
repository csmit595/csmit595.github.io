// Identities and goals: the screens (#/goals, #/goal/<id>), the Today strip, and the editors.
// The rules (which identity a task belongs to, progress, pace) are in goals-core.js.
import { h, fill, today, fmtDate } from './util.js';
import { store } from './store.js';
import * as M from './model.js';
import * as GC from './goals-core.js';
import { AREAS, tagName } from './organize-core.js';
import { icon, btn, iconBtn, modal, confirmDlg, toast, menu } from './ui.js';
import { openTask, openQuickAdd, taskList } from './tasks.js';
import { focusButton, identityTimeLine } from './focus.js';
import { refChip, identityRef } from './scripture.js';

const go = hash => { location.hash = hash; };
const colorOf = i => M.COLORS[i?.color] || M.COLORS.stone;
const header = (title, sub, ...actions) => h('header', { class: 'vhead' }, h('div', null, h('h1', null, title), sub && h('div', { class: 'sub' }, sub)), h('div', { class: 'row' }, actions));
const PACE = { 'on-track': 'On track', behind: 'Behind the calendar', open: '', done: 'Finished', dropped: 'Set aside' };
const data = () => ({ tasks: store.all('tasks'), sessions: store.all('sessions') });
const started = (g, now = today()) => !g.start || g.start <= now;
export const activeGoals = () => store.all('goals').filter(g => g.status === 'active');
export const idDot = (i, size) => h('span', { class: 'pdot idot', style: { background: colorOf(i), ...(size ? { width: size + 'px', height: size + 'px' } : {}) } });

/** A slim progress bar in the identity's color. */
export function bar(pct, color, label) {
  return h('div', { class: 'gbar', role: 'img', 'aria-label': label || `${Math.round(pct * 100)}%` }, h('span', { style: { width: Math.round(Math.max(0, Math.min(1, pct)) * 100) + '%', background: color } }));
}
/** A goal picker for task details: goals grouped under their identities, in his order. */
export function goalSelect(value, onchange) {
  const sel = h('select', { class: 'field', 'aria-label': 'Goal', onchange: () => onchange(sel.value || null) }, h('option', { value: '' }, 'No goal'));
  for (const i of M.identities()) {
    const gs = GC.sortGoals(store.all('goals').filter(g => g.identityId === i.id && (g.status === 'active' || g.id === value)), i);
    if (gs.length) sel.append(h('optgroup', { label: i.name }, gs.map(g => h('option', { value: g.id }, g.title))));
  }
  sel.value = value && store.get('goals', value) ? value : '';
  return sel;
}

function goalRow(g, i, d, now) {
  const p = GC.goalProgress(g, d), pace = GC.goalPace(g, p, now), nt = g.status === 'active' ? GC.nextTask(g, d.tasks) : null;
  return h('a', { class: 'grow-card gstat-' + g.status, href: '#/goal/' + g.id },
    h('div', { class: 'row between' }, h('b', { class: 'gtitle' }, g.title), PACE[pace] && h('span', { class: 'gpace ' + pace }, PACE[pace])),
    bar(p.pct, colorOf(i), p.label),
    h('div', { class: 'row between gmeta' }, h('span', null, p.label), h('span', null, started(g, now) ? `until ${fmtDate(g.end, true)}` : `starts ${fmtDate(g.start, true)}`)),
    nt && h('div', { class: 'gnext' }, icon('right', 12), h('span', null, 'Next: ', nt.content)));
}

function viewGoals(main) {
  const now = today(), q = GC.quarterRange(now), d = data(), ids = M.identities(), all = store.all('goals');
  const nActive = all.filter(g => g.status === 'active' && started(g, now)).length;
  main.append(header('Goals', `${q.label} · ${nActive} active goal${nActive === 1 ? '' : 's'}`, btn('New identity', () => editIdentity(), 'tiny', 'plus'), btn('New goal', () => editGoal({}), 'primary', 'plus')));
  if (!ids.length) main.append(h('div', { class: 'empty' }, h('strong', null, 'No identities yet'), h('p', null, 'An identity is a role you live in. Goals sit under them.'), btn('Add the starting six', () => { M.ensureIdentities(true); store.emit({ local: true }); }, 'primary')));
  for (const i of ids) {
    const mine = GC.sortGoals(all.filter(g => g.identityId === i.id), i);
    const act = mine.filter(g => g.status === 'active' && started(g, now)), later = mine.filter(g => g.status === 'active' && !started(g, now)), past = mine.filter(g => g.status !== 'active');
    const more = e => { e.preventDefault(); menu(e.currentTarget, [
      { label: 'Add a goal here', icon: 'plus', onclick: () => editGoal({ identityId: i.id }) },
      { label: 'Edit identity', icon: 'edit', onclick: () => editIdentity(i) },
      { label: 'Move up', icon: 'left', onclick: () => moveIdentity(i, -1) }, { label: 'Move down', icon: 'right', onclick: () => moveIdentity(i, 1) },
      '-', { label: 'Delete identity', icon: 'trash', danger: true, onclick: async () => { if (await confirmDlg(`Delete “${i.name}”${mine.length ? ` and its ${mine.length} goal${mine.length === 1 ? '' : 's'}` : ''}? Tasks stay; they are only unlinked.`)) M.deleteIdentity(i.id); } },
    ]); };
    main.append(h('section', { class: 'idcard', style: { '--idc': colorOf(i) } },
      h('div', { class: 'idhead' }, h('span', { class: 'idicon' }, icon(i.icon || 'star', 16)), h('div', { class: 'grow' }, h('h2', null, i.name, refChip(identityRef(i.name))), i.purpose && h('div', { class: 'sub' }, i.purpose)), iconBtn('more', 'Identity options', more, 'mini')),
      identityTimeLine(i),
      act.length ? h('div', { class: 'glist' }, act.map(g => goalRow(g, i, d, now))) : h('p', { class: 'sub gnone' }, 'No goal this quarter. That can be the right answer.'),
      later.length > 0 && h('details', { class: 'gfold' }, h('summary', null, `Coming up (${later.length})`), h('div', { class: 'glist' }, later.map(g => goalRow(g, i, d, now)))),
      past.length > 0 && h('details', { class: 'gfold' }, h('summary', null, `Finished and set aside (${past.length})`), h('div', { class: 'glist' }, past.map(g => goalRow(g, i, d, now)))),
      btn('Add goal', () => editGoal({ identityId: i.id }), 'link', 'plus')));
  }
}
function moveIdentity(i, dir) {
  const ids = M.identities(), at = ids.findIndex(x => x.id === i.id), to = at + dir;
  if (to < 0 || to >= ids.length) return;
  const order = ids.map(x => x.id); order.splice(at, 1); order.splice(to, 0, i.id);
  order.forEach((id, n) => { if (store.get('identities', id).order !== n + 1) store.patch('identities', id, { order: n + 1 }, { silent: true }); });
  store.emit({ local: true });
}

function viewGoal(main, id) {
  const g = store.get('goals', id);
  if (!g) { main.append(header('Goal'), h('div', { class: 'empty' }, h('strong', null, 'Goal not found'), h('p', null, 'It may have been deleted on another device.'), h('a', { class: 'btn', href: '#/goals' }, 'All goals'))); return; }
  const i = store.get('identities', g.identityId), d = data(), now = today();
  const p = GC.goalProgress(g, d), pace = GC.goalPace(g, p, now);
  const set = f => store.patch('goals', id, f);
  const linked = d.tasks.filter(t => t.goalId === id && !t.parentId);
  const first = t => GC.firstRank(t.labels, i);
  const open = linked.filter(t => !t.completedAt).sort((a, b) => first(a) - first(b) || ((a.due?.date || '9999') + (a.due?.time || '99')).localeCompare((b.due?.date || '9999') + (b.due?.time || '99')) || M.byOrder(a, b));
  const done = linked.filter(t => t.completedAt).sort((a, b) => b.completedAt - a.completedAt);
  const nt = GC.nextTask(g, d.tasks);
  main.append(h('a', { class: 'crumb', href: '#/goals' }, icon('back', 14), 'Goals'));
  main.append(header(g.title, h('span', { class: 'row' }, idDot(i), i?.name || 'No identity', ' · ', `${fmtDate(g.start, true)} to ${fmtDate(g.end, true)}`),
    g.status === 'active' && focusButton({ goalId: id }, 'tiny'),
    btn('Edit', () => editGoal(g), 'tiny', 'edit'),
    iconBtn('more', 'Goal options', e => menu(e.currentTarget, [
      g.status !== 'done' && { label: 'Mark finished', icon: 'done', onclick: () => { set({ status: 'done', doneAt: Date.now() }); toast('Goal finished. Thanks be to God.'); } },
      g.status !== 'dropped' && { label: 'Set aside (drop)', icon: 'x', onclick: () => { set({ status: 'dropped', doneAt: null }); toast('Goal set aside. Plans change; that is allowed.'); } },
      g.status !== 'active' && { label: 'Make active again', icon: 'back', onclick: () => set({ status: 'active', doneAt: null }) },
      '-', { label: 'Delete goal', icon: 'trash', danger: true, onclick: async () => { if (await confirmDlg(`Delete “${g.title}”? Its ${linked.length} task${linked.length === 1 ? '' : 's'} stay; they are only unlinked.`)) { M.deleteGoal(id); go('#/goals'); } } },
    ]))));
  main.append(h('section', { class: 'idcard gdetail', style: { '--idc': colorOf(i) } },
    g.why && h('p', { class: 'gwhy' }, g.why),
    h('div', { class: 'row between' }, h('b', { class: 'gbig' }, p.label), PACE[pace] && h('span', { class: 'gpace ' + pace }, PACE[pace])),
    bar(p.pct, colorOf(i), p.label),
    g.kind === 'count' && g.status === 'active' && h('div', { class: 'row gap' }, h('span', { class: 'sub' }, 'Count by hand:'), btn('−1', () => set({ manual: Math.max(0, (g.manual || 0) - 1) }), 'tiny'), btn('+1', () => set({ manual: (g.manual || 0) + 1 }), 'tiny'), h('span', { class: 'sub' }, `${g.manual || 0} by hand + ${p.doneTasks} finished task${p.doneTasks === 1 ? '' : 's'}`)),
    g.kind === 'hours' && h('p', { class: 'sub' }, 'Counts focus sessions started for this goal or for one of its tasks.'),
    pace === 'behind' && h('p', { class: 'sub' }, 'Behind the calendar is information, not a verdict. Move the end date, make it smaller, or set it aside.')));
  if (nt) main.append(h('section', { class: 'group' }, h('div', { class: 'ghead' }, h('h3', null, 'Next task')), taskList([nt], { showProject: true, flat: true })));
  main.append(h('section', { class: 'group' }, h('div', { class: 'ghead' }, h('h3', null, `Tasks (${open.length} open)`), open.length > 1 && h('span', { class: 'sub' }, 'Pick what comes next from a task’s ⋯ menu')),
    open.length ? taskList(open, { showProject: true, flat: true }) : h('p', { class: 'sub gnone' }, 'No open tasks under this goal.'),
    g.status === 'active' && h('button', { class: 'addrow', onclick: () => openQuickAdd({ goalId: id }) }, icon('plus', 16), 'Add a task to this goal')));
  if (done.length) main.append(h('details', { class: 'gfold' }, h('summary', null, `Finished (${done.length})`), taskList(done.slice(0, 50), { showProject: true, flat: true, showDone: true })));
}

export function renderGoals(route, main) {
  main.classList.add('goals-view');
  if (route.view === 'goal') viewGoal(main, route.id); else viewGoals(main);
}

// ---- Today: "This quarter" ---------------------------------------------------------------------------------------
/** A slim strip for Today: each active goal with its progress and next task. Folds away (remembered on this device). */
export function goalStrip() {
  const now = today(), d = data(), ids = M.identities();
  const rows = [];
  for (const i of ids) for (const g of GC.sortGoals(store.all('goals').filter(x => x.identityId === i.id && x.status === 'active' && started(x, now)), i)) rows.push([g, i]);
  if (!rows.length) return null;
  let open; try { open = localStorage.getItem('steward.quarterOpen'); } catch {}
  open = open == null ? !window.matchMedia('(max-width: 560px)').matches : open === '1';
  return h('details', { class: 'qstrip', open, ontoggle: e => { try { localStorage.setItem('steward.quarterOpen', e.currentTarget.open ? '1' : '0'); } catch {} } },
    h('summary', null, icon('down', 14), 'This quarter', h('span', { class: 'count' }, rows.length), h('span', { class: 'grow' }), h('a', { class: 'sub', href: '#/goals', onclick: e => e.stopPropagation() }, 'All goals')),
    h('div', { class: 'qrows' }, rows.map(([g, i]) => {
      const p = GC.goalProgress(g, d), nt = GC.nextTask(g, d.tasks);
      return h('div', { class: 'qrow' }, idDot(i), h('a', { class: 'qtitle', href: '#/goal/' + g.id, title: i.name }, g.title), bar(p.pct, colorOf(i), p.label), h('span', { class: 'qlabel' }, p.label),
        nt ? h('button', { type: 'button', class: 'qnext', title: 'Open the next task', onclick: () => openTask(nt.id) }, icon('right', 12), h('span', null, nt.content)) : h('span', { class: 'qnext none' }, 'no next task'));
    })));
}

// ---- editors -----------------------------------------------------------------------------------------------------
export function editGoal(g = {}) {
  const isNew = !g.id, ids = M.identities(), now = today();
  if (!ids.length) { toast('Add an identity first'); return; }
  modal(close => {
    const q = GC.quarterRange(now);
    const title = h('input', { class: 'field', value: g.title || '', placeholder: 'e.g. An A in SCH 601', autofocus: true });
    const why = h('textarea', { class: 'field', rows: 2, placeholder: 'Why this matters (a line, or a verse)', value: g.why || '' });
    const idSel = h('select', { class: 'field' }, ids.map(i => h('option', { value: i.id }, i.name))); idSel.value = g.identityId || ids[0].id;
    const start = h('input', { type: 'date', class: 'field slim', value: g.start || q.start }), end = h('input', { type: 'date', class: 'field slim', value: g.end || q.end });
    let kind = g.kind || 'milestones';
    const target = h('input', { type: 'number', class: 'field slim', min: 0, step: 1, value: g.target ?? '', placeholder: '12' });
    const unit = h('input', { class: 'field slim', value: g.unit || '', placeholder: 'sermons' });
    const kindRow = h('div', { class: 'seg' }, Object.entries(GC.KINDS).map(([k, label]) => h('button', { type: 'button', class: k === kind ? 'on' : '', onclick: e => { kind = k; kindRow.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === e.currentTarget)); drawKind(); } }, label)));
    const kindBox = h('div', null);
    const drawKind = () => fill(kindBox, kind === 'milestones' ? h('p', { class: 'sub' }, 'Progress is the share of this goal’s tasks that are done.')
      : kind === 'count' ? h('div', { class: 'row gap wrap' }, h('label', null, 'Reach', target), h('label', null, 'of', unit), h('span', { class: 'sub' }, 'Finished tasks count, and you can add by hand.'))
        : h('div', { class: 'row gap wrap' }, h('label', null, 'Hours', target), h('span', { class: 'sub' }, 'Counted from focus sessions.')));
    drawKind();
    // "comes first" tags of the identity (his wife and child above the rest of the family)
    let tags = [...(g.tags || [])];
    const tagBox = h('div', null);
    const drawTags = () => { const i = store.get('identities', idSel.value), first = i?.firstTags || []; fill(tagBox, first.length > 0 && h('label', null, 'This goal is for', h('div', { class: 'row wrap seg-chips' }, first.map(t => h('button', { type: 'button', class: 'schip' + (tags.includes(t) ? ' on' : ''), onclick: e => { tags = tags.includes(t) ? tags.filter(x => x !== t) : [...tags, t]; e.currentTarget.classList.toggle('on'); } }, tagName(t)))))); };
    idSel.addEventListener('change', drawTags); drawTags();
    const count = store.all('goals').filter(x => x.status === 'active' && (!x.start || x.start <= now) && x.id !== g.id).length;
    const nq = GC.nextQuarter(now);
    const soft = isNew && count >= GC.SOFT_LIMIT && h('div', { class: 'banner soft' }, `You have ${count} active goals. Three or four a quarter is plenty. Is this one for now or later? `,
      btn(`Later (${nq.label})`, () => { start.value = nq.start; end.value = nq.end; toast(`Dates set to ${nq.label}`); }, 'tiny'));
    const save = () => {
      if (!title.value.trim()) return toast('Give the goal a name');
      if (end.value && start.value && end.value < start.value) return toast('The goal has to end after it starts.');
      const f = { title: title.value.trim(), why: why.value.trim(), identityId: idSel.value, start: start.value || q.start, end: end.value || q.end, kind, target: kind === 'milestones' ? null : Math.max(0, Number(target.value) || 0), unit: kind === 'count' ? unit.value.trim() : '', tags };
      const saved = isNew ? M.addGoal(f) : store.put('goals', { ...store.get('goals', g.id), ...f });
      close(); if (isNew) go('#/goal/' + saved.id);
    };
    return h('div', { class: 'form' }, soft, h('label', null, 'Goal', title), h('label', null, 'Identity', idSel), tagBox, h('label', null, 'Why', why),
      h('div', { class: 'row gap wrap' }, h('label', null, 'From', start), h('label', null, 'To', end)),
      h('label', null, 'How progress is counted', kindRow), kindBox,
      h('div', { class: 'row end' }, btn('Cancel', close), btn(isNew ? 'Add goal' : 'Save', save, 'primary')));
  }, { title: isNew ? 'New goal' : 'Edit goal' });
}

const ICONS = ['star', 'pin', 'spark', 'flag', 'book', 'comment', 'note', 'bell', 'clock', 'tag', 'check', 'today'];
export function editIdentity(i = {}) {
  const isNew = !i.id;
  modal(close => {
    const name = h('input', { class: 'field', value: i.name || '', placeholder: 'e.g. Family', autofocus: true });
    const purpose = h('input', { class: 'field', value: i.purpose || '', placeholder: 'One line: a purpose, or a verse' });
    let color = i.color || 'stone', ic = i.icon || 'star', areas = [...(i.areas || [])];
    const colors = h('div', { class: 'row wrap swatches' }, Object.entries(M.COLORS).map(([k, v]) => h('button', { type: 'button', class: 'swatch' + (k === color ? ' on' : ''), title: k, 'aria-label': k, style: { background: v }, onclick: e => { color = k; colors.querySelectorAll('.swatch').forEach(b => b.classList.toggle('on', b === e.currentTarget)); } })));
    const icons = h('div', { class: 'row wrap seg-chips' }, ICONS.map(k => h('button', { type: 'button', class: 'schip icn' + (k === ic ? ' on' : ''), 'aria-label': k, onclick: e => { ic = k; icons.querySelectorAll('.schip').forEach(b => b.classList.toggle('on', b === e.currentTarget)); } }, icon(k, 15))));
    const areaRow = h('div', { class: 'row wrap seg-chips' }, AREAS.map(a => h('button', { type: 'button', class: 'schip' + (areas.includes(a.id) ? ' on' : ''), onclick: e => { areas = areas.includes(a.id) ? areas.filter(x => x !== a.id) : [...areas, a.id]; e.currentTarget.classList.toggle('on'); } }, a.name)));
    const list = v => String(v || '').split(/[,\s]+/).map(x => x.trim().replace(/^[@#]/, '').toLowerCase()).filter(Boolean);
    const labels = h('input', { class: 'field', value: (i.labels || []).join(', '), placeholder: 'e.g. devotions, prayer (leave empty to take the whole area)' });
    const first = h('input', { class: 'field', value: (i.firstTags || []).join(', '), placeholder: 'tags that sort first, most important first' });
    const hours = h('input', { type: 'number', class: 'field slim', min: 0, step: 0.5, value: i.weeklyTargetMin ? i.weeklyTargetMin / 60 : '', placeholder: 'none' });
    const timed = h('input', { type: 'checkbox', checked: !!i.timed });
    const projects = store.all('projects').sort((a, b) => a.name.localeCompare(b.name));
    let projectIds = [...(i.projectIds || [])];
    const projRow = projects.length > 0 && h('div', { class: 'row wrap seg-chips' }, projects.map(p => h('button', { type: 'button', class: 'schip' + (projectIds.includes(p.id) ? ' on' : ''), onclick: e => { projectIds = projectIds.includes(p.id) ? projectIds.filter(x => x !== p.id) : [...projectIds, p.id]; e.currentTarget.classList.toggle('on'); } }, p.name)));
    const save = () => {
      if (!name.value.trim()) return toast('Give the identity a name');
      const f = { name: name.value.trim(), purpose: purpose.value.trim(), color, icon: ic, areas, labels: list(labels.value), firstTags: list(first.value), projectIds, weeklyTargetMin: Math.round((Number(hours.value) || 0) * 60) || null, timed: timed.checked };
      store.put('identities', isNew ? { order: Date.now(), ...f } : { ...store.get('identities', i.id), ...f });
      close();
    };
    return h('div', { class: 'form' }, h('label', null, 'Name', name), h('label', null, 'Purpose', purpose), h('label', null, 'Color', colors), h('label', null, 'Icon', icons),
      h('label', null, 'Organizer areas', areaRow), h('label', null, 'Only tasks with these tags', labels), projRow && h('label', null, 'Projects that belong here', projRow), h('label', null, 'Comes first inside this identity', first),
      h('div', { class: 'row gap wrap' }, h('label', null, 'Weekly target (hours)', hours), h('label', { class: 'check-line' }, timed, ' Counted with a start/stop timer, Monday to Saturday')),
      h('p', { class: 'sub' }, 'A task finds its identity by itself: its goal first, then its project, then its tags, then its area.'),
      h('div', { class: 'row end' }, btn('Cancel', close), btn(isNew ? 'Add identity' : 'Save', save, 'primary')));
  }, { title: isNew ? 'New identity' : 'Edit identity' });
}

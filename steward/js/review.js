// The weekly review (#/review): about 15 minutes, one step per screen. It ends by showing that next week's necessary
// work fits, so the rest can be left alone: "Take therefore no thought for the morrow" (Matt. 6:34).
import { h, fill, today, fromYmd, fmtDate, fmtTime, esc, addDays } from './util.js';
import { store, settings } from './store.js';
import * as M from './model.js';
import * as ST from './stats-core.js';
import * as GC from './goals-core.js';
import { parseDue } from './dates.js';
import { planFor, planLine, hm } from './dayplan.js';
import { aiReady, askFull } from './ai.js';
import { icon, btn, confirmDlg, toast } from './ui.js';
import { openTask, scheduleMenu } from './tasks.js';
import { editGoal } from './goals.js';
import { statsFor, statsCards } from './stats.js';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'], ABBR = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
export const REVIEW_TASK = 'weekly-review';
const toMin = s => { const [a, b] = s.split(':').map(Number); return a * 60 + b; };
const dayOfMs = ms => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
/** A weekday's fixed blocks, as minute ranges (every-other-week blocks count: the review must be clear every week). */
const blocksOfDow = d => store.all('blocks').filter(b => !b.paused && (b.days || []).includes(d)).map(b => ({ name: b.name, start: toMin(b.start), end: toMin(b.end) }));
export const reviewAt = () => settings.get('reviewAt') || { day: 5, time: '16:00' };
export const reviewProblem = (day, time) => ST.reviewSlotProblem({ day, time, restDay: settings.get('restDay'), blocks: blocksOfDow(day) });

/** The repeating "Weekly review" task. Made once (a task he deleted stays deleted), and moved when the time changes. */
export function ensureReviewTask(again = false) {
  const raw = store.rawGet('tasks', REVIEW_TASK);
  if (again) { M.unmarkSeedGone([REVIEW_TASK]); if (raw?.deleted) store.purge('tasks', REVIEW_TASK); }
  else { if (raw?.deleted) M.markSeedGone(REVIEW_TASK); if (raw || M.seedGone(REVIEW_TASK)) return; }
  if (store.get('tasks', REVIEW_TASK)) return;
  let { day, time } = reviewAt();
  if (reviewProblem(day, time)) time = ST.freeReviewSlot({ day, time, restDay: settings.get('restDay'), blocks: blocksOfDow(day) });
  const due = parseDue(`every ${ABBR[day]} ${time}`)?.due;
  if (!due) return;
  const f = { id: REVIEW_TASK, content: 'Weekly review', description: 'Steward → Menu → Weekly review. About 15 minutes: look back, give thanks, deal with what slipped, check the quiet priorities, and see that next week fits.', due, duration: 15, priority: 2, labels: ['personal'] };
  if (again) { M.addTask(f, { silent: true }); return; } // asked for again: made now, so it wins over the record of its delete
  // Made by Steward itself, so it carries the oldest possible edit time (like the starting identities): a device set up
  // later never overwrites the review time, repeats or history already synced from the others.
  M.ensureLabels(f.labels);
  store.put('tasks', { ...f, projectId: 'inbox', sectionId: null, parentId: null, deadline: null, reminders: [], noteId: null, goalId: null, order: 1, completedAt: null, createdAt: 1, updatedAt: 1 }, { silent: true, keepTimes: true, noHistory: true });
}
/** Change when the review happens. Returns '' or what is in the way. */
export function setReviewTime(day, time) {
  const why = reviewProblem(day, time);
  if (why) return why;
  settings.set('reviewAt', { day, time });
  const due = parseDue(`every ${ABBR[day]} ${time}`)?.due, t = store.get('tasks', REVIEW_TASK);
  if (due && t) store.patch('tasks', REVIEW_TASK, { due, remindedFor: null }); else if (due && !store.rawGet('tasks', REVIEW_TASK) && !M.seedGone(REVIEW_TASK)) ensureReviewTask();
  return '';
}
/** Settings → Weekly review. */
export function reviewSettings(again) {
  const at = reviewAt();
  const daySel = h('select', { class: 'field slim', 'aria-label': 'Day' }, [1, 2, 3, 4, 5, 6].filter(d => d !== settings.get('restDay')).map(d => h('option', { value: d }, DAYS[d]))); daySel.value = at.day;
  const time = h('input', { type: 'time', class: 'field slim', value: at.time, 'aria-label': 'Time' });
  const msg = h('p', { class: 'sub' }, `Now: ${DAYS[at.day]}s at ${fmtTime(at.time)}. A repeating task “Weekly review” reminds you.`);
  const save = () => { const why = setReviewTime(+daySel.value, time.value); if (why) { msg.textContent = why; msg.classList.add('warnline'); return; } toast('Weekly review time saved'); again(); };
  return h('div', null, h('p', { class: 'sub' }, 'About 15 minutes, once a week. It never lands on Sunday, on Saturday family time or on a fixed block.'), h('div', { class: 'row gap wrap' }, daySel, time, btn('Save', save, 'tiny primary'), h('a', { class: 'btn tiny', href: '#/review' }, 'Open the review')), msg,
    !store.get('tasks', REVIEW_TASK) && btn('Add the “Weekly review” task again', () => { ensureReviewTask(true); store.emit({ local: true }); again(); }, 'link'));
}

// ---- the review itself -------------------------------------------------------------------------------------------
const QUIET = [['god', 'Time with God'], ['wife', 'Present with my wife'], ['rest', 'Sunday rest'], ['study', 'Seminary'], ['health', 'Health']];
const STEPS = ['Look back', 'Thanks and wins', 'What slipped', 'Quiet priorities', 'Goals', 'Next week', 'Reflect', 'Close'];
let draft = null;
const draftKey = 'steward.reviewDraft';
function loadDraft(weekOf) {
  try { const d = JSON.parse(localStorage.getItem(draftKey)); if (d && d.weekOf === weekOf) return d; } catch {}
  return { weekOf, step: 0, thanks: '', wins: '', quiet: {}, goals: {}, top3: ['', '', ''], claude: '', quarter: {} };
}
const keep = () => { try { localStorage.setItem(draftKey, JSON.stringify(draft)); } catch {} };
const area = (value, placeholder, oninput) => { const t = h('textarea', { class: 'field', rows: 3, placeholder, value: value || '' }); t.addEventListener('input', () => { oninput(t.value); keep(); }); return t; };
/** Append children the way h() does: lists are flattened, false and null are skipped. */
const put = (el, ...kids) => { const f = h('div', null, kids); el.append(...f.childNodes); };
const promisedBy = t => t.deadline || t.due?.date || null;

export function renderReview(route, main) {
  main.classList.add('review-view');
  const now = today(), week = ST.weekOf(now), next = ST.weekOf(addDays(week[6], 1));
  if (!draft || draft.weekOf !== week[0]) draft = loadDraft(week[0]);
  const quarterStep = GC.quarterEnding(now);
  const steps = quarterStep ? [...STEPS.slice(0, 5), 'This quarter', ...STEPS.slice(5)] : STEPS;
  draft.step = Math.max(0, Math.min(steps.length - 1, draft.step || 0));
  const name = steps[draft.step];
  // Look back from the last review (so Friday evening, Saturday and Sunday are counted), not only this Monday on.
  const done = store.all('reviews').find(r => r.weekOf === week[0]);
  const prev = store.all('reviews').filter(r => r.weekOf < week[0] && r.finishedAt).sort((a, b) => b.finishedAt - a.finishedAt)[0];
  const look = ST.reviewDays(now, prev ? dayOfMs(prev.finishedAt) : null);
  const lookLabel = `${fmtDate(look[0], true)} to ${fmtDate(look[look.length - 1], true).toLowerCase()}`;
  const st = statsFor(look, now, { targetWeeks: 1 });
  const goTo = n => { draft.step = n; keep(); store.emit({}); main.scrollTop = 0; };
  const body = h('div', { class: 'rv-body' });

  if (name === 'Look back') {
    put(body, h('p', { class: 'rv-lead' }, prev && look.length !== 7 ? `Since your last review, in plain words (${lookLabel}):` : `The last seven days in plain words (${lookLabel}):`), h('ul', { class: 'rv-lines' }, ST.plainSummary(st).map(l => h('li', null, l))), h('details', { class: 'gfold' }, h('summary', null, 'See the numbers'), h('div', { class: 'stgrid' }, statsCards(st, { week: true, now, label: 'since ' + fmtDate(look[0], true) }))));
  } else if (name === 'Thanks and wins') {
    put(body, h('label', { class: 'rv-q' }, 'What has God provided this week?', area(draft.thanks, 'Work, a kindness, an answered prayer, strength for a hard day…', v => { draft.thanks = v; })),
      h('label', { class: 'rv-q' }, 'What went well?', area(draft.wins, 'A job done right, a promise kept, an evening at home…', v => { draft.wins = v; })));
  } else if (name === 'What slipped') {
    const open = M.openTasks().filter(t => !t.parentId);
    const overdue = open.filter(t => t.due && t.due.date < now && t.id !== REVIEW_TASK).sort((a, b) => a.due.date.localeCompare(b.due.date));
    const risk = open.filter(t => (t.labels || []).includes('promise') && promisedBy(t) && promisedBy(t) >= now && promisedBy(t) <= addDays(now, 3) && !overdue.includes(t));
    const row = (t, late) => h('div', { class: 'rv-slip' }, h('button', { type: 'button', class: 'rv-slip-name', onclick: () => openTask(t.id) }, h('b', null, t.content), h('small', null, [(t.labels || []).includes('promise') ? 'Customer promise' : null, late ? `was due ${fmtDate(t.due.date, true)}` : `promised for ${fmtDate(promisedBy(t), true)}`, M.projectName(t.projectId)].filter(Boolean).join(' · '))),
      h('div', { class: 'row wrap' }, btn('Reschedule', e => scheduleMenu(e.currentTarget, t), 'tiny', 'upcoming'),
        btn('Tell the customer early', () => { M.addTask({ content: `Tell the customer early: ${t.content}`, projectId: t.projectId, labels: ['promise'], priority: 1, due: { date: now, time: null, recur: null }, description: `About “${t.content}”${promisedBy(t) ? `, promised for ${promisedBy(t)}` : ''}. Give the new date before they have to ask.` }); toast('Added to today: tell the customer early'); }, 'tiny', 'comment'),
        btn('Drop', async () => { if (await confirmDlg(`Drop “${t.content}”? It can be brought back for 90 days.`, 'Drop')) M.deleteTask(t.id); }, 'tiny')));
    put(body, h('p', { class: 'rv-lead' }, overdue.length + risk.length ? 'Give each of these a new day, a word to the customer, or let it go.' : 'Nothing is overdue and no promise is at risk.'),
      overdue.length > 0 && h('h4', null, `Overdue (${overdue.length})`), overdue.slice(0, 40).map(t => row(t, true)),
      risk.length > 0 && h('h4', null, `Promises due in the next three days (${risk.length})`), risk.map(t => row(t, false)));
  } else if (name === 'Quiet priorities') {
    const q = st.quiet;
    const hint = { god: `${q.devotionDays} of ${q.devotionOf} days · ${GC.fmtHours(q.worshipMin)}`, wife: `${GC.fmtHours(q.familyMin)} of family time · ${q.familyBlocksKept} of ${q.familyBlocks} evenings kept`, rest: q.restDays ? (q.restKept === q.restDays ? 'kept' : 'work was done') : 'no Sunday in these days', study: GC.fmtHours(q.studyMin), health: GC.fmtHours(q.healthMin) };
    put(body, h('p', { class: 'rv-lead' }, 'These do not shout. An honest yes, partly or no for each.'), QUIET.map(([k, label]) => {
      const cur = draft.quiet[k] || (draft.quiet[k] = { v: '', note: '' });
      const seg = h('div', { class: 'seg' }, [['yes', 'Yes'], ['partly', 'Partly'], ['no', 'No']].map(([v, l]) => h('button', { type: 'button', class: cur.v === v ? 'on' : '', onclick: e => { cur.v = v; keep(); seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === e.currentTarget)); } }, l)));
      const note = h('input', { class: 'field', placeholder: 'A note (optional)', value: cur.note || '' }); note.addEventListener('input', () => { cur.note = note.value; keep(); });
      return h('div', { class: 'rv-quiet' }, h('div', { class: 'row between wrap' }, h('span', null, h('b', null, label), h('small', null, ' ' + hint[k])), seg), note);
    }));
  } else if (name === 'Goals') {
    const tasks = store.all('tasks'), d = { tasks, sessions: store.all('sessions') };
    const list = M.identities().flatMap(i => GC.sortGoals(store.all('goals').filter(g => g.identityId === i.id && g.status === 'active' && (!g.start || g.start <= now)), i).map(g => [g, i]));
    put(body, h('p', { class: 'rv-lead' }, list.length ? 'For each goal: where it stands, and the one task that comes next.' : 'No active goals this quarter.'), list.map(([g, i]) => {
      const p = GC.goalProgress(g, d), pace = GC.goalPace(g, p, now), cur = draft.goals[g.id] || (draft.goals[g.id] = { v: pace === 'behind' ? 'behind' : 'on-track' });
      const seg = h('div', { class: 'seg' }, [['on-track', 'On track'], ['behind', 'Behind'], ['change', 'Change'], ['drop', 'Drop']].map(([v, l]) => h('button', { type: 'button', class: cur.v === v ? 'on' : '', onclick: e => { cur.v = v; keep(); seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === e.currentTarget)); if (v === 'change') editGoal(g); } }, l)));
      const open = tasks.filter(t => t.goalId === g.id && !t.completedAt);
      const nextSel = h('select', { class: 'field', 'aria-label': 'Next task', onchange: () => store.patch('goals', g.id, { nextTaskId: nextSel.value || null }, { silent: true }) }, h('option', { value: '' }, open.length ? 'Soonest task' : 'No open tasks yet'), open.map(t => h('option', { value: t.id }, t.content.slice(0, 70))));
      nextSel.value = g.nextTaskId && open.some(t => t.id === g.nextTaskId) ? g.nextTaskId : '';
      return h('div', { class: 'rv-goal', style: { '--idc': M.COLORS[i.color] || M.COLORS.stone } }, h('div', { class: 'row between wrap' }, h('span', null, h('b', null, g.title), h('small', null, ` ${i.name} · ${p.label}`)), seg), h('label', null, 'Next task', nextSel), cur.v === 'drop' && h('p', { class: 'sub' }, 'It will be set aside when you finish the review. Plans change; that is allowed.'));
    }));
  } else if (name === 'This quarter') {
    const q = GC.quarterRange(now), nq = GC.nextQuarter(now);
    const list = store.all('goals').filter(g => g.status === 'active' && g.end <= q.end);
    put(body, h('p', { class: 'rv-lead' }, `${q.label} is ending. Close each goal, carry it into ${nq.label}, or let it go.`), list.map(g => {
      const cur = draft.quarter[g.id] || (draft.quarter[g.id] = { v: '' });
      const seg = h('div', { class: 'seg' }, [['done', 'Finished'], ['carry', `Carry into ${nq.label}`], ['drop', 'Drop']].map(([v, l]) => h('button', { type: 'button', class: cur.v === v ? 'on' : '', onclick: e => { cur.v = v; keep(); seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === e.currentTarget)); } }, l)));
      return h('div', { class: 'rv-goal' }, h('div', { class: 'row between wrap' }, h('b', null, g.title), seg));
    }), !list.length && h('p', { class: 'sub' }, 'No goals end this quarter.'), btn(`Set a goal for ${nq.label}`, () => editGoal({ start: nq.start, end: nq.end }), '', 'plus'));
  } else if (name === 'Next week') {
    const goals = store.all('goals').filter(g => g.status === 'active'), tasks = M.openTasks().filter(t => !t.parentId && t.due && t.due.date >= next[0] && t.due.date <= next[6]);
    const picks = [0, 1, 2].map(n => { const inp = h('input', { class: 'field', list: 'rv-picks', placeholder: `Priority ${n + 1}`, value: draft.top3[n] || '' }); inp.addEventListener('input', () => { draft.top3[n] = inp.value; keep(); }); return inp; });
    put(body, h('p', { class: 'rv-lead' }, 'The three things that matter most next week. Pick a goal or a task, or write your own.'), picks,
      h('datalist', { id: 'rv-picks' }, goals.map(g => h('option', { value: 'Goal: ' + g.title })), tasks.slice(0, 60).map(t => h('option', { value: t.content }))),
      h('h4', null, `Does next week fit? (${fmtDate(next[0], true)} to ${fmtDate(next[6], true)})`),
      h('div', { class: 'rv-week' }, next.map(d => { const p = planFor(d); return h('div', { class: 'rv-day ' + p.state }, h('b', null, DAYS[fromYmd(d).getDay()].slice(0, 3)), h('span', { class: 'grow' }, planLine(d) || h('span', { class: 'plan-line' }, p.state === 'rest' ? 'Rest day' : 'Nothing planned yet')), p.state === 'over' && h('a', { class: 'btn tiny', href: '#/upcoming' }, 'Move work')); })),
      next.some(d => planFor(d).state === 'over') && h('p', { class: 'sub' }, 'A day that is over will not get shorter by Friday. Move something now, or tell the customer early.'));
  } else if (name === 'Reflect') {
    const out = h('div', { class: 'rv-claude' }, draft.claude ? h('div', { html: esc(draft.claude).replace(/\n/g, '<br>') }) : null);
    const ask = async () => {
      fill(out, h('p', { class: 'sub' }, icon('spark', 14), ' Claude is reading the week…'));
      const loads = next.map(d => { const p = planFor(d); return `${DAYS[fromYmd(d).getDay()]}: ${p.state === 'rest' ? 'rest day' : p.state === 'over' ? `over by ${hm(-p.margin)} (${hm(p.planned)} planned, ${hm(p.open)} open)` : p.state === 'fits' ? `fits, ${hm(p.margin)} to spare` : 'nothing planned'}`; });
      const said = QUIET.map(([k, l]) => `${l}: ${draft.quiet[k]?.v || 'not answered'}${draft.quiet[k]?.note ? ' (' + draft.quiet[k].note + ')' : ''}`);
      const content = ['THIS WEEK', ...ST.plainSummary(st), '', 'HIS OWN ANSWERS', `God provided: ${draft.thanks || '-'}`, `Went well: ${draft.wins || '-'}`, ...said, '', 'NEXT WEEK', ...loads, `Top three: ${draft.top3.filter(Boolean).join('; ') || '-'}`].join('\n');
      try {
        const r = await askFull('sonnet', { system: REFLECT_SYSTEM, max_tokens: 700, messages: [{ role: 'user', content }] });
        draft.claude = r.text.trim(); keep();
        if (out.isConnected) fill(out, h('div', { html: esc(draft.claude).replace(/\n/g, '<br>') }));
      } catch (e) { if (out.isConnected) fill(out, h('p', { class: 'sub' }, e.message || String(e))); }
    };
    put(body, h('p', { class: 'rv-lead' }, 'Optional. Claude reads this week and next week’s load, reasons from Proverbs and Matthew 5–7, and points out anything crowding out the quiet priorities. Nothing in Steward changes.'),
      aiReady() ? btn(draft.claude ? 'Ask again' : 'Reflect with Claude', ask, 'primary', 'spark') : h('p', { class: 'sub' }, navigator.onLine ? 'Claude is not switched on (Settings → Claude). You can skip this step.' : 'No signal: this step needs a connection. You can skip it.'), out);
  } else if (name === 'Close') {
    const plans = next.map(d => [d, planFor(d)]), work = plans.filter(([, p]) => p.state !== 'rest');
    const planned = work.reduce((n, [, p]) => n + p.planned, 0), open = work.reduce((n, [, p]) => n + p.open, 0), over = work.filter(([, p]) => p.state === 'over'), unest = work.reduce((n, [, p]) => n + p.unestimated, 0);
    put(body, over.length ? h('div', { class: 'rv-close over' }, h('b', null, `Next week does not fit yet: ${over.length} day${over.length === 1 ? ' is' : 's are'} over.`), h('ul', null, over.map(([d, p]) => h('li', null, `${DAYS[fromYmd(d).getDay()]}: over by ${hm(-p.margin)}`))), h('a', { class: 'btn', href: '#/upcoming' }, 'Move work in Upcoming'))
      : h('div', { class: 'rv-close' }, h('b', null, planned ? `Next week’s necessary work fits: ${hm(planned)} planned in ${hm(open)} open.` : 'Nothing is planned for next week yet.'), h('p', null, planned ? 'The work has edges. The rest of the week belongs to God, your family and rest.' : 'Plan the first day or two, then leave the rest.')),
    unest > 0 && h('p', { class: 'sub' }, `${unest} task${unest === 1 ? ' has' : 's have'} no time estimate and ${unest === 1 ? 'is' : 'are'} not counted.`),
    h('p', { class: 'verse' }, '“Take therefore no thought for the morrow: for the morrow shall take thought for the things of itself.” ', h('span', null, 'Matthew 6:34')),
    done && h('p', { class: 'sub' }, `This week’s review was saved ${new Date(done.finishedAt).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}. Finishing again updates it.`));
  }

  const last = draft.step === steps.length - 1;
  put(main, h('header', { class: 'vhead' }, h('div', null, h('h1', null, 'Weekly review'), h('div', { class: 'sub' }, `Week of ${fmtDate(week[0], true)} · step ${draft.step + 1} of ${steps.length}`)), h('a', { class: 'btn tiny', href: '#/stats' }, 'Stats')),
    h('div', { class: 'rv-dots', role: 'tablist' }, steps.map((s, n) => h('button', { type: 'button', class: 'rv-dot' + (n === draft.step ? ' on' : n < draft.step ? ' past' : ''), title: s, 'aria-label': `Step ${n + 1}: ${s}`, onclick: () => goTo(n) }))),
    h('section', { class: 'card rv-card' }, h('h2', null, name), body),
    h('div', { class: 'row between rv-nav' }, draft.step > 0 ? btn('Back', () => goTo(draft.step - 1), '', 'back') : h('span'),
      last ? btn('Finish the review', () => finish(week, st, steps), 'primary', 'check') : btn(name === 'Reflect' ? (draft.claude ? 'Next' : 'Skip') : 'Next', () => goTo(draft.step + 1), 'primary')));
}
const REFLECT_SYSTEM = `You are helping Charles with his weekly review in Steward, his own planning app. He is a follower of Christ first, a husband (his first child is due soon), a seminary student, and he runs a small landscaping company to support that calling. His priorities in order: God, his wife and family, health, work, seminary and church, friends. He wants Sundays off work and family time protected.
Reason from Scripture first, reading it in its plain grammatical and historical sense, and draw chiefly on Proverbs and Matthew 5-7 (the Sermon on the Mount). Quote the KJV exactly with the reference, and only verses you are certain of. Be truthful and kind; do not flatter and do not scold. Do not invent facts beyond what he gives you.
Write no more than 180 words, in plain sentences, no headings, no lists: (1) one thing to give thanks for, (2) the clearest place where work or worry is crowding out God, his wife, Sunday rest, seminary or health, if the week shows one, with one verse, and (3) one concrete change for next week, especially any day that is over its hours (move it, or tell the customer early). If the week was sound, say so plainly. You cannot change anything in Steward; he decides.`;

function finish(week, st, steps) {
  const now = today(), q = GC.quarterRange(now), nq = GC.nextQuarter(now);
  // goal decisions made during the review take effect now
  for (const [id, c] of Object.entries(draft.goals)) if (c.v === 'drop' && store.get('goals', id)?.status === 'active') store.patch('goals', id, { status: 'dropped', doneAt: null }, { silent: true });
  if (steps.includes('This quarter')) for (const [id, c] of Object.entries(draft.quarter)) {
    const g = store.get('goals', id); if (!g || g.status !== 'active') continue;
    if (c.v === 'done') store.patch('goals', id, { status: 'done', doneAt: Date.now() }, { silent: true });
    else if (c.v === 'drop') store.patch('goals', id, { status: 'dropped' }, { silent: true });
    else if (c.v === 'carry') store.patch('goals', id, { end: nq.end }, { silent: true });
  }
  const ans = v => ({ yes: 'Yes', partly: 'Partly', no: 'No' }[v] || 'Not answered');
  const md = [`Week of ${fmtDate(week[0], true)} to ${fmtDate(week[6], true)}`, `Looks back over ${fmtDate(st.days[0], true)} to ${fmtDate(st.days[st.days.length - 1], true)}.`, '', '## The week', ...ST.plainSummary(st).map(l => '- ' + l), '', '## What God provided', draft.thanks || '(left empty)', '', '## What went well', draft.wins || '(left empty)', '',
    '## Quiet priorities', ...QUIET.map(([k, l]) => `- ${l}: ${ans(draft.quiet[k]?.v)}${draft.quiet[k]?.note ? ' — ' + draft.quiet[k].note : ''}`), '',
    '## Goals', ...(Object.keys(draft.goals).length ? Object.entries(draft.goals).map(([id, c]) => `- ${store.rawGet('goals', id)?.title || 'Goal'}: ${{ 'on-track': 'on track', behind: 'behind', change: 'changed', drop: 'set aside' }[c.v] || c.v}`) : ['- No active goals']), '',
    '## Top three for next week', ...(draft.top3.filter(Boolean).length ? draft.top3.filter(Boolean).map((t, n) => `${n + 1}. ${t}`) : ['(none chosen)']), ...(draft.claude ? ['', '## Reflection from Claude', draft.claude] : [])].join('\n');
  const noteId = 'wr-' + week[0], title = `Weekly review · ${fmtDate(week[0], true)}`;
  const res = M.applyOps([{ op: 'upsert', type: 'note', item: { id: noteId, title, notebook: 'Weekly reviews', tags: ['weekly-review'], markdown: md } }]);
  if (res.some(r => r.startsWith('problem'))) console.warn('review note', res);
  const snapshot = { time: st.time.map(t => ({ id: t.id, name: t.name, min: t.min, targetMin: t.targetMin })), quiet: { ...st.quiet, familyBlocksWorked: st.quiet.familyBlocksWorked.length }, promises: { onTime: st.promises.onTime, late: st.promises.late, openPastDue: st.promises.openPastDue }, fit: st.fit && { fits: st.fit.fits, days: st.fit.days }, completed: st.completed };
  store.put('reviews', { ...(store.get('reviews', 'rv-' + week[0]) || {}), id: 'rv-' + week[0], weekOf: week[0], answers: { thanks: draft.thanks, wins: draft.wins, quiet: draft.quiet, goals: draft.goals, quarter: draft.quarter, claude: draft.claude }, top3: draft.top3.filter(Boolean), statsSnapshot: snapshot, noteId, finishedAt: Date.now() });
  const t = store.get('tasks', REVIEW_TASK);
  if (t && !t.completedAt && t.due?.date <= now) M.completeTask(REVIEW_TASK);
  try { localStorage.removeItem(draftKey); } catch {}
  draft = null;
  void q;
  toast('Review saved. It is in the notebook “Weekly reviews”.', 'Open', () => { location.hash = '#/note/' + noteId; }, 9000);
  location.hash = '#/stats';
}

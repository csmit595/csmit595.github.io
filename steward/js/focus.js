// Focus sessions and the family-time timer: one tap to start, a calm full-screen timer, a short check-in at the end.
// The timing rules are in session-core.js. Sessions are saved in the goals file, so a timer started on the phone is
// seen running on the Mac, and the Google helper can send the end alert while Steward is closed.
import { h, fill, today, fromYmd, fmtTime, pad } from './util.js';
import { store, settings } from './store.js';
import * as M from './model.js';
import * as S from './session-core.js';
import { fmtHours } from './goals-core.js';
import { sync, deviceName } from './sync.js';
import { icon, btn, modal, confirmDlg, toast, menu } from './ui.js';

const go = hash => { location.hash = hash; };
const colorOf = i => M.COLORS[i?.color] || M.COLORS.stone;
const clockOf = min => fmtTime(`${pad(Math.floor(min / 60) % 24)}:${pad(min % 60)}`);
const sessions = () => store.all('sessions');
export const runningSession = () => S.running(sessions());
export const familyIdentity = () => M.identities().find(i => i.timed) || null;
const save = s => store.put('sessions', s);

/** What a session is for, in words: the task, else the goal, else the identity. */
export function sessionTitle(s) {
  if (s.kind === 'family') return 'Family time';
  const t = s.taskId && store.rawGet('tasks', s.taskId), g = s.goalId && store.get('goals', s.goalId), i = s.identityId && store.get('identities', s.identityId);
  return (t && !t.deleted && t.content) || g?.title || i?.name || 'Focus';
}
/** Fill in goal and identity from the task or goal chosen. */
function resolve(target) {
  const t = target.taskId ? store.get('tasks', target.taskId) : null;
  const goalId = target.goalId || t?.goalId || null, g = goalId ? store.get('goals', goalId) : null;
  const identityId = target.identityId || g?.identityId || (t ? M.identityOfTask(t)?.id : null) || null;
  return { taskId: t?.id || null, goalId: g?.id || null, identityId };
}
/** Fixed blocks and timed calendar events today, as minute ranges. */
function busyToday() {
  const day = today(), s0 = fromYmd(day), s1 = new Date(s0); s1.setDate(s1.getDate() + 1);
  const out = M.blocksOn(day).map(x => ({ start: x.start, end: x.end, title: x.b.name }));
  for (const e of sync.events || []) {
    if (e.allDay) continue;
    const a = new Date(e.start), b = new Date(e.end);
    if (!(a < s1 && b > s0) || b - a >= 864e5) continue;
    out.push({ start: a < s0 ? 0 : a.getHours() * 60 + a.getMinutes(), end: b >= s1 ? 1440 : b.getHours() * 60 + b.getMinutes(), title: e.title || 'a calendar event' });
  }
  return out;
}
const ask = (message, buttons) => new Promise(res => { let done = false; modal(close => h('div', null, h('p', { class: 'dlg-msg' }, message), h('div', { class: 'row end wrap' }, buttons.map(([label, value, cls]) => btn(label, () => { done = true; res(value); close(); }, cls || '')))), { cls: 'small', onClose: () => { if (!done) res(null); } }); });

// ---- starting ----------------------------------------------------------------------------------------------------
/** The start sheet: what, how long, which format. target: { taskId } | { goalId } | { identityId } | {}. */
export function openFocusStart(target = {}) {
  let { taskId, goalId, identityId } = resolve(target);
  let length = 50, format = 'standard';
  modal(close => {
    const body = h('div', { class: 'form fs-start' });
    const custom = h('input', { type: 'number', class: 'field slim', min: 5, max: 240, step: 5, placeholder: 'min', 'aria-label': 'Minutes', oninput: () => { const n = Math.round(Number(custom.value)); if (n >= 1) { length = Math.min(480, n); draw(); custom.focus(); } } });
    const draw = () => {
      const t = taskId && store.get('tasks', taskId), g = goalId && store.get('goals', goalId), i = identityId && store.get('identities', identityId);
      const idSel = h('select', { class: 'field', 'aria-label': 'Identity', onchange: () => { identityId = idSel.value || null; draw(); } }, h('option', { value: '' }, 'No identity'), M.identities().map(x => h('option', { value: x.id }, x.name)));
      idSel.value = identityId || '';
      const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
      const gd = S.guard({ nowMin, lengthMin: length, busy: busyToday() });
      fill(body,
        h('div', { class: 'fs-what', style: { '--idc': colorOf(i) } }, h('small', null, t ? 'Task' : g ? 'Goal' : 'Focus on'), h('b', null, t ? t.content : g ? g.title : i ? i.name : 'Whatever is in front of you'), (t || g) && i && h('small', null, i.name), g && t && h('small', null, 'Goal: ' + g.title)),
        !t && !g && h('label', null, 'Identity', idSel),
        h('label', null, 'Format', h('div', { class: 'seg' }, [['standard', 'Standard'], ['5-50-5', '5-50-5']].map(([k, l]) => h('button', { type: 'button', class: format === k ? 'on' : '', onclick: () => { format = k; if (k === '5-50-5') length = 60; draw(); } }, l)))),
        format === '5-50-5' ? h('p', { class: 'sub' }, 'Five minutes to plan, fifty to work, five to review: one hour.')
          : h('label', null, 'Length', h('div', { class: 'row wrap seg-chips' }, S.LENGTHS.map(n => h('button', { type: 'button', class: 'schip' + (length === n ? ' on' : ''), onclick: () => { length = n; custom.value = ''; draw(); } }, n + ' min')), custom)),
        gd.clash && h('div', { class: 'banner soft' }, gd.fitMin > 0 ? `This would run into ${gd.clash.title} at ${clockOf(gd.clash.start)}. ` : `${gd.clash.title} is on now (until ${clockOf(gd.clash.end)}). `, gd.fitMin >= 5 && btn(`Shorten to ${gd.fitMin} min`, () => { length = gd.fitMin; format = 'standard'; draw(); }, 'tiny')),
        h('p', { class: 'sub' }, icon('bell', 13), ' Turn on Do Not Disturb before you start, and put the phone face down.'),
        h('div', { class: 'row end' }, btn('Cancel', close), btn(`Start ${length} min`, async () => {
          if (new Date().getDay() === settings.get('restDay') && !(await ask('Today is your rest day. Start anyway?', [['Not today', false], ['Start anyway', true, 'primary']]))) return;
          const g2 = S.guard({ nowMin: new Date().getHours() * 60 + new Date().getMinutes(), lengthMin: length, busy: busyToday() });
          if (g2.clash) {
            const a = await ask(g2.fitMin > 0 ? `This session would run into ${g2.clash.title} at ${clockOf(g2.clash.start)}.` : `${g2.clash.title} is on now, until ${clockOf(g2.clash.end)}.`,
              [['Cancel', null], ['Start anyway', 'go'], ...(g2.fitMin >= 5 ? [[`Shorten to ${g2.fitMin} min`, 'short', 'primary']] : [])]);
            if (!a) return;
            if (a === 'short') { length = g2.fitMin; format = 'standard'; }
          }
          if (!(await endOther())) return;
          close(); begin({ kind: 'focus', taskId, goalId, identityId, plannedMin: length, format });
        }, 'primary', 'clock')));
    };
    draw();
    return body;
  }, { title: 'Focus session', cls: 'small' });
}
/** Only one timer runs at a time: offer to end the one that is going. Returns false if he kept it. */
async function endOther() {
  const r = runningSession();
  if (!r) return true;
  const a = await ask(`${sessionTitle(r)} is still running (${S.clock(S.elapsedMs(r))}). End it and start this one?`, [['Keep it', false], ['End it and start', true, 'primary']]);
  if (!a) return false;
  save(S.finish(store.get('sessions', r.id)));
  return true;
}
function begin(f) {
  const s = save(S.start({ ...f, device: deviceName() }));
  const i = s.identityId && store.get('identities', s.identityId);
  if (i?.playlistUrl && /^https?:\/\//.test(i.playlistUrl)) { try { window.open(i.playlistUrl, '_blank', 'noopener'); } catch {} }
  go('#/focus');
  return s;
}
/** One tap: start counting family time (it counts up until Stop). */
export async function startFamily() {
  const fam = familyIdentity();
  if (!fam) { toast('No identity is set to use the family timer. Edit an identity and tick “Counted with a start/stop timer”.'); return null; }
  const r = runningSession();
  if (r?.kind === 'family') { go('#/focus'); return r; }
  if (!(await endOther())) return null;
  return begin({ kind: 'family', identityId: fam.id });
}
/** A "Focus" button for a task, a goal or an identity. */
export const focusButton = (target, cls = 'tiny') => btn('Focus', () => openFocusStart(target), cls, 'clock');

// ---- time entered by hand ----------------------------------------------------------------------------------------
export function logTime(pre = {}) {
  modal(close => {
    const ids = M.identities();
    const idSel = h('select', { class: 'field' }, ids.map(i => h('option', { value: i.id }, i.name))); idSel.value = pre.identityId || ids[0]?.id || '';
    const goalSel = h('select', { class: 'field' });
    const drawGoals = () => { fill(goalSel, h('option', { value: '' }, 'No goal'), store.all('goals').filter(g => g.identityId === idSel.value && g.status === 'active').map(g => h('option', { value: g.id }, g.title))); goalSel.value = pre.goalId && store.get('goals', pre.goalId)?.identityId === idSel.value ? pre.goalId : ''; };
    idSel.addEventListener('change', drawGoals); drawGoals();
    const hrs = h('input', { type: 'number', class: 'field slim', min: 0, max: 16, step: 1, value: '', placeholder: '0', 'aria-label': 'Hours' }), mins = h('input', { type: 'number', class: 'field slim', min: 0, max: 59, step: 5, value: '', placeholder: '30', 'aria-label': 'Minutes' });
    const day = h('input', { type: 'date', class: 'field slim', value: today(), max: today() });
    const note = h('input', { class: 'field', placeholder: 'Note (optional)' });
    const ok = () => {
      const m = Math.round((Number(hrs.value) || 0) * 60 + (Number(mins.value) || 0));
      if (!(m > 0)) return toast('Enter how long');
      if (m > 16 * 60) return toast('That is more than 16 hours. Check the numbers.');
      const i = store.get('identities', idSel.value);
      save(S.manual({ kind: i?.timed ? 'family' : 'manual', identityId: idSel.value || null, goalId: goalSel.value || null, minutes: m, day: day.value || today(), note: note.value.trim(), device: deviceName() }));
      close(); toast(`${fmtHours(m)} added to ${i?.name || 'your time'}`);
    };
    return h('div', { class: 'form' }, h('p', { class: 'sub' }, 'For when the timer was not started. It counts the same as timed minutes.'), h('label', null, 'For', idSel), h('label', null, 'Goal', goalSel),
      h('div', { class: 'row gap wrap' }, h('label', null, 'Hours', hrs), h('label', null, 'Minutes', mins), h('label', null, 'Day', day)), h('label', null, 'Note', note),
      h('div', { class: 'row end' }, btn('Cancel', close), btn('Add time', ok, 'primary')));
  }, { title: pre.title || 'Add time by hand', cls: 'small' });
}

// ---- the check-in at the end -------------------------------------------------------------------------------------
function checkIn(id) {
  const s0 = store.get('sessions', id);
  if (!s0 || s0.kind !== 'focus' || s0.checkedIn || document.querySelector('.fs-checkin')) return;
  const t = s0.taskId && store.get('tasks', s0.taskId);
  let rating = null, saved = false;
  const finishUp = again => { if (saved) return; saved = true; store.patch('sessions', id, { rating, note: note.value.trim(), checkedIn: true }); if (done?.checked && t && !t.completedAt) M.completeTask(t.id); if (again) setTimeout(() => openFocusStart({ taskId: s0.taskId, goalId: s0.goalId, identityId: s0.identityId }), 60); };
  const note = h('input', { class: 'field', placeholder: 'One line: what got done, or what got in the way' });
  const done = t && !t.completedAt ? h('input', { type: 'checkbox' }) : null;
  modal(close => {
    const stars = h('div', { class: 'row fs-rate' }, [1, 2, 3, 4, 5].map(n => h('button', { type: 'button', class: 'schip', 'aria-label': `${n} of 5`, onclick: e => { rating = n; stars.querySelectorAll('button').forEach((b, k) => b.classList.toggle('on', k < n)); } }, n)));
    return h('div', { class: 'form fs-checkin' }, h('p', { class: 'fs-done-line' }, h('b', null, `${s0.actualMin} minute${s0.actualMin === 1 ? '' : 's'}`), ' on ', sessionTitle(s0), s0.interruptions ? ` · pulled away ${s0.interruptions} time${s0.interruptions === 1 ? '' : 's'}` : ''),
      h('label', null, 'How focused were you? (1 = scattered, 5 = locked in)', stars), h('label', null, 'Note', note),
      done && h('label', { class: 'check-line' }, done, ` Mark “${t.content.slice(0, 60)}” done`),
      h('div', { class: 'row end' }, btn('Another round', () => { finishUp(true); close(); }, '', 'repeat'), btn('Save', () => { finishUp(false); close(); }, 'primary', 'check')));
  }, { title: 'Session finished', cls: 'small', onClose: () => finishUp(false) });
}

// ---- the running timer -------------------------------------------------------------------------------------------
let wake = null, audio = null;
async function keepAwake(on) {
  try {
    if (on && !wake && 'wakeLock' in navigator && !document.hidden) { wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => { wake = null; }); }
    else if (!on && wake) { const w = wake; wake = null; await w.release(); }
  } catch { wake = null; }
}
function chime() {
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    const t0 = audio.currentTime;
    for (const [k, f] of [523.25, 659.25, 783.99].entries()) { const o = audio.createOscillator(), g = audio.createGain(); o.type = 'sine'; o.frequency.value = f; g.gain.setValueAtTime(0.0001, t0 + k * 0.28); g.gain.exponentialRampToValueAtTime(0.25, t0 + k * 0.28 + 0.03); g.gain.exponentialRampToValueAtTime(0.0001, t0 + k * 0.28 + 0.9); o.connect(g).connect(audio.destination); o.start(t0 + k * 0.28); o.stop(t0 + k * 0.28 + 1); }
  } catch {}
}
const primeAudio = () => { try { audio = audio || new (window.AudioContext || window.webkitAudioContext)(); audio.resume?.(); } catch {} };

function timeUp(s) {
  const closed = save(S.finishAtPlanned(s));
  if (!closed.endedAt) return;
  const fresh = Date.now() - closed.endedAt < 3 * 60000;
  if (fresh) {
    chime(); try { navigator.vibrate?.([120, 80, 120]); } catch {}
    if (document.hidden && 'Notification' in window && Notification.permission === 'granted') navigator.serviceWorker?.ready.then(r => r.showNotification('Focus session done', { body: sessionTitle(closed) + ' · time to check in', icon: 'icons/icon-192.png', tag: 'fs-' + closed.id, data: { url: '#/focus' } })).catch(() => {});
  }
  if (!document.hidden) checkIn(closed.id);
}
/** A family timer left running: ask once whether to keep it or stop it at a chosen time. */
function askStale(s) {
  if (document.querySelector('.fs-stale')) return;
  const started = new Date(s.startedAt), now = new Date();
  const blk = M.blocksOn(S.dayOf(s.startedAt)).find(x => x.b.identityId === s.identityId && x.end > started.getHours() * 60 + started.getMinutes());
  const guess = blk ? new Date(started.getFullYear(), started.getMonth(), started.getDate(), Math.floor(blk.end / 60), blk.end % 60) : new Date(Math.min(now.getTime(), s.startedAt + 2 * 3600e3));
  const when = h('input', { type: 'datetime-local', class: 'field', value: `${S.dayOf(guess.getTime())}T${pad(guess.getHours())}:${pad(guess.getMinutes())}` });
  let answered = false;
  modal(close => h('div', { class: 'form fs-stale' }, h('p', { class: 'dlg-msg' }, `Family time has been running since ${started.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })} (${S.clock(S.elapsedMs(s))}). Still going, or was the timer forgotten?`),
    h('label', null, 'Stop it at', when),
    h('div', { class: 'row end wrap' }, btn('Keep it going', () => { answered = true; store.patch('sessions', s.id, { staleAsked: true }); close(); }),
      btn('Stop at that time', () => { const at = new Date(when.value).getTime(); if (!(at > s.startedAt) || at > Date.now()) return toast('Pick a time after it started and not in the future'); answered = true; save(S.finish(store.get('sessions', s.id), at)); close(); toast('Family time saved'); }, 'primary'))),
  { title: 'Family timer', cls: 'small', onClose: () => { if (!answered) store.patch('sessions', s.id, { staleAsked: true }); } });
}

/** Runs every second while Steward is open: ends a session whose time is up, notices a forgotten family timer, keeps the pill right. */
function tick() {
  const r = runningSession();
  if (r && S.isOver(r)) timeUp(r);
  else if (r && S.familyStale(r) && !document.hidden) askStale(r);
  drawPill();
  const face = document.querySelector('.fs-face');
  if (face) paintFace(face);
}
let pill = null;
function drawPill() {
  const r = runningSession(), onFocus = document.body.dataset.view === 'focus';
  if (!r || onFocus) { pill?.remove(); pill = null; return; }
  if (!pill) { pill = h('a', { class: 'focus-pill', href: '#/focus' }); document.body.append(pill); }
  const i = r.identityId && store.get('identities', r.identityId);
  pill.style.setProperty('--idc', colorOf(i));
  const label = `${r.kind === 'family' ? 'Family time' : sessionTitle(r).slice(0, 28)} · ${S.isPaused(r) ? 'paused' : r.plannedMin ? S.clock(S.remainingMs(r)) : S.clock(S.elapsedMs(r))}`;
  if (pill.textContent !== label) fill(pill, icon('clock', 14), label);
}
function paintFace(face) {
  const s = store.get('sessions', face.dataset.id);
  if (!s || s.endedAt) return;
  const big = face.querySelector('.fs-time'), sub = face.querySelector('.fs-sub');
  const paused = S.isPaused(s);
  big.textContent = s.plannedMin ? S.clock(S.remainingMs(s)) : S.clock(S.elapsedMs(s));
  face.classList.toggle('paused', paused);
  if (s.kind === 'family') sub.textContent = paused ? 'Paused' : 'so far today · put the phone away, the time keeps counting';
  else if (s.format === '5-50-5') { const p = S.phase(s); sub.textContent = paused ? 'Paused' : `${{ plan: 'Plan', focus: 'Focus', review: 'Review' }[p.name]} · ${S.clock(p.leftMs)} left in this part`; }
  else sub.textContent = paused ? 'Paused' : `of ${s.plannedMin} minutes`;
  const ring = face.querySelector('.fs-ring span');
  if (ring) ring.style.width = (s.plannedMin ? Math.min(100, S.elapsedMs(s) / (s.plannedMin * 60000) * 100) : 100) + '%';
}

export const leaveFocus = () => { keepAwake(false); };
export function renderFocus(route, main) {
  main.classList.add('focus-view');
  const s = runningSession();
  if (!s) { keepAwake(false); return viewIdle(main); }
  const i = s.identityId && store.get('identities', s.identityId), fam = s.kind === 'family';
  const set = fn => { const cur = store.get('sessions', s.id); if (cur && !cur.endedAt) save(fn(cur)); };
  keepAwake(!fam && !S.isPaused(s));
  const paused = S.isPaused(s);
  const face = h('section', { class: 'fs-face' + (fam ? ' family' : ''), dataset: { id: s.id }, style: { '--idc': colorOf(i) } },
    h('div', { class: 'fs-kicker' }, i ? i.name : fam ? 'Family' : 'Focus', s.format === '5-50-5' && ' · 5-50-5'),
    h('h1', { class: 'fs-title' }, sessionTitle(s)),
    h('div', { class: 'fs-time', role: 'timer', 'aria-live': 'off' }, ''),
    h('div', { class: 'fs-sub' }, ''),
    !fam && h('div', { class: 'fs-ring' }, h('span')),
    h('div', { class: 'row fs-acts' },
      btn(paused ? 'Resume' : 'Pause', () => { primeAudio(); set(paused ? S.resume : S.pause); }, paused ? 'primary' : ''),
      btn(fam ? 'Stop' : 'End early', async () => { if (!fam && !(await ask(`End this session now? ${S.clock(S.elapsedMs(store.get('sessions', s.id)))} will be saved.`, [['Keep going', false], ['End it', true, 'primary']]))) return; const closed = save(S.finish(store.get('sessions', s.id))); keepAwake(false); if (fam) toast(`Family time saved: ${fmtHours(closed.actualMin)}`); else checkIn(closed.id); }, fam ? 'primary' : '')),
    !fam && h('button', { type: 'button', class: 'fs-pulled', onclick: () => set(c => ({ ...c, interruptions: (c.interruptions || 0) + 1 })) }, 'I got pulled away', s.interruptions ? h('span', { class: 'count' }, s.interruptions) : null),
    h('a', { class: 'sub fs-back', href: '#/' + settings.get('home') }, 'Back to Steward (the timer keeps running)'),
    s.device && s.device !== deviceName() && h('div', { class: 'sub' }, `Started on the ${s.device}`));
  main.append(face); paintFace(face);
}
function viewIdle(main) {
  const fam = familyIdentity(), now = Date.now();
  const recent = sessions().filter(x => x.endedAt).sort((a, b) => b.endedAt - a.endedAt).slice(0, 12);
  main.append(h('header', { class: 'vhead' }, h('div', null, h('h1', null, 'Focus'), h('div', { class: 'sub' }, 'One thing at a time, with an end.'))),
    h('div', { class: 'row wrap fs-starts' }, btn('Start a focus session', () => { primeAudio(); openFocusStart({}); }, 'primary', 'clock'), fam && btn('Start family time', () => startFamily(), '', 'pin'), btn('Add time by hand', () => logTime({}), '', 'plus')),
    h('section', { class: 'group' }, h('div', { class: 'ghead' }, h('h3', null, 'Recent')),
      recent.length ? h('div', null, recent.map(x => { const i = x.identityId && store.get('identities', x.identityId); return h('div', { class: 'rowlink fs-row' }, h('span', { class: 'pdot idot', style: { background: colorOf(i) } }), h('span', { class: 'grow' }, sessionTitle(x), h('small', null, [new Date(x.startedAt).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }), i?.name, x.byHand ? 'added by hand' : null, x.rating ? `focus ${x.rating}/5` : null, x.note].filter(Boolean).join(' · '))), h('b', null, fmtHours(x.actualMin || 0)),
        h('button', { class: 'ibtn mini', title: 'Remove', 'aria-label': 'Remove', onclick: async () => { if (await confirmDlg(`Remove this ${fmtHours(x.actualMin || 0)} entry?`, 'Remove')) store.remove('sessions', x.id); } }, icon('x', 14))); }))
        : h('p', { class: 'sub gnone' }, 'Nothing yet. Sessions you finish show here.')));
  void now;
}

// ---- pieces other screens use ------------------------------------------------------------------------------------
/** This week's time for an identity that has a target or a timer, with its buttons (shown on its card in Goals). */
export function identityTimeLine(i) {
  if (!i.weeklyTargetMin && !i.timed) return null;
  const week = S.weekOf(today());
  const min = S.minutesOn(sessions().filter(s => s.identityId === i.id), week, { skipSunday: !!i.timed });
  const target = i.weeklyTargetMin || 0;
  return h('div', { class: 'idtime' },
    h('div', { class: 'row between' }, h('span', null, h('b', null, fmtHours(min)), target ? ` of ${fmtHours(target)} this week` : ' this week', i.timed ? ' (Monday to Saturday)' : ''),
      h('span', { class: 'row' }, i.timed ? btn(runningSession()?.kind === 'family' ? 'Timer running' : 'Start family time', () => startFamily(), 'tiny', 'clock') : btn('Focus', () => openFocusStart({ identityId: i.id }), 'tiny', 'clock'), btn('Add time', () => logTime({ identityId: i.id }), 'tiny', 'plus'))),
    target > 0 && h('div', { class: 'gbar' }, h('span', { style: { width: Math.min(100, Math.round(min / target * 100)) + '%', background: colorOf(i) } })));
}
/** Today: the two one-tap starts. */
export function todayStarts() {
  const r = runningSession(), fam = familyIdentity();
  if (r) return h('div', { class: 'row wrap fs-today' }, h('a', { class: 'btn tiny primary', href: '#/focus' }, icon('clock', 14), `${r.kind === 'family' ? 'Family time' : 'Focus'} running · open`));
  return h('div', { class: 'row wrap fs-today' }, btn('Focus session', () => { primeAudio(); openFocusStart({}); }, 'tiny', 'clock'), fam && btn('Start family time', () => startFamily(), 'tiny', 'pin'));
}
/** A fixed block that belongs to a timed identity just began: offer the timer, once per block per day. */
function offerFamilyAtBlock() {
  const fam = familyIdentity();
  if (!fam || runningSession() || document.hidden) return;
  const now = new Date(), nowMin = now.getHours() * 60 + now.getMinutes(), day = today();
  for (const x of M.blocksOn(day)) {
    if (x.b.identityId !== fam.id || nowMin < x.start || nowMin > Math.min(x.end, x.start + 15)) continue;
    const key = 'steward.famAsked.' + x.b.id;
    try { if (localStorage.getItem(key) === day) continue; localStorage.setItem(key, day); } catch { continue; }
    toast(`${x.b.name}: start the family timer?`, 'Start', () => startFamily(), 20000);
  }
}
/** Sessions that finished while Steward was closed still get their check-in, once, if it was recent. */
function pendingCheckIn() {
  if (document.hidden) return;
  const s = sessions().filter(x => x.kind === 'focus' && x.endedAt && !x.checkedIn && !x.byHand && Date.now() - x.endedAt < 6 * 3600e3 && x.device === deviceName()).sort((a, b) => b.endedAt - a.endedAt)[0];
  if (s) checkIn(s.id);
}
let started = false;
export function initFocus() {
  if (started) return; started = true;
  setInterval(tick, 1000);
  setInterval(offerFamilyAtBlock, 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { tick(); pendingCheckIn(); offerFamilyAtBlock(); if (document.body.dataset.view === 'focus') { const r = runningSession(); keepAwake(!!r && r.kind !== 'family' && !S.isPaused(r)); } } });
  setTimeout(() => { tick(); pendingCheckIn(); offerFamilyAtBlock(); }, 1500);
}

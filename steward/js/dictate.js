// Dictation: speak tasks and notes instead of typing them.
// Two engines: Chrome's speech service (fast, needs signal) and Steward's own speech model on the device
// (js/listen-device.js; Whisper, works with no signal). "Automatic" uses Chrome's when there is signal and the
// device model when there is not, and switches over mid-sentence if the signal drops.
// Spoken punctuation works everywhere ("period", "comma", "question mark", "new line", "new paragraph").
// For tasks, spoken words are turned into Steward's typing shortcuts ("priority one" → p1, "project Hanel" → #Hanel,
// "label promise" → @promise, "deadline friday" → {friday}, "8 a.m." → 8am), and "next task" starts another task.
import { h } from './util.js';
import { spokenGoal } from './goals-core.js';
import { parseDue } from './dates.js';
import { icon } from './ui.js';
import { deviceListen } from './listen-device.js';

const SR = () => window.SpeechRecognition || window.webkitSpeechRecognition;
const deviceCapable = () => !!(navigator.mediaDevices?.getUserMedia && window.AudioWorkletNode && typeof WebAssembly === 'object');
export const canDictate = () => !!SR() || deviceCapable();
const LANG = 'en-US';
// Android Chrome repeats earlier words in each new result; desktop Chrome does not.
const ANDROID = /Android/i.test(navigator.userAgent);
const FATAL = new Set(['not-allowed', 'service-not-allowed', 'audio-capture', 'language-not-supported', 'network', 'phrases-not-supported']);

// Which engine, per device: 'auto' (Chrome's with signal, the device model without) or 'device' (always the device model).
const ENGINE = 'steward.dictate.engine';
export const dictEngine = () => { try { return localStorage.getItem(ENGINE) === 'device' ? 'device' : 'auto'; } catch { return 'auto'; } };
export const setDictEngine = v => { try { localStorage.setItem(ENGINE, v === 'device' ? 'device' : 'auto'); } catch {} };
// Whether the device speech model is fully downloaded (kept up to date by offline.js).
let modelHere = false;
export const setModelHere = v => { modelHere = !!v; };

let active = null; // only one microphone session at a time

/**
 * Start listening. Calls onFinal(text) with each finished phrase (raw words), onInterim(text) with the words still
 * being heard (Chrome's engine only), onStatus(text) with what the device model is doing ("Writing it down…"),
 * and onEnd() once listening stops for good. Returns { stop }.
 */
export function listen(opts = {}) {
  const { onFinal, onInterim = () => {}, onEnd = () => {}, onStatus = () => {} } = opts;
  const onError = opts.onError || say;
  active?.stop();
  let stopped = false, inner = null, ended = false;
  const session = { stop() { stopped = true; inner?.stop(); }, get on() { return !stopped; } };
  const finish = () => { if (ended) return; ended = true; if (active === session) active = null; onInterim(''); onStatus(''); onEnd(); };
  const onDevice = () => { onInterim(''); inner = deviceListen({ onFinal, onError, onStatus, onEnd: finish }); };
  const useDevice = deviceCapable() && (!SR() || dictEngine() === 'device' || (!navigator.onLine && (modelHere || !('processLocally' in (SR().prototype || {})))));
  if (!SR() && !deviceCapable()) { onError('Dictation needs Chrome. Open Steward in Chrome to speak instead of type.'); onEnd(); return session; }
  active = session;
  if (useDevice) onDevice();
  else inner = chromeListen({ onFinal, onInterim, onError, onEnd: finish,
    // The signal dropped: carry on with the model on this device, if it is here.
    handover: () => { if (stopped || !deviceCapable() || !modelHere) return false; onStatus('No signal: switching to the speech model on this device…'); onDevice(); return true; } });
  return session;
}

function chromeListen({ onFinal, onInterim, onError, onEnd, handover }) {
  const Rec = SR();
  let stopped = false, rec = null, quietRounds = 0, switching = false;
  const session = {
    stop() { if (stopped) return; stopped = true; try { rec?.stop(); } catch {} },
    get on() { return !stopped; },
  };
  const begin = () => {
    rec = new Rec();
    rec.lang = LANG; rec.continuous = true; rec.interimResults = true; rec.maxAlternatives = 1;
    // No signal: use the speech model kept on the device, where Chrome has one (Chrome 139 and newer).
    if (!navigator.onLine && 'processLocally' in rec) rec.processLocally = true;
    let lastAndroid = ''; // Android: the latest finished text, which the next one may start with
    const done = new Set();
    rec.onresult = ev => {
      let interim = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i], t = r[0].transcript;
        if (!r.isFinal) { interim += t; continue; }
        if (done.has(i)) continue;
        done.add(i);
        let add = t;
        if (ANDROID && lastAndroid && t.toLowerCase().startsWith(lastAndroid.toLowerCase())) add = t.slice(lastAndroid.length);
        if (ANDROID) lastAndroid = t;
        if (add.trim()) { quietRounds = 0; onFinal(add); }
      }
      if (ANDROID && interim && lastAndroid && interim.toLowerCase().startsWith(lastAndroid.toLowerCase())) interim = interim.slice(lastAndroid.length);
      onInterim(interim.trim());
    };
    rec.onerror = e => {
      if (e.error === 'no-speech') { quietRounds++; return; }
      if (e.error === 'aborted') return;
      if (FATAL.has(e.error)) {
        stopped = true;
        if ((e.error === 'network' || e.error === 'language-not-supported') && handover) { switching = true; return; }
        const msg = e.error === 'not-allowed' || e.error === 'service-not-allowed' ? 'Steward is not allowed to use the microphone. Allow it in Chrome\'s site settings (the icon left of the address), then try again.'
          : e.error === 'audio-capture' ? 'No microphone was found.'
          : e.error === 'network' || e.error === 'language-not-supported' ? 'No signal, and the speech model is not on this device yet. When you have Wi-Fi, open Settings → Speak instead of type → Download the speech model.'
          : 'Dictation stopped (' + e.error + ').';
        onError(msg);
      }
    };
    // Chrome stops on its own after a pause or about a minute; keep going until the person taps Stop.
    rec.onend = () => {
      if (switching) { switching = false; if (handover()) return; onError('No signal, and the speech model is not on this device yet. When you have Wi-Fi, open Settings → Speak instead of type → Download the speech model.'); onEnd(); return; }
      if (stopped || quietRounds >= 2) { stopped = true; onEnd(); return; }
      try { begin(); } catch { stopped = true; onEnd(); }
    };
    rec.start();
  };
  try { begin(); } catch (e) { stopped = true; onError('Dictation could not start: ' + (e?.message || e)); onEnd(); return session; }
  offlineReady();
  return session;
}
const say = msg => import('./ui.js').then(u => u.toast(msg, null, null, 7000));

// While there is signal, ask Chrome (where it can) to keep its English speech model on the device too.
let askedOffline = false;
function offlineReady() {
  const Rec = SR();
  if (askedOffline || !navigator.onLine || !Rec?.available || !Rec?.install) return;
  askedOffline = true;
  Promise.resolve(Rec.available({ langs: [LANG], processLocally: true }))
    .then(s => { if (s === 'downloadable') return Rec.install({ langs: [LANG], processLocally: true }); })
    .catch(() => {});
}

// ---- turning spoken words into text --------------------------------------------------------------------------
const SPOKEN = [
  [/\s*\b(?:new|next) paragraph\b[\s,.]*/gi, '\n\n'],
  [/\s*\b(?:new|next) line\b[\s,.]*/gi, '\n'],
  [/\s*\b(?:period|full stop)\b/gi, '.'],
  [/\s*\bcomma\b/gi, ','],
  [/\s*\bquestion mark\b/gi, '?'],
  [/\s*\bexclamation (?:point|mark)\b/gi, '!'],
  [/\s*\bsemicolon\b/gi, ';'],
  [/\s*\bcolon\b/gi, ':'],
];
const ENDS_SENTENCE = /(^|[.?!]|\n)\s*$/;
/**
 * Shape one spoken phrase so it fits after `before` (the text already in front of the cursor):
 * spoken punctuation, a space where needed, and a capital letter at the start of a sentence.
 */
export function shapeSpeech(raw, before = '', o = {}) {
  let t = ' ' + String(raw).replace(/\s+/g, ' ').trim();
  for (const [re, s] of SPOKEN) t = t.replace(re, o.oneLine && s.includes('\n') ? ' ' : s);
  t = t.replace(/^ /, '').replace(/([.,?!;:])\1+/g, '$1').replace(/ *\n */g, '\n');
  if (!t) return '';
  // capital letter after a sentence ends or a new line starts
  t = t.replace(/([.?!]\s+|\n)([a-z])/g, (_, a, b) => a + b.toUpperCase());
  if (ENDS_SENTENCE.test(before)) t = t.replace(/^([^A-Za-z]*)([a-z])/, (_, a, b) => a + b.toUpperCase());
  if (before && !/[\s\n]$/.test(before) && !/^[.,?!;:\n]/.test(t)) t = ' ' + t;
  return t;
}

const NUM = { one: 1, two: 2, three: 3, four: 4, won: 1, high: 1, top: 1, low: 3, urgent: 1 };
/**
 * Turn a spoken task into Steward's typing shortcuts, so quick add reads it the same way as typed words.
 * names: { projects: [names], labels: [names] }
 */
export function spokenTask(raw, names = {}) {
  let s = ' ' + shapeSpeech(raw, '', { oneLine: true }) + ' ';
  // times: "8 a.m." / "8:30 p.m." / "8 o'clock" → 8am / 8:30pm / 8
  s = s.replace(/\b(\d{1,2})(?::(\d\d))?\s*([ap])\.?\s*m\b\.?/gi, (_, hh, mm, ap) => hh + (mm ? ':' + mm : '') + ap.toLowerCase() + 'm');
  s = s.replace(/\b(\d{1,2}) o'?clock\b/gi, '$1');
  s = s.replace(/\bat noon\b/gi, '12pm').replace(/\b(\d{1,2}):00(?=[ap]m)/g, '$1');
  // "priority one" / "high priority"
  s = s.replace(/\bpriority\s+(one|two|three|four|won|[1-4])\b/gi, (_, n) => ' p' + (NUM[n.toLowerCase()] || n) + ' ');
  s = s.replace(/\b(high|top|urgent|low) priority\b/gi, (_, n) => ' p' + NUM[n.toLowerCase()] + ' ');
  // "for half an hour" / "for an hour" / "for 2 hours"
  s = s.replace(/\bfor half an hour\b/gi, 'for 30m').replace(/\bfor an hour and a half\b/gi, 'for 90m').replace(/\bfor (?:an|one) hour\b/gi, 'for 60m');
  // "project Hanel" / "in project Hanel" / "hashtag Hanel" → #Hanel, only for projects that exist
  const projects = [...(names.projects || [])].sort((a, b) => b.length - a.length);
  s = s.replace(/\s(?:(?:in|to|under|for) )?(?:the )?(?:project|hashtag)\s+(.+)$/i, (all, rest) => {
    const p = projects.find(n => (rest + ' ').toLowerCase().startsWith(n.toLowerCase() + ' '));
    return p ? ' #' + p + ' ' + rest.slice(p.length) : all;
  });
  s = s.replace(/\shashtag\s+/gi, ' #');
  // "label promise" / "at sign promise" → @promise, only for labels that exist (plus promise). A plain "at" or "tag"
  // is left alone: "meet at church" and "price tag" are ordinary words even when a label has that name.
  const labels = new Set([...(names.labels || []), 'promise'].map(l => l.toLowerCase()));
  s = s.replace(/\s(?:label|at sign)\s+([\w-]+)/gi, (all, l) => labels.has(l.toLowerCase()) ? ' @' + l.toLowerCase() : all);
  s = s.replace(/\b(?:it'?s|this is|mark it|mark this)?\s*(?:a\s+)?customer promise\b/gi, ' @promise ');
  // "deadline friday" / "due by november 20" → {friday}: the longest run of words that reads as a date
  s = s.replace(/\s(?:deadline|due by|hard deadline(?: of)?)\s+(.+)$/i, (all, rest) => {
    const words = rest.trim().split(/\s+/);
    for (let n = Math.min(4, words.length); n > 0; n--) {
      const c = words.slice(0, n).join(' ');
      const d = (() => { try { return parseDue(c + ' x'); } catch { return null; } })();
      if (d && !d.due.recur && d.rest.trim() === 'x') return ' {' + c + '} ' + words.slice(n).join(' ');
    }
    return all;
  });
  // "goal nursery ready" / "for the goal read twelve sermons" → goal:<title>, only for goals that exist
  if (names.goals?.length) s = spokenGoal(s, names.goals);
  s = s.replace(/\s{2,}/g, ' ').trim().replace(/[.!]+$/, '');
  return s.charAt(0).toUpperCase() + s.slice(1);
}
/** Split spoken text on "next task" / "new task" / "another task". */
export const splitTasks = text => String(text).split(/[\s,.]*\b(?:next|new|another) task\b[\s,.]*/i);
export const saysStop = text => /\b(?:stop (?:listening|dictating|dictation)|that'?s all|i'?m done)\W*$/i.test(text);
export const withoutStop = text => String(text).replace(/[\s,.]*\b(?:stop (?:listening|dictating|dictation)|that'?s all|i'?m done)\W*$/i, '');

// ---- the "listening" bar -----------------------------------------------------------------------------------
/** A bar at the bottom of the screen with the words being heard and a Stop button. Returns { set(text), remove() }. */
export function listeningBar(onStop, hint = 'Say "period", "comma" or "new line" for punctuation.') {
  document.querySelector('.dictbar')?.remove();
  const words = h('span', { class: 'dict-words' }, hint);
  const bar = h('div', { class: 'dictbar', role: 'status', 'aria-live': 'polite' },
    h('span', { class: 'dict-dot', 'aria-hidden': 'true' }),
    h('span', { class: 'dict-text' }, h('b', null, 'Listening'), words),
    h('button', { type: 'button', class: 'btn primary dict-stop', onpointerdown: e => e.preventDefault(), onclick: () => onStop() }, icon('check', 15), 'Done'));
  document.body.append(bar);
  return {
    set(t) { words.textContent = t ? t : hint; words.classList.toggle('live', !!t); },
    remove() { bar.remove(); },
  };
}
export const micIcon = (size = 18) => icon('mic', size);

// ---- putting spoken words into a rich-text editor -------------------------------------------------------------
const BLOCK = 'div,p,li,h1,h2,h3,h4,h5,h6,blockquote,pre,td,th';
/** The text between the start of the cursor's line and the cursor, in a contentEditable root. */
export function beforeCaret(root) {
  const s = getSelection();
  if (!s.rangeCount || !root.contains(s.anchorNode)) return '';
  const r = s.getRangeAt(0);
  const el = r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement;
  let block = el?.closest(BLOCK);
  if (!block || !root.contains(block)) block = root;
  const b = document.createRange(); b.selectNodeContents(block); b.setEnd(r.startContainer, r.startOffset);
  return b.toString();
}
/** Put the cursor at the end of the last line of root (used when dictation starts with no cursor placed yet). */
export function caretAtEnd(root) {
  root.focus();
  let last = root.lastElementChild;
  while (last && /^(IMG|AUDIO|VIDEO|TABLE|HR|FIGURE)$/.test(last.tagName)) last = null;
  const r = document.createRange();
  if (last && last.matches(BLOCK)) r.selectNodeContents(last); else r.selectNodeContents(root);
  r.collapse(false);
  const s = getSelection(); s.removeAllRanges(); s.addRange(r);
}
/** Insert one spoken phrase at the cursor (the editor must already have focus and its cursor restored). */
export function insertSpoken(root, raw) {
  const t = shapeSpeech(raw, beforeCaret(root));
  for (const seg of t.split(/(\n)/)) {
    if (seg === '\n') document.execCommand('insertParagraph');
    else if (seg) document.execCommand('insertText', false, seg);
  }
  return t;
}
/** A short title from the first words of dictated text. */
export function titleFrom(text) {
  const first = String(text).trim().split(/\n|(?<=[.?!])\s/)[0].replace(/[.?!,;:]+$/, '');
  const w = first.split(/\s+/).filter(Boolean);
  return w.slice(0, 8).join(' ') + (w.length > 8 ? '…' : '');
}

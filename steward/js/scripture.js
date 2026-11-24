// Scripture throughout Steward (5.0 "Timberline"): one anchor verse per screen, chosen for what the screen is for,
// every verse opening in its context; Proverbs of the day; a memory verse each week; First light each morning.
// Only Proverbs and Matthew 5-7 (KJV, js/kjv.js) are used, and every word shown comes from that text.
import { h, fill, today, fromYmd, addDays, mdToHtml } from './util.js';
import { settings } from './store.js';
import * as M from './model.js';
import { btn, modal, toast } from './ui.js';
import { PROVERBS, MATTHEW } from './kjv.js';

const BOOKS = { prov: 'Proverbs', matt: 'Matthew' };
const ABBR = { prov: 'Prov', matt: 'Matt' };

/** "Prov 16:3", "Proverbs 3:5-6", "Matt 6:22" → { book, ch, v1, v2 } or null when it is not in Steward's text. */
export function parseRef(s) {
  const m = /^\s*(prov(?:erbs)?|pr|matt(?:hew)?|mt)\.?\s+(\d{1,2}):(\d{1,3})(?:\s*[-–]\s*(\d{1,3}))?\s*$/i.exec(String(s || ''));
  if (!m) return null;
  const book = /^m/i.test(m[1]) ? 'matt' : 'prov', ch = +m[2], v1 = +m[3], v2 = m[4] ? +m[4] : v1;
  const verses = chapter(book, ch);
  if (!verses || v1 < 1 || v2 < v1 || v2 > verses.length) return null;
  return { book, ch, v1, v2 };
}
export const chapter = (book, ch) => book === 'prov' ? PROVERBS[ch - 1] || null : MATTHEW[String(ch)] || null;
export const refLabel = (r, long) => `${long ? BOOKS[r.book] : ABBR[r.book]} ${r.ch}:${r.v1}${r.v2 > r.v1 ? '–' + r.v2 : ''}`;
/** The exact KJV words of a reference (several verses joined), or ''. */
export function verseText(ref) {
  const r = typeof ref === 'string' ? parseRef(ref) : ref; if (!r) return '';
  return chapter(r.book, r.ch).slice(r.v1 - 1, r.v2).join(' ');
}

// ---- the verse map: a small pool per screen, so no verse turns into wallpaper ------------------------------------
export const POOLS = {
  menu: ['Matt 7:24'],
  firstlight: ['Prov 4:18'],
  today: ['Prov 16:3', 'Prov 10:4', 'Prov 12:24'],
  over: ['Matt 6:27', 'Prov 16:9', 'Prov 19:21'],
  inbox: ['Prov 21:5', 'Prov 13:4', 'Prov 15:22'],
  upcoming: ['Prov 27:1', 'Prov 16:9', 'Prov 19:21'],
  project: ['Prov 27:18', 'Prov 12:11', 'Prov 22:29'],
  promise: ['Matt 5:37', 'Prov 3:27', 'Prov 3:28', 'Prov 25:14'],
  matrix: ['Prov 24:27', 'Matt 6:33'],
  filters: ['Prov 24:3', 'Prov 1:5'],
  label: ['Prov 24:3', 'Prov 1:5'],
  completed: ['Prov 14:23', 'Matt 5:16', 'Prov 12:14'],
  notes: ['Prov 18:15', 'Prov 1:5', 'Prov 9:9'],
  goals: ['Prov 4:25', 'Prov 4:26', 'Prov 16:9'],
  stats: ['Matt 7:20', 'Prov 27:23', 'Prov 20:11'],
  review: ['Prov 27:23', 'Matt 7:24'],
  search: ['Prov 25:2', 'Prov 2:4'],
  focus: ['Matt 6:22', 'Prov 4:25', 'Prov 17:24'],
  family: ['Prov 5:18', 'Prov 31:10', 'Prov 22:6'],
  evening: ['Matt 6:34'],
  lordsday: ['Matt 6:33'],
  lilies: ['Matt 6:28'],
  capture: ['Prov 16:9', 'Prov 16:3'],
  tithe: ['Prov 3:9'],
  withgod: ['Matt 6:6'],
};
// An identity's anchor, by name (his order: Christ Worship, Family, Health, Work, Seminary & Church, Friends).
export function identityRef(name) {
  const n = String(name || '').toLowerCase();
  return /christ|worship|god/.test(n) ? 'Matt 6:33' : /family|elise|home/.test(n) ? 'Prov 5:18' : /health|body|exercise/.test(n) ? 'Prov 3:8'
    : /seminary|church|school|study/.test(n) ? 'Prov 18:15' : /work|business|outdoors/.test(n) ? 'Prov 22:29' : /friend/.test(n) ? 'Prov 27:17' : null;
}
const dayIndex = (d = today()) => Math.round((fromYmd(d) - new Date(2026, 0, 1)) / 864e5);
/** The verse for a screen today: rotates through the screen's pool, one a day. */
export function pick(key, salt = 0) {
  const pool = POOLS[key]; if (!pool) return null;
  return pool[((dayIndex() + salt) % pool.length + pool.length) % pool.length];
}
export const scriptureOn = () => settings.get('scriptureOn') !== false;

/** A verse as Steward shows it: Bitter italic words, the reference after them; tap to read it in its context. */
export function verseEl(ref, opts = {}) {
  const r = parseRef(ref); if (!r || (!opts.force && !scriptureOn())) return null;
  return h('button', { type: 'button', class: 'verse tl-verse' + (opts.small ? ' small' : '') + (opts.cls ? ' ' + opts.cls : ''), title: 'Read it in its context', onclick: e => { e.stopPropagation(); openVerse(r); } },
    h('span', { class: 'vt' }, verseText(r)), h('span', { class: 'vr' }, refLabel(r)));
}
/** Just the reference, as a small tappable tag ("PROV 22:29"). */
export function refChip(ref) {
  const r = parseRef(ref); if (!r || !scriptureOn()) return null;
  return h('button', { type: 'button', class: 'vref', title: verseText(r), onclick: e => { e.preventDefault(); e.stopPropagation(); openVerse(r); } }, refLabel(r));
}
/** References to Proverbs or Matthew 5-7 inside some text ("see Prov. 3:5-6", "Matthew 6:33"). */
export function findRefs(text) {
  const out = [], seen = new Set();
  const re = /\b(Proverbs|Prov|Pr|Matthew|Matt|Mt)\.?\s+(\d{1,2}):(\d{1,3})(?:\s*[-–]\s*(\d{1,3}))?/gi;
  for (const m of String(text || '').matchAll(re)) {
    const r = parseRef(`${m[1]} ${m[2]}:${m[3]}${m[4] ? '-' + m[4] : ''}`);
    if (!r) continue; const k = refLabel(r); if (seen.has(k)) continue; seen.add(k); out.push(k);
  }
  return out;
}

// ---- the verse sheet: every verse opens in its place ---------------------------------------------------------------
export function openVerse(ref, { whole = false } = {}) {
  const r = typeof ref === 'string' ? parseRef(ref) : ref; if (!r) return;
  const all = chapter(r.book, r.ch);
  modal(close => {
    const box = h('div', { class: 'vsheet' });
    const draw = full => {
      const from = full ? 1 : Math.max(1, r.v1 - 3), to = full ? all.length : Math.min(all.length, r.v2 + 3);
      const rows = [];
      for (let v = from; v <= to; v++) rows.push(h('p', { class: 'vv' + (v >= r.v1 && v <= r.v2 ? ' hl' : '') }, h('sup', null, v), all[v - 1]));
      fill(box,
        h('p', { class: 'sub' }, full ? `The whole chapter. ${refLabel(r, true)} is marked.` : 'Read in its place: the verses around it, not just the one line.'),
        h('div', { class: 'vbody' }, rows),
        h('div', { class: 'row gap wrap vacts' },
          !full && btn(`Read all of ${BOOKS[r.book]} ${r.ch}`, () => draw(true), 'tiny', 'book'),
          btn('Make it my memory verse', () => { setMemory(refLabel(r)); toast(`${refLabel(r, true)} is this week’s memory verse`); close(); }, 'tiny', 'star'),
          btn('Save to a note', () => { saveToNote(r); close(); }, 'tiny', 'note')));
      if (full) setTimeout(() => box.querySelector('.vv.hl')?.scrollIntoView({ block: 'center' }), 30);
    };
    draw(whole);
    return box;
  }, { title: `${BOOKS[r.book]} ${r.ch} · KJV`, cls: 'vmodal' });
}
function saveToNote(r) {
  const n = M.addNote({ title: refLabel(r, true), notebook: 'Scripture', tags: ['scripture'], body: mdToHtml(`> ${verseText(r)}\n\n— ${refLabel(r, true)} (KJV)\n\n`) });
  toast('Saved to the Scripture notebook', 'Open', () => { location.hash = '#/note/' + n.id; });
}
/** Proverbs of the day: the chapter that matches the date (31 chapters, so once through every month). */
export const todaysChapter = (d = today()) => Math.min(31, fromYmd(d).getDate());
export function openChapter(n = todaysChapter()) { openVerse({ book: 'prov', ch: n, v1: 1, v2: 1 }, { whole: true }); }

// ---- memory verse of the week ---------------------------------------------------------------------------------------
// 52 verses, a year's worth, alternating Proverbs and the Sermon on the Mount. Week 1 began Monday, November 23, 2026.
export const MEMORY = ['Prov 3:5-6', 'Matt 6:33', 'Prov 4:23', 'Matt 5:16', 'Prov 16:3', 'Matt 6:34', 'Prov 3:9-10', 'Matt 7:24', 'Prov 15:1', 'Matt 5:3',
  'Prov 18:10', 'Matt 6:19-20', 'Prov 22:6', 'Matt 5:44', 'Prov 27:17', 'Matt 6:6', 'Prov 16:9', 'Matt 7:7', 'Prov 1:7', 'Matt 5:37',
  'Prov 10:4', 'Matt 6:24', 'Prov 11:2', 'Matt 7:12', 'Prov 12:22', 'Matt 5:8', 'Prov 14:12', 'Matt 6:9-10', 'Prov 15:22', 'Matt 7:13-14',
  'Prov 17:17', 'Matt 5:14', 'Prov 19:21', 'Matt 6:21', 'Prov 21:5', 'Matt 7:1', 'Prov 22:1', 'Matt 5:6', 'Prov 24:27', 'Matt 6:22',
  'Prov 25:11', 'Matt 5:9', 'Prov 27:1', 'Matt 6:14', 'Prov 28:13', 'Matt 7:20', 'Prov 29:25', 'Matt 6:26', 'Prov 31:10', 'Matt 7:11',
  'Prov 4:18', 'Matt 5:5'];
const EPOCH = '2026-11-23';
const mondayOf = d => { const x = fromYmd(d), wd = (x.getDay() + 6) % 7; return addDays(d, -wd); };
export const memoryWeek = (d = today()) => Math.floor(Math.round((fromYmd(mondayOf(d)) - fromYmd(EPOCH)) / 864e5) / 7);
export function memoryRef(d = today()) {
  const w = memoryWeek(d), own = settings.get('memoryRef');
  if (own && own.week === w && parseRef(own.ref)) return own.ref;
  return MEMORY[((w % 52) + 52) % 52];
}
function setMemory(ref) { settings.set('memoryRef', { ref, week: memoryWeek() }); }
const practiced = () => { try { return JSON.parse(localStorage.getItem('steward.memory.days') || '[]'); } catch { return []; } };
const markPracticed = () => { const d = practiced(); if (!d.includes(today())) d.push(today()); try { localStorage.setItem('steward.memory.days', JSON.stringify(d.slice(-120))); } catch {} };
const letters = t => t.replace(/[A-Za-z’']+/g, w => w[0]);

export function renderMemory(main) {
  const ref = memoryRef(), r = parseRef(ref), text = verseText(r), w = memoryWeek();
  let mode; try { mode = localStorage.getItem('steward.memory.mode') || 'letters'; } catch { mode = 'letters'; }
  const face = h('div', { class: 'mv-face' });
  const words = text.split(' ');
  let shown = 0;
  const draw = () => {
    const body = mode === 'read' ? text : mode === 'blank' ? words.map((x, i) => i < shown ? x : '＿'.repeat(Math.min(4, Math.max(1, Math.ceil(x.length / 3))))).join(' ')
      : words.map((x, i) => i < shown ? x : letters(x)).join(' ');
    fill(face, h('p', { class: 'mv-text' + (mode !== 'read' ? ' hint' : '') }, body), h('p', { class: 'mv-ref' }, refLabel(r, true)));
  };
  const seg = h('div', { class: 'seg' }, [['read', 'Read'], ['letters', 'First letters'], ['blank', 'Blank']].map(([k, l]) => h('button', { type: 'button', class: k === mode ? 'on' : '', onclick: e => { mode = k; shown = 0; try { localStorage.setItem('steward.memory.mode', k); } catch {} seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === e.currentTarget)); draw(); } }, l)));
  const days = practiced(), mon = mondayOf(today());
  const week = [0, 1, 2, 3, 4, 5, 6].map(i => { const d = addDays(mon, i); return h('span', { class: 'mv-day' + (days.includes(d) ? ' on' : '') + (fromYmd(d).getDay() === settings.get('restDay') ? ' rest' : ''), title: fromYmd(d).toLocaleDateString(undefined, { weekday: 'long' }) }, 'MTWTFSS'[i]); });
  main.append(h('header', { class: 'vhead' }, h('div', null, h('div', { class: 'kicker' }, `Memory verse · week ${((w % 52) + 52) % 52 + 1} of 52`), h('h1', null, refLabel(r, true)))),
    seg, h('section', { class: 'card mv-card' }, face,
      h('div', { class: 'row gap wrap' }, btn('Reveal next word', () => { shown = Math.min(words.length, shown + 1); draw(); }, ''), btn('I’ve got it', () => { markPracticed(); shown = words.length; draw(); toast('Practiced today'); render(); }, 'primary', 'check'), btn('In context', () => openVerse(r), 'link'))),
    h('section', { class: 'card' }, h('div', { class: 'row between' }, h('b', null, 'This week'), h('span', { class: 'sub' }, 'practiced in devotions')), h('div', { class: 'mv-week' }, week),
      h('p', { class: 'sub' }, '52 verses a year from Proverbs and Matthew 5–7. In the second year, last year’s verses come back for review. Choose your own from any verse sheet: Make it my memory verse.')));
  draw();
  function render() { const m2 = main; fill(m2); renderMemory(m2); }
}

// ---- First light: once each morning ---------------------------------------------------------------------------------
export function maybeFirstLight() {
  if (!scriptureOn() || settings.get('firstLight') === false) return;
  const d = new Date(), hr = d.getHours(), key = 'steward.firstLight';
  if (hr < 4 || hr >= 12) return;
  try { if (localStorage.getItem(key) === today()) return; localStorage.setItem(key, today()); } catch { return; }
  if (['focus', 'review', 'note'].includes(document.body.dataset.view)) return;
  showFirstLight();
}
export function showFirstLight() {
  const ch = todaysChapter(), mem = parseRef(memoryRef());
  const wrap = h('div', { class: 'firstlight', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Good morning' });
  const close = () => { wrap.classList.add('leaving'); setTimeout(() => wrap.remove(), 350); };
  fill(wrap,
    h('div', { class: 'fl-sun', 'aria-hidden': 'true' }), ridgeSvg('fl-ridge'),
    h('div', { class: 'fl-top' },
      h('div', { class: 'kicker' }, new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })),
      h('h1', null, 'Good morning'),
      verseEl(pick('firstlight'), { force: true, cls: 'big' })),
    h('div', { class: 'fl-bottom' },
      h('button', { type: 'button', class: 'fl-card', onclick: () => openChapter(ch) }, h('span', null, h('span', { class: 'kicker' }, 'Today’s chapter'), h('b', null, `Proverbs ${ch}`)), h('span', { class: 'btn tiny' }, 'Read')),
      h('button', { type: 'button', class: 'fl-card', onclick: () => { close(); location.hash = '#/memory'; } }, h('span', null, h('span', { class: 'kicker' }, 'Memory verse'), h('b', null, refLabel(mem, true))), h('span', { class: 'btn tiny' }, 'Practice')),
      h('button', { type: 'button', class: 'btn primary fl-go', onclick: close }, 'Into the day'),
      h('p', { class: 'sub center' }, 'Shows once each morning. Turn it off in Settings → Appearance.')));
  const esc = e => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); } };
  document.addEventListener('keydown', esc);
  document.body.append(wrap);
}

/** The layered ridge that runs along the top of every screen. Decorative. */
export function ridgeSvg(cls) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', cls); svg.setAttribute('viewBox', '0 0 390 150'); svg.setAttribute('preserveAspectRatio', 'none'); svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = '<g class="r-far"><path d="M-30 92 L30 60 L80 78 L140 36 L200 70 L250 50 L310 80 L360 42 L440 72 L440 150 L-30 150Z"/></g><g class="r-near"><path d="M-30 124 L40 98 L95 110 L150 86 L215 112 L270 94 L330 114 L440 100 L440 150 L-30 150Z"/><path class="r-pines" d="M62 108 l7 -18 l7 18z M80 110 l5 -13 l5 13z M286 100 l7 -18 l7 18z M300 104 l5 -13 l5 13z"/></g>';
  return svg;
}

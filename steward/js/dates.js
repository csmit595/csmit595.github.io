// Plain-language dates ("tomorrow 3pm", "every other fri") and repeating-task logic.
import { ymd, today, fromYmd, addDays, pad, fmtDate, fmtTime } from './util.js';

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAY_RE = '(?:sun(?:day)?|mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?)';
const MON_RE = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const dayIdx = s => DAYS.indexOf(s.slice(0, 3).toLowerCase());
const monIdx = s => MONTHS.indexOf(s.slice(0, 3).toLowerCase());

function nextDow(base, dow, strictlyAfter = true) {
  const d = fromYmd(base);
  let diff = (dow - d.getDay() + 7) % 7;
  if (diff === 0 && strictlyAfter) diff = 7;
  return addDays(base, diff);
}
function addMonths(s, n, dom) {
  const d = fromYmd(s);
  const want = dom || d.getDate();
  const t = new Date(d.getFullYear(), d.getMonth() + n, 1);
  const last = new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate();
  t.setDate(Math.min(want, last));
  return ymd(t);
}
const weekStart = s => addDays(s, -fromYmd(s).getDay());
/** The nth (1-4, or -1 for last) given weekday of a month, as YYYY-MM-DD. */
export function nthWeekday(year, month, nth, dow) {
  if (nth === -1) { const d = new Date(year, month + 1, 0); while (d.getDay() !== dow) d.setDate(d.getDate() - 1); return ymd(d); }
  const d = new Date(year, month, 1); while (d.getDay() !== dow) d.setDate(d.getDate() + 1);
  d.setDate(d.getDate() + 7 * (nth - 1));
  return d.getMonth() === month ? ymd(d) : nthWeekday(year, month, -1, dow);
}
const NTH = { first: 1, '1st': 1, second: 2, '2nd': 2, third: 3, '3rd': 3, fourth: 4, '4th': 4, last: -1 };

/** Next due date for a repeating rule, given the current due date. */
export function nextOccurrence(due, now = today()) {
  const r = due.recur;
  if (!r) return null;
  const step = base => {
    const n = r.n || 1;
    if (r.unit === 'day') {
      if (r.days?.length) { let d = base; for (let i = 0; i < 14; i++) { d = addDays(d, 1); if (r.days.includes(fromYmd(d).getDay())) return d; } }
      return addDays(base, n);
    }
    if (r.unit === 'week') {
      if (!r.days?.length) return addDays(base, 7 * n);
      const anchor = weekStart(r.anchor || base);
      let d = base;
      for (let i = 0; i < 7 * n + 7; i++) {
        d = addDays(d, 1);
        const weeks = Math.round((fromYmd(weekStart(d)) - fromYmd(anchor)) / (7 * 864e5));
        if (r.days.includes(fromYmd(d).getDay()) && ((weeks % n) + n) % n === 0) return d;
      }
      return addDays(base, 7 * n);
    }
    if (r.unit === 'month' && r.nth) { const d = fromYmd(base); const t = new Date(d.getFullYear(), d.getMonth() + n, 1); return nthWeekday(t.getFullYear(), t.getMonth(), r.nth, r.dow); }
    if (r.unit === 'month') return addMonths(base, n, r.dom);
    if (r.unit === 'year') {
      const d = fromYmd(base), a = r.anchor ? fromYmd(r.anchor) : d, y = d.getFullYear() + n;
      const last = new Date(y, a.getMonth() + 1, 0).getDate();
      return ymd(new Date(y, a.getMonth(), Math.min(a.getDate(), last)));
    }
    return addDays(base, 1);
  };
  let next = step(r.fromDone ? now : due.date);
  let guard = 0;
  while (!r.fromDone && next <= now && guard++ < 2000) next = step(next);
  return next;
}

// "John 3:16", "1 Cor 13:4-7", "Ps 23:1" are verses, not times of day.
const BOOKS = 'gen(?:esis)?|ex(?:od(?:us)?)?|lev(?:iticus)?|num(?:bers)?|deut(?:eronomy)?|josh(?:ua)?|judg(?:es)?|ruth|sam(?:uel)?|kings|kgs|chr(?:on(?:icles)?)?|ezra|neh(?:emiah)?|esth(?:er)?|job|ps(?:a|alm|alms)?|prov(?:erbs)?|eccl(?:es(?:iastes)?)?|song(?: of (?:songs|solomon))?|isa(?:iah)?|jer(?:emiah)?|lam(?:entations)?|ezek(?:iel)?|dan(?:iel)?|hos(?:ea)?|joel|amos|obad(?:iah)?|jonah|mic(?:ah)?|nah(?:um)?|hab(?:akkuk)?|zeph(?:aniah)?|hag(?:gai)?|zech(?:ariah)?|mal(?:achi)?|matt(?:hew)?|mt|mark|mk|luke|lk|john|jn|acts|rom(?:ans)?|cor(?:inthians)?|gal(?:atians)?|eph(?:esians)?|phil(?:ippians)?|col(?:ossians)?|thess(?:alonians)?|tim(?:othy)?|tit(?:us)?|philem(?:on)?|phlm|heb(?:rews)?|jam(?:es)?|jas|pet(?:er)?|jude|rev(?:elation)?';
const VERSE_BEFORE = new RegExp(`\\b(?:${BOOKS})\\.?\\s*$`, 'i');
/** A bare "3:16" is a verse when a book of the Bible comes right before it, or a verse range or list follows ("2:42-47", "5:3,10"). */
const isVerse = (text, m) => VERSE_BEFORE.test(text.slice(0, m.index)) || /^\s*(?:[-–—]\s*\d|,\s*\d|ff\b)/.test(text.slice(m.index + m[0].length));
/** "at 14 Oak St" is an address, not 2 PM: a bare "at 3" is not a time when a capitalised word follows it, or a 24-hour number is followed by any word. */
const isAddress = (n, after) => /^\s+[A-Z][a-z]/.test(after) || (n > 12 && /^\s+[a-z]/i.test(after) && !/^\s+(?:p[1-4]|for|on|by|with|and|every|ev)\b/i.test(after));

function parseTime(text, partOk = false) {
  let m;
  const cut = (m) => text.slice(0, m.index) + ' ' + text.slice(m.index + m[0].length);
  if ((m = text.match(/\b(?:at\s+)?(noon|midnight)\b/i))) return { time: m[1].toLowerCase() === 'noon' ? '12:00' : '00:00', rest: cut(m) };
  if ((m = text.match(/\b(?:at\s+|@\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i))) {
    let H = +m[1] % 12; if (/^p/i.test(m[3])) H += 12;
    if (+m[1] <= 12) return { time: `${pad(H)}:${m[2] || '00'}`, rest: cut(m) };
  }
  for (const s of text.matchAll(/\b(at\s+)?([01]?\d|2[0-3]):([0-5]\d)\b/gi)) { if (!s[1] && isVerse(text, s)) continue; return { time: `${pad(+s[2])}:${s[3]}`, rest: cut(s) }; }
  if ((m = text.match(/\bat\s+(\d{1,2})\b(?!\s*[\/.:-]\d)/i)) && +m[1] <= 23 && !isAddress(+m[1], text.slice(m.index + m[0].length))) {
    let H = +m[1]; if (H >= 1 && H <= 6) H += 12; // "at 3" means 3 PM for working hours
    return { time: `${pad(H)}:00`, rest: cut(m) };
  }
  // "morning/afternoon/evening" only count as a time when they clearly mean one ("in the morning", "this evening",
  // "tomorrow morning", or last word) so "evening primrose" and "morning glory" stay plant names.
  const PART = { morning: '09:00', afternoon: '13:00', evening: '19:00' };
  if ((m = text.match(/\b(?:in the|this)\s+(morning|afternoon|evening)\b/i))) return { time: PART[m[1].toLowerCase()], rest: cut(m) };
  if ((m = text.match(/\b(morning|afternoon|evening)\s*$/i)) || (partOk && (m = text.match(/\b(morning|afternoon|evening)\b/i)))) return { time: PART[m[1].toLowerCase()], rest: cut(m) };
  return null;
}
/** Short day names that are also everyday words ("full sun", "sat down", "wed") only count as days when nothing else follows them, or a time does. */
const WORD_DAYS = new Set(['sun', 'sat', 'wed']);
const TIME_NEXT = /^\s*(?:$|[,.;!)]|at\b|@|noon|midnight|morning|afternoon|evening|night|\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b|by\b|for\b)/i;
/** "1/2", "3/4", "5/8" read as fractions (pipe sizes, gravel), not dates, unless written "on 3/4" or with a year. */
function isFraction(text, m) {
  const a = +m[1], b = +m[2];
  if (m[3]) return false;
  const before = text.slice(0, m.index);
  if (/\b(on|due|by|before|until|till|from)\s*$/i.test(before)) return false;
  if (/\d\s*$/.test(before) || /^\s*-?\s*(?:"|'|in\b|inch|ft\b|foot|feet|yd|yard|ton|cu|gal|lb|hp|mm|cm|-)/i.test(text.slice(m.index + m[0].length))) return true;
  return a < b && [2, 3, 4, 8, 16, 32].includes(b);
}

/** Words that mean a task repeats. Used to warn when a repeat was asked for but not understood. */
export const looksRepeating = text => new RegExp(`\\b(?:(?:every|ev)!?\\s+(?:other\\b|\\d|a\\s|an\\s|few\\b|couple\\b|single\\s+(?:day|week)|(?:first|second|third|fourth|last|1st|2nd|3rd|4th)\\b|day|week|month|quarter|year|morning|afternoon|evening|night|${DAY_RE}\\b)|daily|weekly|monthly|yearly|annually|biweekly|fortnightly|quarterly)`, 'i').test(text || '') && !/\b(?:every|ev)\s+(?:day|week|month|year)s?\s+(?:that|we|i|he|she|they|it|is|was)\b/i.test(text || '');

function parseRecur(text) {
  let m0;
  // "every first monday", "every last fri", "every month on the 2nd tuesday"
  if ((m0 = text.match(new RegExp(`\\b(?:every|ev)\\s+(?:(other)\\s+)?(?:month\\s+on\\s+the\\s+)?(first|1st|second|2nd|third|3rd|fourth|4th|last)\\s+(${DAY_RE})\\b(?:\\s+of\\s+(?:the|every)\\s+month)?`, 'i')))) {
    const r = { n: m0[1] ? 2 : 1, unit: 'month', nth: NTH[m0[2].toLowerCase()], dow: dayIdx(m0[3]), text: m0[0].trim().replace(/\s+/g, ' ') };
    return { recur: r, rest: text.slice(0, m0.index) + ' ' + text.slice(m0.index + m0[0].length) };
  }
  // "every last day", "every last day of the month", "every month on the last day"
  if ((m0 = text.match(/\b(?:every|ev)\s+(?:month\s+on\s+the\s+)?last\s+day(?:\s+of\s+(?:the|every)\s+month)?\b/i))) {
    return { recur: { n: 1, unit: 'month', dom: 31, text: m0[0].trim().replace(/\s+/g, ' ') }, rest: text.slice(0, m0.index) + ' ' + text.slice(m0.index + m0[0].length) };
  }
  // "every month on the 15th", "monthly on the 1st"
  if ((m0 = text.match(/\b(?:(?:every|ev)\s+month|monthly)\s+on\s+the\s+(\d{1,2})(?:st|nd|rd|th)?\b/i))) {
    return { recur: { n: 1, unit: 'month', dom: Math.min(31, +m0[1]), text: m0[0].trim().replace(/\s+/g, ' ') }, rest: text.slice(0, m0.index) + ' ' + text.slice(m0.index + m0[0].length) };
  }
  if ((m0 = text.match(/\b(?:every|ev)\s+quarter\b/i))) return { recur: { n: 3, unit: 'month', text: m0[0].trim().replace(/\s+/g, ' ') }, rest: text.slice(0, m0.index) + ' ' + text.slice(m0.index + m0[0].length) };
  const re = new RegExp(`\\b(?:(?<ev>every!?|ev)\\s+(?:(?<other>other)\\s+|(?<num>\\d+)(?<ord>st|nd|rd|th)?(?:\\s+|$))?(?<unit>days?|weeks?|months?|years?|weekdays?|workdays?|weekends?|${DAY_RE}(?:\\s*(?:,|and|&)\\s*${DAY_RE})*)?|(?<word>daily|weekly|biweekly|fortnightly|monthly|quarterly|yearly|annually))(?![\\w])`, 'i');
  const m = text.match(re);
  if (!m) return null;
  const g = m.groups;
  const rest = () => text.slice(0, m.index) + ' ' + text.slice(m.index + m[0].length);
  const r = { n: 1, text: m[0].trim().replace(/\s+/g, ' ') };
  if (g.word) {
    const w = g.word.toLowerCase();
    if (w === 'daily') r.unit = 'day';
    else if (w === 'weekly') r.unit = 'week';
    else if (w === 'biweekly' || w === 'fortnightly') { r.unit = 'week'; r.n = 2; }
    else if (w === 'monthly') r.unit = 'month';
    else if (w === 'quarterly') { r.unit = 'month'; r.n = 3; }
    else r.unit = 'year';
    return { recur: r, rest: rest() };
  }
  if (g.ev.endsWith('!')) r.fromDone = true;
  if (g.other) r.n = 2;
  const unit = (g.unit || '').toLowerCase();
  if (!unit) {
    if (g.num && g.ord) { r.unit = 'month'; r.dom = Math.min(31, +g.num); return { recur: r, rest: rest() }; } // "every 15th"
    return null;
  }
  if (g.num) r.n = +g.num;
  if (/^day/.test(unit)) r.unit = 'day';
  else if (/^weekday|^workday/.test(unit)) { r.unit = 'day'; r.days = [1, 2, 3, 4, 5]; }
  else if (/^weekend/.test(unit)) { r.unit = 'week'; r.days = [0, 6]; }
  else if (/^week/.test(unit)) r.unit = 'week';
  else if (/^month/.test(unit)) r.unit = 'month';
  else if (/^year/.test(unit)) r.unit = 'year';
  else { r.unit = 'week'; r.days = [...new Set((unit.match(new RegExp(DAY_RE, 'gi')) || []).map(dayIdx))].sort(); }
  return { recur: r, rest: rest() };
}

function parseDay(text, now) {
  let m;
  const cut = m => text.slice(0, m.index) + ' ' + text.slice(m.index + m[0].length);
  const y = fromYmd(now).getFullYear();
  const real = (yr, mo, d) => { const dt = new Date(yr, mo, d); return dt.getFullYear() === yr && dt.getMonth() === mo && dt.getDate() === d ? dt : null; }; // rejects Feb 30 and the like
  const future = (mo, d, yr) => {
    let dt = real(yr || y, mo, d);
    if (!yr && (!dt || ymd(dt) < now)) dt = real(y + 1, mo, d) || dt;
    return dt ? ymd(dt) : null;
  };
  if ((m = text.match(/\b(today|tod|tonight)\b/i))) return { date: now, rest: cut(m), time: /tonight/i.test(m[1]) ? '19:00' : null };
  if ((m = text.match(/\b(tomorrow|tom|tmrw|tmr)\b/i))) return { date: addDays(now, 1), rest: cut(m) };
  if ((m = text.match(/\byesterday\b/i))) return { date: addDays(now, -1), rest: cut(m) };
  if ((m = text.match(/\bin\s+(\d+|a|an)\s+(day|week|month|year)s?\b/i))) {
    const n = /^a/i.test(m[1]) ? 1 : +m[1], u = m[2].toLowerCase();
    const date = u === 'day' ? addDays(now, n) : u === 'week' ? addDays(now, 7 * n) : u === 'month' ? addMonths(now, n) : addMonths(now, 12 * n);
    return { date, rest: cut(m) };
  }
  if ((m = text.match(/\bnext\s+week\b/i))) return { date: nextDow(now, 1), rest: cut(m) };
  if ((m = text.match(/\bnext\s+month\b/i))) return { date: addMonths(now, 1, 1), rest: cut(m) };
  if ((m = text.match(/\b(?:this\s+)?weekend\b/i))) return { date: nextDow(now, 6, false), rest: cut(m) };
  if ((m = text.match(/\bend\s+of\s+(?:the\s+)?month\b/i))) return { date: addMonths(now, 0, 31), rest: cut(m) };
  if ((m = text.match(new RegExp(`\\b(${MON_RE})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, 'i')))) { const date = future(monIdx(m[1]), +m[2], m[3] && +m[3]); if (date) return { date, rest: cut(m) }; }
  if ((m = text.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MON_RE})\\b(?:,?\\s+(\\d{4}))?`, 'i')))) { const date = future(monIdx(m[2]), +m[1], m[3] && +m[3]); if (date) return { date, rest: cut(m) }; }
  for (const s of text.matchAll(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g)) {
    if (+s[1] > 12 || +s[2] > 31 || isFraction(text, s)) continue;
    const yr = s[3] ? (+s[3] < 100 ? 2000 + +s[3] : +s[3]) : null;
    const date = future(+s[1] - 1, +s[2], yr); if (date) return { date, rest: cut(s) };
  }
  if ((m = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/)) && real(+m[1], +m[2] - 1, +m[3])) return { date: m[0], rest: cut(m) };
  for (const s of text.matchAll(new RegExp(`\\b(next\\s+|this\\s+|on\\s+|by\\s+|due\\s+)?(${DAY_RE})\\b`, 'gi'))) {
    // "full sun shrubs": a bare "sun", "sat" or "wed" followed by more words is not a day
    if (!s[1] && WORD_DAYS.has(s[2].toLowerCase()) && !TIME_NEXT.test(text.slice(s.index + s[0].length))) continue;
    m = s;
    let date = nextDow(now, dayIdx(m[2]), !/this/i.test(m[1] || ''));
    if (/next/i.test(m[1] || '') && fromYmd(date).getDay() > fromYmd(now).getDay() && fromYmd(now).getDay() !== 0) date = addDays(date, 7);
    return { date, rest: cut(m) };
  }
  return null;
}

/** Parse a date phrase. Returns {date,time,recur} plus the leftover text, or null if no date was found. */
export function parseDue(text, now = today()) {
  let rest = text, recur = null, date = null, time = null;
  const rr = parseRecur(rest);
  if (rr) { recur = rr.recur; rest = rr.rest.replace(/\b(starting|from)\s+(?=\S)/i, ' '); }
  const dd = parseDay(rest, now);
  if (dd) { date = dd.date; rest = dd.rest; if (dd.time) time = dd.time; }
  const partOk = new RegExp(`\\b(?:today|tod|tomorrow|tom|tmrw|tmr|${DAY_RE}|\\d{1,2}(?:st|nd|rd|th)?)\\s+(?:morning|afternoon|evening)\\b`, 'i').test(text);
  const tt = parseTime(rest, partOk);
  if (tt) { time = tt.time; rest = tt.rest; }
  if (!recur && !date && !time) return null;
  if (!date) {
    if (recur?.days?.length) { date = now; for (let i = 0; i < 7 && !recur.days.includes(fromYmd(date).getDay()); i++) date = addDays(date, 1); }
    else if (recur?.nth) { const d = fromYmd(now); date = nthWeekday(d.getFullYear(), d.getMonth(), recur.nth, recur.dow); if (date < now) { const t = new Date(d.getFullYear(), d.getMonth() + 1, 1); date = nthWeekday(t.getFullYear(), t.getMonth(), recur.nth, recur.dow); } }
    else if (recur?.dom) { date = addMonths(now, 0, recur.dom); if (date < now) date = addMonths(now, 1, recur.dom); }
    else date = now;
  }
  if (recur) { recur.anchor = date; if (recur.unit === 'month' && !recur.dom && !recur.nth) recur.dom = fromYmd(date).getDate(); }
  rest = rest.replace(/\s+(on|at|by|due)\s*$/i, '').replace(/\s{2,}/g, ' ').trim();
  return { due: { date, time: time || null, recur: recur || null }, rest };
}

/** Quick add: "Mulch at Hanel fri 8am p1 #Projects @promise for 2h" */
export function parseQuickAdd(text, ctx, opts = {}) {
  const out = { content: text, priority: 4, labels: [], projectId: null, sectionId: null, due: null, deadline: null, duration: null, chips: [], dueChip: null };
  let s = ' ' + text + ' ';
  let m;
  // {nov 20} sets a deadline, as in Todoist
  if ((m = s.match(/\{([^}]+)\}/))) { const d = parseDue(m[1].trim()); if (d && !d.due.recur) { out.deadline = d.due.date; s = s.replace(m[0], ' '); out.chips.push('⚑ ' + fmtDate(d.due.date)); } }
  if ((m = s.match(/\s[pP]([1-4])(?=\s)/))) { out.priority = +m[1]; s = s.replace(m[0], ' '); out.chips.push('Priority ' + m[1]); }
  // #Project (longest matching project name wins, so names with spaces work)
  const hash = s.indexOf(' #');
  if (hash >= 0) {
    const after = s.slice(hash + 2).toLowerCase();
    const p = [...ctx.projects].sort((a, b) => b.name.length - a.name.length).find(p => after.startsWith(p.name.toLowerCase() + ' ') || after.startsWith(p.name.toLowerCase().replace(/\s+/g, '') + ' '));
    if (p) {
      const used = after.startsWith(p.name.toLowerCase() + ' ') ? p.name.length : p.name.replace(/\s+/g, '').length;
      out.projectId = p.id; s = s.slice(0, hash) + ' ' + s.slice(hash + 2 + used); out.chips.push('#' + p.name);
    }
  }
  if (out.projectId && (m = s.match(/\s\/([^\s/]+)(?=\s)/))) {
    const sec = ctx.sections.find(x => x.projectId === out.projectId && x.name.toLowerCase().replace(/\s+/g, '').startsWith(m[1].toLowerCase()));
    if (sec) { out.sectionId = sec.id; s = s.replace(m[0], ' '); out.chips.push('/' + sec.name); }
  }
  const lre = /\s@([\w-]+)(?=\s)/g;
  while ((m = lre.exec(s))) { out.labels.push(m[1]); out.chips.push('@' + m[1]); }
  s = s.replace(lre, ' ');
  if ((m = s.match(/\sfor\s+(\d+(?:\.\d+)?)\s*(m|min|mins|minutes|h|hr|hrs|hours?)(?=\s)/i))) {
    out.duration = Math.round(+m[1] * (/^h/i.test(m[2]) ? 60 : 1)); s = s.replace(m[0], ' '); out.chips.push(out.duration + ' min');
  }
  // opts.keepDate: the person tapped the date chip to say "those words are part of the name, not a date"
  const d = opts.keepDate ? null : parseDue(s.trim());
  if (d && d.rest.trim()) { out.due = d.due; s = d.rest; out.dueChip = describeDue(d.due); }
  if (!opts.keepDate && looksRepeating(text.replace(/\{[^}]*\}/g, '')) && !out.due?.recur) { out.repeatProblem = true; out.chips.push('⚠ repeat not understood'); }
  out.content = s.replace(/\s{2,}/g, ' ').trim();
  return out;
}

export function describeDue(due) {
  if (!due) return '';
  let s = fmtDate(due.date);
  if (due.time) s += ' ' + fmtTime(due.time);
  if (due.recur) s += ' ↻ ' + due.recur.text;
  return s;
}

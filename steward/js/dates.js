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
    if (r.unit === 'month') return addMonths(base, n, r.dom);
    if (r.unit === 'year') { const d = fromYmd(base); d.setFullYear(d.getFullYear() + n); return ymd(d); }
    return addDays(base, 1);
  };
  let next = step(r.fromDone ? now : due.date);
  let guard = 0;
  while (!r.fromDone && next <= now && guard++ < 2000) next = step(next);
  return next;
}

function parseTime(text) {
  let m;
  const cut = (m) => text.slice(0, m.index) + ' ' + text.slice(m.index + m[0].length);
  if ((m = text.match(/\b(?:at\s+)?(noon|midnight)\b/i))) return { time: m[1].toLowerCase() === 'noon' ? '12:00' : '00:00', rest: cut(m) };
  if ((m = text.match(/\b(?:at\s+|@\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i))) {
    let H = +m[1] % 12; if (/^p/i.test(m[3])) H += 12;
    if (+m[1] <= 12) return { time: `${pad(H)}:${m[2] || '00'}`, rest: cut(m) };
  }
  if ((m = text.match(/\b(?:at\s+)?([01]?\d|2[0-3]):([0-5]\d)\b/))) return { time: `${pad(+m[1])}:${m[2]}`, rest: cut(m) };
  if ((m = text.match(/\bat\s+(\d{1,2})\b(?!\s*[\/.-]\d)/i)) && +m[1] <= 23) {
    let H = +m[1]; if (H >= 1 && H <= 6) H += 12; // "at 3" means 3 PM for working hours
    return { time: `${pad(H)}:00`, rest: cut(m) };
  }
  if ((m = text.match(/\b(?:in the\s+|this\s+)?(morning|afternoon|evening)\b/i))) return { time: { morning: '09:00', afternoon: '13:00', evening: '19:00' }[m[1].toLowerCase()], rest: cut(m) };
  return null;
}

function parseRecur(text) {
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
  else if (/^weekend/.test(unit)) { r.unit = 'week'; r.days = [6]; }
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
  const future = (mo, d, yr) => {
    let dt = new Date(yr || y, mo, d);
    if (!yr && ymd(dt) < now) dt = new Date(y + 1, mo, d);
    return ymd(dt);
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
  if ((m = text.match(new RegExp(`\\b(${MON_RE})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, 'i')))) return { date: future(monIdx(m[1]), +m[2], m[3] && +m[3]), rest: cut(m) };
  if ((m = text.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MON_RE})\\b(?:,?\\s+(\\d{4}))?`, 'i')))) return { date: future(monIdx(m[2]), +m[1], m[3] && +m[3]), rest: cut(m) };
  if ((m = text.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/)) && +m[1] <= 12 && +m[2] <= 31) {
    const yr = m[3] ? (+m[3] < 100 ? 2000 + +m[3] : +m[3]) : null;
    return { date: future(+m[1] - 1, +m[2], yr), rest: cut(m) };
  }
  if ((m = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/))) return { date: m[0], rest: cut(m) };
  if ((m = text.match(new RegExp(`\\b(next\\s+|this\\s+|on\\s+)?(${DAY_RE})\\b`, 'i')))) {
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
  const tt = parseTime(rest);
  if (tt) { time = tt.time; rest = tt.rest; }
  if (!recur && !date && !time) return null;
  if (!date) {
    if (recur?.days?.length) { date = now; for (let i = 0; i < 7 && !recur.days.includes(fromYmd(date).getDay()); i++) date = addDays(date, 1); }
    else if (recur?.dom) { date = addMonths(now, 0, recur.dom); if (date < now) date = addMonths(now, 1, recur.dom); }
    else date = now;
  }
  if (recur) { recur.anchor = date; if (recur.unit === 'month' && !recur.dom) recur.dom = fromYmd(date).getDate(); }
  rest = rest.replace(/\s+(on|at|by|due)\s*$/i, '').replace(/\s{2,}/g, ' ').trim();
  return { due: { date, time: time || null, recur: recur || null }, rest };
}

/** Quick add: "Mulch at Hanel fri 8am p1 #Projects @promise for 2h" */
export function parseQuickAdd(text, ctx) {
  const out = { content: text, priority: 4, labels: [], projectId: null, sectionId: null, due: null, duration: null, chips: [] };
  let s = ' ' + text + ' ';
  let m;
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
  const d = parseDue(s.trim());
  if (d && d.rest.trim()) { out.due = d.due; s = d.rest; out.chips.unshift(describeDue(d.due)); }
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

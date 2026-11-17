// Saved-filter query language, modelled on Todoist's: "(today | overdue) & @promise", "p1 & #Hanel", "7 days & !@waiting"
import { today, addDays } from './util.js';
import { parseDue } from './dates.js';

function tokenize(q) {
  const toks = []; let cur = '';
  const flush = () => { if (cur.trim()) toks.push({ t: 'term', v: cur.trim() }); cur = ''; };
  for (let i = 0; i < q.length; i++) {
    const c = q[i];
    if (c === '\\' && i + 1 < q.length) { cur += q[++i]; continue; }
    if (c === '&' || c === '|' || c === ')') { flush(); toks.push({ t: c }); }
    else if ((c === '(' || c === '!') && !cur.trim()) { toks.push({ t: c }); }
    else cur += c;
  }
  flush();
  return toks;
}

function wild(pattern) {
  const re = new RegExp('^' + pattern.toLowerCase().split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
  return s => re.test(String(s || '').toLowerCase());
}

function term(raw, ctx) {
  const v = raw.toLowerCase().replace(/\s+/g, ' ').trim();
  const now = today();
  let m;
  if (v === 'today') return t => t.due?.date === now;
  if (v === 'tomorrow') return t => t.due?.date === addDays(now, 1);
  if (v === 'yesterday') return t => t.due?.date === addDays(now, -1);
  if (v === 'overdue' || v === 'od' || v === 'over due') return t => !!t.due && t.due.date < now;
  if (v === 'no date' || v === 'no due date') return t => !t.due;
  if (v === 'no time') return t => !t.due?.time;
  if (v === 'no priority') return t => (t.priority || 4) === 4;
  if (v === 'no labels' || v === 'no label') return t => !(t.labels || []).length;
  if (v === 'no section') return t => !t.sectionId;
  if (v === 'recurring') return t => !!t.due?.recur;
  if (v === 'deadline' || v === 'has deadline') return t => !!t.deadline;
  if (v === 'no deadline') return t => !t.deadline;
  if (v === 'subtask') return t => !!t.parentId;
  if (v === 'reminder' || v === 'has reminder') return t => !!(t.reminders || []).length;
  if (v === 'has note') return t => !!t.noteId;
  if (v === 'view all' || v === 'all') return () => true;
  if ((m = v.match(/^(?:p|priority )([1-4])$/))) return t => (t.priority || 4) === +m[1];
  if ((m = v.match(/^(?:next )?(\d+) days?$/))) { const end = addDays(now, +m[1] - 1); return t => !!t.due && t.due.date >= now && t.due.date <= end; }
  if ((m = v.match(/^(due|date|created|deadline) ?(before|after)?: ?(.+)$/))) {
    const d = parseDue(m[3], now)?.due.date;
    if (!d) return () => false;
    const get = m[1] === 'created' ? t => (t.createdAt ? new Date(t.createdAt).toLocaleDateString('en-CA') : null) : m[1] === 'deadline' ? t => t.deadline : t => t.due?.date;
    if (m[2] === 'before') return t => { const x = get(t); return !!x && x < d; };
    if (m[2] === 'after') return t => { const x = get(t); return !!x && x > d; };
    return t => get(t) === d;
  }
  if ((m = v.match(/^search: ?(.+)$/))) return t => (t.content + ' ' + (t.description || '')).toLowerCase().includes(m[1]);
  if (v.startsWith('@')) { const w = wild(v.slice(1)); return t => (t.labels || []).some(w); }
  if (v.startsWith('##')) {
    const w = wild(v.slice(2));
    const ids = new Set(ctx.projects.filter(p => w(p.name)).map(p => p.id));
    let grew = true;
    while (grew) { grew = false; for (const p of ctx.projects) if (p.parentId && ids.has(p.parentId) && !ids.has(p.id)) { ids.add(p.id); grew = true; } }
    if (w('inbox')) ids.add('inbox');
    return t => ids.has(t.projectId || 'inbox');
  }
  if (v.startsWith('#')) {
    const w = wild(v.slice(1));
    const ids = new Set(ctx.projects.filter(p => w(p.name)).map(p => p.id));
    if (w('inbox')) ids.add('inbox');
    return t => ids.has(t.projectId || 'inbox');
  }
  if (v.startsWith('/')) { const w = wild(v.slice(1)); const ids = new Set(ctx.sections.filter(s => w(s.name)).map(s => s.id)); return t => ids.has(t.sectionId); }
  const d = parseDue(v, now);
  if (d && !d.rest) return t => t.due?.date === d.due.date;
  return t => (t.content + ' ' + (t.description || '')).toLowerCase().includes(v);
}

function parse(toks, ctx) {
  let i = 0;
  const or = () => { let a = and(); while (toks[i]?.t === '|') { i++; const b = and(), l = a; a = t => l(t) || b(t); } return a; };
  const and = () => { let a = not(); while (toks[i]?.t === '&') { i++; const b = not(), l = a; a = t => l(t) && b(t); } return a; };
  const not = () => {
    const k = toks[i];
    if (!k) return () => true;
    if (k.t === '!') { i++; const a = not(); return t => !a(t); }
    if (k.t === '(') { i++; const a = or(); if (toks[i]?.t === ')') i++; return a; }
    if (k.t === 'term') { i++; return term(k.v, ctx); }
    i++; return () => true;
  };
  return or();
}

/** Returns a list of {title, test} groups (commas split a filter into several lists). */
export function compileFilter(query, ctx) {
  const parts = []; let depth = 0, cur = '';
  for (const c of query) {
    if (c === '(') depth++; if (c === ')') depth--;
    if (c === ',' && depth <= 0) { parts.push(cur); cur = ''; } else cur += c;
  }
  parts.push(cur);
  return parts.filter(p => p.trim()).map(p => {
    try { return { title: p.trim(), test: parse(tokenize(p), ctx) }; }
    catch { return { title: p.trim(), test: () => false }; }
  });
}

// Claude, online. Haiku sorts each new task or note (area, tags, customer promise, project or notebook, and whether a
// capture is a task or a note); Sonnet helps plan the day and helps with Writing. Steward is public code, so the API key
// never lives here: it stays in the Steward helper (Charles's own Google Apps Script), which adds it and asks Claude.
// With no signal, no helper or no key, everything falls back to the on-device organizer and nothing is lost.
import { h, fill, today, fromYmd, addDays, pad, fmtTime, mdToHtml, sanitize } from './util.js';
import { store, settings } from './store.js';
import * as M from './model.js';
import { sync } from './sync.js';
import { icon, btn, modal, toast } from './ui.js';
import * as C from './organize-core.js';

export const aiOn = () => settings.get('aiOn') === true;
let downUntil = 0, noKey = false;
/** Claude can be asked right now (switched on, signal, helper reachable, key saved). */
export const aiReady = () => aiOn() && !noKey && navigator.onLine && !!sync.helperUrl() && sync.connected() && Date.now() > downUntil;

/** Ask Claude through the helper. model: 'haiku' | 'sonnet'. Returns the reply's text. */
export async function ask(model, opts) { return (await askFull(model, opts)).text; }
/** Same as ask(), but returns { text, stop } so a reply cut off at the length limit can be told apart. */
export async function askFull(model, { system, messages, max_tokens }) {
  if (!navigator.onLine) throw new Error('No signal');
  const started = Date.now();
  try {
    const r = await helperRetrying('ai', { model, system, messages, max_tokens });
    if (r.usage) settings.set('aiUsageSeen', r.usage);
    return { text: r.text || '', stop: r.stop || null };
  } catch (e) {
    const m = String(e.message || e);
    if (/no-key|bad-key/.test(m)) { noKey = true; throw new Error('Claude is not set up yet: add your API key in Settings → Claude.'); }
    if (/no-credit/.test(m)) { downUntil = Date.now() + 30 * 60000; throw new Error('Your Anthropic account is out of credit. Add credit in the Claude Console (Billing).'); }
    if (/unknown request/.test(m)) { downUntil = Date.now() + 60 * 60000; throw new Error('The Steward helper needs updating before it can reach Claude.'); }
    if (isDropped(e)) throw new Error(`The connection to Claude dropped after ${Math.round((Date.now() - started) / 1000)} seconds (weak signal, or Steward was in the background), even after trying again. Nothing was changed. Try again with Steward open.`);
    downUntil = Date.now() + 3 * 60000; // a hiccup: use the device for a few minutes, then try Claude again
    throw e;
  }
}
// "Failed to fetch": the phone lost the connection mid-request (signal dropped, or Android paused Steward in the
// background while Claude was still answering). The helper never answered, so ask again: once Steward is back on
// screen and has signal, up to twice.
const isDropped = e => e instanceof TypeError || /failed to fetch|load failed|networkerror|network error/i.test(String(e?.message || e));
const backOnScreen = () => new Promise(res => {
  const ok = () => !document.hidden && navigator.onLine;
  if (ok()) return res();
  const check = () => { if (ok()) { document.removeEventListener('visibilitychange', check); removeEventListener('online', check); clearInterval(t); res(); } };
  const t = setInterval(check, 2000);
  document.addEventListener('visibilitychange', check); addEventListener('online', check);
});
async function helperRetrying(action, data) {
  for (let attempt = 0; ; attempt++) {
    try { return await sync.helper(action, data); }
    catch (e) {
      if (!isDropped(e) || attempt >= 2) throw e;
      console.warn('Claude request dropped; asking again', e);
      await backOnScreen();
      await new Promise(r => setTimeout(r, 1500));
    }
  }
}
export const keyStatus = () => sync.helper('aiKey', {}).then(r => { noKey = !r.hasKey; return r; });
export const saveKey = key => sync.helper('aiKey', { set: key }).then(r => { noKey = !r.hasKey; return r; });
export const clearKey = () => sync.helper('aiKey', { clear: true }).then(r => { noKey = true; return r; });

// Claude's JSON is not always strictly valid: code fences, a sentence before or after it, Scripture quoted with straight
// "double quotes" inside a string, a trailing comma, or a reply cut short. Read it as forgivingly as possible.
const repairJson = s => {
  let out = '', inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (!inStr) { out += c; if (c === '"') inStr = true; continue; }
    if (esc) { out += c; esc = false; continue; }
    if (c === '\\') { out += c; esc = true; continue; }
    if (c === '\n' || c === '\r' || c === '\t') { out += c === '\t' ? '\\t' : '\\n'; continue; }
    if (c === '"') {
      // A real closing quote is followed by , : } ] (or the end); any other quote is part of the text.
      const next = s.slice(i + 1).match(/^\s*(.)/)?.[1];
      if (!next || /[,:}\]]/.test(next)) { out += c; inStr = false; } else out += '\\"';
      continue;
    }
    out += c;
  }
  if (inStr) out += '"';
  out = out.replace(/,\s*([}\]])/g, '$1');
  // Close whatever a cut-short reply left open.
  const stack = []; let q = false, e = false;
  for (const c of out) { if (q) { if (e) e = false; else if (c === '\\') e = true; else if (c === '"') q = false; continue; } if (c === '"') q = true; else if (c === '{' || c === '[') stack.push(c); else if (c === '}' || c === ']') stack.pop(); }
  out = out.replace(/[,:]\s*$/, '');
  while (stack.length) out += stack.pop() === '{' ? '}' : ']';
  return out;
};
const firstJson = s => {
  s = String(s || '').replace(/```(?:json)?/gi, '');
  const a = s.indexOf('{'); if (a < 0) return null;
  // The object that the first { opens (ignoring braces inside strings), then the widest {...} span, then the rest.
  let depth = 0, q = false, e = false, end = -1;
  for (let i = a; i < s.length && end < 0; i++) { const c = s[i]; if (q) { if (e) e = false; else if (c === '\\') e = true; else if (c === '"') q = false; continue; } if (c === '"') q = true; else if (c === '{') depth++; else if (c === '}' && --depth === 0) end = i; }
  const b = s.lastIndexOf('}');
  for (const t of [end > 0 ? s.slice(a, end + 1) : null, b > a ? s.slice(a, b + 1) : null, s.slice(a)].filter(Boolean)) {
    try { const j = JSON.parse(t); if (j && typeof j === 'object') return j; } catch {}
    try { const j = JSON.parse(repairJson(t)); if (j && typeof j === 'object') return j; } catch {}
  }
  return null;
};
export const _test = { firstJson };

// ---- Haiku: sorting -----------------------------------------------------------------------------------------------
const cache = new Map();
const hash = s => { let x = 2166136261; for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619); } return (x >>> 0).toString(36) + s.length; };

/**
 * Claude Haiku's suggestion, in the same shape as the on-device organizer's (organize-core suggest()), or null when
 * Claude cannot be asked. m: the trained on-device model (for the known tags, projects and notebooks).
 */
export async function sortWithClaude(m, text, kind) {
  text = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 1500);
  if (!aiReady() || text.split(' ').length < 2) return null;
  const key = kind + '|' + hash(text);
  if (cache.has(key)) return cache.get(key);
  const tagPool = new Set([...Object.values(C.DETAILS).flat(), ...[...m.keys].filter(k => k.startsWith('t:')).map(k => k.slice(2))]);
  const tagsByArea = C.AREAS.map(a => `${a.id}: ${[...tagPool].filter(t => (C.areaOfTag(m, t) || '') === a.id).join(', ') || '(none yet)'}`).join('\n');
  const loose = [...tagPool].filter(t => !C.areaOfTag(m, t));
  const projects = store.all('projects').map(p => p.name).filter(n => n && !/^inbox$/i.test(n));
  const notebooks = store.all('notebooks').map(n => n.name).filter(Boolean);
  const words = store.all('orgwords').slice(0, 80).map(w => `${w.word} → ${[w.area, ...(w.tags || [])].filter(Boolean).join(', ')}`);
  const lessons = store.all('lessons').filter(l => l.text).sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, 25)
    .map(l => `"${l.text.slice(0, 160)}" → ${JSON.stringify({ area: l.area, tags: l.tags, promise: l.promise, project: l.project, notebook: l.notebook })}`);
  const system = [
    'You file new entries in Steward, the task and note app of Charles, who owns CS Outdoors (a landscape management company in Greenville, SC), is a first-year BJU Seminary student, serves at church (including ESL teaching at Embrace English), and is married to Elise with a baby due January 2027.',
    'Areas (pick at most one): cs-outdoors, seminary, church, home-family, personal.',
    'Tags he uses, by area:\n' + tagsByArea + (loose.length ? '\nother: ' + loose.join(', ') : ''),
    projects.length ? 'Task projects: ' + projects.join(' | ') : '', notebooks.length ? 'Note notebooks: ' + notebooks.join(' | ') : '',
    words.length ? 'Names and words that always mean an area:\n' + words.join('\n') : '',
    lessons.length ? 'How he filed recent entries (follow his habits):\n' + lessons.join('\n') : '',
    '"promise" is true only when the entry records something Charles told a customer he would do (a date, a call back, a quote, a visit). His own plans and deadlines are not promises.',
    '"kind" is "task" if the entry is something to do, "note" if it is information to keep.',
    'Use only tags, projects and notebooks from the lists above (exact spelling); leave a field null or empty when unsure.',
    'Reply with JSON only: {"kind":"task"|"note","area":id|null,"tags":[...up to 4],"promise":true|false,"project":name|null,"notebook":name|null,"sure":0-1}',
  ].filter(Boolean).join('\n\n');
  let out = null;
  try {
    const reply = await ask('haiku', { system, max_tokens: 200, messages: [{ role: 'user', content: `New ${kind === 'note' ? 'note' : 'entry'}: ${text}` }] });
    const j = firstJson(reply);
    if (!j) return null;
    const sure = Math.max(0.5, Math.min(0.97, Number(j.sure) || 0.85));
    const area = C.AREA_IDS.includes(j.area) ? j.area : null;
    const tags = [...new Set((Array.isArray(j.tags) ? j.tags : []).map(C.tagSlug).filter(t => tagPool.has(t)))].slice(0, 4).map(id => ({ id, p: sure }));
    const pick = (list, v) => list.find(x => x.toLowerCase() === String(v || '').toLowerCase());
    const pj = kind === 'task' ? pick(projects, j.project) : null, nb = kind === 'note' ? pick(notebooks, j.notebook) : null;
    out = {
      area, areaP: area ? sure : 0, areas: [], tags,
      promise: { p: j.promise ? sure : 0.05, on: !!j.promise && (area === 'cs-outdoors' || !area) },
      project: pj ? { name: pj.toLowerCase(), p: sure } : null, notebook: nb ? { name: nb.toLowerCase(), p: sure } : null,
      kind: j.kind === 'note' || j.kind === 'task' ? j.kind : null, by: 'claude',
    };
  } catch (e) { console.warn('Claude sort', e); return null; }
  cache.set(key, out); if (cache.size > 60) cache.delete(cache.keys().next().value);
  return out;
}

// ---- Sonnet: plan the day --------------------------------------------------------------------------------------------
const toMin = s => { const [a, b] = String(s || '0:0').split(':').map(Number); return a * 60 + (b || 0); };
const clock = n => `${pad(Math.floor(n / 60) % 24)}:${pad(n % 60)}`;
const PLAN_RULES = `How Charles wants a day planned, in this order:
1. Promises to customers come first (label "promise"). If one cannot fit, say so plainly and suggest telling the customer early and asking to move the date. Never quietly drop one.
2. Invoicing stays current.
3. Then work by how fast it spoils: leaf cleanups (most urgent), mowing (keep weekly/biweekly rhythm), weed treatments (can flex a little), bush trimming (flexes most), then projects like mulch, irrigation and tree work (flex a lot, unless a date was promised).
Never place anything over a fixed block or calendar event (devotions, classes, family dinner, church, ESL teaching, date night). Stay inside his planning hours. Sunday is his rest day.
Guard the quiet priorities: time with God, Elise and the coming baby, seminary work, rest and health. If the necessary work already fits, say so, so he can stop adding hours "just in case". If it does not fit, say what should move rather than stretching into family or rest time.
Leave a little margin between field jobs for driving and loading.`;

/** Open the "Plan with Claude" sheet for a day. */
export function planWithClaude(day, plan) {
  const isToday = day === today(), now = new Date(), nowMin = isToday ? now.getHours() * 60 + now.getMinutes() : null;
  const win = (settings.get('hours') || [])[fromYmd(day).getDay()] || null;
  const open = M.openTasks().filter(t => !t.parentId);
  const pname = id => (id && id !== 'inbox' ? store.get('projects', id)?.name : '') || '';
  const dayTasks = open.filter(t => t.due?.date && t.due.date <= day);
  const soon = open.filter(t => !dayTasks.includes(t) && ((t.deadline && t.deadline <= addDays(day, 7)) || ((t.labels || []).includes(C.PROMISE) && t.due?.date && t.due.date <= addDays(day, 3))));
  const row = t => ({ id: t.id, task: t.content, project: pname(t.projectId) || undefined, priority: t.priority && t.priority < 4 ? t.priority : undefined, labels: t.labels?.length ? t.labels : undefined, minutes: t.duration || undefined, due: t.due ? t.due.date + (t.due.time ? ' ' + t.due.time : '') : undefined, repeats: t.due?.recur?.text || undefined, deadline: t.deadline || undefined, notes: t.description ? t.description.slice(0, 200) : undefined });
  const fixed = [...plan.blocks.map(x => ({ from: clock(x.start), to: clock(x.end), what: x.b.name, fixed: true })), ...plan.evs.map(x => ({ from: clock(x.start), to: clock(x.end), what: x.e.title }))].sort((a, b) => a.from.localeCompare(b.from));
  const facts = {
    day: `${fromYmd(day).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}${isToday ? ', now ' + clock(nowMin) : ''}`,
    planningHours: win ? `${win.start}–${win.end}` : 'none (rest day or no planning)',
    busy: fixed, tasksForThisDay: dayTasks.map(row), comingUpSoon: soon.slice(0, 25).map(row),
  };
  const system = `You help Charles plan his day in Steward. He owns CS Outdoors (landscaping, Greenville SC), is a seminary student, and is a husband and soon a father. He is a Christian who weighs decisions by Scripture, especially Proverbs and Matthew 5–7.\n\n${PLAN_RULES}\n\nTasks without minutes: estimate sensibly and say it is a guess. Times are Eastern, 24-hour HH:MM.${isToday ? ' Plan only from now on.' : ''}\n\n\nReply with one JSON object and nothing else: no Markdown, no code fences, no words before or after it. It must be valid JSON. Inside text values never use the double-quote character; when quoting Scripture use single quotes or curly quotes instead. Keep every "why" to a few words.\nShape (example values):\n{"headline": "The necessary work fits with room to spare.",\n "order": [{"id": "abc123", "start": "11:40", "minutes": 15, "why": "quick office task"}],\n "later": [{"id": "def456", "why": "flexes; no promise"}],\n "tell": ["Text the Hanels today that Friday may slip."],\n "word": "'The thoughts of the diligent tend only to plenteousness' (Proverbs 21:5, KJV)."}\n"order": tasks to do this day with start times. "later": tasks that should move to another day. "tell": customers to contact early about a date at risk (empty list if none). "word": one or two sentences of encouragement or caution grounded in Proverbs or Matthew 5–7, quoting the KJV exactly with the reference, or "" if nothing fits.`;
  modal((close, body) => {
    const box = h('div', { class: 'aiplan' }, h('p', { class: 'sub' }, icon('spark', 14), ' Claude Sonnet is planning ', isToday ? 'the rest of today' : 'this day', '…'));
    let result = null;
    const busyMin = fixed.map(f => ({ s: toMin(f.from), e: toMin(f.to) }));
    const draw = () => {
      const tasks = new Map(open.map(t => [t.id, t]));
      const arr = v => Array.isArray(v) ? v : [];
      const order = arr(result.order).filter(o => o && tasks.has(o.id) && /^\d{1,2}:\d{2}$/.test(o.start || ''))
        .map(o => { const s = toMin(o.start), mins = Math.max(5, Math.min(600, Number(o.minutes) || tasks.get(o.id).duration || 30)); return { ...o, s, mins, clash: busyMin.some(b => s < b.e && b.s < s + mins) || (win && (s < toMin(win.start) || s + mins > toMin(win.end))) }; });
      const later = arr(result.later).filter(o => o && tasks.has(o.id));
      const tell = arr(result.tell).filter(x => typeof x === 'string' && x);
      const useTimes = () => {
        const before = [];
        for (const o of order) if (!o.clash) { const t = tasks.get(o.id); before.push({ id: t.id, due: t.due, duration: t.duration }); store.patch('tasks', t.id, { due: { ...(t.due || { recur: null }), date: day, time: clock(o.s) }, duration: t.duration || o.mins }, { silent: true }); }
        store.emit({ local: true }); close();
        toast(`Times set on ${before.length} task${before.length === 1 ? '' : 's'}`, 'Undo', () => { for (const b of before) store.patch('tasks', b.id, { due: b.due, duration: b.duration }, { silent: true }); store.emit({ local: true }); });
      };
      const moveLater = o => { const t = tasks.get(o.id); if (!t || t.due?.recur) return toast('Repeating tasks keep their own rhythm. Change this one from the task itself.'); const was = t.due; store.patch('tasks', t.id, { due: { ...(t.due || { time: null, recur: null }), date: addDays(day, 1) } }); toast('Moved to the next day', 'Undo', () => store.patch('tasks', t.id, { due: was })); };
      fill(box,
        h('p', { class: 'aip-head' }, String(result.headline || '')),
        order.length ? h('ol', { class: 'aip-list' }, order.map(o => h('li', { class: o.clash ? 'clash' : '' }, h('span', { class: 'aip-t' }, fmtTime(clock(o.s))), h('span', { class: 'grow' }, h('b', null, tasks.get(o.id).content), h('span', { class: 'sub' }, ` · ${o.mins} min${o.why ? ' · ' + o.why : ''}`), o.clash && h('span', { class: 'aip-warn' }, ' · overlaps a fixed time; will not be set'))))) : null,
        later.length ? h('div', null, h('h4', null, 'Better on another day'), h('ul', { class: 'aip-list' }, later.map(o => h('li', null, h('span', { class: 'grow' }, h('b', null, tasks.get(o.id).content), o.why && h('span', { class: 'sub' }, ' · ' + o.why)), btn('Move to next day', () => moveLater(o), 'tiny'))))) : null,
        tell.length ? h('div', { class: 'aip-tell' }, h('h4', null, icon('flag', 13), ' Tell early'), h('ul', null, tell.map(s => h('li', null, s)))) : null,
        result.word ? h('p', { class: 'aip-word' }, String(result.word)) : null,
        h('p', { class: 'sub' }, 'Nothing changes until you press a button. Times can still be changed on each task.'),
        h('div', { class: 'row end gap' }, btn('Close', close), order.some(o => !o.clash) && btn('Use these times', useTimes, 'primary', 'check')));
    };
    const showPlain = text => fill(box,
      h('p', { class: 'sub' }, 'Claude answered in a form Steward could not turn into times, so here is the plan as written. Nothing was changed.'),
      h('div', { class: 'aiw-answer', html: sanitize(mdToHtml(String(text).replace(/```(?:json)?/gi, '').trim())) }),
      h('div', { class: 'row end gap' }, btn('Close', close), btn('Try again', () => { close(); planWithClaude(day, plan); }, 'primary', 'spark')));
    (async () => {
      const messages = [{ role: 'user', content: JSON.stringify(facts) }];
      let r = await askFull('sonnet', { system, max_tokens: 4000, messages });
      result = firstJson(r.text);
      // Not readable: ask once more, showing Claude its own reply, before giving up.
      if (!result?.order && r.text.trim()) {
        const why = r.stop === 'max_tokens' ? 'Your reply was cut off because it was too long. Send it again, shorter (few-word reasons).' : 'Your reply was not valid JSON.';
        const r2 = await askFull('sonnet', { system, max_tokens: 4000, messages: [...messages, { role: 'assistant', content: r.text.slice(0, 20000) }, { role: 'user', content: why + ' Reply again with only the JSON object in the shape asked for, with no double-quote characters inside text values.' }] });
        const j = firstJson(r2.text); if (j?.order) { result = j; r = r2; } else if (!result && j) result = j;
      }
      if (!body.isConnected) return;
      if (result && (result.order || result.later || result.headline)) return draw();
      if (r.text.trim()) return showPlain(r.text);
      throw new Error('Claude sent back an empty answer. Try again in a minute.');
    })().catch(e => { if (body.isConnected) fill(box, h('p', null, e.message || String(e)), h('div', { class: 'row end gap' }, btn('Close', close), btn('Try again', () => { close(); planWithClaude(day, plan); }, 'primary', 'spark'))); });
    return box;
  }, { title: 'Plan with Claude', cls: 'wide' });
}

// ---- Sonnet: help with Writing ---------------------------------------------------------------------------------------
const WRITE_SYSTEM = `You help Charles in Steward's Writing section. He is a first-year student at BJU Seminary (writing Turabian-style papers) and preaches and teaches (sermons, Sunday school, devotionals). His tradition is Bible-church evangelical with Baptist influences; he reads Scripture by the literal, grammatical-historical-contextual method.
Rules: Be truthful. Never invent sources, quotations, page numbers or publication details; if a citation is needed and you are not certain of it, say what to look up instead. Quote Scripture from the KJV exactly, with the reference. Follow Turabian (Chicago notes-bibliography) when asked about citations. Keep his voice: plain, warm, direct. Answer in Markdown; keep it as short as the request allows.`;

/** Open the "Ask Claude" sheet in Writing. selected: highlighted text (may be ''); whole: the document's text; title. insert(html): puts text at the cursor. */
export function askAboutWriting({ selected, whole, title, insert }) {
  modal((close, body) => {
    const q = h('textarea', { class: 'field', rows: 3, autofocus: true, placeholder: selected ? 'What should Claude do with the selected text? e.g. tighten this paragraph, check the Turabian footnote, is this exegesis sound?' : 'Ask about this document, e.g. outline the argument, suggest a stronger introduction, what is missing?' });
    const out = h('div', { class: 'aiw-out' });
    let answer = '';
    const go = async () => {
      const ask_ = q.value.trim(); if (!ask_) return toast('Type what you would like help with');
      fill(out, h('p', { class: 'sub' }, icon('spark', 14), ' Claude Sonnet is thinking…'));
      const ctx = `Document: "${title || 'Untitled'}"\n\n${selected ? 'Selected text:\n"""\n' + selected.slice(0, 20000) + '\n"""\n\nWhole document for context:\n' : 'Document text:\n'}"""\n${whole.slice(0, 80000)}\n"""\n\nRequest: ${ask_}`;
      try {
        answer = await ask('sonnet', { system: WRITE_SYSTEM, max_tokens: 3000, messages: [{ role: 'user', content: ctx }] });
        if (!body.isConnected) return;
        fill(out, h('div', { class: 'aiw-answer', html: sanitize(mdToHtml(answer)) }),
          h('div', { class: 'row end gap' }, btn('Copy', () => navigator.clipboard?.writeText(answer).then(() => toast('Copied'))), insert && btn(selected ? 'Put after the selection' : 'Insert at the cursor', () => { insert(sanitize(mdToHtml(answer))); close(); }, 'primary')));
      } catch (e) { if (body.isConnected) fill(out, h('p', null, e.message || String(e))); }
    };
    q.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); go(); } });
    return h('div', null, selected && h('blockquote', { class: 'aiw-sel' }, selected.slice(0, 400) + (selected.length > 400 ? '…' : '')), q,
      h('div', { class: 'row end gap' }, btn('Close', close), btn('Ask', go, 'primary', 'spark')), out,
      h('p', { class: 'sub' }, 'The document is sent to Claude to answer. Nothing in it changes unless you press Insert.'));
  }, { title: 'Ask Claude', cls: 'wide' });
}

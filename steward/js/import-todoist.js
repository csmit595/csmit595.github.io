// Bring everything over from Todoist: projects, sections, tasks and sub-tasks, labels, filters, comments, reminders.
// Uses your Todoist API token (Todoist → Settings → Integrations → Developer). The token is used once and not saved.
// Every item gets an id made from its Todoist id ("td-…"), so running the import again later UPDATES what came over
// instead of making duplicates, and finishes here anything you finished in Todoist in the meantime.
import { store, settings } from './store.js';
import * as M from './model.js';
import { parseDue } from './dates.js';
import { ymd, hm } from './util.js';

const API = 'https://api.todoist.com/api/v1/sync';
const COLOR = { berry_red: 'rose', red: 'red', orange: 'orange', yellow: 'gold', olive_green: 'moss', lime_green: 'moss', green: 'green', mint_green: 'teal', teal: 'teal', sky_blue: 'blue', light_blue: 'blue', blue: 'blue', grape: 'plum', violet: 'plum', lavender: 'indigo', magenta: 'rose', salmon: 'rose', charcoal: 'slate', grey: 'stone', taupe: 'stone' };
// Todoist label names may have spaces; Steward labels are single words. Your old "customer-promise" label becomes
// "promise", which is what Steward's "Customer promises" filter and Claude use.
const labelName = n => { const s = String(n).trim().replace(/\s+/g, '-'); return /^customer-?promises?$/i.test(s) ? 'promise' : s; };

async function fetchAll(token) {
  const r = await fetch(API, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ sync_token: '*', resource_types: '["projects","items","sections","labels","filters","notes","reminders","user"]' }) });
  if (r.status === 401 || r.status === 403) throw new Error('Todoist did not accept that token. Copy it again from Todoist → Settings → Integrations → Developer.');
  if (!r.ok) throw new Error(`Todoist said ${r.status}. Try again in a minute.`);
  return r.json();
}

/** Todoist's due → Steward's {date, time, recur}. Times stay in your local time. */
function dueOf(d, problems, name) {
  if (!d?.date) return null;
  let date, time = null;
  if (/T/.test(d.date)) {
    const when = /Z$|[+-]\d\d:?\d\d$/.test(d.date) ? new Date(d.date) : new Date(d.date.replace(/(\d\d:\d\d)(:\d\d)?$/, '$1:00'));
    if (isNaN(when)) return null;
    date = ymd(when); time = hm(when);
  } else date = d.date.slice(0, 10);
  let recur = null;
  if (d.is_recurring && d.string) {
    const pd = parseDue(d.string, date);
    // only trust a repeat Steward read completely; leftover words ("…of the month") mean it would repeat wrongly
    recur = pd?.due.recur && !pd.rest.replace(/\b(starting|from|at|on|ending|every)\b/gi, '').trim() ? pd.due.recur : null;
    if (recur) recur = { ...recur, anchor: date, ...(recur.unit === 'month' && !recur.nth && !recur.days ? { dom: recur.dom || +date.slice(8) } : {}) };
    else problems.push(`"${name}" repeats "${d.string}" in Todoist, which Steward cannot read yet; it came over as a one-time task. Set its repeat in Steward.`);
  }
  return { date, time, recur };
}

export async function importTodoist(token, { pauseReminders = false, onStep } = {}) {
  onStep?.('Asking Todoist for everything…');
  const j = await fetchAll(token.trim());
  const live = x => x && !x.is_deleted && !x.is_archived;
  const problems = [];
  const projects = (j.projects || []).filter(live);
  const inbox = projects.find(p => p.inbox_project || p.is_inbox_project || p.id === j.user?.inbox_project_id);
  const pid = id => (!id || id === inbox?.id ? 'inbox' : 'tdp-' + id);
  const keepProj = new Set(projects.map(p => p.id));
  const now = Date.now();
  const n = { projects: 0, sections: 0, tasks: 0, finished: 0, labels: 0, filters: 0, comments: 0, reminders: 0 };

  onStep?.('Projects and sections…');
  for (const p of projects) {
    if (p.id === inbox?.id) continue;
    const cur = store.get('projects', 'tdp-' + p.id);
    store.put('projects', { ...(cur || {}), id: 'tdp-' + p.id, name: p.name, color: COLOR[p.color] || 'green', parentId: p.parent_id && keepProj.has(p.parent_id) && p.parent_id !== inbox?.id ? 'tdp-' + p.parent_id : null,
      order: (p.child_order ?? 0) * 1000, favorite: !!p.is_favorite, view: p.view_style === 'board' ? 'board' : (cur?.view || 'list'), sort: cur?.sort || 'manual' }, { silent: true });
    n.projects++;
  }
  for (const s of (j.sections || []).filter(live)) {
    if (!keepProj.has(s.project_id)) continue;
    store.put('sections', { ...(store.get('sections', 'tds-' + s.id) || {}), id: 'tds-' + s.id, projectId: pid(s.project_id), name: s.name, order: (s.section_order ?? s.child_order ?? 0) * 1000 }, { silent: true });
    n.sections++;
  }

  onStep?.('Labels and filters…');
  const labels = new Set();
  for (const l of (j.labels || []).filter(x => x && !x.is_deleted)) labels.add(labelName(l.name));
  const items = (j.items || j.tasks || []).filter(t => t && !t.is_deleted && !t.checked && keepProj.has(t.project_id));
  for (const t of items) for (const l of t.labels || []) labels.add(labelName(l));
  M.ensureLabels([...labels]); n.labels = labels.size;
  for (const f of (j.filters || []).filter(x => x && !x.is_deleted)) {
    if (/assigned|shared|added by|created:|\bview all\b/i.test(f.query || '')) { problems.push(`Filter "${f.name}" (${f.query}) uses Todoist team features Steward does not have; it was left out.`); continue; }
    // labels with spaces are written "@time\ sensitive" in Todoist filters
    const query = String(f.query || '').replace(/@((?:\\ |[^\s&|()!,\\])+)/g, (_, l) => '@' + labelName(l.replace(/\\ /g, ' ')));
    store.put('filters', { ...(store.get('filters', 'tdf-' + f.id) || {}), id: 'tdf-' + f.id, name: f.name, query, favorite: !!f.is_favorite }, { silent: true });
    n.filters++;
  }

  onStep?.(`Tasks (${items.length})…`);
  const ids = new Set(items.map(t => t.id));
  const rems = new Map();
  for (const r of (j.reminders || []).filter(x => x && !x.is_deleted)) {
    const list = rems.get(r.item_id) || [];
    if (r.type === 'relative' && r.minute_offset != null) list.push({ before: +r.minute_offset });
    else if (r.type === 'absolute' && r.due?.date) { const d = /Z$/.test(r.due.date) ? new Date(r.due.date) : new Date(r.due.date); if (!isNaN(d)) list.push({ at: `${ymd(d)}T${hm(d)}` }); }
    rems.set(r.item_id, list);
  }
  for (const t of items) {
    const id = 'td-' + t.id, cur = store.get('tasks', id);
    const dur = t.duration?.amount ? (t.duration.unit === 'day' ? null : +t.duration.amount) : null;
    const reminders = rems.get(t.id) || [];
    n.reminders += reminders.length;
    store.put('tasks', { ...(cur || {}), id, content: t.content, description: t.description || '', projectId: pid(t.project_id),
      sectionId: t.section_id ? 'tds-' + t.section_id : null, parentId: t.parent_id && ids.has(t.parent_id) ? 'td-' + t.parent_id : null,
      priority: 5 - (t.priority || 1), labels: (t.labels || []).map(labelName), due: dueOf(t.due, problems, t.content), deadline: t.deadline?.date || null,
      duration: dur, reminders, noteId: cur?.noteId || null, order: (t.child_order ?? 0) * 1000, completedAt: null,
      createdAt: cur?.createdAt || (t.added_at ? Date.parse(t.added_at) : now), remindedFor: null }, { silent: true, by: 'Todoist import', noHistory: !cur });
    n.tasks++;
  }
  // Brought over before, but no longer open in Todoist: you finished (or deleted) it there, so finish it here too.
  for (const t of store.all('tasks')) if (t.id.startsWith('td-') && !t.completedAt && !ids.has(t.id.slice(3))) { store.put('tasks', { ...t, completedAt: now }, { silent: true, by: 'Todoist import' }); n.finished++; }

  onStep?.('Comments…');
  for (const c of (j.notes || j.comments || []).filter(x => x && !x.is_deleted && x.item_id && ids.has(x.item_id))) {
    const file = c.file_attachment?.file_url ? `\n${c.file_attachment.file_name || 'Attachment'}: ${c.file_attachment.file_url}` : '';
    store.put('comments', { ...(store.get('comments', 'tdc-' + c.id) || {}), id: 'tdc-' + c.id, taskId: 'td-' + c.item_id, text: (c.content || '') + file, author: 'Todoist', createdAt: c.posted_at ? Date.parse(c.posted_at) : now }, { silent: true });
    n.comments++;
  }
  if (pauseReminders) settings.set('remindersPaused', true);
  store.emit({ local: true });
  return { n, problems };
}

/** Plain words for the result screen. */
export function describeImport({ n, problems }) {
  const c = (k, word) => n[k] ? `${n[k]} ${word}${n[k] === 1 ? '' : 's'}` : null;
  const parts = [c('tasks', 'open task'), c('projects', 'project'), c('sections', 'section'), c('labels', 'label'), c('filters', 'filter'), c('comments', 'comment'), c('reminders', 'reminder')].filter(Boolean);
  return { line: 'Brought over ' + parts.join(', ') + '.' + (n.finished ? ` ${n.finished} task${n.finished === 1 ? '' : 's'} you finished in Todoist since last time ${n.finished === 1 ? 'was' : 'were'} finished here too.` : ''), problems };
}

// Steward helper that runs in Google Apps Script every few minutes, in Charles's own Google account.
// While Steward is closed on every device it:
//   1. applies the task changes Claude leaves in "Steward/inbox for Claude" to steward-tasks.json, and
//   2. keeps the "Steward Reminders" calendar right, so the phone buzzes for tasks Claude added.
// It uses Steward's own task code (store.js, model.js, dates.js), so changes are applied exactly as the app does.
// Change files that touch notes or Writing documents are left for the app (they need its HTML tools).
import './shims.js'; // must stay first
import { store } from '../steward/js/store.js';
import { applyOps, openTasks, reminderTimes, reminderKey } from '../steward/js/model.js';

const DRIVE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const CAL = 'https://www.googleapis.com/calendar/v3';
const FOLDER = 'application/vnd.google-apps.folder';
const needsApp = o => o && o.op !== 'delete' && ['note', 'doc', 'document'].includes(String(o.type || '').toLowerCase());

/**
 * env.http(url, {method, headers, body}) -> {status, text}  (synchronous)
 * env.props: {get(k), set(k, v)} saved between runs
 */
export function run(env) {
  const log = [];
  const api = (url, opts = {}, raw = false) => {
    const r = env.http(url, opts);
    if (r.status >= 300) { const e = new Error(`Google said ${r.status}: ${String(r.text).slice(0, 200)}`); e.status = r.status; throw e; }
    if (raw) return r.text;
    return r.status === 204 || !r.text ? null : JSON.parse(r.text);
  };
  const json = { 'Content-Type': 'application/json' };
  const find = (name, parent, folder) => {
    const q = `name='${name.replace(/'/g, "\\'")}' and '${parent}' in parents and trashed=false` + (folder ? ` and mimeType='${FOLDER}'` : '');
    return api(`${DRIVE}/files?q=${encodeURIComponent(q)}&fields=files(id,name,version)&orderBy=createdTime`).files[0] || null;
  };
  const trash = id => api(`${DRIVE}/files/${id}`, { method: 'PATCH', headers: json, body: JSON.stringify({ trashed: true }) });

  // ---- where things are ----
  let d = JSON.parse(env.props.get('drive') || 'null');
  const alive = id => { try { return !api(`${DRIVE}/files/${id}?fields=trashed`).trashed; } catch (e) { if (e.status === 404) return false; throw e; } };
  if (!d || !alive(d.inbox) || !alive(d.tasks)) {
    const root = find('Steward', 'root', true);
    if (!root) return 'No Steward folder in Drive yet.';
    const inbox = find('inbox for Claude', root.id, true), tasks = find('steward-tasks.json', root.id);
    if (!inbox || !tasks) return 'Steward has not finished setting up Drive yet.';
    d = { root: root.id, inbox: inbox.id, tasks: tasks.id };
    env.props.set('drive', JSON.stringify(d));
  }

  // ---- 1. Claude's change files ----
  const q = `'${d.inbox}' in parents and trashed=false`;
  const files = (api(`${DRIVE}/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType)&orderBy=createdTime&pageSize=100`).files || [])
    .filter(f => !/^(failed-|report-)/.test(f.name) && f.mimeType !== FOLDER);
  // Files left for the app last time (notes, documents) don't need looking at again until the app takes them.
  const deferred = new Set(JSON.parse(env.props.get('deferred') || '[]'));
  const fresh = files.filter(f => !deferred.has(f.id));
  env.props.set('deferred', JSON.stringify(files.filter(f => deferred.has(f.id)).map(f => f.id)));
  const meta = api(`${DRIVE}/files/${d.tasks}?fields=version`);
  const remindersDue = meta.version !== env.props.get('tasksVersion') || Date.now() - Number(env.props.get('remindersAt') || 0) > 6 * 3600e3;
  if (!fresh.length && !remindersDue) return 'Nothing new.';

  store.merge('tasks', JSON.parse(api(`${DRIVE}/files/${d.tasks}?alt=media`, {}, true)));
  const report = (name, lines) => {
    const form = { name: `report-${name.replace(/\.json$/i, '')}.txt`, parents: [d.inbox], mimeType: 'text/plain' };
    const body = [`Steward (Google helper) ${new Date().toString()}`, `Changes from ${name}:`, ...lines].join('\n');
    try { env.upload(form, body); } catch (e) { log.push('report failed: ' + e.message); }
  };
  let applied = 0;
  for (const f of fresh) {
    let ops;
    try {
      const url = f.mimeType === 'application/vnd.google-apps.document' ? `${DRIVE}/files/${f.id}/export?mimeType=text/plain` : `${DRIVE}/files/${f.id}?alt=media`;
      const j = JSON.parse(String(api(url, {}, true)).replace(/^﻿/, '').replace(/[“”]/g, '"').trim());
      ops = Array.isArray(j) ? j : j?.ops;
      if (!Array.isArray(ops)) throw new Error('not a list of changes');
    } catch (e) {
      if (e.status) throw e; // Google trouble: try again next run
      api(`${DRIVE}/files/${f.id}`, { method: 'PATCH', headers: json, body: JSON.stringify({ name: 'failed-' + f.name }) });
      report(f.name, ['Nothing was applied: ' + (e.message || 'the file could not be read')]);
      continue;
    }
    if (ops.some(needsApp)) { log.push(`left for the app: ${f.name}`); deferred.add(f.id); env.props.set('deferred', JSON.stringify([...deferred].filter(id => files.some(x => x.id === id)))); continue; }
    const results = applyOps(ops);
    const problems = results.filter(x => x.startsWith('problem'));
    if (problems.length) report(f.name, [`${results.length - problems.length} applied, ${problems.length} with problems:`, ...problems]);
    applied++;
    log.push(`applied ${f.name}: ${results.length - problems.length} ok, ${problems.length} problems`);
    pendingTrash.push(f.id);
  }
  if (applied) {
    // Re-read just before writing: if a device saved in the meantime, fold its version in so nothing is lost.
    const now = api(`${DRIVE}/files/${d.tasks}?fields=version`);
    if (now.version !== meta.version) store.merge('tasks', JSON.parse(api(`${DRIVE}/files/${d.tasks}?alt=media`, {}, true)));
    const r = api(`${UPLOAD}/files/${d.tasks}?uploadType=media&fields=id,version`, { method: 'PATCH', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(store.snapshot('tasks')) });
    env.props.set('tasksVersion', r.version);
    for (const id of pendingTrash.splice(0)) trash(id); // only once the tasks are safely in Drive
  } else env.props.set('tasksVersion', meta.version);

  // ---- 2. phone reminders ----
  if (applied || remindersDue) { log.push(syncReminders(api, env)); env.props.set('remindersAt', String(Date.now())); }
  return log.join('\n') || 'Up to date.';
}
const pendingTrash = [];

function syncReminders(api, env) {
  const json = { 'Content-Type': 'application/json' };
  let calId = env.props.get('remCal');
  const list = api(`${CAL}/users/me/calendarList?minAccessRole=owner`);
  if (!calId || !(list.items || []).some(c => c.id === calId)) {
    calId = (list.items || []).find(c => c.summary === 'Steward Reminders')?.id;
    if (!calId) return 'no Steward Reminders calendar yet (the app makes it)';
    env.props.set('remCal', calId);
  }
  const now = Date.now(), horizon = now + 60 * 864e5;
  const want = new Map();
  for (const t of openTasks()) for (const at of reminderTimes(t)) {
    const ms = at.getTime();
    if (ms < now - 60000 || ms > horizon) continue;
    want.set(reminderKey(t.id, at), { summary: '⏰ ' + t.content, at });
  }
  const base = `${CAL}/calendars/${encodeURIComponent(calId)}/events`;
  const have = new Map();
  let pageToken = '';
  do {
    const r = api(`${base}?singleEvents=true&maxResults=2500&timeMin=${encodeURIComponent(new Date(now).toISOString())}${pageToken ? '&pageToken=' + pageToken : ''}`);
    for (const e of r.items || []) if (e.status !== 'cancelled') have.set(e.id, e);
    pageToken = r.nextPageToken || '';
  } while (pageToken);
  let added = 0, removed = 0;
  const del = id => { try { api(`${base}/${id}`, { method: 'DELETE' }); removed++; } catch (e) { if (e.status !== 404 && e.status !== 410) throw e; } };
  // Same rules as the app: keep Claude's own reminder events that still match a task; remove the rest.
  for (const [id, e] of have) {
    if (id.startsWith('st')) continue;
    const m = /steward-task:([\w-]+)/.exec(e.description || '');
    if (!m || !e.start?.dateTime) continue;
    const key = reminderKey(m[1], new Date(e.start.dateTime));
    if (want.has(key) && !have.has(key)) want.delete(key); else del(id);
  }
  const body = (id, w) => JSON.stringify({ id, summary: w.summary, description: 'Reminder from Steward', status: 'confirmed', start: { dateTime: w.at.toISOString() }, end: { dateTime: new Date(w.at.getTime() + 5 * 60000).toISOString() }, reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 0 }] } });
  for (const [id] of have) if (id.startsWith('st') && !want.has(id)) del(id);
  for (const [id, w] of want) {
    const e = have.get(id);
    if (e && e.summary === w.summary) continue;
    if (e) { api(`${base}/${id}`, { method: 'PATCH', headers: json, body: body(id, w) }); continue; }
    try { api(base, { method: 'POST', headers: json, body: body(id, w) }); added++; }
    catch (err) { if (err.status === 409) api(`${base}/${id}`, { method: 'PUT', headers: json, body: body(id, w) }); else throw err; }
  }
  return `reminders: ${added} added, ${removed} removed`;
}

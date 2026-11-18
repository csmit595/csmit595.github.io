// Steward helper that runs in Google Apps Script every few minutes, in Charles's own Google account.
// While Steward is closed on every device it:
//   1. applies the task changes Claude leaves in "Steward/inbox for Claude" to steward-tasks.json, and
//   2. sends Steward's reminders as notifications to the phone and the Mac (Web Push, see push.js), checking every
//      minute; until every device has shown its test notification, it also keeps the old "Steward Reminders"
//      calendar right as a backup, and empties that calendar once notifications are proven.
// It uses Steward's own task code (store.js, model.js, dates.js), so changes are applied exactly as the app does.
// Change files that touch notes or Writing documents are left for the app (they need its HTML tools).
import './shims.js'; // must stay first
import { store } from '../steward/js/store.js';
import { applyOps, openTasks, reminderTimes, reminderKey, projectName } from '../steward/js/model.js';
import { newKeys, request } from './push.js';

const DRIVE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const CAL = 'https://www.googleapis.com/calendar/v3';
const FOLDER = 'application/vnd.google-apps.folder';
const needsApp = o => o && o.op !== 'delete' && ['note', 'doc', 'document'].includes(String(o.type || '').toLowerCase());

/**
 * env.http(url, {method, headers, body}) -> {status, text}  (synchronous)
 * env.props: {get(k), set(k, v)} saved between runs
 */
function tools(env) {
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
  return { api, json, find, trash };
}

export function run(env) {
  const log = [];
  const { api, json, find, trash } = tools(env);

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
  if (d.push && !alive(d.push)) { delete d.push; env.props.set('drive', JSON.stringify(d)); }
  setUpPush(env, api, find, json, d);

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
  // Files applied on an earlier run whose move to the trash did not go through: finish the move, never apply twice.
  const done = new Set(JSON.parse(env.props.get('applied') || '[]'));
  for (const f of fresh) {
    if (done.has(f.id)) { trash(f.id); done.delete(f.id); env.props.set('applied', JSON.stringify([...done])); continue; }
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
    if (problems.length) report(f.name, [`${results.filter(x => x.startsWith('ok')).length} applied, ${problems.length} with problems:`, ...problems]);
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
    // only once the tasks are safely in Drive; remembered first, so a failed move is finished next run, not re-applied
    const ids = pendingTrash.splice(0);
    env.props.set('applied', JSON.stringify([...done, ...ids]));
    for (const id of ids) { trash(id); done.delete(id); }
    env.props.set('applied', JSON.stringify([...done].filter(id => !ids.includes(id))));
  } else env.props.set('tasksVersion', meta.version);

  // ---- 2. phone reminders ----
  // Notifications come from tick() every minute. The calendar is only a backup until every device has shown its test.
  if (applied || remindersDue) { log.push(syncReminders(api, env, pushProven(env))); env.props.set('remindersAt', String(Date.now())); }
  return log.join('\n') || 'Up to date.';
}
const pendingTrash = [];

function syncReminders(api, env, clearOnly) {
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
  if (!clearOnly) for (const t of openTasks()) for (const at of reminderTimes(t)) {
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
  return clearOnly ? `calendar reminders: notifications are on, ${removed} calendar reminders removed` : `calendar reminders: ${added} added, ${removed} removed`;
}

// ---- notifications (Web Push) ----------------------------------------------------------------------------------
// Drive folder Steward/notifications holds:
//   key.json            the helper's public sender key (the devices subscribe with it)
//   device-<id>.json    one per phone or computer: its push address and keys, written by Steward on that device;
//                       "confirmedAt" is set once that device has shown the helper's test notification.
const PLAN_AHEAD = 3 * 3600e3, LATE = 15 * 60000;
const readJson = (k, d) => { try { return JSON.parse(k || 'null') ?? d; } catch { return d; } };

/** True once there is at least one device and every device has shown its test notification. */
export function pushProven(env) {
  const devs = Object.values(readJson(env.props.get('pushDevices'), {}));
  return devs.length > 0 && devs.every(x => x.confirmedAt);
}

const clock = d => { const h = d.getHours(), m = d.getMinutes(); return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
function planFrom(version) {
  const now = Date.now(), items = [];
  for (const t of openTasks()) for (const at of reminderTimes(t)) {
    const ms = at.getTime();
    if (ms < now - LATE || ms > now + PLAN_AHEAD) continue;
    const bits = [];
    if (t.due?.time) bits.push('Due ' + clock(new Date(`${t.due.date}T${t.due.time}:00`)));
    if ((t.labels || []).includes('promise')) bits.push('Customer promise');
    if (t.projectId && t.projectId !== 'inbox') bits.push(projectName(t.projectId));
    items.push({ k: reminderKey(t.id, at), at: ms, id: t.id, title: String(t.content).slice(0, 120), body: bits.join(' · ').slice(0, 120) });
  }
  items.sort((a, b) => a.at - b.at);
  return { v: version, at: now, items: items.slice(0, 30) };
}

/**
 * Runs every minute. Cheap when nothing is due: one look at the task file's version and one at the notifications
 * folder. Sends each reminder once, up to 15 minutes late if Google ran the timer late.
 */
export function tick(env) {
  const { api, find, json } = tools(env);
  const d = readJson(env.props.get('drive'), null);
  if (!d) return 'Waiting for the first sync.';
  const keys = setUpPush(env, api, find, json, d);
  if (!keys) return 'No Steward folder in Drive yet.';
  const log = [];

  // ---- devices ----
  const q = `'${d.push}' in parents and trashed=false and name contains 'device-'`;
  const listed = api(`${DRIVE}/files?q=${encodeURIComponent(q)}&fields=files(id,name,version)&pageSize=100`).files || [];
  const old = readJson(env.props.get('pushDevices'), {}), devs = {};
  for (const f of listed) {
    if (old[f.id] && old[f.id].v === f.version) { devs[f.id] = old[f.id]; continue; }
    try {
      const j = JSON.parse(api(`${DRIVE}/files/${f.id}?alt=media`, {}, true));
      if (j.endpoint && j.keys?.p256dh && j.keys?.auth) devs[f.id] = { v: f.version, name: String(j.name || 'device').slice(0, 40), endpoint: j.endpoint, keys: { p256dh: j.keys.p256dh, auth: j.keys.auth }, vapid: j.vapid || '', confirmedAt: j.confirmedAt || 0, tested: old[f.id]?.endpoint === j.endpoint ? old[f.id].tested : 0 };
    } catch (e) { if (e.status && e.status !== 404) throw e; }
  }
  const send = (id, msg) => {
    const dev = devs[id];
    if (dev.vapid && dev.vapid !== keys.public) return 'old key'; // the device re-subscribes on its next sync
    const r = env.push(request(dev, keys, msg, msg.test ? 24 * 3600 : 3600));
    if (r.status === 404 || r.status === 410) { // the browser threw this subscription away: forget the device file
      try { api(`${DRIVE}/files/${id}`, { method: 'PATCH', headers: json, body: JSON.stringify({ trashed: true }) }); } catch {}
      delete devs[id]; log.push(`${dev.name}: gone (${r.status}), removed`); return 'gone';
    }
    if (r.status >= 300) { log.push(`${dev.name}: push service said ${r.status} ${String(r.text).slice(0, 120)}`); return 'error'; }
    return 'ok';
  };
  // A test to each new device: once it shows, Steward on that device marks itself confirmed.
  for (const id of Object.keys(devs)) {
    const dev = devs[id];
    if (dev.confirmedAt || (dev.tested && Date.now() - dev.tested < 6 * 3600e3)) continue;
    if (send(id, { test: true, title: 'Steward notifications are on', body: `Reminders will show on this ${dev.name} even when Steward is closed.`, tag: 'steward-test' }) === 'ok') { dev.tested = Date.now(); log.push(`test sent to ${dev.name}`); }
  }

  // ---- reminders ----
  const meta = api(`${DRIVE}/files/${d.tasks}?fields=version`);
  let plan = readJson(env.props.get('pushPlan'), null);
  if (!plan || plan.v !== meta.version || Date.now() - plan.at > 50 * 60000) {
    store.merge('tasks', JSON.parse(api(`${DRIVE}/files/${d.tasks}?alt=media`, {}, true)));
    plan = planFrom(meta.version);
    env.props.set('pushPlan', JSON.stringify(plan));
  }
  const now = Date.now();
  const sent = Object.fromEntries(Object.entries(readJson(env.props.get('pushSent'), {})).filter(([, at]) => at > now - 2 * LATE));
  const due = plan.items.filter(x => x.at <= now + 30000 && x.at > now - LATE && !sent[x.k]);
  for (const r of due) {
    const ids = Object.keys(devs);
    const results = ids.map(id => send(id, { title: r.title, body: r.body || 'Steward reminder', tag: r.k, taskId: r.id }));
    if (!ids.length || results.some(x => x === 'ok' || x === 'gone') || results.every(x => x !== 'error')) sent[r.k] = r.at;
    log.push(`reminder "${r.title}" → ${ids.map((id, i) => `${devs[id]?.name || 'device'} ${results[i]}`).join(', ') || 'no devices'}`);
  }
  env.props.set('pushSent', JSON.stringify(sent));
  env.props.set('pushDevices', JSON.stringify(devs));
  return log.join('\n') || 'Nothing due.';
}

/** Makes the sender keys (once) and the notifications folder with key.json in it. Returns the keys. */
function setUpPush(env, api, find, json, d) {
  let keys = readJson(env.props.get('pushKeys'), null);
  if (!keys) { keys = newKeys(); env.props.set('pushKeys', JSON.stringify(keys)); }
  if (d.push && d.pushKey === keys.public) return keys;
  if (!d.push) { const f = find('notifications', d.root, true); d.push = f ? f.id : api(`${DRIVE}/files?fields=id`, { method: 'POST', headers: json, body: JSON.stringify({ name: 'notifications', parents: [d.root], mimeType: FOLDER }) }).id; }
  const body = JSON.stringify({ about: 'Steward notifications: the public half of the Google helper\'s sender key. Steward on each device subscribes with it.', publicKey: keys.public });
  const f = find('key.json', d.push);
  if (f) api(`${UPLOAD}/files/${f.id}?uploadType=media`, { method: 'PATCH', headers: { 'Content-Type': 'text/plain' }, body });
  else env.upload({ name: 'key.json', parents: [d.push], mimeType: 'text/plain' }, body);
  d.pushKey = keys.public;
  env.props.set('drive', JSON.stringify(d));
  return keys;
}

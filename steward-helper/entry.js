// Steward helper that runs in Google Apps Script every few minutes, in Charles's own Google account.
// While Steward is closed on every device it:
//   1. applies the task changes Claude leaves in "Steward/inbox for Claude" to steward-tasks.json, and
//   2. sends Steward's reminders as notifications to the phone and the Mac (Web Push, see push.js), checking every
//      minute; until every device has shown its test notification, it also keeps the old "Steward Reminders"
//      calendar right as a backup, and empties that calendar once notifications are proven.
// It uses Steward's own task code (store.js, model.js, dates.js), so changes are applied exactly as the app does.
// Change files that touch notes are left for the app (they need its HTML tools).
import './shims.js'; // must stay first
import { store } from '../steward/js/store.js';
import { applyOps, parseChangeFile, openTasks, reminderTimes, reminderKey, projectName, blocksOn } from '../steward/js/model.js';
import { isRunning, isPaused, dayOf } from '../steward/js/session-core.js';
import { newKeys, request } from './push.js';

const DRIVE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const CAL = 'https://www.googleapis.com/calendar/v3';
const FOLDER = 'application/vnd.google-apps.folder';
// (Since Steward 4.5 there is no Writing section: a change that names a document or source is answered with a
// report saying so, by the shared applyOps, and everything else in the file is applied as usual.)
// Identities, goals, sessions and reviews live in steward-goals.json, which only the app reads and writes; a task
// filed under a goal by its title needs that file too. Those change files are left for the app as well.
// Which changes the helper may apply itself, and which wait for the app: see needs-app.js.
import { needsApp } from './needs-app.js';

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

/** Finds the Steward folder, the inbox and the task file (remembered between runs). Returns null if not set up yet. */
function locate(env, api, find) {
  let d = JSON.parse(env.props.get('drive') || 'null');
  const alive = id => { try { return !api(`${DRIVE}/files/${id}?fields=trashed`).trashed; } catch (e) { if (e.status === 404) return false; throw e; } };
  if (!d || !alive(d.inbox) || !alive(d.tasks)) {
    const root = find('Steward', 'root', true);
    if (!root) return null;
    const inbox = find('inbox for Claude', root.id, true), tasks = find('steward-tasks.json', root.id);
    if (!inbox || !tasks) return null;
    d = { root: root.id, inbox: inbox.id, tasks: tasks.id };
    env.props.set('drive', JSON.stringify(d));
  }
  if (d.push && !alive(d.push)) { delete d.push; env.props.set('drive', JSON.stringify(d)); }
  return d;
}
// Change files the app has taken to apply itself (through web() below): the timer leaves them alone for a while.
const CLAIM = 10 * 60000;
const claims = env => Object.fromEntries(Object.entries(readJson(env.props.get('claimed'), {})).filter(([, at]) => at > Date.now() - CLAIM));

export function run(env) {
  const log = [];
  const { api, json, find, trash } = tools(env);

  // ---- where things are ----
  const d = locate(env, api, find);
  if (!d) return 'Steward has not finished setting up Drive yet.';
  setUpPush(env, api, find, json, d);

  // ---- 1. Claude's change files ----
  const q = `'${d.inbox}' in parents and trashed=false`;
  const claimed = claims(env);
  const files = (api(`${DRIVE}/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType)&orderBy=createdTime&pageSize=100`).files || [])
    .filter(f => !/^(failed-|report-)/.test(f.name) && f.mimeType !== FOLDER && !claimed[f.id]);
  // Files left for the app last time (notes) don't need looking at again until the app takes them.
  const deferred = new Set(JSON.parse(env.props.get('deferred') || '[]'));
  const fresh = files.filter(f => !deferred.has(f.id));
  env.props.set('deferred', JSON.stringify(files.filter(f => deferred.has(f.id)).map(f => f.id)));
  const meta = api(`${DRIVE}/files/${d.tasks}?fields=version`);
  const remindersDue = meta.version !== env.props.get('tasksVersion') || Date.now() - Number(env.props.get('remindersAt') || 0) > 6 * 3600e3;
  // Steward finds this helper through the shared settings in steward-tasks.json (it can only see its own files).
  const urlNew = !!env.url && env.props.get('urlSaved') !== env.url;
  if (!fresh.length && !remindersDue && !urlNew) return 'Nothing new.';

  store.merge('tasks', JSON.parse(api(`${DRIVE}/files/${d.tasks}?alt=media`, {}, true)));
  if (urlNew) { const cur = store.get('prefs', 'shared'); store.put('prefs', { ...(cur || {}), id: 'shared', helperUrl: env.url }); log.push('helper address saved for Steward'); }
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
      ops = parseChangeFile(api(url, {}, true));
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
  if (applied || urlNew) {
    // Re-read just before writing: if a device saved in the meantime, fold its version in so nothing is lost.
    const now = api(`${DRIVE}/files/${d.tasks}?fields=version`);
    if (now.version !== meta.version) store.merge('tasks', JSON.parse(api(`${DRIVE}/files/${d.tasks}?alt=media`, {}, true)));
    const r = api(`${UPLOAD}/files/${d.tasks}?uploadType=media&fields=id,version`, { method: 'PATCH', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(store.snapshot('tasks')) });
    env.props.set('tasksVersion', r.version);
    if (urlNew) env.props.set('urlSaved', env.url);
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

/** What to send about timers in the next few hours: focus sessions ending, and family blocks beginning. */
function focusPlanFrom(gVersion, tVersion, now) {
  const items = [], sessions = store.all('sessions'), title = id => { const t = id && store.rawGet('tasks', id); return t && !t.deleted ? t.content : ''; };
  for (const s of sessions) {
    if (!isRunning(s) || isPaused(s) || s.kind === 'family' || !s.endsAt) continue;
    if (s.endsAt < now - LATE || s.endsAt > now + PLAN_AHEAD) continue;
    const what = title(s.taskId) || store.get('goals', s.goalId)?.title || store.get('identities', s.identityId)?.name || '';
    items.push({ k: 'fs-' + s.id, at: s.endsAt, title: 'Focus session done', body: (what ? String(what).slice(0, 90) + ' · ' : '') + 'time to check in', url: '#/focus' });
  }
  // a block that belongs to an identity counted with a timer: offer the timer when it starts, unless one is running
  const timed = new Set(store.all('identities').filter(i => i.timed).map(i => i.id));
  const going = sessions.some(s => isRunning(s) && s.kind === 'family');
  if (timed.size && !going) {
    const day = dayOf(now), [y, m, dd] = day.split('-').map(Number);
    for (const x of blocksOn(day)) {
      if (!timed.has(x.b.identityId)) continue;
      const at = new Date(y, m - 1, dd, Math.floor(x.start / 60), x.start % 60).getTime();
      if (at < now - LATE || at > now + PLAN_AHEAD) continue;
      items.push({ k: `fb-${x.b.id}-${day}`, at, title: 'Family time: start the timer?', body: String(x.b.name).slice(0, 80) + ' · tap to start counting', url: '#/family-start' });
    }
  }
  items.sort((a, b) => a.at - b.at);
  return { g: gVersion, t: tVersion, at: now, items: items.slice(0, 20) };
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
  const deliver = (list, what) => {
    for (const r of list.filter(x => x.at <= now + 30000 && x.at > now - LATE && !sent[x.k])) {
      const ids = Object.keys(devs);
      const results = ids.map(id => send(id, { title: r.title, body: r.body || 'Steward reminder', tag: r.k, ...(r.id ? { taskId: r.id } : {}), ...(r.url ? { url: r.url } : {}) }));
      if (!ids.length || results.some(x => x === 'ok' || x === 'gone') || results.every(x => x !== 'error')) sent[r.k] = r.at;
      log.push(`${what} "${r.title}" → ${ids.map((id, i) => `${devs[id]?.name || 'device'} ${results[i]}`).join(', ') || 'no devices'}`);
    }
  };
  deliver(plan.items, 'reminder');

  // ---- focus sessions and family time (steward-goals.json, written by the app) ----
  // The end of a running focus session, and "start the timer?" when a fixed block of a timed identity (family dinner,
  // date night) begins. One more look at a file version each minute; the file is read only when it has changed.
  if (!d.goals && now - Number(env.props.get('goalsLooked') || 0) > 10 * 60000) {
    env.props.set('goalsLooked', String(now));
    const f = find('steward-goals.json', d.root);
    if (f) { d.goals = f.id; env.props.set('drive', JSON.stringify(d)); }
  }
  if (d.goals) {
    let gmeta = null;
    try { gmeta = api(`${DRIVE}/files/${d.goals}?fields=version,trashed`); } catch (e) { if (e.status !== 404) throw e; }
    if (!gmeta || gmeta.trashed) { delete d.goals; env.props.set('drive', JSON.stringify(d)); }
    else {
      let fp = readJson(env.props.get('focusPlan'), null);
      if (!fp || fp.g !== gmeta.version || fp.t !== meta.version || now - fp.at > 50 * 60000) {
        store.merge('tasks', JSON.parse(api(`${DRIVE}/files/${d.tasks}?alt=media`, {}, true)));
        store.merge('goals', JSON.parse(api(`${DRIVE}/files/${d.goals}?alt=media`, {}, true)));
        fp = focusPlanFrom(gmeta.version, meta.version, now);
        env.props.set('focusPlan', JSON.stringify(fp));
      }
      deliver(fp.items, 'timer');
    }
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

// ---- Steward's line to the helper ----------------------------------------------------------------------------
// Steward signs in with per-file Drive access only ("drive.file"), so Google never shows it a warning screen. That
// access covers the files Steward made itself, but not the files Claude leaves in "inbox for Claude", the photos and
// scans Claude files into Steward/attachments, the notifications folder this helper keeps, or Google Calendar.
// Steward reaches those through this helper, published as a web app that runs as Charles. wrapper.gs.js checks that
// every request carries a Google pass issued to Steward for the same Google account before calling web().
const SLIM_EVENT = e => ({ id: e.id, summary: e.summary, start: e.start, end: e.end, location: e.location, description: e.description, recurringEventId: e.recurringEventId, htmlLink: e.htmlLink, status: e.status });

export function web(env, req) {
  const { api, json, find, trash } = tools(env);
  const d = locate(env, api, find);
  if (!d) return { ok: false, error: 'Steward has not finished setting up Drive yet.' };
  const parentsOf = id => api(`${DRIVE}/files/${id}?fields=parents,trashed`);
  switch (req.action) {
    case 'ping': return { ok: true, root: d.root };

    // Claude's change files, for Steward to apply itself. The timer leaves them alone for 10 minutes once taken.
    case 'inbox': {
      const q = `'${d.inbox}' in parents and trashed=false`;
      const listed = (api(`${DRIVE}/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType)&orderBy=createdTime&pageSize=100`).files || [])
        .filter(f => !/^(failed-|report-)/.test(f.name) && f.mimeType !== FOLDER).slice(0, 25);
      const claimed = claims(env), files = [];
      for (const f of listed) {
        const url = f.mimeType === 'application/vnd.google-apps.document' ? `${DRIVE}/files/${f.id}/export?mimeType=text/plain` : `${DRIVE}/files/${f.id}?alt=media`;
        let text; try { text = String(api(url, {}, true)); } catch (e) { if (e.status === 404) continue; throw e; }
        claimed[f.id] = Date.now(); files.push({ id: f.id, name: f.name, text });
      }
      env.props.set('claimed', JSON.stringify(claimed));
      return { ok: true, files };
    }
    case 'inboxDone': {
      const claimed = claims(env), deferred = new Set(readJson(env.props.get('deferred'), []));
      const inInbox = id => { try { const m = parentsOf(id); return !m.trashed && (m.parents || []).includes(d.inbox); } catch (e) { if (e.status === 404) return false; throw e; } };
      for (const id of req.done || []) { if (inInbox(id)) trash(id); delete claimed[id]; deferred.delete(id); }
      for (const f of req.failed || []) {
        if (inInbox(f.id)) api(`${DRIVE}/files/${f.id}`, { method: 'PATCH', headers: json, body: JSON.stringify({ name: 'failed-' + String(f.name || 'change.json').replace(/^failed-/, '') }) });
        delete claimed[f.id]; deferred.delete(f.id);
      }
      for (const id of req.release || []) delete claimed[id]; // taken but left for later (a note change while Steward was closed)
      env.props.set('claimed', JSON.stringify(claimed)); env.props.set('deferred', JSON.stringify([...deferred]));
      return { ok: true };
    }

    // A photo, scan or PDF that Claude put in Steward/attachments (Steward can read its own uploads directly).
    case 'file': {
      const m = parentsOf(req.id);
      const att = find('attachments', d.root, true);
      if (m.trashed || !att || !(m.parents || []).includes(att.id)) return { ok: false, error: 'not a Steward attachment' };
      return { ok: true, ...env.download(req.id) };
    }

    // Google Calendar
    case 'calendar': {
      const hidden = new Set(req.hidden || []);
      const list = api(`${CAL}/users/me/calendarList?minAccessRole=reader`).items || [];
      const calendars = list.map(c => ({ id: c.id, summary: c.summaryOverride || c.summary, backgroundColor: c.backgroundColor, primary: !!c.primary, accessRole: c.accessRole }));
      const events = [];
      for (const c of calendars) {
        if (hidden.has(c.id) || c.summary === 'Steward Reminders') continue;
        let pageToken = '';
        do {
          const r = api(`${CAL}/calendars/${encodeURIComponent(c.id)}/events?singleEvents=true&orderBy=startTime&maxResults=2500&timeMin=${encodeURIComponent(req.from)}&timeMax=${encodeURIComponent(req.to)}${pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''}`);
          for (const e of r.items || []) if (e.status !== 'cancelled') events.push({ calId: c.id, e: SLIM_EVENT(e) });
          pageToken = r.nextPageToken || '';
        } while (pageToken);
      }
      return { ok: true, calendars, events };
    }
    case 'calSave': {
      const base = `${CAL}/calendars/${encodeURIComponent(req.calId)}/events`;
      const e = req.eventId ? api(`${base}/${encodeURIComponent(req.eventId)}`, { method: 'PATCH', headers: json, body: JSON.stringify(req.body) })
        : api(base, { method: 'POST', headers: json, body: JSON.stringify(req.body) });
      return { ok: true, event: SLIM_EVENT(e) };
    }
    case 'calDelete': {
      try { api(`${CAL}/calendars/${encodeURIComponent(req.calId)}/events/${encodeURIComponent(req.eventId)}`, { method: 'DELETE' }); }
      catch (e) { if (e.status !== 404 && e.status !== 410) throw e; }
      return { ok: true };
    }

    // Notifications: the sender key, and this device's entry in Steward/notifications.
    case 'push': {
      const keys = setUpPush(env, api, find, json, d);
      let mine = null;
      if (req.remove) {
        const m = parentsOf(req.remove);
        if (!m.trashed && (m.parents || []).includes(d.push)) trash(req.remove);
      }
      if (req.device && /^[a-z0-9]{4,20}$/.test(req.device.id || '')) {
        const name = `device-${req.device.id}.json`, body = String(req.device.body || '');
        JSON.parse(body); // must be a device entry, not anything else
        const f = find(name, d.push);
        if (f) { api(`${UPLOAD}/files/${f.id}?uploadType=media`, { method: 'PATCH', headers: { 'Content-Type': 'text/plain' }, body }); mine = f.id; }
        else mine = env.upload({ name, parents: [d.push], mimeType: 'text/plain' }, body).id;
      }
      const q = `'${d.push}' in parents and trashed=false and name contains 'device-'`;
      const devices = [];
      for (const f of api(`${DRIVE}/files?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=100`).files || []) {
        try { const j = JSON.parse(api(`${DRIVE}/files/${f.id}?alt=media`, {}, true)); devices.push({ id: f.id, file: f.name, name: String(j.name || 'device').slice(0, 40), confirmedAt: j.confirmedAt || 0, endpoint: j.endpoint || '' }); }
        catch (e) { if (e.status && e.status !== 404) throw e; }
      }
      return { ok: true, publicKey: keys.public, devices, mine };
    }

    // Claude (Anthropic API). The API key lives only in this script's properties: Steward is public code on GitHub,
    // so the key can never be inside the app. Steward sends the words, the helper adds the key and asks Claude.
    case 'aiKey': {
      if (typeof req.set === 'string') {
        const k = req.set.trim();
        if (!/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(k)) return { ok: false, error: 'That does not look like an Anthropic API key (it starts with sk-ant-).' };
        const test = env.anthropic(k, { model: AI_MODELS.haiku.id, max_tokens: 5, messages: [{ role: 'user', content: 'Reply with OK.' }] });
        if (test.status === 401 || test.status === 403) return { ok: false, error: 'Anthropic did not accept that key.' };
        if (test.status >= 300 && !/credit|billing|balance/i.test(test.text)) return { ok: false, error: 'Anthropic answered ' + test.status + '. Try again in a minute.' };
        env.props.set('anthropicKey', k);
        if (test.status >= 300) return { ok: true, hasKey: true, warning: 'Key saved, but the account has no credit yet. Add credit in the Claude Console (Billing).' };
      }
      if (req.clear) env.props.set('anthropicKey', '');
      return { ok: true, hasKey: !!env.props.get('anthropicKey'), usage: aiUsage(env) };
    }
    case 'ai': {
      const key = env.props.get('anthropicKey');
      if (!key) return { ok: false, error: 'no-key' };
      const m = AI_MODELS[req.model];
      if (!m) return { ok: false, error: 'unknown model' };
      const messages = (Array.isArray(req.messages) ? req.messages : []).slice(-12)
        .filter(x => x && (x.role === 'user' || x.role === 'assistant') && typeof x.content === 'string')
        .map(x => ({ role: x.role, content: x.content.slice(0, m.maxChars) }));
      if (!messages.length || messages[messages.length - 1].role !== 'user') return { ok: false, error: 'nothing to ask' };
      const body = { model: m.id, max_tokens: Math.max(16, Math.min(m.maxOut, Number(req.max_tokens) || m.maxOut)), messages };
      if (typeof req.system === 'string' && req.system) body.system = req.system.slice(0, 20000);
      const r = env.anthropic(key, body);
      let j = null; try { j = JSON.parse(r.text); } catch (e) {}
      if (r.status >= 300 || !j) {
        const why = j?.error?.message || ('Anthropic answered ' + r.status);
        return { ok: false, error: /credit|billing|balance/i.test(why) ? 'no-credit' : r.status === 401 ? 'bad-key' : why.slice(0, 200) };
      }
      const text = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
      const u = j.usage || {}, cost = ((u.input_tokens || 0) * m.inPrice + (u.output_tokens || 0) * m.outPrice) / 1e6;
      const usage = aiUsage(env); usage.calls++; usage.cost = Math.round((usage.cost + cost) * 1e6) / 1e6;
      usage[req.model] = (usage[req.model] || 0) + 1;
      env.props.set('aiUsage', JSON.stringify(usage));
      return { ok: true, text, stop: j.stop_reason, usage };
    }
  }
  return { ok: false, error: 'unknown request' };
}

// Claude models Steward may use, with list prices per million tokens (Nov 2026; Haiku's price is for prompts under 100k).
const AI_MODELS = {
  haiku: { id: 'claude-haiku-5-5', inPrice: 0.10, outPrice: 0.50, maxOut: 600, maxChars: 20000 },
  sonnet: { id: 'claude-sonnet-5-5', inPrice: 2, outPrice: 10, maxOut: 4000, maxChars: 120000 },
};
// This month's Claude use, kept so Settings can show what it costs.
function aiUsage(env) {
  const month = new Date().toISOString().slice(0, 7);
  const u = readJson(env.props.get('aiUsage'), null);
  return u && u.month === month ? u : { month, calls: 0, cost: 0 };
}

// Runs out/Code.gs in a bare V8 context shaped like Apps Script (no timers, no crypto, no DOM) against a fake Google.
import vm from 'node:vm';
import fs from 'node:fs';
const code = fs.readFileSync(new URL('./out/Code.gs', import.meta.url), 'utf8');

const files = new Map(); let nid = 1;
const mk = (name, parent, body, mime = 'text/plain') => { const id = 'f' + nid++; files.set(id, { id, name, parents: [parent], body, version: '1', mimeType: mime, trashed: false }); return id; };
const root = mk('Steward', 'root', null, 'application/vnd.google-apps.folder');
const inbox = mk('inbox for Claude', root, null, 'application/vnd.google-apps.folder');
const tasksId = mk('steward-tasks.json', root, JSON.stringify({ app: 'steward', format: 1, tasks: [{ id: 't-old', content: 'Existing task', projectId: 'inbox', updatedAt: 1, createdAt: 1 }, { id: 't-done', content: 'Mow Wenger', projectId: 'inbox', due: { date: '2026-11-18', time: '15:00' }, updatedAt: 1, createdAt: 1 }], projects: [], sections: [], comments: [], labels: [{ id: 'lb-promise', name: 'promise', updatedAt: 1, createdAt: 1 }], filters: [], prefs: [], blocks: [] }));
const due = new Date(Date.now() + 3 * 3600e3), pad = n => String(n).padStart(2, '0');
const ymd = `${due.getFullYear()}-${pad(due.getMonth() + 1)}-${pad(due.getDate())}`, hm = `${pad(due.getHours())}:00`;
const callFile = mk('claude-2026-11-17-call.json', inbox, JSON.stringify({ ops: [
  { op: 'upsert', type: 'task', item: { id: 'cl-20261117-call-1', content: 'Call Linda about patio', due: { date: ymd, time: hm }, labels: ['promise'], project: 'Hanel' } },
  { op: 'upsert', type: 'task', item: { content: 'Order sand', due: 'tomorrow 7am' } },
  { op: 'complete', id: 't-done' },
  { op: 'upsert', type: 'task', item: { id: 'nope', due: 'fri' } },
] }));
const noteFile = mk('claude-2026-11-17-note.json', inbox, JSON.stringify({ ops: [{ op: 'upsert', type: 'note', item: { title: 'Plan', markdown: '# hi' } }] }));
const badFile = mk('claude-2026-11-17-bad.json', inbox, '{ not json');
const events = new Map([['olddead', { id: 'olddead', summary: '⏰ gone', description: 'steward-task:zzz', start: { dateTime: due.toISOString() } }]]);

function handle(url, o) {
  const u = new URL(url), m = (o.method || 'get').toUpperCase(); let mm;
  const J = (x, s = 200) => ({ s, t: JSON.stringify(x) });
  if (u.pathname === '/calendar/v3/users/me/calendarList') return J({ items: [{ id: 'remcal', summary: 'Steward Reminders' }] });
  if ((mm = /^\/calendar\/v3\/calendars\/remcal\/events(?:\/(.+))?$/.exec(u.pathname))) {
    if (m === 'GET') return J({ items: [...events.values()] });
    if (m === 'DELETE') { events.delete(mm[1]); return { s: 204, t: '' }; }
    const b = JSON.parse(o.payload); events.set(b.id, b); return J(b);
  }
  if (u.pathname === '/drive/v3/files' && m === 'GET') {
    const q = u.searchParams.get('q'), parent = /'([^']+)' in parents/.exec(q)[1], name = /name='([^']+)'/.exec(q)?.[1];
    return J({ files: [...files.values()].filter(f => !f.trashed && f.parents.includes(parent) && (!name || f.name === name)) });
  }
  if ((mm = /^\/drive\/v3\/files\/([^/]+)$/.exec(u.pathname))) {
    const f = files.get(mm[1]); if (!f) return J({}, 404);
    if (m === 'PATCH') { Object.assign(f, JSON.parse(o.payload)); return J({ id: f.id }); }
    if (u.searchParams.get('alt') === 'media') return { s: 200, t: f.body };
    return J({ version: f.version, trashed: f.trashed });
  }
  if ((mm = /^\/upload\/drive\/v3\/files\/([^/]+)$/.exec(u.pathname))) { const f = files.get(mm[1]); f.body = o.payload; f.version = String(+f.version + 1); return J({ id: f.id, version: f.version }); }
  if (u.pathname === '/upload/drive/v3/files') { const parts = o.payload.split(/--steward\d+/); const meta = JSON.parse(parts[1].split('\r\n\r\n')[1]); mk(meta.name, meta.parents[0], parts[2].split('\r\n\r\n')[1]); return J({}); }
  throw new Error('unhandled ' + m + ' ' + url);
}
const props = new Map(), logs = [];
const ctx = {
  console: { log: s => logs.push(s) },
  ScriptApp: { getOAuthToken: () => 'AT', getProjectTriggers: () => [], newTrigger: () => ({ timeBased: () => ({ everyMinutes: () => ({ create: () => {} }) }) }) },
  PropertiesService: { getScriptProperties: () => ({ getProperty: k => props.get(k) ?? null, setProperty: (k, v) => props.set(k, v) }) },
  LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
  Utilities: { sleep: () => {} },
  UrlFetchApp: { fetch: (url, o) => { if (o.headers.Authorization !== 'Bearer AT') throw new Error('no auth'); const r = handle(url, o); return { getResponseCode: () => r.s, getContentText: () => r.t }; } },
};
vm.createContext(ctx);
vm.runInContext(code, ctx);
vm.runInContext('setUp()', ctx);

const ok = (c, w) => { console.log((c ? 'PASS ' : 'FAIL ') + w); if (!c) process.exitCode = 1; };
const t = JSON.parse(files.get(tasksId).body).tasks;
const call = t.find(x => x.id === 'cl-20261117-call-1');
ok(call && call.due.date === ymd && call.labels.includes('promise'), "Claude's task added with date and promise label");
ok(JSON.parse(files.get(tasksId).body).projects.some(p => p.name === 'Hanel') && call.projectId !== 'inbox', 'project created by name');
ok(t.some(x => x.content === 'Order sand' && x.due?.time === '07:00'), 'plain-words date understood ("tomorrow 7am")');
ok(t.find(x => x.id === 't-done').completedAt, 'complete applied');
ok(!t.some(x => x.id === 'nope'), 'patch to unknown task refused (no blank task)');
ok(files.get(callFile).trashed, 'applied file moved to trash');
ok(!files.get(noteFile).trashed, 'note file left for the app');
ok(files.get(badFile).name.startsWith('failed-'), 'unreadable file renamed failed-');
const reports = [...files.values()].filter(f => f.name.startsWith('report-'));
ok(reports.some(r => /nope|no task with that id/.test(r.body)) && reports.some(r => /bad/.test(r.name)), 'reports written for problems');
ok([...events.values()].some(e => e.summary === '⏰ Call Linda about patio' && e.id.startsWith('st')), 'phone reminder created');
ok(!events.has('olddead'), 'stale reminder removed');
ok(![...events.values()].some(e => e.summary === '⏰ Mow Wenger'), 'no reminder for completed task');
const n = events.size;
logs.length = 0; vm.runInContext('syncSteward()', ctx);
ok(logs[0] === 'Nothing new.', 'second run does nothing (saves quota): ' + logs[0]);
ok(events.size === n, 'no duplicate reminders');
console.log('first-run log:\n' + [...props.entries()].map(([k, v]) => k + '=' + v).join('\n'));

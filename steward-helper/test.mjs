// Runs out/Code.gs in a bare V8 context shaped like Apps Script (no timers, no crypto, no DOM) against a fake Google.
import vm from 'node:vm';
import fs from 'node:fs';
import nodeCrypto from 'node:crypto';
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
    const q = u.searchParams.get('q'), parent = /'([^']+)' in parents/.exec(q)[1], name = /name='([^']+)'/.exec(q)?.[1], part = /name contains '([^']+)'/.exec(q)?.[1];
    return J({ files: [...files.values()].filter(f => !f.trashed && f.parents.includes(parent) && (!name || f.name === name) && (!part || f.name.includes(part))) });
  }
  if (u.pathname === '/drive/v3/files' && m === 'POST') { const b = JSON.parse(o.payload); return J({ id: mk(b.name, b.parents[0], null, b.mimeType) }); }
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
const props = new Map(), logs = [], triggers = [], pushes = [];
const ctx = {
  console: { log: s => logs.push(s) },
  ScriptApp: { getOAuthToken: () => 'AT', getProjectTriggers: () => [], newTrigger: fn => ({ timeBased: () => ({ everyMinutes: n => ({ create: () => { triggers.push(fn + '/' + n); } }) }) }) },
  PropertiesService: { getScriptProperties: () => ({ getProperty: k => props.get(k) ?? null, setProperty: (k, v) => props.set(k, v) }) },
  LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
  Utilities: { sleep: () => {}, getUuid: () => nodeCrypto.randomUUID(), DigestAlgorithm: { SHA_256: 'sha256' }, computeDigest: (a, s) => Array.from(nodeCrypto.createHash('sha256').update(s).digest(), b => (b > 127 ? b - 256 : b)) },
  UrlFetchApp: { fetch: (url, o) => {
    if (url.startsWith('https://fcm.googleapis.com/')) { pushes.push({ url, o }); const s = url.endsWith('/gone') ? 410 : 201; return { getResponseCode: () => s, getContentText: () => '' }; }
    if (o.headers.Authorization !== 'Bearer AT') throw new Error('no auth'); const r = handle(url, o); return { getResponseCode: () => r.s, getContentText: () => r.t }; } },
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

// ---- notifications ----
ok(triggers.includes('syncSteward/10') && triggers.includes('sendReminders/1'), 'timers set: sync every 10 min, reminders every minute');
const pushFolder = [...files.values()].find(f => f.name === 'notifications');
const keyFile = [...files.values()].find(f => f.name === 'key.json');
ok(pushFolder && keyFile && keyFile.parents[0] === pushFolder.id, 'notifications folder and key.json made');
const serverPub = JSON.parse(keyFile.body).publicKey;
ok(Buffer.from(serverPub, 'base64url').length === 65, 'public sender key is a P-256 point');
ok(!JSON.parse(props.get('pushKeys')).secret.includes(serverPub) && !keyFile.body.includes(JSON.parse(props.get('pushKeys')).secret), 'secret half never written to Drive');
// a phone subscribes (as Chrome would)
const ua = nodeCrypto.createECDH('prime256v1'); ua.generateKeys();
const authSecret = nodeCrypto.randomBytes(16);
const devFile = mk('device-phone1.json', pushFolder.id, JSON.stringify({ name: 'phone', endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: authSecret.toString('base64url') }, vapid: serverPub }));
mk('device-old.json', pushFolder.id, JSON.stringify({ name: 'old laptop', endpoint: 'https://fcm.googleapis.com/fcm/send/gone', keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: authSecret.toString('base64url') }, vapid: serverPub }));
// a reminder due right now
const tj = JSON.parse(files.get(tasksId).body);
const nowD = new Date(), ymdN = `${nowD.getFullYear()}-${pad(nowD.getMonth() + 1)}-${pad(nowD.getDate())}`, hmN = `${pad(nowD.getHours())}:${pad(nowD.getMinutes())}`;
tj.tasks.push({ id: 't-now', content: 'Text Daniel the Wenger time', projectId: 'inbox', labels: ['promise'], due: { date: ymdN, time: hmN }, updatedAt: 2, createdAt: 2 });
files.get(tasksId).body = JSON.stringify(tj); files.get(tasksId).version = String(+files.get(tasksId).version + 1);
pushes.length = 0; logs.length = 0;
vm.runInContext('sendReminders()', ctx);
function open(p) {
  const body = Buffer.from(p.o.payload.map(b => b & 255));
  const salt = body.subarray(0, 16), rs = body.readUInt32BE(16), idlen = body[20], asPub = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
  const shared = ua.computeSecret(asPub);
  const ikm = Buffer.from(nodeCrypto.hkdfSync('sha256', shared, authSecret, Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPub]), 32));
  const cek = Buffer.from(nodeCrypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(nodeCrypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = nodeCrypto.createDecipheriv('aes-128-gcm', cek, nonce); d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  ok(rs === 4096 && plain[plain.length - 1] === 2, 'record header and padding delimiter right');
  return JSON.parse(plain.subarray(0, plain.length - 1).toString());
}
function vapidOk(p) {
  const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(p.o.headers.Authorization);
  if (!m) return false;
  const jwk = { kty: 'EC', crv: 'P-256', x: Buffer.from(m[4], 'base64url').subarray(1, 33).toString('base64url'), y: Buffer.from(m[4], 'base64url').subarray(33).toString('base64url') };
  const good = nodeCrypto.verify('sha256', Buffer.from(m[1] + '.' + m[2]), { key: nodeCrypto.createPublicKey({ key: jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, Buffer.from(m[3], 'base64url'));
  const claims = JSON.parse(Buffer.from(m[2], 'base64url'));
  return good && m[4] === serverPub && claims.aud === 'https://fcm.googleapis.com' && claims.exp > Date.now() / 1000 && /^https:/.test(claims.sub);
}
const toPhone = pushes.filter(p => p.url.endsWith('/abc'));
ok(toPhone.length === 2, 'phone got the test and the reminder: ' + toPhone.length);
ok(toPhone.every(vapidOk), 'VAPID signature verifies with the published key');
ok(toPhone.every(p => p.o.headers['Content-Encoding'] === 'aes128gcm' && p.o.headers.TTL && !/Bearer/.test(p.o.headers.Authorization)), 'push headers right, no Google pass sent');
const msgs = toPhone.map(open);
ok(msgs.some(x => x.test && /phone/.test(x.body)), 'test notification decrypts');
const rem = msgs.find(x => x.taskId === 't-now');
ok(rem && rem.title === 'Text Daniel the Wenger time' && /Customer promise/.test(rem.body), 'reminder decrypts with title and body: ' + JSON.stringify(rem));
ok([...files.values()].find(f => f.name === 'device-old.json').trashed, 'device the browser dropped (410) is forgotten');
pushes.length = 0; vm.runInContext('sendReminders()', ctx);
ok(pushes.length === 0, 'nothing sent twice');
// before the device confirms, the calendar stays as a backup; after, it is emptied
ok([...events.values()].some(e => e.id.startsWith('st')), 'calendar kept until notifications are proven');
files.get(devFile).body = JSON.stringify({ ...JSON.parse(files.get(devFile).body), confirmedAt: Date.now() }); files.get(devFile).version = '2';
vm.runInContext('sendReminders()', ctx);
props.set('remindersAt', '0'); logs.length = 0; vm.runInContext('syncSteward()', ctx);
ok(![...events.values()].some(e => e.id.startsWith('st')), 'calendar reminders removed once the device confirmed: ' + logs.join(' | '));
console.log('first-run log:\n' + [...props.entries()].map(([k, v]) => k + '=' + v).join('\n'));

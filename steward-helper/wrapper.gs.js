
// ---- Apps Script side --------------------------------------------------------------------------------------------
function stewardEnv_() {
  const token = ScriptApp.getOAuthToken();
  const props = PropertiesService.getScriptProperties();
  const http = (url, opts) => {
    const o = { method: (opts.method || 'GET').toLowerCase(), headers: Object.assign({ Authorization: 'Bearer ' + token }, opts.headers || {}), muteHttpExceptions: true };
    if (o.headers['Content-Type']) { o.contentType = o.headers['Content-Type']; delete o.headers['Content-Type']; }
    if (opts.body != null) o.payload = opts.body;
    for (let attempt = 0; ; attempt++) {
      const r = UrlFetchApp.fetch(url, o);
      const status = r.getResponseCode();
      if ((status === 429 || status >= 500) && attempt < 2) { Utilities.sleep(1000 * 3 ** attempt); continue; }
      return { status, text: r.getContentText() };
    }
  };
  const upload = (meta, text) => {
    const boundary = 'steward' + Date.now();
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${text}\r\n--${boundary}--`;
    const r = http('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', { method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + boundary }, body });
    if (r.status >= 300) throw new Error('upload ' + r.status);
    return JSON.parse(r.text);
  };
  // A file's bytes, for Steward (it cannot read files Claude uploaded). Base64 so it travels as text.
  const download = id => {
    const meta = JSON.parse(http('https://www.googleapis.com/drive/v3/files/' + id + '?fields=mimeType,size', {}).text);
    if (Number(meta.size || 0) > 35e6) throw new Error('too big to pass along');
    const r = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + id + '?alt=media', { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
    if (r.getResponseCode() >= 300) throw new Error('download ' + r.getResponseCode());
    return { mime: meta.mimeType || 'application/octet-stream', b64: Utilities.base64Encode(r.getContent()) };
  };
  // Web Push: no Google pass here (the push service checks Steward's own signed sender note instead); binary body.
  const push = req => {
    const headers = Object.assign({}, req.headers), contentType = headers['Content-Type']; delete headers['Content-Type'];
    const payload = Array.from(req.body, b => (b > 127 ? b - 256 : b));
    const r = UrlFetchApp.fetch(req.url, { method: 'post', headers, contentType, payload, muteHttpExceptions: true });
    return { status: r.getResponseCode(), text: r.getContentText() };
  };
  let url = props.getProperty('webAppUrl') || '';
  if (!url) try { url = ScriptApp.getService().getUrl() || ''; } catch (e) {}
  url = url.replace(/\/dev$/, '/exec');
  return { http, upload, download, push, url, props: { get: k => props.getProperty(k), set: (k, v) => props.setProperty(k, String(v)) } };
}

/** Runs on the timer. */
function syncSteward() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return; // the previous run is still going
  try { console.log(StewardHelper.run(stewardEnv_())); } finally { lock.releaseLock(); }
}

/** Runs every minute: sends reminders due now to the phone and the Mac. */
function sendReminders() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return;
  try { const out = StewardHelper.tick(stewardEnv_()); if (out !== 'Nothing due.') console.log(out); } finally { lock.releaseLock(); }
}

/** Run this once by hand: it asks for permission, sets the timers, and does a first sync. */
function setUp() {
  for (const t of ScriptApp.getProjectTriggers()) if (['syncSteward', 'sendReminders'].includes(t.getHandlerFunction())) ScriptApp.deleteTrigger(t);
  ScriptApp.newTrigger('syncSteward').timeBased().everyMinutes(10).create();
  ScriptApp.newTrigger('sendReminders').timeBased().everyMinutes(1).create();
  syncSteward();
  sendReminders();
}

// ---- Steward's requests (published as a web app: Execute as me, Who has access: Anyone) ----------------------------
// "Anyone" only means Google lets the request reach this script; the script itself answers only a request carrying a
// Google pass that Google issued to the Steward app, for this same Google account.
const STEWARD_CLIENT_ID_ = '953176719624-701gj43chqpp040biv5qvvr628o8rflo.apps.googleusercontent.com';
function stewardCallerOk_(token) {
  if (!token || typeof token !== 'string' || token.length > 4096) return false;
  const cache = CacheService.getScriptCache();
  const key = 'pass-' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token));
  if (cache.get(key)) return true;
  const info = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?access_token=' + encodeURIComponent(token), { muteHttpExceptions: true });
  if (info.getResponseCode() !== 200) return false;
  const j = JSON.parse(info.getContentText());
  const client = PropertiesService.getScriptProperties().getProperty('clientId') || STEWARD_CLIENT_ID_;
  if (j.aud !== client && j.azp !== client) return false;
  const who = t => { const r = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/about?fields=user(permissionId)', { headers: { Authorization: 'Bearer ' + t }, muteHttpExceptions: true }); return r.getResponseCode() === 200 ? JSON.parse(r.getContentText()).user.permissionId : null; };
  const them = who(token);
  if (!them || them !== who(ScriptApp.getOAuthToken())) return false;
  cache.put(key, '1', Math.max(60, Math.min(3000, Number(j.expires_in || 0) - 60)));
  return true;
}
function doPost(e) {
  const reply = o => ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
  let req;
  try { req = JSON.parse(e.postData.contents); } catch (err) { return reply({ ok: false, error: 'bad request' }); }
  if (!stewardCallerOk_(req.token)) return reply({ ok: false, error: 'auth' });
  delete req.token;
  const locked = ['inbox', 'inboxDone', 'push'].includes(req.action);
  const lock = LockService.getScriptLock();
  if (locked && !lock.tryLock(25000)) return reply({ ok: false, error: 'busy' });
  try { return reply(StewardHelper.web(stewardEnv_(), req)); }
  catch (err) { console.warn(err); return reply({ ok: false, error: String(err.message || err).slice(0, 300) }); }
  finally { if (locked) lock.releaseLock(); }
}
function doGet() { return ContentService.createTextOutput('Steward helper is running.'); }


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
    const r = http('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', { method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + boundary }, body });
    if (r.status >= 300) throw new Error('upload ' + r.status);
  };
  // Web Push: no Google pass here (the push service checks Steward's own signed sender note instead); binary body.
  const push = req => {
    const headers = Object.assign({}, req.headers), contentType = headers['Content-Type']; delete headers['Content-Type'];
    const payload = Array.from(req.body, b => (b > 127 ? b - 256 : b));
    const r = UrlFetchApp.fetch(req.url, { method: 'post', headers, contentType, payload, muteHttpExceptions: true });
    return { status: r.getResponseCode(), text: r.getContentText() };
  };
  return { http, upload, push, props: { get: k => props.getProperty(k), set: (k, v) => props.setProperty(k, String(v)) } };
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

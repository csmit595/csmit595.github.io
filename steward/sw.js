// Service worker: makes Steward open with no connection, receives things shared from other apps, and syncs with
// Google Drive in the background while Steward is closed (loaded as a module: register('sw.js', { type: 'module' })).
import { bgSync } from './js/bg.js';
import { kvSet } from './js/lsmirror.js';
const VERSION = 'steward-5.0.2';
// Tools (PDF reader, page reader, search model) are kept in their own cache, so an update to Steward
// never throws them away and they keep working with no signal. Bump only when a file in vendor/ changes.
const TOOLS = 'steward-tools-1';
const FILES = ['./', 'index.html', 'manifest.webmanifest', 'css/app.css', 'icons/icon-192.png', 'icons/mark.png', 'icons/icon-512.png',
  'js/boot.js', 'js/lsmirror.js', 'js/bg.js', 'js/app.js', 'js/util.js', 'js/store.js', 'js/model.js', 'js/dates.js', 'js/filters.js', 'js/sync.js', 'js/ui.js', 'js/tasks.js', 'js/notes.js', 'js/ocr.js', 'js/search.js', 'js/semantic.js', 'js/semantic-worker.js', 'js/dayplan.js', 'js/import-todoist.js', 'js/offline.js', 'js/dictate.js', 'js/listen-device.js', 'js/whisper-worker.js', 'js/mic-worklet.js', 'js/organize.js', 'js/organize-core.js', 'js/context-core.js', 'js/ai.js', 'js/inbox-sort.js', 'js/versions.js', 'js/versions-core.js', 'js/migrate.js', 'js/legacy-writing.js', 'js/goals-core.js', 'js/goals.js', 'js/focus.js', 'js/session-core.js', 'js/stats-core.js', 'js/stats.js', 'js/review.js', 'js/scripture.js', 'js/kjv.js', 'fonts/inter-latin-wght-normal.woff2', 'fonts/bitter-latin-500-normal.woff2', 'fonts/bitter-latin-600-normal.woff2', 'fonts/bitter-latin-700-normal.woff2', 'fonts/bitter-latin-400-italic.woff2', 'icons/icon-maskable-512.png', 'privacy.html'];

self.addEventListener('install', e => { e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES.map(f => new Request(f, { cache: 'reload' })))).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    const tools = await caches.open(TOOLS);
    for (const k of keys) {
      if (!k.startsWith('steward-') || k === VERSION || k === TOOLS || k === 'steward-share') continue;
      // Older versions kept tools in the app cache: move them over instead of downloading them again.
      if (!k.startsWith('steward-tools-')) {
        const old = await caches.open(k);
        for (const req of await old.keys()) if (/\/vendor\//.test(req.url) && !(await tools.match(req))) { const r = await old.match(req); if (r) await tools.put(req, r).catch(() => {}); }
      }
      await caches.delete(k);
    }
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  if (e.request.method === 'POST' && url.pathname.endsWith('/share')) {
    e.respondWith((async () => {
      const fd = await e.request.formData();
      const cache = await caches.open('steward-share');
      const meta = { title: fd.get('title') || '', text: fd.get('text') || '', url: fd.get('url') || '', files: [] };
      let i = 0;
      for (const f of fd.getAll('files')) {
        if (!(f instanceof File)) continue;
        const key = '__share/' + i++;
        await cache.put(key, new Response(f, { headers: { 'Content-Type': f.type || 'application/octet-stream', 'X-Name': encodeURIComponent(f.name || 'file') } }));
        meta.files.push(key);
      }
      await cache.put('__share/meta', new Response(JSON.stringify(meta), { headers: { 'Content-Type': 'application/json' } }));
      return Response.redirect('./#shared', 303);
    })());
    return;
  }
  if (e.request.method !== 'GET' || url.pathname.includes('/clipper/')) return;
  // Tools: use the copy on the device; download (and keep) only if it is missing.
  if (/\/vendor\//.test(url.pathname)) {
    e.respondWith((async () => {
      const tools = await caches.open(TOOLS);
      const hit = await tools.match(e.request, { ignoreSearch: true });
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res.status === 200 && res.type === 'basic') await tools.put(e.request, res.clone()).catch(() => {});
      return res;
    })());
    return;
  }
  // Network first so updates arrive; fall back to the saved copy when offline, or when the signal is so weak
  // that the network has not answered within a few seconds (a job site with one bar must not mean a blank screen).
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const saved = () => cache.match(e.request, { ignoreSearch: true }).then(r => r || (e.request.mode === 'navigate' ? cache.match('index.html') : undefined));
    const big = /\/vendor\//.test(url.pathname); // large one-time downloads (search model, page reader) get all the time they need
    // Steward's own files skip the phone's 10-minute web cache (a quick "has it changed?" check), so a new version shows up at once.
    const req = big ? e.request : e.request.mode === 'navigate' ? new Request(e.request.url, { cache: 'no-cache', credentials: 'same-origin' }) : new Request(e.request, { cache: 'no-cache' });
    const net = fetch(req).then(res => { if (res.redirected && e.request.mode === 'navigate') return Response.redirect(res.url, 302); if (res.status === 200 && res.type === 'basic') cache.put(e.request, res.clone()).catch(() => {}); return res; });
    let timer;
    const slow = big ? new Promise(() => {}) : new Promise(r => { timer = setTimeout(async () => r(await saved()), 3500); });
    try {
      const res = await Promise.race([net, slow.then(r => r || net)]);
      return res;
    } catch {
      return (await saved()) || Response.error();
    } finally { clearTimeout(timer); net.catch(() => {}); }
  })());
});
self.addEventListener('message', e => { if (e.data?.steward === 'skip-waiting') self.skipWaiting(); });
// Reminders sent by the Steward helper (Google Apps Script) through Web Push: they arrive even while Steward is closed.
self.addEventListener('push', e => {
  let m = {};
  try { m = e.data ? e.data.json() : {}; } catch { m = { body: e.data?.text() || '' }; }
  e.waitUntil((async () => {
    await self.registration.showNotification(m.title || 'Steward reminder', {
      body: m.body || '', icon: 'icons/icon-192.png', tag: m.tag || undefined, renotify: !!m.tag, timestamp: Date.now(),
      requireInteraction: !m.test, // a reminder stays on screen (Mac) until dealt with; the test does not
      data: { taskId: m.taskId || null, url: typeof m.url === 'string' && /^#\/[\w-]+$/.test(m.url) ? m.url : null },
    });
    // Remember that notifications work on this device; the next sync tells the helper (and the other devices).
    const sub = await self.registration.pushManager.getSubscription().catch(() => null);
    await kvSet('pushOk', { at: Date.now(), endpoint: sub?.endpoint || '' }).catch(() => {});
    if (m.test) await bgSync('push-test');
  })());
});
// The browser renewed this device's push address: subscribe again and update Drive.
self.addEventListener('pushsubscriptionchange', e => { e.waitUntil(bgSync('push-renew')); });
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const id = e.notification.data?.taskId, url = e.notification.data?.url; // url: a screen to open (a finished focus session, the family timer)
  e.waitUntil((async () => {
    const cs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (cs[0]) { await cs[0].focus().catch(() => {}); if (id) cs[0].postMessage({ steward: 'open-task', id }); else if (url) cs[0].postMessage({ steward: 'go', url }); return; }
    await self.clients.openWindow(id ? './#/task/' + encodeURIComponent(id) : url ? './' + url : './');
  })());
});

// Chrome wakes Steward every so often (it decides how often) to sync while closed.
self.addEventListener('periodicsync', e => { if (e.tag === 'steward-sync') e.waitUntil(bgSync('periodic')); });
// Changes made with no signal are sent as soon as the connection comes back, even if Steward was closed.
self.addEventListener('sync', e => { if (e.tag === 'steward-push') e.waitUntil(bgSync('push')); });

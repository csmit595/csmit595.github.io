// Service worker: makes Steward open with no connection, receives things shared from other apps, and syncs with
// Google Drive in the background while Steward is closed (loaded as a module: register('sw.js', { type: 'module' })).
import { bgSync } from './js/bg.js';
const VERSION = 'steward-3.3.0';
const FILES = ['./', 'index.html', 'manifest.webmanifest', 'css/app.css', 'icons/icon-192.png', 'icons/mark.png', 'icons/icon-512.png',
  'js/boot.js', 'js/lsmirror.js', 'js/bg.js', 'js/app.js', 'js/util.js', 'js/store.js', 'js/model.js', 'js/dates.js', 'js/filters.js', 'js/sync.js', 'js/ui.js', 'js/tasks.js', 'js/notes.js', 'js/calendar.js', 'js/ocr.js', 'js/search.js', 'js/semantic.js', 'js/semantic-worker.js', 'js/writing.js', 'js/cite.js', 'js/export-docx.js', 'js/writing-tools.js', 'js/dayplan.js', 'js/import-todoist.js'];

self.addEventListener('install', e => { e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('steward-') && k !== VERSION && k !== 'steward-share').map(k => caches.delete(k)))).then(() => self.clients.claim()));
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
  // Network first so updates arrive; fall back to the saved copy when offline, or when the signal is so weak
  // that the network has not answered within a few seconds (a job site with one bar must not mean a blank screen).
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const saved = () => cache.match(e.request, { ignoreSearch: true }).then(r => r || (e.request.mode === 'navigate' ? cache.match('index.html') : undefined));
    const net = fetch(e.request).then(res => { if (res.status === 200 && res.type === 'basic') cache.put(e.request, res.clone()).catch(() => {}); return res; });
    const big = /\/vendor\//.test(url.pathname); // large one-time downloads (search model, page reader) get all the time they need
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
self.addEventListener('notificationclick', e => { e.notification.close(); e.waitUntil(self.clients.matchAll({ type: 'window' }).then(cs => (cs[0] ? cs[0].focus() : self.clients.openWindow('./')))); });

// Chrome wakes Steward every so often (it decides how often) to sync while closed.
self.addEventListener('periodicsync', e => { if (e.tag === 'steward-sync') e.waitUntil(bgSync('periodic')); });
// Changes made with no signal are sent as soon as the connection comes back, even if Steward was closed.
self.addEventListener('sync', e => { if (e.tag === 'steward-push') e.waitUntil(bgSync('push')); });

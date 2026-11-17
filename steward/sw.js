// Service worker: makes Bruin open with no connection and receives things shared from other apps.
const VERSION = 'steward-1.2.0';
const FILES = ['./', 'index.html', 'manifest.webmanifest', 'css/app.css', 'icons/icon-192.png', 'icons/mark.png', 'icons/icon-512.png',
  'js/app.js', 'js/util.js', 'js/store.js', 'js/model.js', 'js/dates.js', 'js/filters.js', 'js/sync.js', 'js/ui.js', 'js/tasks.js', 'js/notes.js', 'js/calendar.js'];

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
  if (e.request.method !== 'GET') return;
  // Network first so updates arrive; fall back to the saved copy when offline.
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    try {
      const res = await fetch(e.request);
      if (res.ok) cache.put(e.request, res.clone());
      return res;
    } catch {
      return (await cache.match(e.request, { ignoreSearch: true })) || (e.request.mode === 'navigate' ? cache.match('index.html') : Response.error());
    }
  })());
});
self.addEventListener('notificationclick', e => { e.notification.close(); e.waitUntil(self.clients.matchAll({ type: 'window' }).then(cs => (cs[0] ? cs[0].focus() : self.clients.openWindow('./')))); });

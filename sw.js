// sw.js — offline shell. App files are cache-first with a background refresh;
// anything else (Google APIs, PDF.js) goes straight to the network.

const VERSION = 'planner-v11';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/app.js',
  './js/store.js',
  './js/util.js',
  './js/ui.js',
  './js/editor.js',
  './js/gcal.js',
  './js/cloud.js',
  './js/appearance.js',
  './js/syllabus.js',
  './js/capture.js',
  './js/views/overview.js',
  './js/views/semester.js',
  './js/views/week.js',
  './js/views/areas.js',
  './js/views/notes.js',
  './js/views/settings.js',
  './icons/favicon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION)
      // cache: 'reload' fetches past the HTTP cache. Without it a plain c.add()
      // is served by it, and since Pages sends max-age=600 a freshly bumped
      // VERSION can be filled with the files it was bumped to replace.
      .then((c) => Promise.allSettled(
        SHELL.map((u) => c.add(new Request(u, { cache: 'reload' })))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;      // Google, CDN: network only

  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const hit = await cache.match(e.request, { ignoreSearch: true });
    const net = fetch(e.request).then((res) => {
      if (res && res.ok) cache.put(e.request, res.clone());
      return res;
    }).catch(() => null);
    return hit || (await net) || cache.match('./index.html');
  })());
});

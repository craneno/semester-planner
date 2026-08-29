// sw.js — offline shell.
//
// One cache per VERSION, written once at install and never touched again, so
// everything it serves came from the same deploy. Anything not in the shell
// (Google APIs, PDF.js) goes straight to the network.

const VERSION = 'planner-v14';
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
    if (hit) return hit;

    // Anything not in the shell still goes to the network, but the shell is
    // never written to after install. It used to refresh each file in the
    // background, which quietly broke the one guarantee that matters: a cache
    // held whatever each file happened to be when it was last requested, so a
    // page could run one version's JS against another version's CSS — blocks
    // positioned against the viewport because .day-lanes had no rule yet.
    // A cache now only ever holds what one VERSION installed, all at once.
    const net = await fetch(e.request).catch(() => null);
    return net || cache.match('./index.html');
  })());
});

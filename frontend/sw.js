// Installable app shell. Pages load from the network first (fresh data, correct sign-in state)
// and fall back to the cached shell offline. API responses are never cached.
const CACHE = 'schedora-shell-v2';
const SHELL = ['/', '/index.html', '/app.css', '/app.js', '/favicon.svg', '/logo-schedora.png', '/manifest.webmanifest'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  // Meeting pages are never served by the worker: their camera/microphone and CSP headers must come from the server.
  if (event.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/') || /^\/meet\/(room|join)\//.test(url.pathname)) return;
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(() => caches.match('/index.html')));
    return;
  }
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok) caches.open(CACHE).then(cache => cache.put(event.request, response.clone()));
    return response;
  }).catch(() => caches.match(event.request)));
});

const CACHE = 'stdhub-shell-v2';
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/favicon-256.png', '/icon-192.png', '/icon-512.png', '/css/theme-tokens.css', '/css/components-global.css', '/css/mobile.css', '/css/pages.css', '/css/themes.css', '/js/app-core.js', '/js/app-search-core.js'];

self.addEventListener('install', event => event.waitUntil(
  caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting())
));

self.addEventListener('activate', event => event.waitUntil(
  caches.keys()
    .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
    .then(() => self.clients.claim())
));

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/') || /\.pdf$/i.test(url.pathname)) return;

  const isDocument = request.mode === 'navigate' || url.pathname === '/' || url.pathname === '/index.html';
  if (isDocument) {
    event.respondWith(
      fetch(request)
        .then(response => {
          if (response.ok) caches.open(CACHE).then(cache => cache.put(request, response.clone()));
          return response;
        })
        .catch(() => caches.match(request).then(cached => cached || caches.match('/index.html')))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(cached => cached || fetch(request).then(response => {
      if (response.ok && /\.(css|js|png|ico|webmanifest)$/i.test(url.pathname)) {
        caches.open(CACHE).then(cache => cache.put(request, response.clone()));
      }
      return response;
    }))
  );
});

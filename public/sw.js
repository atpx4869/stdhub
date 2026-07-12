const CACHE = 'stdhub-shell-v1';
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/favicon-256.png', '/icon-192.png', '/icon-512.png', '/css/theme-tokens.css', '/css/components-global.css', '/css/mobile.css', '/css/pages.css', '/css/themes.css', '/js/app-core.js', '/js/app-search-core.js'];
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/') || /\.pdf$/i.test(url.pathname)) return;
  event.respondWith(caches.match(request).then(cached => cached || fetch(request).then(response => { if (response.ok && (url.pathname === '/' || /\.(css|js|png|ico|webmanifest)$/i.test(url.pathname))) { const copy = response.clone(); caches.open(CACHE).then(cache => cache.put(request, copy)); } return response; }).catch(() => caches.match('/index.html'))));
});

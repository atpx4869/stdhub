const CACHE = 'stdhub-shell-v4';

// 只缓存"几乎不变"的 shell 资源（HTML / 图标 / manifest）
// JS / CSS 交给浏览器自己的 HTTP 缓存（带 ?v= 查询参数做版本控制）
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/favicon-256.png', '/icon-192.png', '/icon-512.png'];

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
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  // API / PDF / 跨域 —— 直接放行，不走 Service Worker
  if (url.pathname.startsWith('/api/') || /\.pdf$/i.test(url.pathname)) return;

  const isDocument = request.mode === 'navigate' || url.pathname === '/' || url.pathname === '/index.html';

  if (isDocument) {
    // 页面：联网优先，失败回退缓存
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

  // JS / CSS / 图片等静态资源：联网优先，利用浏览器自身 HTTP 缓存（304）
  // 失败时回退到 Service Worker 缓存
  event.respondWith(
    fetch(request).then(response => {
      if (response.ok) {
        const clone = response.clone();
        caches.open(CACHE).then(cache => cache.put(request, clone));
      }
      return response;
    }).catch(() => caches.match(request))
  );
});

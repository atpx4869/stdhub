const CACHE = 'stdhub-shell-v8-document-reader';

// 只缓存 shell（HTML / 图标 / manifest）
// JS / CSS 走浏览器 HTTP 缓存（带 ?v= 版本号），SW 不插手
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

  // API / PDF — 直接放行
  if (url.pathname.startsWith('/api/') || /\.pdf$/i.test(url.pathname)) return;

  // JS / CSS / 图片 / 字体 / 其他静态资源 — 直接放行，走浏览器 HTTP 缓存
  if (/\.(js|css|png|ico|svg|woff2?|ttf|mjs|map)$/i.test(url.pathname)) return;

  // 页面导航 — 联网优先，失败回退缓存
  if (request.mode === 'navigate' || url.pathname === '/' || url.pathname === '/index.html') {
    event.respondWith(
      fetch(request)
        .then(response => {
          if (response.ok) {
            try { caches.open(CACHE).then(cache => cache.put(request, response.clone())); } catch {}
          }
          return response;
        })
        .catch(() => caches.match(request).then(cached => cached || caches.match('/index.html')))
    );
  }
});

(function bootstrapDocument(global) {
  'use strict';
  const validThemes = ['dark', 'light', 'paper', 'legacy'];
  function detectLegacy() {
    try {
      const ua = navigator.userAgent || '';
      const chrome = ua.match(/Chrom(?:e|ium)\/(\d+)/);
      return Boolean((chrome && Number.parseInt(chrome[1], 10) <= 109) || /Windows NT (5\.|6\.[0-3])(?:[^\d]|$)/.test(ua));
    } catch { return false; }
  }
  let theme = 'dark';
  try {
    const saved = localStorage.getItem('bzxz.theme');
    if (validThemes.includes(saved)) theme = saved;
    else if (detectLegacy()) { theme = 'legacy'; localStorage.setItem('bzxz.theme', 'legacy'); }
  } catch { if (detectLegacy()) theme = 'legacy'; }
  document.documentElement.setAttribute('data-theme', theme);

  if (theme !== 'legacy') {
    for (const [rel, href, crossOrigin] of [
      ['preconnect', 'https://fonts.googleapis.com', false],
      ['preconnect', 'https://fonts.gstatic.com', true],
      ['stylesheet', 'https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;1,9..40,400&family=Source+Serif+4:ital,opsz,wght@0,8..60,400;0,8..60,500;1,8..60,400&family=DM+Mono:ital,wght@0,400;0,500&display=swap', false],
    ]) {
      const link = document.createElement('link');
      link.rel = rel;
      link.href = href;
      if (crossOrigin) link.crossOrigin = '';
      document.head.appendChild(link);
    }
  }

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    let reloading = false;
    global.addEventListener('load', () => {
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!reloading) { reloading = true; location.reload(); }
      });
      const version = new URL(document.currentScript?.src || location.href).searchParams.get('v') || 'dev';
      navigator.serviceWorker.register(`/sw.js?v=${encodeURIComponent(version)}`).catch(() => {});
    });
  }
})(window);

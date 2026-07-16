/**
 * 国家 CMA（机构级）能力徽章。
 *
 * 与 CNAS/CMA 订阅资质及一单一库独立：仅表示本地已同步的国家 CMA
 * 机构级能力数据严格命中当前标准号同年版，绝不暗示某个具体场所具有该能力。
 */
(function setupNatCmaBadge() {
  if (typeof window === 'undefined' || window.__natCmaBadgeReady) return;
  window.__natCmaBadgeReady = true;

  const cache = new Map();
  window.__natCmaMatchCache = cache;
  window.natCmaInvalidateCache = function () { cache.clear(); };

  window.natCmaBadgeHtml = function natCmaBadgeHtml(stdCode) {
    if (!stdCode) return '';
    const data = cache.get(stdCode);
    if (data === null) return '';
    if (data) return renderBadge(data);
    return '<span class="nat-cma-badge-pending" data-nat-cma="' + escapeAttr(stdCode) + '"></span>';
  };

  window.fetchNatCmaBadges = async function fetchNatCmaBadges(stdCodes) {
    if (!stdCodes || !stdCodes.length) return;
    const unique = [...new Set(stdCodes.filter(Boolean))];
    const pending = unique.filter(code => !cache.has(code));
    if (pending.length) {
      try {
        const res = await fetch('/api/nat-cma/batch-match', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ stdCodes: pending }),
        });
        const body = res.ok ? await readApiResponse(res) : {};
        for (const code of pending) {
          cache.set(code, body && Object.prototype.hasOwnProperty.call(body, code) ? body[code] : null);
        }
      } catch (_) {
        for (const code of pending) cache.set(code, null);
      }
    }
    document.querySelectorAll('.nat-cma-badge-pending[data-nat-cma]').forEach(el => {
      const code = el.getAttribute('data-nat-cma') || '';
      if (!cache.has(code)) return;
      const data = cache.get(code);
      if (!data) { el.remove(); return; }
      el.outerHTML = renderBadge(data);
    });
  };

  function renderBadge(data) {
    const organizations = Array.isArray(data.organizations) ? data.organizations : [];
    const names = organizations.map(item => item.orgName || item.certCode).filter(Boolean);
    const count = Number(data.abilityCount || 0);
    const tip = '国家 CMA · 机构级能力数据\n'
      + '严格匹配当前标准号同年版\n'
      + (names.length ? '机构：' + names.join('、') + '\n' : '')
      + '匹配能力记录：' + count + ' 条\n'
      + '场所订阅仅用于管理范围，不代表场所独立能力。';
    return '<span class="qual-badge qual-badge-cma nat-cma-badge" title="' + escapeAttr(tip) + '">'
      + '<span class="qual-dot"></span>国家CMA<span class="qual-tooltip">' + escapeHtml(tip).replace(/\n/g, '<br>') + '</span></span>';
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function escapeAttr(value) { return escapeHtml(value).replace(/"/g, '&quot;'); }
})();

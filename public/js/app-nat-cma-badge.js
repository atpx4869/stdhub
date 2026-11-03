/** 本院已批准能力表「国CMA」徽章；与旧在线抓取、CNAS/CMA、国家库独立。 */
(function setupNatCmaBadge() {
  if (typeof window === 'undefined' || window.__natCmaBadgeReady) return;
  window.__natCmaBadgeReady = true;
  const cache = new Map();
  const checked = new Map();
  const inFlight = new Map();
  const TTL_MS = 60000;
  let generation = 0;
  window.__natCmaMatchCache = cache;

  function cached(code) {
    if (!checked.has(code) || Date.now() - checked.get(code) >= TTL_MS) {
      cache.delete(code);
      checked.delete(code);
      return undefined;
    }
    return cache.get(code);
  }
  function placeholder(code) {
    return '<span class="nat-cma-badge-pending" data-nat-cma="' + escapeAttr(code) + '"></span>';
  }
  window.natCmaInvalidateCache = function () {
    generation++;
    cache.clear(); checked.clear(); inFlight.clear();
    const codes = [];
    document.querySelectorAll('[data-nat-cma]').forEach(el => {
      const code = el.getAttribute('data-nat-cma');
      if (!code) return;
      codes.push(code);
      el.outerHTML = placeholder(code);
    });
    if (codes.length) window.fetchNatCmaBadges(codes);
  };
  window.natCmaBadgeHtml = function natCmaBadgeHtml(stdCode) {
    if (!stdCode) return '';
    const data = cached(stdCode);
    if (data === null) return placeholder(stdCode);
    return data ? renderBadge(data, stdCode) : placeholder(stdCode);
  };
  window.fetchNatCmaBadges = async function fetchNatCmaBadges(stdCodes) {
    if (!Array.isArray(stdCodes) || !stdCodes.length) return;
    const current = generation;
    const unique = [...new Set(stdCodes.filter(code => typeof code === 'string' && code.trim()))];
    const pending = unique.filter(code => cached(code) === undefined && !inFlight.has(code));
    const jobs = [];
    for (let start = 0; start < pending.length; start += 100) {
      const chunk = pending.slice(start, start + 100);
      const job = (async function () {
        try {
          const res = await fetch('/api/nat-cma/table/batch-match', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ stdCodes: chunk }),
          });
          if (!res.ok) return; // A transport/auth failure is not a confirmed non-match.
          const body = await readApiResponse(res);
          if (!body || typeof body !== 'object' || current !== generation) return;
          for (const code of chunk) {
            const data = Object.prototype.hasOwnProperty.call(body, code) ? body[code] : null;
            cache.set(code, data && Number(data.abilityCount) > 0 ? data : null);
            checked.set(code, Date.now());
          }
          while (cache.size > 3000) {
            const key = cache.keys().next().value;
            cache.delete(key); checked.delete(key);
          }
        } catch (_) { /* Keep unknown retryable; never cache network failures as absent. */ }
        finally {
          if (current === generation) chunk.forEach(code => inFlight.delete(code));
        }
      })();
      chunk.forEach(code => inFlight.set(code, job));
      jobs.push(job);
    }
    unique.forEach(code => { const job = inFlight.get(code); if (job) jobs.push(job); });
    await Promise.all(jobs);
    if (current !== generation) return;
    document.querySelectorAll('[data-nat-cma]').forEach(el => {
      const code = el.getAttribute('data-nat-cma') || '';
      const data = cached(code);
      if (data === undefined) {
        if (el.classList.contains('nat-cma-badge')) el.outerHTML = placeholder(code);
        return;
      }
      if (!data) {
        // Keep an invisible, retryable marker for version changes and expired negatives.
        if (!el.classList.contains('nat-cma-badge-pending')) el.outerHTML = placeholder(code);
        return;
      }
      el.outerHTML = renderBadge(data, code);
    });
    if (typeof window.refreshLocalBadgePriority === 'function') window.refreshLocalBadgePriority(document);
  };
  function renderBadge(data, code) {
    const tip = '国CMA · 湖北省产品质量监督检验研究院已批准能力表\n'
      + '严格匹配当前标准号同年版\n'
      + '匹配能力记录：' + Number(data.abilityCount || 0) + ' 条\n'
      + (data.summary ? String(data.summary) + '\n' : '')
      + (data.limited ? '存在部分参数或限制范围，请查看明细\n' : '')
      + '命中不等于全标准覆盖；点击查看产品、参数与限制。';
    return '<span class="qual-badge qual-badge-cma nat-cma-badge" role="button" tabindex="0" data-nat-cma="'
      + escapeAttr(code) + '" aria-label="查看 ' + escapeAttr(code) + ' 的国CMA能力明细" title="' + escapeAttr(tip) + '">'
      + '<span class="qual-dot"></span>国CMA<span class="qual-tooltip">' + escapeHtml(tip).replace(/\n/g, '<br>') + '</span></span>';
  }
  function openBadge(event) {
    if (event.type === 'keydown' && event.key !== 'Enter' && event.key !== ' ') return;
    const target = event.target && event.target.closest ? event.target.closest('.nat-cma-badge[data-nat-cma]') : null;
    if (!target) return;
    event.preventDefault(); event.stopPropagation();
    if (typeof window.openNatCmaTableStandard === 'function') window.openNatCmaTableStandard(target.getAttribute('data-nat-cma'));
  }
  document.addEventListener('click', openBadge, true);
  document.addEventListener('keydown', openBadge, true);
  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function escapeAttr(value) { return escapeHtml(value).replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
})();

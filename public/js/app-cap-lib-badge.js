/**
 * 国家 CMA 一单一库 徽章 —— 跨页面共享组件。
 *
 * 注入到：
 * 1) 标准检索结果卡（app-search.js 调用 capLibBadgeHtml + flushCapLibBadgesIn）
 * 2) 资质查询页搜索结果（app-qual.js renderQualSearchResults 调用同样接口）
 * 3) cma-diff 比对页表格（app-cma-diff.js 直接渲染 5 档完整版）
 *
 * 状态：4+1 档（详见 src/shared/cap-lib-status.ts）
 *   ✅ in_lib       绿 「国家库 · {领域}」
 *   ⚠ cite_only    黄 「已废止·仅限引用」
 *   🟠 abolished   橙 「已废止」
 *   🔴 series_only 红 「年版不在库 → 改用 {seriesNewCode}」
 *   ⛔ not_in_lib  深红「未入库」
 *
 * 数据缓存：window.__capLibStatusCache（Map<stdCode, status|null>）
 * 失效时机：cma-diff 页同步完成后调用 window.capLibInvalidateCache()
 */

(function setupCapLibBadge() {
  if (typeof window === 'undefined') return;
  if (window.__capLibBadgeReady) return;
  window.__capLibBadgeReady = true;

  /** @type {Map<string, object|null>} */
  const cache = new Map();
  window.__capLibStatusCache = cache;

  /** 让外部清掉缓存（同步完成后） */
  window.capLibInvalidateCache = function () { cache.clear(); };

  /**
   * 给一组 stdCode 渲染占位 + 异步拉状态填充。
   * 占位徽章用 data-cap-lib="<stdCode>" 标记，拿到结果后 querySelectorAll 全部替换。
   *
   * @param {string} stdCode
   * @returns {string} 占位 HTML 片段（不命中也会先渲染空 span 等数据回来再替换）
   */
  window.capLibBadgeHtml = function capLibBadgeHtml(stdCode) {
    if (!stdCode) return '';
    const esc = escAttr(stdCode);
    const cached = cache.get(stdCode);
    if (cached === null) return ''; // 已确认无数据，不再渲染
    if (cached) return renderBadgeMarkup(cached, stdCode);
    return `<span class="cap-lib-badge cap-lib-badge-pending" data-cap-lib="${esc}"></span>`;
  };

  /**
   * 拉取一批 stdCode 的状态并填充 DOM（替换 .cap-lib-badge-pending 占位）。
   * 多次调用同一批 stdCode 会自动从缓存复用、只查未命中的。
   *
   * @param {string[]} stdCodes
   */
  window.fetchCapLibBadges = async function fetchCapLibBadges(stdCodes) {
    if (!stdCodes || !stdCodes.length) return;
    const unique = [...new Set(stdCodes.filter(Boolean))];
    const pending = unique.filter(c => !cache.has(c));
    if (pending.length) {
      try {
        const res = await fetch('/api/cma-diff/batch-status', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ stdCodes: pending }),
        });
        if (res.ok) {
          const body = await readApiResponse(res);
          // 后端返回 toCamelCase 过的 { [stdCode]: { status, libDomain, ... } }；
          // 未命中的 stdCode 不在响应里，统一标 null 防止下次重查
          for (const c of pending) {
            cache.set(c, body && Object.prototype.hasOwnProperty.call(body, c) ? body[c] : null);
          }
        } else {
          // 服务端错（如未启用 cma-diff tab + 没有 qual/search 权限）静默；
          // 占位保留为空 chip，不影响主页面
          for (const c of pending) cache.set(c, null);
        }
      } catch (e) {
        for (const c of pending) cache.set(c, null);
      }
    }
    // DOM 替换
    document.querySelectorAll('.cap-lib-badge-pending[data-cap-lib]').forEach(el => {
      const code = el.getAttribute('data-cap-lib') || '';
      if (!cache.has(code)) return;
      const data = cache.get(code);
      if (!data) { el.remove(); return; }
      el.outerHTML = renderBadgeMarkup(data, code);
    });
  };

  /** 把单条 status 数据渲染成 .cap-lib-badge 标记。 */
  function renderBadgeMarkup(data, stdCode) {
    if (!data) return '';
    const st = data.status;
    if (!st) return '';
    // 不画 stale 且 not_in_lib（用户根本没同步过库，徽章无意义）
    if (data.stale && st === 'not_in_lib') return '';
    const cls = 'cap-lib-badge cap-lib-badge-' + st.replace(/_/g, '-');
    const { label, tip } = describeStatus(data, stdCode);
    return '<span class="' + cls + '" title="' + escAttr(tip) + '"><span class="cap-lib-dot"></span>' + escHtml(label) + '</span>';
  }

  function describeStatus(data, stdCode) {
    const domain = data.libDomain || '';
    switch (data.status) {
      case 'in_lib':
        return { label: '国家库', tip: '国家库收录' + (domain ? ' · ' + domain : '') };
      case 'cite_only':
        return { label: '已废止·可引用', tip: (data.libRemark || '已废止，仅限能力项目库范围内现行有效产品标准引用') };
      case 'abolished':
        return { label: '已废止', tip: (data.libRemark || '已废止，不在能力项目库范围内') };
      case 'series_only':
        return {
          label: '年版过期',
          tip: '年版 ' + stdCode + ' 不在国家库，建议改用 ' + (data.seriesNewCode || '新年版'),
        };
      case 'not_in_lib':
        return { label: '未入库', tip: '该标准号不在国家 CMA 能力项目库内（资质到期不再延续）' };
      default:
        return { label: '', tip: '' };
    }
  }

  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function escAttr(s) {
    return escHtml(s).replace(/"/g, '&quot;');
  }
})();

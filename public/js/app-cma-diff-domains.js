/**
 * CMA 一单一库比对 — 领域订阅 + 同步 + 进度轮询。
 *
 * 已从 app-cma-diff.js 拆出，与 labs / search 模块共享全局作用域。
 * utils（formatDateTime / escHtml / escAttr / cssEscape）定义在本文件 IIFE 前，
 * 后续模块可直接调用。常量通过 window._cmaDiff 暴露。
 */

// ── 共享工具（file-scope，跨模块可用）─────────────────────────────

function formatDateTime(s) {
  if (!s) return '';
  try {
    const d = new Date(s);
    const pad = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
      + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  } catch { return s; }
}
function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escAttr(s) { return escHtml(s).replace(/"/g, '&quot;'); }
function cssEscape(s) {
  if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(String(s));
  return String(s).replace(/["\\\]]/g, '\\$&');
}

(function () {
  if (typeof window === 'undefined') return;

  // ── 常量 & 状态 ────────────────────────────────────────────────

  var DIFF_STATUS_META = {
    in_lib:      { label: '在库',         color: 'var(--cap-lib-in-fg)',         emoji: '✅' },
    cite_only:   { label: '废止·可引用',   color: 'var(--cap-lib-cite-fg)',       emoji: '⚠'  },
    abolished:   { label: '已废止',       color: 'var(--cap-lib-abolished-fg)',  emoji: '🟠' },
    series_only: { label: '年版过期',     color: 'var(--cap-lib-series-fg)',     emoji: '🔴' },
    not_in_lib:  { label: '未入库',       color: 'var(--cap-lib-not-fg)',        emoji: '⛔' },
  };
  var STATUS_ORDER = ['in_lib', 'cite_only', 'abolished', 'series_only', 'not_in_lib'];
  var GROUP_ORDER = ['not_in_lib', 'series_only', 'abolished', 'cite_only', 'in_lib'];
  var PAGE_SIZE_OPTIONS = [50, 100, 200, 300, 500, 1000];
  var PAGE_SIZE_DEFAULT = 100;

  function getPageSize() {
    var v = parseInt(localStorage.getItem('capLib.pageSize'), 10);
    return PAGE_SIZE_OPTIONS.includes(v) ? v : PAGE_SIZE_DEFAULT;
  }
  function setPageSize(v) {
    if (PAGE_SIZE_OPTIONS.includes(v)) { try { localStorage.setItem('capLib.pageSize', String(v)); } catch (e) { /* ignore */ } }
  }

  // 暴露给其它模块
  window._cmaDiff = {
    DIFF_STATUS_META: DIFF_STATUS_META,
    STATUS_ORDER: STATUS_ORDER,
    GROUP_ORDER: GROUP_ORDER,
    PAGE_SIZE_OPTIONS: PAGE_SIZE_OPTIONS,
    getPageSize: getPageSize,
    setPageSize: setPageSize,
  };

  /** 进度轮询定时器 jobId → setInterval handle */
  var progressTimers = new Map();
  var progressSettlers = new Map();
  var pendingDomainSubs = new Map();
  var domainSubFlushTimer = null;
  var domainSubFlushPromise = Promise.resolve();

  window._tabCleanup = window._tabCleanup || {};
  window._tabCleanup.capLibDiff = function () {
    for (var t of progressTimers.values()) clearInterval(t);
    progressTimers.clear();
    progressSettlers.clear();
    if (pendingDomainSubs.size || domainSubFlushTimer) {
      flushPendingDomainSubs().catch(function () { /* toast already shown */ });
    }
  };

  // ── 用户辅助 ───────────────────────────────────────────────────

  function getCurrentUser() {
    try { return typeof currentUser !== 'undefined' ? currentUser : null; }
    catch (e) { return null; }
  }
  function isAdminUser() {
    var u = getCurrentUser();
    return !!(u && u.role === 'admin');
  }
  window._cmaDiff.isAdminUser = isAdminUser;

  // ── 入口 ──────────────────────────────────────────────────────

  window.loadCapLibPage = async function loadCapLibPage() {
    var adminBtn = document.getElementById('capLibCleanupBtn');
    if (adminBtn) adminBtn.style.display = isAdminUser() ? '' : 'none';
    var syncBtn = document.getElementById('capLibSyncAllBtn');
    if (syncBtn) syncBtn.disabled = !isAdminUser();
    if (syncBtn) syncBtn.title = syncBtn.disabled ? '仅管理员可触发同步' : '同步勾选的领域';

    await Promise.all([renderDomains(), window._cmaDiffRenderLabs()]);
  };

  window.addEventListener('tabchange', function (e) {
    var tab = e && e.detail && e.detail.tab;
    if (tab === 'cma-diff') {
      try { loadCapLibPage(); } catch (ex) { /* ignore */ }
    }
  });

  // ── 领域订阅 + 同步 ───────────────────────────────────────────

  async function renderDomains() {
    var box = document.getElementById('capLibDomainsBody');
    if (!box) return;
    try {
      var res = await fetch('/api/cma-diff/domains');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var data = await readApiResponse(res);
      var items = (data && data.items) || [];
      if (!items.length) { box.innerHTML = '<div style="color:var(--text-3)">无领域数据</div>'; return; }
      var isAdmin = isAdminUser();

      var subscribedCount = items.filter(function (it) { return it.subscribed; }).length;
      var latestSynced = '';
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        if (it.lastSyncedAt && (!latestSynced || it.lastSyncedAt > latestSynced)) latestSynced = it.lastSyncedAt;
      }
      var summaryEl = document.getElementById('capLibDomSummary');
      if (summaryEl) {
        summaryEl.textContent = '\u5DF2\u8BA2\u9605 ' + subscribedCount + ' \u4E2A\u9886\u57DF \u00B7 \u6700\u8FD1\u540C\u6B65 ' + (latestSynced ? formatDateTime(latestSynced) : '\u4ECE\u672A');
      }

      var batchBar = isAdmin
        ? '<div class="cap-lib-dom-batchbar">'
             + '<button class="btn btn-sm btn-ghost" onclick="capLibSyncChecked(this)">\u66F4\u65B0\u52FE\u9009</button>'
             + '<button class="btn btn-sm btn-ghost" onclick="capLibSyncAll(this)">\u5168\u90E8\u66F4\u65B0</button>'
             + '<span class="cap-lib-dom-batchhint">\u8FDC\u7AEF\u9650\u6D41\u5E76\u53D1\u62C9\u53D6\uFF0C\u5165\u5E93\u4E32\u884C\u6392\u961F\uFF1B\u8FDE\u7EED\u52FE\u9009\u4F1A\u6279\u91CF\u4FDD\u5B58</span>'
           + '</div>'
        : '';

      box.innerHTML = batchBar + '<div class="cap-lib-dom-table">' + items.map(function (it) {
        var synced = it.lastSyncedAt ? formatDateTime(it.lastSyncedAt) : '\u4ECE\u672A';
        var remote = it.remoteTotal ? it.remoteTotal.toLocaleString() : '?';
        var local = it.localTotal ? it.localTotal.toLocaleString() : '0';
        var stats = it.lastSyncStats;
        var statsHtml = stats
          ? '<span class="cap-lib-dom-stats">+' + stats.added + ' \u6539' + stats.changed + ' \u7559' + stats.unchanged + (stats.removedSoft ? ' \u8FDC\u7AEF\u5C11' + stats.removedSoft : '') + '</span>'
          : '';
        var checked = it.subscribed ? 'checked' : '';
        var subAttr = isAdmin ? '' : 'disabled';
        var syncBtnHtml = isAdmin
          ? '<button class="btn btn-sm btn-ghost" onclick="capLibSyncOne(\'' + escAttr(it.domain) + '\', this)">' + (it.lastSyncedAt ? '\u5237\u65B0' : '\u62C9\u53D6') + '</button>'
          : '';
        return ''
          + '<div class="cap-lib-dom-row" data-domain="' + escAttr(it.domain) + '">'
          + '<label class="cap-lib-dom-check">'
          + '<input type="checkbox" ' + checked + ' ' + subAttr
          + ' onchange="capLibToggleSub(\'' + escAttr(it.domain) + '\', this.checked)">'
          + '<span class="cap-lib-dom-name" title="' + escAttr(it.domain) + '">' + escHtml(it.domain) + '</span>'
          + '</label>'
          + '<div class="cap-lib-dom-counts">'
          + '<span class="cap-lib-dom-total" title="\u672C\u5730 / \u8FDC\u7AEF">' + local + ' / ' + remote + '</span>'
          + statsHtml
          + '</div>'
          + '<div class="cap-lib-dom-synced">' + escHtml(synced) + '</div>'
          + '<div class="cap-lib-dom-actions">' + syncBtnHtml
          + '<div class="cap-lib-dom-progress" id="capLibDomProg-' + escAttr(it.domain) + '"></div>'
          + '</div>'
          + '</div>';
      }).join('') + '</div>';

      var card = document.getElementById('capLibDomCard');
      var arrow = document.getElementById('capLibDomFoldArrow');
      if (card) {
        var collapsed = localStorage.getItem('capLib.domCollapsed') !== '0';
        card.classList.toggle('collapsed', collapsed);
        if (arrow) arrow.textContent = collapsed ? '\u25B8' : '\u25BE';
      }
    } catch (e) {
      box.innerHTML = '<div style="color:var(--danger)">' + escHtml('\u52A0\u8F7D\u5931\u8D25\uFF1A' + (e.message || String(e))) + '</div>';
    }
  }

  window.capLibToggleDomCard = function () {
    var card = document.getElementById('capLibDomCard');
    var arrow = document.getElementById('capLibDomFoldArrow');
    if (!card) return;
    var collapsed = card.classList.toggle('collapsed');
    if (arrow) arrow.textContent = collapsed ? '\u25B8' : '\u25BE';
    try { localStorage.setItem('capLib.domCollapsed', collapsed ? '1' : '0'); } catch (e) { /* ignore */ }
  };

  window.capLibSyncChecked = async function (triggerBtn) {
    if (!isAdminUser()) return;
    var checked = Array.from(document.querySelectorAll('.cap-lib-dom-row input[type=checkbox]:checked'))
      .map(function (cb) { return cb.closest('.cap-lib-dom-row'); })
      .map(function (row) { return row && row.getAttribute('data-domain'); })
      .filter(Boolean);
    if (!checked.length) { showToast('\u672A\u52FE\u9009\u4EFB\u4F55\u9886\u57DF', 'fail'); return; }
    if (triggerBtn) { triggerBtn.disabled = true; triggerBtn.textContent = '\u542F\u52A8\u4E2D\u2026'; }
    try {
      await flushPendingDomainSubs();
      var res = await fetch('/api/cma-diff/sync-selected', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domains: checked }),
      });
      if (!res.ok) {
        var txt = await res.text();
        showToast('\u542F\u52A8\u540C\u6B65\u5931\u8D25\uFF1A' + (txt || res.status), 'fail');
        return;
      }
      var body = await readApiResponse(res);
      startBatchProgress((body && body.jobs) || [], '\u52FE\u9009\u9886\u57DF\u5DF2\u5168\u90E8\u540C\u6B65\u5B8C\u6210');
    } catch (e) {
      showToast('\u542F\u52A8\u540C\u6B65\u5931\u8D25\uFF1A' + (e.message || e), 'fail');
    } finally {
      if (triggerBtn) { setTimeout(function () { triggerBtn.disabled = false; triggerBtn.textContent = '\u66F4\u65B0\u52FE\u9009'; }, 600); }
    }
  };

  window.capLibToggleSub = function (domain, subscribed) {
    if (!isAdminUser()) return;
    pendingDomainSubs.set(domain, !!subscribed);
    scheduleDomainSubFlush();
  };

  window.capLibSyncOne = async function (domain, btn) {
    if (btn) { btn.disabled = true; btn.textContent = '\u540C\u6B65\u4E2D\u2026'; }
    try {
      await flushPendingDomainSubs();
      var res = await fetch('/api/cma-diff/sync/' + encodeURIComponent(domain), { method: 'POST' });
      if (!res.ok) {
        var txt = await res.text();
        showToast('\u542F\u52A8\u540C\u6B65\u5931\u8D25\uFF1A' + (txt || res.status), 'fail');
        if (btn) { btn.disabled = false; btn.textContent = '\u5237\u65B0'; }
        return;
      }
      var body = await readApiResponse(res);
      var taskId = createTaskCenterTask({ type: 'sync', label: '能力库同步 · ' + domain, progress: '已启动，等待进度…' });
      pollSyncProgress(body.jobId, domain, btn, { taskId: taskId });
    } catch (e) {
      showToast('\u542F\u52A8\u540C\u6B65\u5931\u8D25\uFF1A' + (e.message || e), 'fail');
      if (btn) { btn.disabled = false; btn.textContent = '\u5237\u65B0'; }
    }
  };

  window.capLibSyncAll = async function (triggerBtn) {
    var btn = triggerBtn || document.getElementById('capLibSyncAllBtn');
    var originalText = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '\u540C\u6B65\u4E2D\u2026'; }
    try {
      await flushPendingDomainSubs();
      var res = await fetch('/api/cma-diff/sync-all', { method: 'POST' });
      if (!res.ok) {
        var txt = await res.text();
        showToast('\u542F\u52A8\u540C\u6B65\u5931\u8D25\uFF1A' + (txt || res.status), 'fail');
        return;
      }
      var body = await readApiResponse(res);
      var jobs = (body && body.jobs) || [];
      if (!jobs.length) {
        showToast('\u6CA1\u6709\u52FE\u9009\u9886\u57DF\u53EF\u540C\u6B65', 'fail');
        return;
      }
      startBatchProgress(jobs, '\u5DF2\u8BA2\u9605\u9886\u57DF\u5DF2\u5168\u90E8\u540C\u6B65\u5B8C\u6210');
    } catch (e) {
      showToast('\u542F\u52A8\u540C\u6B65\u5931\u8D25\uFF1A' + (e.message || e), 'fail');
    } finally {
      if (btn) { setTimeout(function () { btn.disabled = false; btn.textContent = originalText || '\u540C\u6B65\u52FE\u9009\u9886\u57DF'; }, 600); }
    }
  };

  function scheduleDomainSubFlush() {
    if (domainSubFlushTimer) clearTimeout(domainSubFlushTimer);
    domainSubFlushTimer = setTimeout(function () {
      domainSubFlushTimer = null;
      flushPendingDomainSubs().catch(function () { /* toast already shown */ });
    }, 350);
  }

  async function flushPendingDomainSubs() {
    if (domainSubFlushTimer) {
      clearTimeout(domainSubFlushTimer);
      domainSubFlushTimer = null;
    }
    await domainSubFlushPromise.catch(function () { /* next flush may still succeed */ });
    if (!pendingDomainSubs.size) return;
    var items = Array.from(pendingDomainSubs.entries()).map(function (e) { return { domain: e[0], subscribed: e[1] }; });
    pendingDomainSubs.clear();
    domainSubFlushPromise = (async function () {
      try {
        var res = await fetch('/api/cma-diff/domains/subscriptions', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items: items }),
        });
        if (!res.ok) {
          var txt = await res.text();
          throw new Error(txt || 'HTTP ' + res.status);
        }
      } catch (e) {
        for (var i = 0; i < items.length; i++) {
          var it = items[i];
          if (!pendingDomainSubs.has(it.domain)) pendingDomainSubs.set(it.domain, it.subscribed);
        }
        showToast('\u4FDD\u5B58\u8BA2\u9605\u5931\u8D25\uFF1A' + (e.message || e), 'fail');
        throw e;
      }
    })();
    return domainSubFlushPromise;
  }

  function startBatchProgress(jobs, doneMessage) {
    if (!jobs.length) { showToast('\u6CA1\u6709\u52FE\u9009\u9886\u57DF\u53EF\u540C\u6B65', 'fail'); return; }
    var remaining = jobs.length;
    var onSettled = function () {
      remaining -= 1;
      if (remaining <= 0) {
        showToast(doneMessage || '\u9886\u57DF\u540C\u6B65\u5DF2\u5B8C\u6210');
        if (window.capLibInvalidateCache) window.capLibInvalidateCache();
        window.loadCapLibPage();
      }
    };
    for (var i = 0; i < jobs.length; i++) {
      var j = jobs[i];
      var rowBtn = document.querySelector(
        '.cap-lib-dom-row[data-domain="' + cssEscape(j.domain) + '"] .cap-lib-dom-actions button');
      if (rowBtn) { rowBtn.disabled = true; rowBtn.textContent = '\u540C\u6B65\u4E2D\u2026'; }
      var taskId = createTaskCenterTask({ type: 'sync', label: '能力库同步 · ' + j.domain, progress: '已启动，等待进度…' });
      pollSyncProgress(j.jobId, j.domain, rowBtn, { onSettled: onSettled, quietDone: true, taskId: taskId });
    }
  }

  function addProgressSettler(jobId, onSettled) {
    if (!onSettled) return;
    var list = progressSettlers.get(jobId) || [];
    list.push(onSettled);
    progressSettlers.set(jobId, list);
  }

  function pollSyncProgress(jobId, domain, btn, opts) {
    var onSettled = opts && opts.onSettled;
    if (progressTimers.has(jobId)) {
      addProgressSettler(jobId, onSettled);
      return;
    }
    addProgressSettler(jobId, onSettled);
    var quietDone = opts && opts.quietDone;
    var taskId = opts && opts.taskId;
    var progEl = document.getElementById('capLibDomProg-' + domain);
    var settled = false;
    var tick = async function () {
      try {
        var res = await fetch('/api/cma-diff/sync/progress/' + encodeURIComponent(jobId));
        if (!res.ok) {
          if (taskId) completeTaskCenterTask(taskId, 'fail', { error: '无法读取同步进度', progress: '无法读取同步进度' });
          settle();
          return;
        }
        var p = await readApiResponse(res);
        var pct = p.total ? Math.min(100, Math.round((p.current || 0) / p.total * 100)) : 0;
        if (taskId) updateTaskCenterTask(taskId, { progress: progressText(p, pct) });
        if (progEl) {
          progEl.innerHTML = '<div class="cap-lib-prog-bar"><div style="width:' + pct + '%"></div></div>'
            + '<span class="cap-lib-prog-text">' + escHtml(progressText(p, pct)) + '</span>';
        }
        if (p.phase === 'done') {
          if (!quietDone) showToast('\u300C' + domain + '\u300D\u540C\u6B65\u5B8C\u6210 \u00B7 \u65B0\u589E ' + (p.stats && p.stats.added || 0) + ' / \u53D8\u66F4 ' + (p.stats && p.stats.changed || 0));
          if (taskId) completeTaskCenterTask(taskId, 'success', { progress: '完成 · 新增 ' + (p.stats && p.stats.added || 0) + ' / 变更 ' + (p.stats && p.stats.changed || 0) });
          var didSettle = settle();
          if (didSettle && !onSettled) {
            if (window.capLibInvalidateCache) window.capLibInvalidateCache();
            window.loadCapLibPage();
          }
        } else if (p.phase === 'error') {
          if (taskId) completeTaskCenterTask(taskId, 'fail', { error: p.error || '未知错误', progress: p.error || '未知错误' });
          showToast('\u300C' + domain + '\u300D\u540C\u6B65\u5931\u8D25\uFF1A' + (p.error || '\u672A\u77E5\u9519\u8BEF'), 'fail');
          settle();
        }
      } catch (e) {
        if (taskId) completeTaskCenterTask(taskId, 'fail', { error: e.message || '连接失败', progress: e.message || '连接失败' });
        settle();
      }
    };
    var stop = function () {
      var h = progressTimers.get(jobId); if (h) clearInterval(h);
      progressTimers.delete(jobId);
      if (btn) { btn.disabled = false; btn.textContent = '\u5237\u65B0'; }
    };
    var settle = function () {
      if (settled) return false;
      settled = true;
      stop();
      var list = progressSettlers.get(jobId) || [];
      progressSettlers.delete(jobId);
      for (var i = 0; i < list.length; i++) {
        try { list[i](); } catch (e) { /* ignore */ }
      }
      return true;
    };
    tick();
    progressTimers.set(jobId, setInterval(tick, 1500));
  }

  function phaseLabel(phase) {
    switch (phase) {
      case 'pending': return '\u6392\u961F';
      case 'fetching': return '\u5E76\u53D1\u62C9\u53D6\u4E2D';
      case 'queued': return '\u7B49\u5F85\u5165\u5E93';
      case 'upserting': return '\u5165\u5E93\u4E2D';
      case 'done': return '\u5B8C\u6210';
      case 'error': return '\u5931\u8D25';
      default: return phase || '';
    }
  }

  function progressText(p, pct) {
    var label = phaseLabel(p.phase);
    if (p.phase === 'fetching') {
      if (p.total > 0) return '\u5E76\u53D1\u62C9\u53D6 ' + (p.current || 0).toLocaleString() + '/' + p.total.toLocaleString() + ' (' + pct + '%)';
      return '\u62C9\u53D6\u9996\u9875\u2026\uFF08\u5927\u9886\u57DF\u7EA6\u9700\u534A\u5206\u949F\uFF09';
    }
    if (p.phase === 'queued' && p.total > 0) {
      return '\u7B49\u5F85\u5165\u5E93 ' + p.total.toLocaleString() + ' \u884C';
    }
    if (p.phase === 'upserting' && p.total > 0) {
      return '\u5165\u5E93\u4E2D ' + (p.current || 0).toLocaleString() + '/' + p.total.toLocaleString() + ' (' + pct + '%)';
    }
    return label + (p.total ? ' ' + pct + '%' : '');
  }

})();

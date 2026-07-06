/**
 * CMA 一单一库比对页（tab="cma-diff"）。
 *
 * 整体逻辑：
 *  1) switchTab('cma-diff') 触发 loadCapLibPage()，并发拉 domains / summary / labs
 *  2) 用户勾领域 → 批量 PUT /api/cma-diff/domains/subscriptions（仅 admin，短防抖）
 *  3) 点同步 → POST /api/cma-diff/sync-selected 或 /sync/:name 拿 jobId → 1.5s 轮询 progress
 *  4) 同步完成 → window.capLibInvalidateCache() + 重渲整页
 *
 * 与其它 tab 的解耦：本文件只动 #page-cma-diff 内的 DOM，不干扰任何全局状态。
 * window._tabCleanup.capLibDiff 用于离开 tab 时停止进度轮询。
 */

(function () {
  if (typeof window === 'undefined') return;

  const DIFF_STATUS_META = {
    in_lib:      { label: '在库',         color: 'var(--ok)',         emoji: '✅' },
    cite_only:   { label: '废止·可引用',   color: 'var(--warning)',    emoji: '⚠'  },
    abolished:   { label: '已废止',       color: '#d97706',           emoji: '🟠' },
    series_only: { label: '年版过期',     color: 'var(--danger)',     emoji: '🔴' },
    not_in_lib:  { label: '未入库',       color: '#7f1d1d',           emoji: '⛔' },
  };
  const STATUS_ORDER = ['in_lib', 'cite_only', 'abolished', 'series_only', 'not_in_lib'];
  /**
   * 单一 worst→best 严重度顺序（修正 #2）。分组渲染、默认展开「最严重档」、
   * diffByLab 行排序、导出排序统一引这一个常量，避免散落多份失同步。
   */
  const GROUP_ORDER = ['not_in_lib', 'series_only', 'abolished', 'cite_only', 'in_lib'];
  /** 机构内每个状态档分页大小（可选项 + 默认 + localStorage 记忆） */
  const PAGE_SIZE_OPTIONS = [50, 100, 200, 300, 500, 1000];
  const PAGE_SIZE_DEFAULT = 100;
  function getPageSize() {
    const v = parseInt(localStorage.getItem('capLib.pageSize'), 10);
    return PAGE_SIZE_OPTIONS.includes(v) ? v : PAGE_SIZE_DEFAULT;
  }
  function setPageSize(v) {
    if (PAGE_SIZE_OPTIONS.includes(v)) { try { localStorage.setItem('capLib.pageSize', String(v)); } catch { /* ignore */ } }
  }

  /** 进度轮询定时器 jobId → setInterval handle */
  const progressTimers = new Map();
  /** 同一个 jobId 可能被多个批量按钮关注，完成回调集中挂这里 */
  const progressSettlers = new Map();
  const pendingDomainSubs = new Map();
  let domainSubFlushTimer = null;
  let domainSubFlushPromise = Promise.resolve();

  window._tabCleanup = window._tabCleanup || {};
  window._tabCleanup.capLibDiff = function () {
    for (const t of progressTimers.values()) clearInterval(t);
    progressTimers.clear();
    progressSettlers.clear();
    if (pendingDomainSubs.size || domainSubFlushTimer) {
      flushPendingDomainSubs().catch(function () { /* toast already shown */ });
    }
  };

  // ── 入口 ──────────────────────────────────────────────────────────

  // 注：currentUser 在 app-auth-admin.js 用 `let` 顶层声明，不挂 window；
  // 但脚本顶层 let 在浏览器里是"脚本作用域"全局变量，跨 <script> 文件可直读，
  // 只是 `window.currentUser` 拿不到。统一靠局部 helper 兜底未登录状态。
  function getCurrentUser() {
    try { return typeof currentUser !== 'undefined' ? currentUser : null; }
    catch (e) { return null; }
  }
  function isAdminUser() {
    const u = getCurrentUser();
    return !!(u && u.role === 'admin');
  }

  window.loadCapLibPage = async function loadCapLibPage() {
    const adminBtn = document.getElementById('capLibCleanupBtn');
    if (adminBtn) adminBtn.style.display = isAdminUser() ? '' : 'none';
    const syncBtn = document.getElementById('capLibSyncAllBtn');
    if (syncBtn) syncBtn.disabled = !isAdminUser();
    if (syncBtn) syncBtn.title = syncBtn.disabled ? '仅管理员可触发同步' : '同步勾选的领域';

    await Promise.all([renderDomains(), renderLabs()]);
  };

  // 在 app-core.switchTab 末尾 case 列表里没本 tab 的特殊 hook，所以这里订阅 tabchange 事件
  window.addEventListener('tabchange', function (e) {
    const tab = e && e.detail && e.detail.tab;
    if (tab === 'cma-diff') {
      try { loadCapLibPage(); } catch { /* ignore */ }
    }
  });

  // ── 领域订阅 + 同步 ───────────────────────────────────────────────

  async function renderDomains() {
    const box = document.getElementById('capLibDomainsBody');
    if (!box) return;
    try {
      const res = await fetch('/api/cma-diff/domains');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await readApiResponse(res);
      const items = (data && data.items) || [];
      if (!items.length) { box.innerHTML = '<div style="color:var(--text-3)">无领域数据</div>'; return; }
      const isAdmin = isAdminUser();

      // 收起态标题栏摘要：已订阅 N 个领域 · 最近同步 时间（取所有领域里最新一次）
      const subscribedCount = items.filter(it => it.subscribed).length;
      let latestSynced = '';
      for (const it of items) {
        if (it.lastSyncedAt && (!latestSynced || it.lastSyncedAt > latestSynced)) latestSynced = it.lastSyncedAt;
      }
      const summaryEl = document.getElementById('capLibDomSummary');
      if (summaryEl) {
        summaryEl.textContent = `已订阅 ${subscribedCount} 个领域 · 最近同步 ${latestSynced ? formatDateTime(latestSynced) : '从未'}`;
      }

      // 批量同步条（仅 admin）：远端限流并发拉取，SQLite 入库仍串行排队
      const batchBar = isAdmin
        ? `<div class="cap-lib-dom-batchbar">
             <button class="btn btn-sm btn-ghost" onclick="capLibSyncChecked(this)">更新勾选</button>
             <button class="btn btn-sm btn-ghost" onclick="capLibSyncAll(this)">全部更新</button>
             <span class="cap-lib-dom-batchhint">远端限流并发拉取，入库串行排队；连续勾选会批量保存</span>
           </div>`
        : '';

      box.innerHTML = batchBar + '<div class="cap-lib-dom-table">' + items.map(it => {
        const synced = it.lastSyncedAt ? formatDateTime(it.lastSyncedAt) : '从未';
        const remote = it.remoteTotal ? it.remoteTotal.toLocaleString() : '?';
        const local = it.localTotal ? it.localTotal.toLocaleString() : '0';
        const stats = it.lastSyncStats;
        const statsHtml = stats
          ? `<span class="cap-lib-dom-stats">+${stats.added} 改${stats.changed} 留${stats.unchanged}${stats.removedSoft ? ' 远端少' + stats.removedSoft : ''}</span>`
          : '';
        const checked = it.subscribed ? 'checked' : '';
        const subAttr = isAdmin ? '' : 'disabled';
        const syncBtn = isAdmin
          ? `<button class="btn btn-sm btn-ghost" onclick="capLibSyncOne('${escAttr(it.domain)}', this)">${it.lastSyncedAt ? '刷新' : '拉取'}</button>`
          : '';
        return `
          <div class="cap-lib-dom-row" data-domain="${escAttr(it.domain)}">
            <label class="cap-lib-dom-check">
              <input type="checkbox" ${checked} ${subAttr}
                onchange="capLibToggleSub('${escAttr(it.domain)}', this.checked)">
              <span class="cap-lib-dom-name" title="${escAttr(it.domain)}">${escHtml(it.domain)}</span>
            </label>
            <div class="cap-lib-dom-counts">
              <span class="cap-lib-dom-total" title="本地 / 远端">${local} / ${remote}</span>
              ${statsHtml}
            </div>
            <div class="cap-lib-dom-synced">${escHtml(synced)}</div>
            <div class="cap-lib-dom-actions">${syncBtn}
              <div class="cap-lib-dom-progress" id="capLibDomProg-${escAttr(it.domain)}"></div>
            </div>
          </div>`;
      }).join('') + '</div>';

      // 恢复整卡折叠态（默认收起）
      const card = document.getElementById('capLibDomCard');
      const arrow = document.getElementById('capLibDomFoldArrow');
      if (card) {
        const collapsed = localStorage.getItem('capLib.domCollapsed') !== '0'; // 默认收起
        card.classList.toggle('collapsed', collapsed);
        if (arrow) arrow.textContent = collapsed ? '▸' : '▾';
      }
    } catch (e) {
      box.innerHTML = `<div style="color:var(--danger)">加载失败：${escHtml(e.message || String(e))}</div>`;
    }
  }

  // 整卡折叠：toggle .collapsed + arrow + 写 localStorage（'0'=展开 / 其它=收起）
  window.capLibToggleDomCard = function () {
    const card = document.getElementById('capLibDomCard');
    const arrow = document.getElementById('capLibDomFoldArrow');
    if (!card) return;
    const collapsed = card.classList.toggle('collapsed');
    if (arrow) arrow.textContent = collapsed ? '▸' : '▾';
    try { localStorage.setItem('capLib.domCollapsed', collapsed ? '1' : '0'); } catch { /* ignore */ }
  };

  /**
   * 更新勾选：一次请求启动所有勾选领域。后端会限流并发拉远端页，DB 写入串行排队。
   */
  window.capLibSyncChecked = async function (triggerBtn) {
    if (!isAdminUser()) return;
    const checked = [...document.querySelectorAll('.cap-lib-dom-row input[type=checkbox]:checked')]
      .map(cb => cb.closest('.cap-lib-dom-row'))
      .map(row => row && row.getAttribute('data-domain'))
      .filter(Boolean);
    if (!checked.length) { showToast('未勾选任何领域', 'fail'); return; }
    if (triggerBtn) { triggerBtn.disabled = true; triggerBtn.textContent = '启动中…'; }
    try {
      await flushPendingDomainSubs();
      const res = await fetch('/api/cma-diff/sync-selected', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domains: checked }),
      });
      if (!res.ok) {
        const txt = await res.text();
        showToast('启动同步失败：' + (txt || res.status), 'fail');
        return;
      }
      const body = await readApiResponse(res);
      startBatchProgress((body && body.jobs) || [], '勾选领域已全部同步完成');
    } catch (e) {
      showToast('启动同步失败：' + (e.message || e), 'fail');
    } finally {
      if (triggerBtn) { setTimeout(function () { triggerBtn.disabled = false; triggerBtn.textContent = '更新勾选'; }, 600); }
    }
  };

  window.capLibToggleSub = function (domain, subscribed) {
    if (!isAdminUser()) return;
    pendingDomainSubs.set(domain, !!subscribed);
    scheduleDomainSubFlush();
  };

  window.capLibSyncOne = async function (domain, btn) {
    if (btn) { btn.disabled = true; btn.textContent = '同步中…'; }
    try {
      await flushPendingDomainSubs();
      const res = await fetch('/api/cma-diff/sync/' + encodeURIComponent(domain), { method: 'POST' });
      if (!res.ok) {
        const txt = await res.text();
        showToast('启动同步失败：' + (txt || res.status), 'fail');
        if (btn) { btn.disabled = false; btn.textContent = '刷新'; }
        return;
      }
      const body = await readApiResponse(res);
      pollSyncProgress(body.jobId, domain, btn);
    } catch (e) {
      showToast('启动同步失败：' + (e.message || e), 'fail');
      if (btn) { btn.disabled = false; btn.textContent = '刷新'; }
    }
  };

  window.capLibSyncAll = async function (triggerBtn) {
    const btn = triggerBtn || document.getElementById('capLibSyncAllBtn');
    const originalText = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '同步中…'; }
    try {
      await flushPendingDomainSubs();
      const res = await fetch('/api/cma-diff/sync-all', { method: 'POST' });
      if (!res.ok) {
        const txt = await res.text();
        showToast('启动同步失败：' + (txt || res.status), 'fail');
        return;
      }
      const body = await readApiResponse(res);
      const jobs = (body && body.jobs) || [];
      if (!jobs.length) {
        showToast('没有勾选领域可同步', 'fail');
        return;
      }
      startBatchProgress(jobs, '已订阅领域已全部同步完成');
    } catch (e) {
      showToast('启动同步失败：' + (e.message || e), 'fail');
    } finally {
      if (btn) { setTimeout(function () { btn.disabled = false; btn.textContent = originalText || '同步勾选领域'; }, 600); }
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
    const items = [...pendingDomainSubs.entries()].map(([domain, subscribed]) => ({ domain, subscribed }));
    pendingDomainSubs.clear();
    domainSubFlushPromise = (async function () {
      try {
        const res = await fetch('/api/cma-diff/domains/subscriptions', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items }),
        });
        if (!res.ok) {
          const txt = await res.text();
          throw new Error(txt || 'HTTP ' + res.status);
        }
      } catch (e) {
        for (const it of items) {
          if (!pendingDomainSubs.has(it.domain)) pendingDomainSubs.set(it.domain, it.subscribed);
        }
        showToast('保存订阅失败：' + (e.message || e), 'fail');
        throw e;
      }
    })();
    return domainSubFlushPromise;
  }

  function startBatchProgress(jobs, doneMessage) {
    if (!jobs.length) { showToast('没有勾选领域可同步', 'fail'); return; }
    let remaining = jobs.length;
    const onSettled = function () {
      remaining -= 1;
      if (remaining <= 0) {
        showToast(doneMessage || '领域同步已完成');
        if (window.capLibInvalidateCache) window.capLibInvalidateCache();
        window.loadCapLibPage();
      }
    };
    for (const j of jobs) {
      const rowBtn = document.querySelector(
        `.cap-lib-dom-row[data-domain="${cssEscape(j.domain)}"] .cap-lib-dom-actions button`);
      if (rowBtn) { rowBtn.disabled = true; rowBtn.textContent = '同步中…'; }
      pollSyncProgress(j.jobId, j.domain, rowBtn, { onSettled, quietDone: true });
    }
  }

  function addProgressSettler(jobId, onSettled) {
    if (!onSettled) return;
    const list = progressSettlers.get(jobId) || [];
    list.push(onSettled);
    progressSettlers.set(jobId, list);
  }

  function pollSyncProgress(jobId, domain, btn, opts) {
    const onSettled = opts && opts.onSettled;
    if (progressTimers.has(jobId)) {
      addProgressSettler(jobId, onSettled);
      return;
    }
    addProgressSettler(jobId, onSettled);
    const quietDone = opts && opts.quietDone;
    const progEl = document.getElementById('capLibDomProg-' + domain);
    let settled = false;
    const tick = async function () {
      try {
        const res = await fetch('/api/cma-diff/sync/progress/' + encodeURIComponent(jobId));
        if (!res.ok) { settle(); return; }
        const p = await readApiResponse(res);
        const pct = p.total ? Math.min(100, Math.round((p.current || 0) / p.total * 100)) : 0;
        if (progEl) {
          progEl.innerHTML = '<div class="cap-lib-prog-bar"><div style="width:' + pct + '%"></div></div>'
            + '<span class="cap-lib-prog-text">' + escHtml(progressText(p, pct)) + '</span>';
        }
        if (p.phase === 'done') {
          if (!quietDone) showToast('「' + domain + '」同步完成 · 新增 ' + (p.stats?.added || 0) + ' / 变更 ' + (p.stats?.changed || 0));
          const didSettle = settle();
          if (didSettle && !onSettled) {
            if (window.capLibInvalidateCache) window.capLibInvalidateCache();
            window.loadCapLibPage();
          }
        } else if (p.phase === 'error') {
          showToast('「' + domain + '」同步失败：' + (p.error || '未知错误'), 'fail');
          settle();
        }
      } catch (e) { settle(); }
    };
    const stop = function () {
      const h = progressTimers.get(jobId); if (h) clearInterval(h);
      progressTimers.delete(jobId);
      if (btn) { btn.disabled = false; btn.textContent = '刷新'; }
    };
    const settle = function () {
      if (settled) return false;
      settled = true;
      stop();
      const list = progressSettlers.get(jobId) || [];
      progressSettlers.delete(jobId);
      for (const fn of list) {
        try { fn(); } catch (e) { /* ignore */ }
      }
      return true;
    };
    tick();
    progressTimers.set(jobId, setInterval(tick, 1500));
  }

  function phaseLabel(phase) {
    switch (phase) {
      case 'pending': return '排队';
      case 'fetching': return '并发拉取中';
      case 'queued': return '等待入库';
      case 'upserting': return '入库中';
      case 'done': return '完成';
      case 'error': return '失败';
      default: return phase || '';
    }
  }

  // 进度文案：拉取/入库阶段尽量显「X/Y 行 + 百分比」；拉取首页未拿到 total 时给明确的等待提示，
  // 不再死显「拉取中 0%」让人误判卡死（产品质量检验 41k 行、旧串行拉取很容易等到心焦）。
  function progressText(p, pct) {
    const label = phaseLabel(p.phase);
    if (p.phase === 'fetching') {
      if (p.total > 0) return '并发拉取 ' + (p.current || 0).toLocaleString() + '/' + p.total.toLocaleString() + ' (' + pct + '%)';
      return '拉取首页…（大领域约需半分钟）';
    }
    if (p.phase === 'queued' && p.total > 0) {
      return '等待入库 ' + p.total.toLocaleString() + ' 行';
    }
    if (p.phase === 'upserting' && p.total > 0) {
      return '入库中 ' + (p.current || 0).toLocaleString() + '/' + p.total.toLocaleString() + ' (' + pct + '%)';
    }
    return label + (p.total ? ' ' + pct + '%' : '');
  }

  // ── 机构列表 ──────────────────────────────────────────────────────

  async function renderLabs() {
    const box = document.getElementById('capLibLabsBody');
    if (!box) return;
    try {
      const res = await fetch('/api/cma-diff/labs');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await readApiResponse(res);
      const items = (data && data.items) || [];
      if (!items.length) {
        box.innerHTML = '<div class="cap-lib-empty">未订阅任何 CMA 机构。请先到「资质查询」页订阅。</div>';
        return;
      }
      // 默认按 not_in_lib + series_only 降序排（最值得关注的在前）
      items.sort((a, b) => {
        const sa = (a.byStatus?.not_in_lib || 0) + (a.byStatus?.series_only || 0);
        const sb = (b.byStatus?.not_in_lib || 0) + (b.byStatus?.series_only || 0);
        if (sa !== sb) return sb - sa;
        return (b.total || 0) - (a.total || 0);
      });
      box.innerHTML = items.map(lab => {
        const dots = STATUS_ORDER.map(k => {
          const n = lab.byStatus?.[k] || 0;
          if (!n) return '';
          const meta = DIFF_STATUS_META[k];
          return `<span class="cap-lib-lab-dot" style="color:${meta.color}">${meta.emoji} ${n}</span>`;
        }).filter(Boolean).join('');
        const gid = 'capLibLab_' + escAttr(lab.certNumber);
        const labNameAttr = escAttr(lab.labName || lab.certNumber);
        return `
          <div class="cap-lib-lab-group">
            <div class="cap-lib-lab-head" onclick="capLibToggleLab('${escAttr(lab.certNumber)}')">
              <span class="cap-lib-lab-arrow" id="${gid}_arrow">▸</span>
              <span class="cap-lib-lab-name">${escHtml(lab.labName)}</span>
              <span class="cap-lib-lab-cert">${escHtml(lab.certNumber)}</span>
              <span class="cap-lib-lab-counts">${dots || '<span style="color:var(--text-3)">无数据</span>'}</span>
              <span class="cap-lib-lab-total">${(lab.total || 0).toLocaleString()} 行</span>
              <button class="btn btn-sm btn-ghost cap-lib-lab-recompare"
                onclick="event.stopPropagation();capLibRecompareLab('${escAttr(lab.certNumber)}')"
                title="清缓存重新与国家库对比">重新对比</button>
              <button class="btn btn-sm btn-ghost cap-lib-lab-export"
                onclick="event.stopPropagation();capLibExportDiff({ certNumbers: ['${escAttr(lab.certNumber)}'] }, this)"
                title="导出「${labNameAttr}」整表">导出此机构</button>
            </div>
            <div class="cap-lib-lab-body" id="${gid}_body" style="display:none"></div>
          </div>`;
      }).join('');
    } catch (e) {
      box.innerHTML = `<div style="color:var(--danger)">加载失败：${escHtml(e.message || String(e))}</div>`;
    }
  }

  window.capLibToggleLab = async function (certNumber) {
    const gid = 'capLibLab_' + certNumber;
    const body = document.getElementById(gid + '_body');
    const arrow = document.getElementById(gid + '_arrow');
    if (!body) return;
    if (body.style.display === '') {
      // 收起：清缓存让 GC 回收（长机构 _capLibGroups 可能上百行）
      body.style.display = 'none';
      if (arrow) arrow.textContent = '▸';
      body._capLibGroups = null;
      body.dataset.loaded = '';
      return;
    }
    body.style.display = '';
    if (arrow) arrow.textContent = '▾';
    if (body.dataset.loaded === '1') return;
    body.innerHTML = '<div style="padding:8px;color:var(--text-3)">加载中…</div>';
    try {
      const res = await fetch('/api/cma-diff/labs/' + encodeURIComponent(certNumber));
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await readApiResponse(res);
      const rows = (data && data.rows) || [];
      if (!rows.length) {
        body.innerHTML = '<div style="padding:8px;color:var(--text-3)">该机构无 CMA 资质行</div>';
        body.dataset.loaded = '1';
        return;
      }
      // 按 5 档分组缓存到 DOM 引用上（避免 JSON 反复 parse）
      const groups = { not_in_lib: [], series_only: [], abolished: [], cite_only: [], in_lib: [] };
      for (const r of rows) (groups[r.diffStatus] || groups.not_in_lib).push(r);
      body._capLibGroups = groups;
      body.dataset.cert = certNumber;
      // 机构内搜索框 + 状态分组容器（搜索只重渲容器，不动搜索框）
      body.innerHTML = `
        <div class="cap-lib-lab-search">
          <input type="text" class="cap-lib-lab-search-input" placeholder="在本机构内搜标准号 / 标准名 / 检测项目…"
            oninput="capLibSearchLab(this)">
        </div>
        <div class="cap-lib-lab-groups" id="${escAttr('capLibLab_' + certNumber)}_groups"></div>`;
      const groupsHost = body.querySelector('.cap-lib-lab-groups');
      renderStatusGroups(groupsHost, groups, certNumber);
      body.dataset.loaded = '1';
    } catch (e) {
      body.innerHTML = `<div style="padding:8px;color:var(--danger)">加载失败：${escHtml(e.message || String(e))}</div>`;
    }
  };

  /**
   * 机构内搜索：按关键词过滤该机构缓存的 5 档行（标准号 / 标准名 / 检测项目），重渲分组容器。
   * 空关键词 → 恢复默认（只展开最严重档）；有关键词 → 命中档全展开、显示过滤后行 + 计数。
   * 防抖 200ms 避免逐字符重渲。
   */
  window.capLibSearchLab = function (input) {
    const labBody = input.closest('.cap-lib-lab-body');
    if (!labBody) return;
    const host = labBody.querySelector('.cap-lib-lab-groups');
    const groups = labBody._capLibGroups;
    const certNumber = labBody.dataset.cert || '';
    if (!host || !groups) return;
    clearTimeout(input._capLibSearchTimer);
    input._capLibSearchTimer = setTimeout(() => {
      const kw = (input.value || '').trim().toLowerCase();
      if (!kw) {
        renderStatusGroups(host, groups, certNumber);   // 恢复默认视图
        return;
      }
      const filtered = { not_in_lib: [], series_only: [], abolished: [], cite_only: [], in_lib: [] };
      let hits = 0;
      for (const status of GROUP_ORDER) {
        for (const r of (groups[status] || [])) {
          const items = (r.testItems && r.testItems.length ? r.testItems : (r.testItem ? [r.testItem] : []));
          const hay = (r.stdCode + ' ' + (r.stdName || '') + ' ' + items.join(' ')).toLowerCase();
          if (hay.indexOf(kw) !== -1) { filtered[status].push(r); hits++; }
        }
      }
      renderStatusGroups(host, filtered, certNumber, {
        expandAll: true,
        emptyText: '没有匹配「' + (input.value || '').trim() + '」的标准行',
      });
      void hits;
    }, 200);
  };

  /**
   * 渲染机构内 5 个状态档折叠卡。默认展开第一个非空的最严重档（GROUP_ORDER 首个 count>0）。
   * 每档内是分页表（renderPagedTable），其余档懒渲染（点开才生成 HTML）。
   * opts.expandAll：搜索结果模式下，所有非空档默认展开并立即渲染（让命中行一眼可见）。
   * opts.emptyText：所有档为空时的提示（搜索无命中时用）。
   */
  function renderStatusGroups(body, groups, certNumber, opts) {
    const expandAll = !!(opts && opts.expandAll);
    // 把当前展示的分组挂到容器上，供翻页/展开懒渲染取（搜索态下取过滤后的集合，非全量）
    body._capLibViewGroups = groups;
    const firstNonEmpty = GROUP_ORDER.find(k => (groups[k] || []).length > 0);
    if (!firstNonEmpty) {
      body.innerHTML = `<div class="cap-lib-lab-search-empty">${escHtml((opts && opts.emptyText) || '无数据')}</div>`;
      return;
    }
    let html = '';
    for (const status of GROUP_ORDER) {
      const list = groups[status] || [];
      if (!list.length) continue;             // 空组不渲染
      const meta = DIFF_STATUS_META[status];
      const expanded = expandAll || status === firstNonEmpty;
      const gid = body.id + '_s_' + status;
      const exportBtn = `<button class="btn btn-sm btn-ghost cap-lib-stgroup-export"
        onclick="event.stopPropagation();capLibExportDiff({ certNumbers: ['${escAttr(certNumber)}'], statuses: ['${status}'] }, this)"
        title="只导该档">导出</button>`;
      html += `
        <div class="cap-lib-stgroup" data-status="${status}">
          <div class="cap-lib-stgroup-head" onclick="capLibToggleStGroup('${gid}')">
            <span class="cap-lib-stgroup-arrow" id="${gid}_arrow">${expanded ? '▾' : '▸'}</span>
            <span style="color:${meta.color}">${meta.emoji} ${escHtml(meta.label)}</span>
            <span class="cap-lib-stgroup-count">${list.length} 条</span>
            ${exportBtn}
          </div>
          <div class="cap-lib-stgroup-body" id="${gid}_body" data-page="1"
               data-rendered="${expanded ? '1' : ''}" style="display:${expanded ? '' : 'none'}">
            ${expanded ? renderPagedTable(list, 1, certNumber) : ''}
          </div>
        </div>`;
    }
    body.innerHTML = html;
  }

  /** 按每页大小切片 + 翻页器 + 黑名单批量条 + 每页数量选择器。pages≤1 只显示总数。 */
  function renderPagedTable(list, page, certNumber) {
    const total = list.length;
    const pageSize = getPageSize();
    const pages = Math.ceil(total / pageSize) || 1;
    const p = Math.min(Math.max(1, page), pages);
    const slice = list.slice((p - 1) * pageSize, p * pageSize);
    const pageSizeSel = `<label class="cap-lib-pagesize">每页
      <select onchange="capLibSetPageSize(this)">
        ${PAGE_SIZE_OPTIONS.map(n => `<option value="${n}" ${n === pageSize ? 'selected' : ''}>${n}</option>`).join('')}
      </select> 条</label>`;
    const blackBar = `<div class="cap-lib-black-bar">
      <button class="cap-lib-row-act" onclick="capLibAddCheckedToBlacklist(this)">勾选项加入黑名单</button>
      <span class="cap-lib-black-hint">黑名单内的标准号不显示也不参与匹配（用于屏蔽表格合并产生的非标准号脏行）</span>
      ${pageSizeSel}
    </div>`;
    const tableHtml = `
      <table class="cap-lib-diff-table cap-lib-diff-table-actions">
        <thead><tr><th class="cap-lib-row-pick"><input type="checkbox" class="cap-lib-row-checkall" onchange="capLibToggleCheckAll(this)" title="全选/取消本页"></th><th>状态</th><th>标准号</th><th>标准名</th><th>类别/项目</th><th>替代/备注</th><th>操作</th></tr></thead>
        <tbody>${slice.map(r => renderDiffRow(r, certNumber)).join('')}</tbody>
      </table>`;
    const pagerHtml = pages > 1
      ? renderPager(p, pages, total)
      : `<div class="cap-lib-pager">共 ${total} 条</div>`;
    return blackBar + tableHtml + pagerHtml;
  }

  /** 翻页器：≤7 页全列，否则压缩成「1 … cur-1 cur cur+1 … last」。 */
  function renderPager(current, pages, total) {
    const btns = compressPages(current, pages);
    return `<div class="cap-lib-pager">
      <button onclick="capLibPageGo(this, ${current - 1})" ${current === 1 ? 'disabled' : ''}>‹</button>
      ${btns.map(pg => pg === '…'
        ? '<span class="cap-lib-pager-gap">…</span>'
        : `<button class="${pg === current ? 'is-active' : ''}" onclick="capLibPageGo(this, ${pg})">${pg}</button>`
      ).join('')}
      <button onclick="capLibPageGo(this, ${current + 1})" ${current === pages ? 'disabled' : ''}>›</button>
      <span class="cap-lib-pager-info">共 ${total} 条</span>
    </div>`;
  }

  /** ≤7 页全列；否则首尾固定 + 当前页 ±1，两侧省略号。 */
  function compressPages(cur, pages) {
    if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1);
    const out = [1];
    if (cur > 3) out.push('…');
    for (let p = Math.max(2, cur - 1); p <= Math.min(pages - 1, cur + 1); p++) out.push(p);
    if (cur < pages - 2) out.push('…');
    out.push(pages);
    return out;
  }

  // 当前展示中的分组：搜索态取过滤后的（挂在 .cap-lib-lab-groups 容器上），否则全量缓存
  function viewGroupsFor(el) {
    const host = el.closest('.cap-lib-lab-groups');
    if (host && host._capLibViewGroups) return host._capLibViewGroups;
    const labBody = el.closest('.cap-lib-lab-body');
    return (labBody && labBody._capLibGroups) || {};
  }

  // 翻页：定位所在 stgroup-body，从当前展示分组取该档 list，重渲表 + 翻页器
  window.capLibPageGo = function (btn, page) {
    const stbody = btn.closest('.cap-lib-stgroup-body');
    const group = btn.closest('.cap-lib-stgroup');
    const labBody = btn.closest('.cap-lib-lab-body');
    if (!stbody || !group || !labBody) return;
    const status = group.getAttribute('data-status');
    const list = viewGroupsFor(btn)[status] || [];
    const certNumber = labBody.dataset.cert || '';
    stbody.dataset.page = String(page);
    stbody.innerHTML = renderPagedTable(list, page, certNumber);
    stbody.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };

  // 改每页数量：记 localStorage，把本机构所有「已渲染」的状态档表从第 1 页重渲（统一生效）
  window.capLibSetPageSize = function (sel) {
    const v = parseInt(sel.value, 10);
    setPageSize(v);
    const labBody = sel.closest('.cap-lib-lab-body');
    if (!labBody) return;
    const certNumber = labBody.dataset.cert || '';
    labBody.querySelectorAll('.cap-lib-stgroup').forEach(group => {
      const stbody = group.querySelector('.cap-lib-stgroup-body');
      if (!stbody || !stbody.dataset.rendered) return;   // 未展开渲染的档不动，下次展开自然用新值
      const status = group.getAttribute('data-status');
      const list = (group.closest('.cap-lib-lab-groups')?._capLibViewGroups || labBody._capLibGroups || {})[status] || [];
      stbody.dataset.page = '1';
      stbody.innerHTML = renderPagedTable(list, 1, certNumber);
    });
  };

  // 状态档折叠：首次展开懒渲染该档分页表
  window.capLibToggleStGroup = function (gid) {
    const stbody = document.getElementById(gid + '_body');
    const arrow = document.getElementById(gid + '_arrow');
    if (!stbody) return;
    if (stbody.style.display === 'none') {
      if (!stbody.dataset.rendered) {
        const group = stbody.closest('.cap-lib-stgroup');
        const labBody = stbody.closest('.cap-lib-lab-body');
        const status = group && group.getAttribute('data-status');
        const list = viewGroupsFor(stbody)[status] || [];
        const certNumber = (labBody && labBody.dataset.cert) || '';
        stbody.innerHTML = renderPagedTable(list, Number(stbody.dataset.page) || 1, certNumber);
        stbody.dataset.rendered = '1';
      }
      stbody.style.display = '';
      if (arrow) arrow.textContent = '▾';
    } else {
      stbody.style.display = 'none';
      if (arrow) arrow.textContent = '▸';
    }
  };

  function renderDiffRow(r, certNumber) {
    const meta = DIFF_STATUS_META[r.diffStatus] || { label: r.diffStatus, color: 'var(--text-3)', emoji: '·' };
    const note = r.diffStatus === 'series_only' && r.seriesNewCode
      ? `建议改用 <b>${escHtml(r.seriesNewCode)}</b>${r.seriesDomain ? ' · ' + escHtml(r.seriesDomain) : ''}`
      : (r.libRemark ? escHtml(r.libRemark) : '');
    // 同号聚合的多个检测项目（去重显示）
    const items = (r.testItems && r.testItems.length ? r.testItems : (r.testItem ? [r.testItem] : []));
    const itemHtml = items.map(escHtml).join('、');
    const codeAttr = escAttr(r.stdCode);
    const certAttr = escAttr(certNumber || '');
    const mappedTag = r.manualMapped ? ' <span class="cap-lib-mapped-tag" title="已手动映射">✎</span>' : '';
    // 行操作：未入库提供「指定」库内标准号 + 「重试」；其它档可重试
    const isNotInLib = r.diffStatus === 'not_in_lib';
    const actions = `<div class="cap-lib-row-actions">`
      + (isNotInLib
          ? `<button class="cap-lib-row-act" onclick="capLibManualMap('${certAttr}','${codeAttr}')" title="手动指定库内标准号">指定</button>`
          : '')
      + `<button class="cap-lib-row-act" onclick="capLibRematchRow(this,'${certAttr}','${codeAttr}')" title="重新匹配此标准号">重试</button>`
      + `<button class="cap-lib-row-act" onclick="capLibDiagnose('${codeAttr}')" title="诊断：归一化值 + 本地库命中 + 各领域同步状态">诊断</button>`
      + `</div>`;
    return `
      <tr class="cap-lib-diff-row" data-status="${r.diffStatus}" data-code="${codeAttr}">
        <td class="cap-lib-row-pick"><input type="checkbox" class="cap-lib-row-check" data-code="${codeAttr}" onchange="capLibSyncCheckAll(this)" title="勾选后可加入黑名单"></td>
        <td><span class="cap-lib-row-status" style="color:${meta.color}">${meta.emoji} ${escHtml(meta.label)}</span></td>
        <td class="cap-lib-row-code">${escHtml(r.stdCode)}${mappedTag}</td>
        <td>${escHtml(r.stdName || '')}</td>
        <td><div class="cap-lib-row-cat">${escHtml(r.category || '')}</div><div class="cap-lib-row-item">${itemHtml}</div></td>
        <td>${note}</td>
        <td class="cap-lib-row-actcell">${actions}</td>
      </tr>`;
  }

  /**
   * 三级导出（Part 2b）：状态档头 / 机构头 / 顶部三处共用。
   * filter = { certNumbers: string[], statuses?: DiffStatus[] }，certNumbers 空 = 全部订阅机构。
   * 流式下载：fetch blob → Content-Disposition 取文件名 → a.click。
   */
  window.capLibExportDiff = async function (filter, btn) {
    if (btn) btn.disabled = true;
    try {
      const res = await fetch('/api/cma-diff/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(filter || { certNumbers: [] }),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        showToast('导出失败：' + (txt || res.status), 'fail');
        return;
      }
      const blob = await res.blob();
      const cd = res.headers.get('Content-Disposition') || '';
      const m = cd.match(/filename\*=UTF-8''([^;]+)/);
      const fn = m ? decodeURIComponent(m[1]) : 'CMA一单一库比对.xlsx';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = fn; document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 100);
      showToast('已导出：' + fn);
    } catch (e) {
      showToast('导出失败：' + (e.message || e), 'fail');
    } finally {
      if (btn) btn.disabled = false;
    }
  };

  // ── 黑名单 / 手动映射 / 重试（Part 3 + 4） ────────────────────────

  /** 收集当前状态档表内勾选行的标准号，批量加入黑名单（admin）。 */
  /** 表头全选框：勾中/取消本页表格内全部行（筛选/分档后的当前页可见行）。 */
  window.capLibToggleCheckAll = function (master) {
    const table = master.closest('table');
    if (!table) return;
    table.querySelectorAll('tbody .cap-lib-row-check').forEach(cb => { cb.checked = master.checked; });
  };

  /** 行勾选变动时回写表头全选框状态（全勾=选中 / 部分=半选 / 全不勾=不选）。 */
  window.capLibSyncCheckAll = function (row) {
    const table = row.closest('table');
    const master = table && table.querySelector('.cap-lib-row-checkall');
    if (!master) return;
    const all = [...table.querySelectorAll('tbody .cap-lib-row-check')];
    const checked = all.filter(cb => cb.checked).length;
    master.checked = checked > 0 && checked === all.length;
    master.indeterminate = checked > 0 && checked < all.length;
  };

  window.capLibAddCheckedToBlacklist = async function (btn) {
    if (!isAdminUser()) { showToast('仅管理员可操作', 'fail'); return; }
    const scope = btn.closest('.cap-lib-stgroup-body') || document;
    const codes = [...scope.querySelectorAll('.cap-lib-row-check:checked')]
      .map(cb => cb.getAttribute('data-code')).filter(Boolean);
    if (!codes.length) { showToast('未勾选任何行', 'fail'); return; }
    if (!confirm('确认把勾选的 ' + codes.length + ' 个标准号加入黑名单？加入后不再显示、不参与匹配。')) return;
    btn.disabled = true;
    try {
      const res = await fetch('/api/cma-diff/blacklist', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: codes.map(c => ({ stdCode: c })) }),
      });
      if (!res.ok) { const t = await res.text(); showToast('加入失败：' + (t || res.status), 'fail'); return; }
      const body = await readApiResponse(res);
      showToast('已加入黑名单 ' + (body.added || 0) + ' 个');
      reloadLabAfterChange(btn);
    } catch (e) { showToast('加入失败：' + (e.message || e), 'fail'); }
    finally { btn.disabled = false; }
  };

  /** 未入库行手动指定库内标准号（admin）→ 写映射 → 局部重匹配刷新该行。 */
  window.capLibManualMap = async function (certNumber, srcStdCode) {
    if (!isAdminUser()) { showToast('仅管理员可操作', 'fail'); return; }
    const libStdCode = prompt('为「' + srcStdCode + '」指定库内标准号（填国家库里的标准号，如 GB/T 1234-2024）：', '');
    if (libStdCode == null) return;
    const v = libStdCode.trim();
    if (!v) { showToast('未填写标准号', 'fail'); return; }
    try {
      const res = await fetch('/api/cma-diff/manual-map', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ certNumber, srcStdCode, libStdCode: v }),
      });
      if (!res.ok) { const t = await res.text(); showToast('指定失败：' + (t || res.status), 'fail'); return; }
      showToast('已指定，正在重新匹配…');
      await rematchAndReplaceRow(certNumber, srcStdCode);
    } catch (e) { showToast('指定失败：' + (e.message || e), 'fail'); }
  };

  /** 单项重试：重新匹配该标准号并就地替换该行（不整页重渲）。 */
  window.capLibRematchRow = async function (btn, certNumber, stdCode) {
    if (btn) btn.disabled = true;
    try { await rematchAndReplaceRow(certNumber, stdCode); }
    finally { if (btn) btn.disabled = false; }
  };

  // 调 rematch 端点拿最新行 → 如果状态变了就整机构重渲（行可能要换档），否则就地更新该行内容
  async function rematchAndReplaceRow(certNumber, stdCode) {
    try {
      const res = await fetch('/api/cma-diff/rematch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ certNumber, stdCode }),
      });
      if (!res.ok) { const t = await res.text(); showToast('重试失败：' + (t || res.status), 'fail'); return; }
      const body = await readApiResponse(res);
      const row = body && body.row;
      if (!row) { showToast('未找到该标准号'); return; }
      // 状态可能跨档变化（如 not_in_lib → in_lib），最稳是整机构失效重拉
      capLibRecompareLab(certNumber);
      showToast('已重新匹配：' + (DIFF_STATUS_META[row.diffStatus]?.label || row.diffStatus));
    } catch (e) { showToast('重试失败：' + (e.message || e), 'fail'); }
  }

  /** 机构维度手动触发重新对比：失效该机构缓存 + 重新拉取展开。 */
  window.capLibRecompareLab = function (certNumber) {
    const gid = 'capLibLab_' + certNumber;
    const body = document.getElementById(gid + '_body');
    if (!body) return;
    body.dataset.loaded = '';
    body._capLibGroups = null;
    // 若当前已展开则立即重拉；否则下次展开自然重拉
    if (body.style.display !== 'none') {
      // 先收起再展开触发重新加载
      body.style.display = 'none';
      capLibToggleLab(certNumber);
    }
  };

  // 黑名单/映射变更后，把所在机构重新对比（找按钮所在机构 cert）
  function reloadLabAfterChange(el) {
    const labBody = el.closest && el.closest('.cap-lib-lab-body');
    const cert = labBody && labBody.dataset.cert;
    if (cert) capLibRecompareLab(cert);
  }

  /** 打开黑名单管理：拉列表渲染到一个卡里（多选移除）。 */
  window.capLibOpenBlacklist = async function () {
    const card = document.getElementById('capLibBlacklistCard');
    const bodyEl = document.getElementById('capLibBlacklistBody');
    if (!card || !bodyEl) return;
    card.style.display = '';
    bodyEl.innerHTML = '<div style="color:var(--text-3)">加载中…</div>';
    try {
      const res = await fetch('/api/cma-diff/blacklist');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await readApiResponse(res);
      const items = (data && data.items) || [];
      if (!items.length) {
        bodyEl.innerHTML = '<div style="color:var(--text-3)">黑名单为空。在机构对比表里勾选脏行点「勾选项加入黑名单」即可添加。</div>';
        return;
      }
      const isAdmin = isAdminUser();
      const rows = items.map(it => `
        <label class="cap-lib-black-item">
          <input type="checkbox" class="cap-lib-black-pick" data-id="${it.id}" ${isAdmin ? '' : 'disabled'}>
          <span class="cap-lib-row-code">${escHtml(it.stdCode)}</span>
          ${it.reason ? '<span class="cap-lib-black-reason">' + escHtml(it.reason) + '</span>' : ''}
        </label>`).join('');
      const removeBtn = isAdmin
        ? '<button class="cap-lib-row-act" onclick="capLibRemoveBlacklist(this)">移除勾选</button>'
        : '';
      bodyEl.innerHTML = `<div class="cap-lib-black-toolbar">${removeBtn}
        <span class="cap-lib-black-hint">共 ${items.length} 条</span></div>
        <div class="cap-lib-black-list">${rows}</div>`;
    } catch (e) {
      bodyEl.innerHTML = `<div style="color:var(--danger)">加载失败：${escHtml(e.message || String(e))}</div>`;
    }
  };

  window.capLibRemoveBlacklist = async function (btn) {
    if (!isAdminUser()) return;
    const ids = [...document.querySelectorAll('.cap-lib-black-pick:checked')]
      .map(cb => Number(cb.getAttribute('data-id'))).filter(Boolean);
    if (!ids.length) { showToast('未勾选任何条目', 'fail'); return; }
    btn.disabled = true;
    try {
      const res = await fetch('/api/cma-diff/blacklist', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
      if (!res.ok) { const t = await res.text(); showToast('移除失败：' + (t || res.status), 'fail'); return; }
      const body = await readApiResponse(res);
      showToast('已移除 ' + (body.removed || 0) + ' 条');
      capLibOpenBlacklist();   // 刷新列表
      // 黑名单变更影响所有机构匹配 → 失效缓存 + 整页重渲
      if (window.capLibInvalidateCache) window.capLibInvalidateCache();
      window.loadCapLibPage();
    } catch (e) { showToast('移除失败：' + (e.message || e), 'fail'); }
    finally { btn.disabled = false; }
  };

  window.capLibCloseBlacklist = function () {
    const card = document.getElementById('capLibBlacklistCard');
    if (card) card.style.display = 'none';
  };

  // ── 诊断（误判自查） ──────────────────────────────────────────────

  /** 诊断某标准号：调后端本地查询，把归一化值 + 命中 + 各领域同步状态渲染到诊断卡。 */
  window.capLibDiagnose = async function (stdCode) {
    const card = document.getElementById('capLibDiagCard');
    const bodyEl = document.getElementById('capLibDiagBody');
    if (!card || !bodyEl) return;
    card.style.display = '';
    card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    bodyEl.innerHTML = '<div style="color:var(--text-3)">诊断中…</div>';
    try {
      const res = await fetch('/api/cma-diff/diagnose?stdCode=' + encodeURIComponent(stdCode));
      if (!res.ok) { const t = await res.text(); bodyEl.innerHTML = '<div style="color:var(--danger)">诊断失败：' + escHtml(t || res.status) + '</div>'; return; }
      const d = await readApiResponse(res);
      bodyEl.innerHTML = renderDiagnose(d);
    } catch (e) {
      bodyEl.innerHTML = '<div style="color:var(--danger)">诊断失败：' + escHtml(e.message || String(e)) + '</div>';
    }
  };

  // 顶部诊断输入框触发
  window.capLibDiagnoseInput = function () {
    const inp = document.getElementById('capLibDiagInput');
    const v = inp && inp.value.trim();
    if (!v) { showToast('请输入标准号', 'fail'); return; }
    capLibDiagnose(v);
  };

  window.capLibCloseDiag = function () {
    const card = document.getElementById('capLibDiagCard');
    if (card) card.style.display = 'none';
  };

  function renderDiagnose(d) {
    const fmt = (s) => s ? formatDateTime(s) : '从未';
    const exact = (d.exactMatches || []).map(m =>
      `<li><span class="cap-lib-row-code">${escHtml(m.stdCode)}</span> · ${escHtml(m.domain)} · ${escHtml(m.libStatus)}${m.remark ? ' · ' + escHtml(m.remark) : ''} <span style="color:var(--text-3)">(见于 ${escHtml(fmt(m.lastSeenAt))})</span></li>`).join('');
    const series = (d.seriesMatches || []).map(m =>
      `<li><span class="cap-lib-row-code">${escHtml(m.stdCode)}</span> · ${escHtml(m.domain)} · ${escHtml(m.libStatus)}</li>`).join('');
    const domains = (d.domainSyncState || []).map(s => {
      const stale = !s.lastSyncedAt;
      const short = s.localTotal < s.remoteTotal;
      const warn = stale ? '⚠ 从未同步' : (short ? '⚠ 本地少于远端' : '');
      return `<tr><td>${escHtml(s.domain)}</td><td>${escHtml(fmt(s.lastSyncedAt))}</td><td>${(s.localTotal || 0).toLocaleString()} / ${(s.remoteTotal || 0).toLocaleString()}</td><td style="color:var(--warning)">${warn}</td></tr>`;
    }).join('');
    return `
      <div class="cap-lib-diag-row"><b>输入</b>：${escHtml(d.input)}</div>
      <div class="cap-lib-diag-row"><b>归一化</b>：清洗=<code>${escHtml(d.cleaned)}</code> · 保年=<code>${escHtml(d.full)}</code> · 剥年=<code>${escHtml(d.base)}</code></div>
      <div class="cap-lib-diag-row"><b>本地库保年命中</b>：${exact ? '<ul class="cap-lib-diag-list">' + exact + '</ul>' : '<span style="color:var(--text-3)">无</span>'}</div>
      ${series ? '<div class="cap-lib-diag-row"><b>剥年(新年版)命中</b>：<ul class="cap-lib-diag-list">' + series + '</ul></div>' : ''}
      <div class="cap-lib-diag-row"><b>黑名单</b>：${d.blacklisted ? '<span style="color:var(--danger)">是（已排除）</span>' : '否'} · <b>手动映射</b>：${d.manualMap ? escHtml(d.manualMap.libNorm) + (d.manualMap.certNumber ? '（机构 ' + escHtml(d.manualMap.certNumber) + '）' : '（全局）') : '无'}</div>
      <div class="cap-lib-diag-verdict">${escHtml(d.verdict)}</div>
      <details class="cap-lib-diag-domains"><summary>各订阅领域同步状态（点开）</summary>
        <table class="cap-lib-diff-table"><thead><tr><th>领域</th><th>上次同步</th><th>本地/远端</th><th></th></tr></thead>
        <tbody>${domains || '<tr><td colspan="4" style="color:var(--text-3)">无订阅领域</td></tr>'}</tbody></table>
      </details>`;
  }

  // ── Cleanup（admin） ───────────────────────────────────────────────

  window.capLibCleanup = async function () {
    if (!confirm('确认删除 30 天未在远端出现的本地条目？此操作不可恢复。')) return;
    try {
      const res = await fetch('/api/cma-diff/cleanup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ days: 30 }),
      });
      if (!res.ok) {
        const txt = await res.text();
        showToast('清理失败：' + (txt || res.status), 'fail'); return;
      }
      const body = await readApiResponse(res);
      showToast('清理完成：删除 ' + (body.deleted || 0) + ' 条');
      if (window.capLibInvalidateCache) window.capLibInvalidateCache();
      window.loadCapLibPage();
    } catch (e) { showToast('清理失败：' + (e.message || e), 'fail'); }
  };

  // ── utils ─────────────────────────────────────────────────────────

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
  // CSS attribute-selector 转义（批量同步按 data-domain 反查行用）。优先用原生 CSS.escape。
  function cssEscape(s) {
    if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(String(s));
    return String(s).replace(/["\\\]]/g, '\\$&');
  }

  // ── 子 tab 切换 ──────────────────────────────────────────────────

  window.switchCapLibTab = function (tab) {
    document.querySelectorAll('.cap-lib-tab').forEach(t => t.classList.remove('active'));
    document.querySelector(`.cap-lib-tab[onclick*="${tab}"]`)?.classList.add('active');
    document.querySelectorAll('.cap-lib-tab-content').forEach(c => c.style.display = 'none');
    const target = document.getElementById('capLibTab' + tab.charAt(0).toUpperCase() + tab.slice(1));
    if (target) target.style.display = '';
    // 首次切换时加载数据
    if (tab === 'domains' || tab === 'labs') {
      try { loadCapLibPage(); } catch (e) { /* ignore */ }
    }
  };

  // ── 能力项目库搜索 ──────────────────────────────────────────────────

  let _capLibSearchPage = 1;
  const _CAP_LIB_SEARCH_PAGE_SIZE = 50;

  /** 初始化领域下拉选项（从 meta 数据填充） */
  window.capLibInitSearchDomains = function () {
    const sel = document.getElementById('capLibSearchDomain');
    if (!sel || sel.options.length > 1) return; // 已初始化
    const meta = window._capLibDomainsMeta || [];
    for (const d of meta) {
      const opt = document.createElement('option');
      opt.value = d.domain;
      opt.textContent = d.domain;
      sel.appendChild(opt);
    }
  };

  /** 执行搜索 */
  window.capLibDoSearch = function (page) {
    _capLibSearchPage = page || 1;
    const q = (document.getElementById('capLibSearchInput')?.value || '').trim();
    const domain = document.getElementById('capLibSearchDomain')?.value || '';
    const offset = (_capLibSearchPage - 1) * _CAP_LIB_SEARCH_PAGE_SIZE;

    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (domain) params.set('domain', domain);
    params.set('limit', String(_CAP_LIB_SEARCH_PAGE_SIZE));
    params.set('offset', String(offset));

    const resultsEl = document.getElementById('capLibSearchResults');
    const summaryEl = document.getElementById('capLibSearchSummary');
    const pagerEl = document.getElementById('capLibSearchPager');
    if (!resultsEl) return;

    resultsEl.innerHTML = '<div style="color:var(--text-3);font-size:13px">搜索中…</div>';
    if (pagerEl) pagerEl.innerHTML = '';

    fetch(`${API}/api/cma-diff/search?${params}`)
      .then(r => readApiResponse(r))
      .then(data => {
        const items = data.items || [];
        const total = data.total || 0;
        if (summaryEl) summaryEl.textContent = total > 0 ? `共 ${total} 条` : '';

        if (items.length === 0) {
          resultsEl.innerHTML = '<div style="color:var(--text-3);font-size:13px">未找到匹配记录</div>';
          return;
        }

        let html = '<table class="cap-lib-search-table"><thead><tr>'
          + '<th>标准号</th><th>检测方法</th><th>领域</th><th>备注</th>'
          + '</tr></thead><tbody>';
        for (const item of items) {
          html += `<tr>`
            + `<td>${escHtml(item.stdCode)}</td>`
            + `<td>${escHtml(item.method)}</td>`
            + `<td>${escHtml(item.domain)}</td>`
            + `<td style="max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escAttr(item.remark)}">${escHtml(item.remark)}</td>`
            + `</tr>`;
        }
        html += '</tbody></table>';
        resultsEl.innerHTML = html;

        // 分页
        if (pagerEl && total > _CAP_LIB_SEARCH_PAGE_SIZE) {
          const totalPages = Math.ceil(total / _CAP_LIB_SEARCH_PAGE_SIZE);
          let pager = '';
          if (_capLibSearchPage > 1) pager += `<button class="btn btn-sm btn-ghost" onclick="capLibDoSearch(${_capLibSearchPage - 1})">上一页</button>`;
          pager += `<span style="font-size:12px;color:var(--text-3)">${_capLibSearchPage} / ${totalPages}</span>`;
          if (_capLibSearchPage < totalPages) pager += `<button class="btn btn-sm btn-ghost" onclick="capLibDoSearch(${_capLibSearchPage + 1})">下一页</button>`;
          pagerEl.innerHTML = pager;
        }
      })
      .catch(err => {
        resultsEl.innerHTML = `<div style="color:var(--danger);font-size:13px">搜索失败: ${escHtml(err.message)}</div>`;
      });
  };

  // 页面加载时初始化领域下拉
  setTimeout(() => { capLibInitSearchDomains(); }, 500);
})();

// ── Auth (认证已禁用，直接使用管理员身份) ──
let currentUser = { id: 1, username: 'admin', displayName: '管理员', role: 'admin', allowedTabs: null };
let isRegisterMode = false;
let trendChart = null;
let sourceChart = null;

// 页面加载后直接初始化
setTimeout(() => {
  window.bzxzPublicSettings = { downloadPreferLocal: true };
  onAuthReady();
}, 0);

// Global fetch 401 interceptor — 认证已禁用，401 不需要特殊处理
const _origFetch = window.fetch;
window.fetch = function(...args) {
  return _origFetch.apply(this, args);
};

async function apiFetch(url, options = {}) {
  const res = await fetch(url, { ...options, credentials: 'same-origin' });
  return res;
}

// Reset the auth overlay to its default "login" state. Called whenever we
// show the overlay so stale register-mode copy / cleared password input from
// the prior session doesn't bleed through.
function resetAuthFormToLogin() {
  isRegisterMode = false;
  var title = document.getElementById('authTitle');
  if (title) title.textContent = '欢迎回来，请登录';
  var submit = document.getElementById('authSubmitBtn');
  if (submit) {
    submit.textContent = '登录';
    submit.disabled = false;
  }
  var err = document.getElementById('authError');
  if (err) err.textContent = '';
  var pwd = document.getElementById('authPassword');
  if (pwd) pwd.value = '';
}

// 记录上次 status 拉回来的 loginRequired —— 退出登录后用来决定要不要露出
// "继续以访客身份使用"链接（免登录模式下退出要停在登录页，需要一个回访客的入口）。
var lastLoginRequired = true;
function updateGuestContinueVisibility() {
  var el = document.getElementById('authGuestContinue');
  if (!el) return;
  el.style.display = lastLoginRequired ? 'none' : '';
}

async function checkAuthStatus() {
  try {
    const res = await fetch('/api/auth/status', { credentials: 'same-origin' });
    const data = await readApiResponse(res);
    lastLoginRequired = !!data.loginRequired;
    window.bzxzPublicSettings = data.publicSettings || {};
    currentUser = data.user || { id: 1, username: 'admin', displayName: '管理员', role: 'admin', allowedTabs: null };
    onAuthReady();
  } catch (e) {
    currentUser = { id: 1, username: 'admin', displayName: '管理员', role: 'admin', allowedTabs: null };
    onAuthReady();
  }
}

function onAuthReady() {
  var udHeader = document.getElementById('udHeader');
  if (udHeader) udHeader.innerHTML = `${escapeHtml(currentUser.displayName || currentUser.username)} <span>${escapeHtml(currentUser.role)}</span>`;
  var sbName = document.getElementById('sidebarUserName');
  if (sbName) sbName.textContent = currentUser.displayName || currentUser.username;
  var sbRole = document.getElementById('sidebarUserRole');
  if (sbRole) sbRole.textContent = currentUser.role;
  // 手机端「我」页
  var meName = document.getElementById('meUserName');
  if (meName) meName.textContent = currentUser.displayName || currentUser.username;
  var meRole = document.getElementById('meUserRole');
  if (meRole) meRole.textContent = currentUser.role === 'admin' ? '管理员' : '普通用户';
  var meStats = document.getElementById('meRowStats');
  var meSettings = document.getElementById('meRowSettings');
  // 认证已简化，默认所有用户可见设置和统计
  if (meStats) meStats.style.display = '';
  if (meSettings) meSettings.style.display = '';
  // Apply per-user tab permissions
  applyTabPermissions();
  // 显示版本号
  fetchVersion();
  // Show announcements
  try { if (typeof checkAnnouncements === 'function') checkAnnouncements(); } catch(e){}
  try { if (typeof checkReleaseNotesIfUpgraded === 'function') checkReleaseNotesIfUpgraded(); } catch(e){}
  // Default stats date range: last 30 days
  var today = beijingDate();
  var monthAgo = new Date(new Date().getTime() + 8*3600000 - 30 * 86400000).toISOString().slice(0, 10);
  var statsTo = document.getElementById('statsTo');
  var statsFrom = document.getElementById('statsFrom');
  if (statsTo) statsTo.value = today;
  if (statsFrom) statsFrom.value = monthAgo;
  initPanels();
  if (typeof renderTopSourceHealth === 'function') renderTopSourceHealth();
  if (typeof refreshSourceHealth === 'function' && Date.now() - (sourceHealthCheckedAt || 0) > 5 * 60 * 1000) {
    refreshSourceHealth();
  }
  if (typeof pollEnvironmentCheck === 'function') pollEnvironmentCheck();
}

var TAB_LABELS = {search:'标准检索',tools:'工具箱',local:'本地文件库',history:'下载历史',qual:'资质查询','cma-diff':'CMA 一单一库',logs:'运行日志',stats:'使用统计',settings:'系统设置',me:'我'};

function applyTabPermissions() {
  var allowed = currentUser.allowedTabs; // null = all allowed
  document.querySelectorAll('.sidebar-item[data-tab]').forEach(function(item) {
    var tab = item.dataset.tab;
    if (tab === 'users') return; // admin-only handled separately
    if (allowed === null || allowed.indexOf(tab) >= 0) {
      item.style.display = '';
    } else {
      item.style.display = 'none';
    }
  });
  // If current tab is hidden, switch to first allowed
  var activeTab = document.querySelector('.sidebar-item.active');
  if (activeTab && activeTab.style.display === 'none') {
    var first = document.querySelector('.sidebar-item[data-tab]:not([style*="display: none"])');
    if (first) switchTab(first.dataset.tab);
  }
}


// Close user dropdown on outside click
document.addEventListener("click", (e) => {
  const dd = document.getElementById("userDropdown");
  const btn = document.getElementById("sidebarUserToggle");
  if (dd.classList.contains("open") && !dd.contains(e.target) && (!btn || !btn.contains(e.target))) {
    dd.classList.remove("open");
  }
});


// 认证已禁用，无需登录表单事件监听

function doLogout() {
  // 认证已禁用，无需退出登录功能
}

// 用户在登录页点"继续以访客身份使用"时调用 —— 重新拉 status，
// 若后端给了 guest 会话就会自动 onAuthReady + 隐藏 overlay。
async function continueAsGuest() {
  try { await checkAuthStatus(); } catch (e) { /* overlay 已可见 */ }
}

function toggleUserDropdown() {
  document.getElementById('userDropdown').classList.toggle('open');

// ── 版本号获取与显示 ──
let appVersion = '';
async function fetchVersion() {
  if (appVersion) return;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch('/api/health', { signal: ctrl.signal, cache: 'no-store' });
    clearTimeout(timer);
    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      appVersion = data.version || '';
    }
  } catch {}
  const el = document.getElementById('meVersion');
  if (el) el.textContent = appVersion ? `v${appVersion} · 标准盒子` : '标准盒子';
}
}

// ── Login overlay: version + online status ──
function initLoginOverlayMeta() {
  // 先启动健康检查轮询，避免 IPC 调用挂起时整个登录页一直显示“正在检查服务…”
  pollLoginHealth();
  setInterval(pollLoginHealth, 30000);

  // 版本号尽力而为：给 IPC 调用一个 2 秒超时，避免 preload 未就绪时阻塞
  const verEl = document.getElementById('authVersion');
  if (verEl && window.bzxz && typeof window.bzxz.getAppVersion === 'function') {
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000));
    Promise.race([window.bzxz.getAppVersion(), timeout])
      .then((v) => { if (v) verEl.textContent = 'v' + v; })
      .catch(() => { /* 留给 /api/health 返回的 version 兜底 */ });
  }
}

async function pollLoginHealth() {
  const el = document.getElementById('authStatus');
  if (!el) return;
  const overlay = document.getElementById('authOverlay');
  // Skip polling when login overlay is hidden
  if (!overlay || overlay.classList.contains('hidden')) return;
  const textEl = el.querySelector('.auth-status-text');
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch('/api/health', { signal: ctrl.signal, cache: 'no-store' });
    clearTimeout(timer);
    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      const total = Array.isArray(data.sources) ? data.sources.length : 0;
      el.dataset.state = 'online';
      if (textEl) textEl.textContent = total > 0 ? `服务在线 · ${total} 个数据源` : '服务在线';
      const verEl = document.getElementById('authVersion');
      if (verEl && (!verEl.textContent || verEl.textContent === 'v—') && data.version) {
        verEl.textContent = 'v' + data.version;
      }
      return;
    }
    throw new Error('bad status');
  } catch {
    el.dataset.state = 'offline';
    if (textEl) textEl.textContent = '服务离线';
  }
}

document.addEventListener('DOMContentLoaded', initLoginOverlayMeta);

function showChangePwd() {
  document.getElementById('userDropdown').classList.remove('open');
  const oldPwd = prompt('请输入原密码');
  if (!oldPwd) return;
  const newPwd = prompt('请输入新密码（至少6位）');
  if (!newPwd || newPwd.length < 6) { showToast('密码至少6位', 'fail'); return; }
  // /api/auth/password is in the auth-endpoint exclude list, so a 401 from
  // a wrong old password no longer bumps the user back to the login overlay.
  apiFetch('/api/auth/password', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ oldPassword: oldPwd, newPassword: newPwd }),
  }).then(async (r) => {
    const d = await readApiResponse(r);
    if (r.ok && d.ok) showToast('密码已修改', 'success');
    else showToast(d.message || '修改失败', 'fail');
  }).catch(() => showToast('修改失败', 'fail'));
}

// ── Stats ──
async function loadStats() {
  const from = document.getElementById('statsFrom').value;
  const to = document.getElementById('statsTo').value;
  const params = new URLSearchParams();
  if (from) params.set('from', from);
  if (to) params.set('to', to);

  try {
    const [summaryRes, tsRes, srcRes, popularRes, healthRes] = await Promise.all([
      apiFetch(`/api/stats/summary?${params}`).then(r => readApiResponse(r)),
      apiFetch(`/api/stats/timeseries?${params}`).then(r => readApiResponse(r)),
      apiFetch(`/api/stats/by-source?${params}`).then(r => readApiResponse(r)),
      apiFetch(`/api/stats/popular-standards?${params}`).then(r => readApiResponse(r)),
      apiFetch(`/api/stats/source-health`).then(r => readApiResponse(r)),
    ]);

    // Summary cards
    const typeMap = { search: '搜索', download: '下载', batch_resolve: '批量解析', complete: '补全', qual_search: '资质查询', preview: '预览', open: '打开', check: '查新' };
    const total = summaryRes.total || 0;
    const failCount = summaryRes.failCount || 0;
    const successRate = total > 0 ? Math.round((total - failCount) / total * 100) : 100;
    let html = `<div class="stat-card"><div class="stat-value">${total}</div><div class="stat-label">总操作数</div></div>`;
    html += `<div class="stat-card"><div class="stat-value">${summaryRes.uniqueUsers}</div><div class="stat-label">活跃用户</div></div>`;
    html += `<div class="stat-card stat-fail"><div class="stat-value">${successRate}%</div><div class="stat-label">成功率</div></div>`;
    if (failCount > 0) {
      html += `<div class="stat-card stat-fail"><div class="stat-value">${failCount}</div><div class="stat-label">失败</div></div>`;
    }
    for (const item of summaryRes.byType) {
      html += `<div class="stat-card"><div class="stat-value">${item.count}</div><div class="stat-label">${typeMap[item.eventType] || item.eventType}</div></div>`;
    }
    document.getElementById('statsSummary').innerHTML = html;

    // Source success rates panel
    renderSourceRates(srcRes.items || []);

    // Trend chart
    const dates = [...new Set(tsRes.items.map(r => r.date))].sort();
    const types = [...new Set(tsRes.items.map(r => r.eventType))];
    const colors = { search: '#3b82f6', download: '#10b981', batch_resolve: '#f59e0b', complete: '#8b5cf6', qual_search: '#ec4899', check: '#f97316' };
    const datasets = types.map(t => ({
      label: typeMap[t] || t,
      data: dates.map(d => { const row = tsRes.items.find(r => r.date === d && r.eventType === t); return row ? row.count : 0; }),
      borderColor: colors[t] || '#666',
      backgroundColor: (colors[t] || '#666') + '33',
      tension: 0.3, fill: true,
    }));
    if (trendChart) trendChart.destroy();
    trendChart = new Chart(document.getElementById('chartTrend'), {
      type: 'line',
      data: { labels: dates, datasets },
      options: { responsive: true, plugins: { legend: { labels: { color: '#aaa', font: { size: 11 } } } }, scales: { x: { ticks: { color: '#888', font: { size: 10 } } }, y: { beginAtZero: true, ticks: { color: '#888', font: { size: 10 }, stepSize: 1 } } } },
    });

    // Source pie chart
    const srcLabels = srcRes.items.map(r => r.source);
    const srcCounts = srcRes.items.map(r => r.count);
    const srcColors = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6'];
    if (sourceChart) sourceChart.destroy();
    sourceChart = new Chart(document.getElementById('chartSource'), {
      type: 'doughnut',
      data: { labels: srcLabels, datasets: [{ data: srcCounts, backgroundColor: srcColors }] },
      options: { responsive: true, plugins: { legend: { labels: { color: '#aaa', font: { size: 11 } } } } },
    });

    // Popular standards panel
    renderPopularStandards(popularRes.items || []);

    // Source health dashboard
    renderSourceHealth(healthRes.sources || {});

    // 操作明细（Phase 2）
    loadStatsActivity();
  } catch (e) { console.error('Stats load error:', e); }
}

// ── 来源成功率面板 ──
function renderSourceRates(items) {
  const el = document.getElementById('statsSourceRates');
  if (!el) return;
  if (!items.length) { el.innerHTML = '<div class="stat-panel-empty">暂无数据</div>'; return; }
  const srcLabels = { bz: 'BZ 标准在线', gbw: 'BW 国标网', by: 'BY 内网', labr: 'Labr 补给' };
  el.innerHTML = items.map(r => {
    const total = r.count || 0;
    const ok = r.successCount || 0;
    const fail = r.failCount || 0;
    const rate = total > 0 ? Math.round(ok / total * 100) : 0;
    const barColor = rate >= 90 ? 'var(--success)' : rate >= 70 ? 'var(--warning)' : 'var(--danger)';
    return `<div class="src-rate-row">
      <div class="src-rate-name">${srcLabels[r.source] || r.source}</div>
      <div class="src-rate-bar"><div class="src-rate-fill" style="width:${rate}%;background:${barColor}"></div></div>
      <div class="src-rate-nums">${ok}/${total} (${rate}%)</div>
    </div>`;
  }).join('');
}

// ── 热门标准面板 ──
function renderPopularStandards(items) {
  const el = document.getElementById('statsPopular');
  if (!el) return;
  if (!items.length) { el.innerHTML = '<div class="stat-panel-empty">暂无数据</div>'; return; }
  el.innerHTML = `<table class="stat-mini-table"><thead><tr><th>标准号</th><th>来源</th><th>操作数</th><th>成功率</th></tr></thead><tbody>` +
    items.map(r => {
      const rate = r.count > 0 ? Math.round((r.successCount || 0) / r.count * 100) : 0;
      return `<tr><td class="mono">${escapeHtml(r.standardId || '—')}</td><td>${r.source || '—'}</td><td>${r.count}</td><td>${rate}%</td></tr>`;
    }).join('') + '</tbody></table>';
}

// ── 源健康看板 ──
function renderSourceHealth(sources) {
  const el = document.getElementById('statsHealth');
  if (!el) return;
  const srcLabels = { bz: 'BZ', gbw: 'BW', by: 'BY', labr: 'Labr' };
  const keys = Object.keys(sources);
  if (!keys.length) { el.innerHTML = '<div class="stat-panel-empty">暂无数据</div>'; return; }
  el.innerHTML = keys.map(k => {
    const h = sources[k];
    const hasRecentFail = h.lastFail && (!h.lastSuccess || h.lastFail > h.lastSuccess);
    const status = hasRecentFail ? 'warn' : (h.lastSuccess ? 'ok' : 'idle');
    const statusLabel = status === 'warn' ? '有失败' : (status === 'ok' ? '正常' : '未使用');
    const lastAct = h.lastSuccess || h.lastFail || '—';
    const lastShort = lastAct !== '—' ? lastAct.replace('T', ' ').substring(5, 16) : '—';
    return `<div class="health-row health-${status}">
      <span class="health-dot"></span>
      <span class="health-name">${srcLabels[k] || k}</span>
      <span class="health-status">${statusLabel}</span>
      <span class="health-meta">成功${h.successTotal} / 失败${h.failTotal}</span>
      <span class="health-time">最近: ${lastShort}</span>
    </div>`;
  }).join('');
}

function escapeHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// 操作明细筛选态
var statsActFilter = { eventType: '', result: '' };
var STATS_ACT_TYPE_MAP = { search: '查询', download: '下载', batch_resolve: '批量解析', complete: '补全', qual_search: '资质查询', preview: '预览', open: '打开', check: '查新' };
var STATS_CLIENT_MAP = { web: ['web', 'cl-web'], desktop: ['桌面', 'cl-desktop'], mobile: ['手机', 'cl-mobile'], system: ['系统', 'cl-web'] };

async function loadStatsActivity() {
  const host = document.getElementById('statsActivity');
  if (!host) return;
  const from = document.getElementById('statsFrom').value;
  const to = document.getElementById('statsTo').value;
  const params = new URLSearchParams();
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  params.set('collapse', '5m');
  params.set('limit', '300');
  if (statsActFilter.eventType) params.set('eventType', statsActFilter.eventType);
  if (statsActFilter.result) params.set('result', statsActFilter.result);
  try {
    const data = await apiFetch(`/api/stats/activity?${params}`).then(r => readApiResponse(r));
    const groups = data.groups || [];
    if (!groups.length) { host.innerHTML = '<div class="sa-empty">暂无操作记录</div>'; return; }
    host.innerHTML = groups.map((g, gi) => renderActivityGroup(g, gi)).join('');
  } catch (e) { console.error('activity load error:', e); host.innerHTML = '<div class="sa-empty">加载失败</div>'; }
}

function fmtActTime(iso) {
  if (!iso) return '';
  const d = new Date(iso); const p = n => String(n).padStart(2, '0');
  return `${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function clientBadge(c) {
  const m = STATS_CLIENT_MAP[c] || [c || '—', 'cl-web'];
  return c ? `<span class="cl-badge ${m[1]}">${m[0]}</span>` : '<span class="muted">—</span>';
}
function renderActivityGroup(g, gi) {
  const collapsed = g.count > 1;
  const typeLabel = STATS_ACT_TYPE_MAP[g.eventType] || g.eventType;
  const hasFail = g.failCount > 0;
  const resultCell = collapsed
    ? `${g.successCount ? `<span class="res-badge res-ok">${g.successCount} 成功</span>` : ''}${hasFail ? ` <span class="res-badge res-fail">${g.failCount} 失败</span>` : ''}`
    : (g.children[0] && g.children[0].result === 'fail' ? '<span class="res-badge res-fail">失败</span>' : (g.children[0] && g.children[0].result === 'success' ? '<span class="res-badge res-ok">成功</span>' : '<span class="muted">—</span>'));
  const opCell = collapsed ? `<span class="sa-caret">▸</span>${typeLabel} ×${g.count}` : typeLabel;
  const objCell = collapsed
    ? `<span class="muted">5 分钟内 ${g.count} 次</span>`
    : escapeHtml((g.children[0] && (g.children[0].label || g.children[0].standardId || g.children[0].source || '')) || '—');
  const childRows = collapsed ? `<div class="sa-children" style="display:none">${g.children.map(c => `
    <div class="sa-child">
      <span class="mono">${fmtActTime(c.createdAt)}</span>
      ${c.result === 'fail' ? '<span class="res-badge res-fail">失败</span>' : (c.result === 'success' ? '<span class="res-badge res-ok">成功</span>' : '')}
      <span>${escapeHtml(c.label || c.standardId || c.source || '—')}</span>
      ${c.error ? `<div class="sa-err">${escapeHtml(c.error)}</div>` : ''}
    </div>`).join('')}</div>` : (g.children[0] && g.children[0].error ? `<div class="sa-children" style="display:none"><div class="sa-err">${escapeHtml(g.children[0].error)}</div></div>` : '');
  const expandable = collapsed || (g.children[0] && g.children[0].error);
  return `<div class="sa-row${hasFail ? ' sa-fail' : ''}${expandable ? ' sa-expandable' : ''}"${expandable ? ` onclick="toggleActivityRow(this)"` : ''}>
    <div class="sa-cells">
      <span class="mono">${fmtActTime(g.endAt)}</span>
      <span class="sa-user">${escapeHtml(g.displayName || g.username)}</span>
      <span class="mono">${g.hostname ? escapeHtml(g.hostname) : '<span class="muted">—</span>'}</span>
      <span class="mono">${g.ip ? escapeHtml(g.ip) : '<span class="muted">—</span>'}</span>
      <span>${clientBadge(g.client)}</span>
      <span class="sa-op">${opCell}</span>
      <span class="sa-res">${resultCell}</span>
      <span class="sa-obj">${objCell}</span>
    </div>
    ${childRows}
  </div>`;
}
function toggleActivityRow(el) {
  el.classList.toggle('open');
  const kids = el.querySelector('.sa-children');
  if (kids) kids.style.display = el.classList.contains('open') ? 'block' : 'none';
}
// 工具条筛选（事件委托，绑一次）
(function initStatsActivityToolbar() {
  document.addEventListener('click', function (e) {
    const b = e.target.closest && e.target.closest('#statsActivityToolbar .sa-chip');
    if (!b) return;
    if (b.hasAttribute('data-act-type')) {
      statsActFilter.eventType = b.getAttribute('data-act-type');
      b.parentElement.querySelectorAll('[data-act-type]').forEach(x => x.classList.toggle('active', x === b));
    } else if (b.hasAttribute('data-act-result')) {
      statsActFilter.result = b.getAttribute('data-act-result');
      b.parentElement.querySelectorAll('[data-act-result]').forEach(x => x.classList.toggle('active', x === b));
    }
    loadStatsActivity();
  });
})();

// ── Users management ──
var selectedUserIds = new Set();

// Cache of current users keyed by id — actions read username/role/etc. from
// here instead of trusting attributes that would otherwise need to be re-
// escaped through string templates (XSS risk vector).
var usersById = new Map();

async function loadUsers() {
  try {
    const [usersRes, settingsRes] = await Promise.all([
      apiFetch('/api/admin/users').then(r => readApiResponse(r)),
      apiFetch('/api/admin/settings').then(r => readApiResponse(r)),
    ]);
    document.getElementById('regEnabledToggle').checked = settingsRes.registrationEnabled;
    document.getElementById('loginRequiredToggle').checked = settingsRes.loginRequired;
    var lgEl = document.getElementById('lanGuestAllowedToggle');
    if (lgEl) lgEl.checked = !!settingsRes.lanGuestAllowed;
    usersById = new Map(usersRes.users.map(u => [u.id, u]));
    let html = '';
    for (const u of usersRes.users) {
      const roleBadge = u.role === 'admin' ? '<span class="badge badge-admin">管理员</span>' : '<span class="badge badge-user">用户</span>';
      const statusBadge = u.isActive ? '<span class="badge badge-active">启用</span>' : '<span class="badge badge-inactive">禁用</span>';
      const toggleLabel = u.isActive ? '禁用' : '启用';
      const roleLabel = u.role === 'admin' ? '降为用户' : '升为管理员';
      const checked = selectedUserIds.has(u.id) ? 'checked' : '';
      html += `<tr>
        <td><input type="checkbox" class="user-select" data-uid="${u.id}" ${checked}></td>
        <td>${escapeHtml(u.username)}</td>
        <td>${escapeHtml(u.displayName || '—')}</td>
        <td>${roleBadge}</td>
        <td>${statusBadge}</td>
        <td>${Number(u.searchCount) || 0}</td>
        <td>${Number(u.downloadCount) || 0}</td>
        <td class="users-actions">
          <button data-user-action="detail" data-uid="${u.id}">明细</button>
          <button data-user-action="perms" data-uid="${u.id}">权限</button>
          <button data-user-action="toggle-active" data-uid="${u.id}">${toggleLabel}</button>
          <button data-user-action="toggle-role" data-uid="${u.id}">${roleLabel}</button>
          <button style="color:var(--danger)" data-user-action="delete" data-uid="${u.id}">删除</button>
        </td>
      </tr>`;
    }
    document.getElementById('usersBody').innerHTML = html;
    updateBatchBar();
  } catch (e) { console.error('Users load error:', e); }
}

// Single delegated listener on the users table body. Replaces inline onclick
// handlers that previously embedded raw username strings into JS source — a
// stored-XSS sink if a username contained a single quote or backslash.
document.addEventListener('DOMContentLoaded', () => {
  const body = document.getElementById('usersBody');
  if (!body) return;
  body.addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-user-action]');
    if (!btn) return;
    const id = parseInt(btn.dataset.uid, 10);
    if (!Number.isFinite(id)) return;
    const user = usersById.get(id);
    if (!user) return;
    const action = btn.dataset.userAction;
    if (action === 'detail') showUserDetail(id);
    else if (action === 'perms') showUserPerms(id);
    else if (action === 'toggle-active') toggleUserActive(id, user.isActive ? 0 : 1);
    else if (action === 'toggle-role') changeUserRole(id, user.role === 'admin' ? 'user' : 'admin');
    else if (action === 'delete') deleteUser(id);
  });
  body.addEventListener('change', (ev) => {
    const cb = ev.target.closest('input.user-select[data-uid]');
    if (!cb) return;
    const id = parseInt(cb.dataset.uid, 10);
    if (!Number.isFinite(id)) return;
    toggleUserSelect(id, cb.checked);
  });
});

function toggleUserSelect(id, checked) {
  if (checked) selectedUserIds.add(id); else selectedUserIds.delete(id);
  updateBatchBar();
}

function toggleSelectAllUsers(checked) {
  document.querySelectorAll('#usersBody [data-uid]').forEach(cb => {
    cb.checked = checked;
    const id = parseInt(cb.dataset.uid);
    if (checked) selectedUserIds.add(id); else selectedUserIds.delete(id);
  });
  updateBatchBar();
}

function updateBatchBar() {
  const bar = document.getElementById('usersBatchBar');
  const count = selectedUserIds.size;
  document.getElementById('usersSelectedCount').textContent = count;
  bar.style.display = count > 0 ? 'inline-flex' : 'none';
}

async function batchSetActive(active) {
  const ids = [...selectedUserIds];
  if (!ids.length) return;
  const label = active ? '启用' : '禁用';
  if (!await showConfirm({ title: label + '用户', body: '确定' + label + '选中的 ' + ids.length + ' 个用户？', confirmText: label })) return;
  await Promise.all(ids.map(id =>
    apiFetch('/api/admin/users/' + id, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isActive: !!active }),
    })
  ));
  selectedUserIds.clear();
  showToast('已' + label + ' ' + ids.length + ' 个用户');
  loadUsers();
}

async function batchDeleteUsers() {
  const ids = [...selectedUserIds];
  if (!ids.length) return;
  if (!await showConfirm({ title: '批量删除用户', body: '确定删除选中的 ' + ids.length + ' 个用户？此操作不可恢复。', danger: true, confirmText: '删除' })) return;
  await Promise.all(ids.map(id => apiFetch('/api/admin/users/' + id, { method: 'DELETE' })));
  selectedUserIds.clear();
  showToast('已删除 ' + ids.length + ' 个用户');
  loadUsers();
}

function showDefaultPerms() {
  var modal = document.getElementById('modalBody');
  var overlay = document.getElementById('modalOverlay');
  // Load current default from settings
  apiFetch('/api/admin/settings').then(r => readApiResponse(r)).then(function(s) {
    var defaults = s.defaultAllowedTabs; // null = all allowed
    var html = '<h3 style="margin-bottom:12px;font-size:16px">新用户默认权限</h3>';
    html += '<p style="font-size:12px;color:var(--text-3);margin-bottom:12px">新建用户时自动应用的权限，用户创建后可单独调整</p>';
    html += '<div id="defaultPermCheckboxes">';
    TAB_ITEMS.forEach(function(t) {
      var checked = (defaults === null || defaults.indexOf(t.key) >= 0) ? 'checked' : '';
      html += '<label style="display:flex;align-items:center;gap:8px;padding:8px 12px;border-radius:8px;cursor:pointer;transition:background 0.15s" onmouseover="this.style.background=\'var(--surface-h)\'" onmouseout="this.style.background=\'\'">';
      html += '<input type="checkbox" data-defperm="' + t.key + '" ' + checked + ' style="accent-color:var(--accent);width:16px;height:16px">';
      html += '<span style="font-size:14px;font-weight:500">' + t.label + '</span>';
      html += '<span style="font-size:12px;color:var(--text-3)">' + t.desc + '</span>';
      html += '</label>';
    });
    html += '</div>';
    html += '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">';
    html += '<button class="btn btn-ghost btn-sm" onclick="document.getElementById(\'modalOverlay\').classList.remove(\'open\')">取消</button>';
    html += '<button class="btn btn-primary btn-sm" onclick="saveDefaultPerms()">保存</button>';
    html += '</div>';
    modal.innerHTML = html;
    overlay.classList.add('open');
  });
}

async function saveDefaultPerms() {
  var checks = document.querySelectorAll('#defaultPermCheckboxes [data-defperm]');
  var tabs = [];
  checks.forEach(function(cb) { if (cb.checked) tabs.push(cb.dataset.defperm); });
  try {
    var res = await apiFetch('/api/admin/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultAllowedTabs: tabs }),
    });
    if (!res.ok) {
      var errBody = await res.json().catch(function() { return null; });
      var msg = (errBody && (errBody.message || errBody.error)) || ('HTTP ' + res.status);
      showToast('保存失败: ' + msg, 'fail', 5000);
      return;
    }
  } catch (e) {
    showToast('保存失败: ' + ((e && e.message) || '网络错误'), 'fail', 5000);
    return;
  }
  document.getElementById('modalOverlay').classList.remove('open');
  showToast('默认权限已保存');
}

async function toggleUserActive(id, active) {
  await apiFetch(`/api/admin/users/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ isActive: !!active }),
  });
  loadUsers();
}

async function changeUserRole(id, role) {
  await apiFetch(`/api/admin/users/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role }),
  });
  loadUsers();
}

async function deleteUser(id) {
  const user = usersById.get(id);
  if (!user) return;
  if (!await showConfirm({ title: '删除用户', body: '确定删除用户「' + user.username + '」？此操作不可恢复。', danger: true, confirmText: '删除' })) return;
  const res = await apiFetch('/api/admin/users/' + id, { method: 'DELETE' });
  const d = await readApiResponse(res);
  if (d.ok) { showToast('用户已删除'); loadUsers(); }
  else showToast(d.message || '删除失败', 'fail');
}

function toggleRegistration(enabled) {
  apiFetch('/api/admin/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ registrationEnabled: enabled }),
  }).then(r => readApiResponse(r)).then(d => {
    document.getElementById('regEnabledToggle').checked = d.registrationEnabled;
  });
}

function toggleLoginRequired(enabled) {
  apiFetch('/api/admin/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ loginRequired: enabled }),
  }).then(r => readApiResponse(r)).then(d => {
    document.getElementById('loginRequiredToggle').checked = d.loginRequired;
  });
}

// 「允许局域网游客」——默认关。开启意味着任何 Wi-Fi 内能访问到 5937 端口的客户端
// 都能以访客身份匿名使用（绕过登录页），等价于把账号体系关掉。仅在「家用/小团队
// + 内网完全可信」时启用。开启时弹 confirm 让管理员显式确认风险。
function toggleLanGuestAllowed(enabled) {
  var el = document.getElementById('lanGuestAllowedToggle');
  if (enabled) {
    var ok = window.confirm(
      '⚠ 开启「允许局域网游客」后，任何能访问本机 5937 端口的设备（同 Wi-Fi 手机、同事电脑等）都可以匿名以访客身份使用，绕过登录页。\n\n' +
      '账号系统、权限、审计将对 LAN 客户端失效。请仅在内网完全可信的场景启用。\n\n' +
      '确认开启？'
    );
    if (!ok) { if (el) el.checked = false; return; }
  }
  apiFetch('/api/admin/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lanGuestAllowed: enabled }),
  }).then(r => readApiResponse(r)).then(d => {
    if (el) el.checked = !!d.lanGuestAllowed;
    if (typeof showToast === 'function') {
      showToast(d.lanGuestAllowed ? '局域网游客已开启' : '局域网游客已关闭', d.lanGuestAllowed ? 'warn' : 'success');
    }
  }).catch(function () {
    if (el) el.checked = !enabled; // 回滚
  });
}

async function showCreateUser() {
  const username = prompt('用户名（至少2位）');
  if (!username || username.length < 2) return;
  const password = prompt('密码（至少6位）');
  if (!password || password.length < 6) { showToast('密码至少6位', 'fail'); return; }
  // Fetch default permissions
  let allowedTabs = null;
  try {
    const s = await apiFetch('/api/admin/settings').then(r => readApiResponse(r));
    allowedTabs = s.defaultAllowedTabs; // null = all
  } catch { /* keep null */ }
  apiFetch('/api/admin/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, allowedTabs }),
  }).then(r => readApiResponse(r)).then(d => {
    if (d.user) { showToast('用户已创建'); loadUsers(); }
    else showToast(d.message || '创建失败', 'fail');
  });
}

// 顺序对齐 sidebar（index.html）+ 后端 ALL_TABS（admin-routes.ts）。三处增删 tab 必须同步。
var TAB_ITEMS = [
  { key: 'search', label: '标准检索', desc: '搜索和下载标准' },
  { key: 'tools', label: '工具箱', desc: '查新/批量/补全' },
  { key: 'local', label: '本地文件库', desc: '已下载标准管理' },
  { key: 'history', label: '下载历史', desc: '查看下载记录' },
  { key: 'qual', label: '资质查询', desc: 'CNAS/CMA 资质' },
  { key: 'cma-diff', label: 'CMA 一单一库', desc: '资质 vs 国家库比对' },
  { key: 'logs', label: '运行日志', desc: '搜索/下载/同步记录' },
  { key: 'stats', label: '使用统计', desc: '查看使用数据' },
  { key: 'settings', label: '系统设置', desc: '下载参数和源' },
];

function showUserPerms(userId) {
  var user = usersById.get(userId);
  if (!user) return;
  var allowed = user.allowedTabs; // null = all allowed
  var modal = document.getElementById('modalBody');
  var overlay = document.getElementById('modalOverlay');
  var html = '<h3 style="margin-bottom:12px;font-size:16px">功能权限 — ' + escapeHtml(user.username) + '</h3>';
  html += '<p style="font-size:12px;color:var(--text-3);margin-bottom:12px">勾选用户可使用的功能，未勾选的功能在侧边栏中不显示</p>';
  html += '<div id="permCheckboxes">';
  TAB_ITEMS.forEach(function(t) {
    var checked = (allowed === null || allowed.indexOf(t.key) >= 0) ? 'checked' : '';
    html += '<label style="display:flex;align-items:center;gap:8px;padding:8px 12px;border-radius:8px;cursor:pointer;transition:background 0.15s" onmouseover="this.style.background=\'var(--surface-h)\'" onmouseout="this.style.background=\'\'">';
    html += '<input type="checkbox" data-perm-tab="' + t.key + '" ' + checked + ' style="accent-color:var(--accent);width:16px;height:16px">';
    html += '<span style="font-size:14px;font-weight:500">' + t.label + '</span>';
    html += '<span style="font-size:12px;color:var(--text-3)">' + t.desc + '</span>';
    html += '</label>';
  });
  html += '</div>';
  html += '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">';
  html += '<button class="btn btn-ghost btn-sm" onclick="document.getElementById(\'modalOverlay\').classList.remove(\'open\')">取消</button>';
  html += '<button class="btn btn-primary btn-sm" onclick="saveUserPerms(' + userId + ')">保存</button>';
  html += '</div>';
  modal.innerHTML = html;
  overlay.classList.add('open');
}

async function saveUserPerms(userId) {
  var checks = document.querySelectorAll('#permCheckboxes [data-perm-tab]');
  var tabs = [];
  checks.forEach(function(cb) { if (cb.checked) tabs.push(cb.dataset.permTab); });
  try {
    var res = await apiFetch('/api/admin/users/' + userId, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ allowedTabs: tabs }),
    });
    // 之前没校验 res.ok,后端 zod 校验失败(400)会被静默吞,用户报"保存了没生效"
    if (!res.ok) {
      var errBody = await res.json().catch(function() { return null; });
      var msg = (errBody && (errBody.message || errBody.error)) || ('HTTP ' + res.status);
      if (typeof showToast === 'function') showToast('保存失败: ' + msg, 'fail', 5000);
      else alert('保存失败: ' + msg);
      return;
    }
  } catch (e) {
    var msg2 = (e && e.message) || '网络错误';
    if (typeof showToast === 'function') showToast('保存失败: ' + msg2, 'fail', 5000);
    else alert('保存失败: ' + msg2);
    return;
  }
  document.getElementById('modalOverlay').classList.remove('open');
  loadUsers();
}

async function showUserDetail(userId) {
  const modal = document.getElementById('modalBody');
  const overlay = document.getElementById('modalOverlay');
  modal.innerHTML = '<p style="color:var(--text-3)">加载中...</p>';
  overlay.classList.add('open');
  try {
    const res = await apiFetch(`/api/admin/users/${userId}/events`);
    const d = await readApiResponse(res);
    if (!res.ok) throw new Error(d.message || '加载失败');

    const typeLabels = { search: '搜索', download: '下载', batch_resolve: '批量解析', complete: '补全' };
    // 颜色全部走主题变量，卡片随主题（暗/亮/暖）自适应。注意是 --warning 不是 --warn。
    const typeColors = { search: 'var(--accent)', download: 'var(--success)', batch_resolve: 'var(--warning)', complete: '#a78bfa' };

    // 统计卡片：中性 surface 底 + 顶部 3px 主题色条 + 同色数字（仿主题按钮风格，
    // 替换原先死板的灰底 oklch(25% 0.01 250)）。border/surface 都是主题变量，三套主题通吃。
    const statCard = (color, value, label) =>
      `<div style="padding:8px 14px;border-radius:8px;background:var(--surface-h);border:1px solid var(--border);border-top:3px solid ${color};text-align:center"><div style="font-size:20px;font-weight:600;color:${color}">${value}</div><div style="font-size:11px;color:var(--text-3)">${label}</div></div>`;

    let summaryHtml = '<div style="display:flex;gap:12px;flex-wrap:wrap;margin:12px 0">';
    const total = d.summary.reduce((s, r) => s + r.count, 0);
    summaryHtml += statCard('var(--accent)', total, '总计');
    for (const s of d.summary) {
      const color = typeColors[s.eventType] || 'var(--text-2)';
      summaryHtml += statCard(color, s.count, typeLabels[s.eventType] || s.eventType);
    }
    summaryHtml += '</div>';

    let sourceHtml = '';
    if (d.bySource.length > 0) {
      sourceHtml = '<div style="margin:8px 0;font-size:13px;color:var(--text-2)">来源分布: ' +
        d.bySource.map(s => `<span class="source-badge source-${escapeHtml(s.source)}">${srcLabel(s.source)} ${s.count}</span>`).join(' ') +
        '</div>';
    }

    let listHtml = '';
    if (d.recent.length > 0) {
      listHtml = '<div style="max-height:320px;overflow-y:auto;margin-top:8px"><table class="users-table"><thead><tr><th>时间</th><th>类型</th><th>来源</th><th>标准号</th></tr></thead><tbody>';
      for (const e of d.recent) {
        const time = e.createdAt ? utcToBeijing(e.createdAt) : '—';
        const typeLabel = typeLabels[e.eventType] || e.eventType;
        const color = typeColors[e.eventType] || 'var(--text-2)';
        listHtml += `<tr>
          <td style="font-size:12px;white-space:nowrap">${time}</td>
          <td><span style="color:${color};font-size:12px">${typeLabel}</span></td>
          <td>${e.source ? srcLabel(e.source) : '—'}</td>
          <td style="font-size:12px">${e.standardId ? escapeHtml(e.standardId) : '—'}</td>
        </tr>`;
      }
      listHtml += '</tbody></table></div>';
    } else {
      listHtml = '<p style="color:var(--text-3);font-size:13px;margin-top:8px">暂无使用记录</p>';
    }

    modal.innerHTML = `<h3>用户: ${escapeHtml(d.user.displayName || d.user.username)}</h3>
      ${summaryHtml}${sourceHtml}${listHtml}
      <button class="btn btn-ghost btn-sm" style="margin-top:12px" data-action="modal-close">关闭</button>`;
  } catch (e) {
    modal.innerHTML = `<p style="color:var(--danger)">加载失败: ${escapeHtml(e.message)}</p>`;
  }
}

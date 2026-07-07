// ── Auth Core ──

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
}

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

// ── Login overlay: version + online status ──
function initLoginOverlayMeta() {
  // 先启动健康检查轮询，避免 IPC 调用挂起时整个登录页一直显示"正在检查服务…"
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

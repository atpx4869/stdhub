// ── Auth User Management ──

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

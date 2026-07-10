// ── Settings (Web 端精简版) ──
// 仅保留下载设置、标准库、诊断面板。Electron 桌面端功能已移除。

const SETTINGS_LABELS = { gbw: 'BW源', bz: 'BZ源', by: 'BY源' };
const SETTINGS_NOTES = { gbw: '自动验证码 5~15s', bz: '合成PDF 30~90s', by: '直链PDF 2~5s' };

// ── 下载设置 ──

function toggleDownloadSource(source, enabled) {
  if (enabled) { if (!downloadSources.includes(source)) downloadSources.push(source); }
  else { downloadSources = downloadSources.filter(s => s !== source); }
  saveSettings();
}
function setConcurrency(n) { downloadConcurrency = n; saveSettings(); }
function setTimeoutVal(n) { downloadTimeout = n; saveSettings(); }
function setHistoryLimit(n) { localStorage.setItem('bzxz_history_limit', String(n)); return n; }
function getHistoryLimit() { return parseInt(localStorage.getItem('bzxz_history_limit') || '8', 10); }

// ── 源检测 ──

var sourceStatusCache = {};

async function checkAllSources() {
  var btn = document.getElementById('checkSourcesBtn');
  if (btn) { btn.textContent = '检测中...'; btn.disabled = true; }
  var list = document.getElementById('sourceStatusList');
  if (list) list.innerHTML = renderSourceStatusLoading();
  try {
    var res = await fetch('/api/standards/check-sources');
    var data = await readApiResponse(res);
    sourceStatusCache = data.results || {};
  } catch {
    ALL_SOURCES.forEach(function(s) { sourceStatusCache[s] = { status: 'error', ms: 0, error: '请求失败' }; });
  }
  if (list) list.innerHTML = renderSourceStatusList();
  if (btn) { btn.textContent = '全部检测'; btn.disabled = false; }
}

async function checkSingleSource(src) {
  var el = document.getElementById('ss-' + src);
  if (el) el.innerHTML = '<span class="spinner" style="width:12px;height:12px"></span>';
  try {
    var res = await fetch('/api/standards/check-sources?sources=' + src);
    var data = await readApiResponse(res);
    Object.assign(sourceStatusCache, data.results || {});
  } catch { sourceStatusCache[src] = { status: 'error', ms: 0, error: '请求失败' }; }
  if (el) el.innerHTML = renderSourceStatusItem(src);
}

function renderSourceStatusLoading() {
  return ALL_SOURCES.map(function(s) {
    return '<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border)">'
      + '<span style="font-weight:500;color:var(--text);min-width:80px">' + srcLabel(s) + '</span>'
      + '<span class="spinner" style="width:12px;height:12px"></span>'
      + '<span style="color:var(--text-3)">检测中...</span></div>';
  }).join('');
}

function renderSourceStatusItem(src) {
  var r = sourceStatusCache[src];
  if (!r) return '<span style="color:var(--text-3)">未检测</span>';
  if (r.status === 'ok') {
    return '<span style="color:var(--success)">● 正常</span> <span style="color:var(--text-3)">' + r.ms + 'ms</span>';
  }
  var msg = String(r.error || '');
  var isWarn = msg.includes('凭据未配置') || msg.includes('超时');
  var color = isWarn ? 'var(--warning)' : 'var(--danger)';
  var label = isWarn ? (msg.includes('凭据') ? '未配置' : '超时') : '异常';
  return '<span style="color:' + color + '">● ' + escapeHtml(label) + '</span> <span style="color:var(--text-3)">' + escapeHtml(r.error || '未知错误') + '</span>';
}

function renderSourceStatusList() {
  return ALL_SOURCES.map(function(s) {
    var statusHtml = renderSourceStatusItem(s);
    return '<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border)">'
      + '<span style="font-weight:500;color:var(--text);min-width:80px">' + srcLabel(s) + '</span>'
      + '<span id="ss-' + s + '" style="flex:1">' + statusHtml + '</span>'
      + '<button class="btn btn-ghost btn-sm" style="font-size:11px;padding:2px 8px" onclick="checkSingleSource(\'' + s + '\')">重试</button>'
      + '</div>';
  }).join('');
}

// ── 标准库设置 ──

var libraryState = { loaded: false, loading: false, data: null, error: '' };

async function loadLibrarySettings() {
  var box = document.getElementById('libraryStatusBox');
  if (!box) return;
  libraryState.loading = true;
  try {
    var res = await apiFetch('/api/admin/settings');
    var s = await readApiResponse(res);
    libraryState.data = s;
    libraryState.loaded = true;
    libraryState.error = '';
    renderLibraryStatus();
  } catch (e) {
    libraryState.error = (e && e.message) || '加载失败';
    box.innerHTML = '<span style="color:var(--danger)">' + escapeHtml(libraryState.error) + '</span>';
  } finally {
    libraryState.loading = false;
  }
}

function renderLibraryStatus() {
  var box = document.getElementById('libraryStatusBox');
  if (!box || !libraryState.data) return;
  var s = libraryState.data;
  var lib = s.library || {};
  var banner = '';
  if (lib.fallbackUsed) {
    banner = '<div class="library-banner warn">⚠ ' + escapeHtml(lib.fallbackReason || '首选库目录不可写，已临时回退') + '</div>';
  } else if (!lib.writable) {
    banner = '<div class="library-banner err">✕ 当前库目录不可写：' + escapeHtml(lib.fallbackReason || '请检查权限') + '</div>';
  }
  var prio = (s.librarySourcePriority || ['gbw','bz','by']).map(srcLabel).join(' › ');
  var indexed = lib.lastIndexedAt ? lib.lastIndexedAt.replace('T', ' ').replace('Z', '') : '—';
  box.innerHTML = banner +
    '<div class="library-row"><span class="library-row-label">当前目录</span>' +
      '<code class="library-row-value">' + escapeHtml(lib.dir || '—') + '</code></div>' +
    '<div class="library-row"><span class="library-row-label">配置值</span>' +
      '<input type="text" id="libraryDirInput" class="library-input" placeholder="留空使用默认" value="' + escapeHtml(s.standardsLibraryDir || '') + '">' +
      '<button class="btn btn-sm btn-primary" onclick="saveLibraryDir()">保存</button></div>' +
    '<div class="library-row"><span class="library-row-label">已索引</span>' +
      '<span class="library-row-value">' + (Number(lib.indexCount) || 0) + ' 个 PDF · 最近 ' + escapeHtml(indexed) + '</span></div>' +
    '<div class="library-row"><span class="library-row-label">源优先级</span>' +
      '<span class="library-row-value">' + escapeHtml(prio) + '</span></div>' +
    '<div class="library-row"><span class="library-row-label">文件夹监听</span>' +
      '<label class="library-toggle"><input type="checkbox" id="libraryWatcherEnabledChk"' +
        (s.libraryWatcherEnabled === false ? '' : ' checked') +
        ' onchange="saveLibraryWatcherEnabled(this.checked)"> 启用</label></div>' +
    '<div class="library-row"><span class="library-row-label">本地优先下载</span>' +
      '<label class="library-toggle"><input type="checkbox" id="downloadPreferLocalChk"' +
        (s.downloadPreferLocal === false ? '' : ' checked') +
        ' onchange="saveDownloadPreferLocal(this.checked)"> 启用</label></div>';
}

async function saveDownloadPreferLocal(enabled) {
  try {
    var res = await apiFetch('/api/admin/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ downloadPreferLocal: !!enabled }),
    });
    var data = await readApiResponse(res);
    libraryState.data = data;
    if (!window.bzxzPublicSettings) window.bzxzPublicSettings = {};
    window.bzxzPublicSettings.downloadPreferLocal = !!enabled;
    showToast(enabled ? '已启用本地优先下载' : '已关闭本地优先下载');
  } catch (e) {
    showToast((e && e.message) || '保存失败', 'fail');
    var chk = document.getElementById('downloadPreferLocalChk');
    if (chk) chk.checked = !enabled;
  }
}

async function saveLibraryWatcherEnabled(enabled) {
  try {
    var res = await apiFetch('/api/admin/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ libraryWatcherEnabled: !!enabled }),
    });
    var data = await readApiResponse(res);
    libraryState.data = data;
    showToast(enabled ? '已开启文件夹监听' : '已关闭文件夹监听');
  } catch (e) {
    showToast((e && e.message) || '保存失败', 'fail');
    var chk = document.getElementById('libraryWatcherEnabledChk');
    if (chk) chk.checked = !enabled;
  }
}

async function saveLibraryDir() {
  var input = document.getElementById('libraryDirInput');
  if (!input) return;
  var val = input.value.trim();
  try {
    var res = await apiFetch('/api/admin/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ standardsLibraryDir: val }),
    });
    var data = await readApiResponse(res);
    libraryState.data = data;
    renderLibraryStatus();
    showToast('库目录已保存，后台正在重扫…');
    setTimeout(loadLibrarySettings, 2500);
  } catch (e) {
    showToast((e && e.message) || '保存失败', 'fail');
  }
}

async function rescanLibrary() {
  var btn = document.getElementById('libraryRescanBtn');
  if (btn) { btn.disabled = true; btn.textContent = '扫描中…'; }
  try {
    var res = await apiFetch('/api/admin/library/rescan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ full: true }),
    });
    var data = await readApiResponse(res);
    var r = data.result || {};
    showToast('扫描完成：新增 ' + (r.added || 0) + ' · 更新 ' + (r.updated || 0) + ' · 删除 ' + (r.removed || 0));
    loadLibrarySettings();
  } catch (e) {
    showToast((e && e.message) || '扫描失败', 'fail');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '重新扫描'; }
  }
}

// ── 诊断面板 ──

const ENV_CHECK_BADGE = {
  ok:      { icon: '✅', color: 'var(--success)' },
  fail:    { icon: '❌', color: 'var(--danger)' },
  pending: { icon: '⏳', color: 'var(--text-3)' },
  skip:    { icon: '⏭️', color: 'var(--text-3)' },
};

async function pollEnvironmentCheck() {
  const bannerEl = document.getElementById('envWarning');
  const textEl = document.getElementById('envWarningText');
  if (!bannerEl || !textEl) return;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch('/api/diagnostics/environment');
      const report = await readApiResponse(res);
      if (report && report.finishedAt) {
        const failed = Object.values(report.checks || {}).filter(c => c.status === 'fail');
        if (failed.length) {
          textEl.textContent = '检测到 ' + failed.length + ' 项异常';
          bannerEl.style.display = 'flex';
        }
        return;
      }
    } catch { /* keep trying */ }
    await new Promise(r => setTimeout(r, 1500));
  }
}

function showDiagnostics() {
  var overlay = document.getElementById('modalOverlay');
  var modal = document.getElementById('modalBody');
  if (!overlay || !modal) return;
  overlay.classList.add('open');
  modal.innerHTML = '<div style="padding:20px"><h3 style="margin-bottom:12px">系统诊断</h3><div id="diagBody"><span class="spinner"></span> 加载中…</div></div>';
  loadDiagnostics();
}

async function loadDiagnostics() {
  var body = document.getElementById('diagBody');
  if (!body) return;
  try {
    var [envRes, hostsRes] = await Promise.all([
      fetch('/api/diagnostics/environment').then(r => readApiResponse(r)),
      fetch('/api/diagnostics/hosts').then(r => readApiResponse(r)),
    ]);
    var html = '';
    // 环境检测
    if (envRes && envRes.checks) {
      html += '<h4 style="margin:12px 0 8px">环境检测</h4>';
      html += Object.values(envRes.checks).map(c => {
        var badge = ENV_CHECK_BADGE[c.status] || ENV_CHECK_BADGE.pending;
        return '<div style="padding:4px 0;font-size:13px">' + badge.icon + ' ' + escapeHtml(c.label) + (c.ms ? ' <span style="color:var(--text-3)">(' + c.ms + 'ms)</span>' : '') + '</div>';
      }).join('');
    }
    // 上游延迟
    if (hostsRes && Object.keys(hostsRes).length) {
      html += '<h4 style="margin:12px 0 8px">上游延迟</h4>';
      html += Object.entries(hostsRes).map(([host, stats]) =>
        '<div style="padding:4px 0;font-size:13px">' + escapeHtml(host) + ': ' + stats.min + '~' + stats.max + 'ms (avg ' + stats.avg + 'ms)</div>'
      ).join('');
    }
    body.innerHTML = html || '<div style="color:var(--text-3)">暂无诊断数据</div>';
  } catch (e) {
    body.innerHTML = '<div style="color:var(--danger)">加载失败: ' + escapeHtml(e.message) + '</div>';
  }
}

// ── 主渲染函数 ──

function renderSettings() {
  const isAdmin = (typeof currentUser !== 'undefined' && currentUser && currentUser.role === 'admin');

  const priorityRows = downloadPriority.map((s, i) => {
    const enabled = downloadSources.includes(s);
    return `
    <div class="set-row draggable source-priority-row" data-priority="${s}" style="opacity:${enabled ? '1' : '0.45'}">
      <span class="set-drag-handle">⋮</span>
      <span class="set-order">${i + 1}</span>
      <div class="set-row-main">
        <div class="set-row-title">${SETTINGS_LABELS[s]}</div>
        <div class="set-row-note">${SETTINGS_NOTES[s]}</div>
      </div>
      <span class="set-chip">${srcLabel(s)}</span>
      <label class="toggle-switch">
        <input type="checkbox" ${enabled ? 'checked' : ''} onchange="toggleDownloadSource('${s}', this.checked);renderSettings()">
        <span class="toggle-track"><span class="toggle-thumb"></span></span>
      </label>
    </div>`;
  }).join('');

  const seg = (opts, current, fn, suffix) => `<div class="set-seg">${opts.map(n =>
    `<button class="set-seg-item ${n === current ? 'active' : ''}" onclick="${fn}(${n});renderSettings()">${n}${suffix || ''}</button>`
  ).join('')}</div>`;
  const concurrencySeg = seg(VALID_CONCURRENCY, downloadConcurrency, 'setConcurrency', '');
  const timeoutSeg = seg([10, 15, 20, 30, 60], downloadTimeout, 'setTimeoutVal', 's');
  const historySeg = seg([3, 5, 8, 10, 15, 20], getHistoryLimit(), 'setHistoryLimit', '');

  const navItems = [
    ['set-sec-download', '⚙', '下载与源'],
    ['set-sec-library', '📁', '文件库'],
  ];
  if (isAdmin) {
    navItems.push(['set-sec-qual', '📋', '资质订阅']);
    navItems.push(['set-sec-autosync', '🔄', '自动同步']);
  }
  navItems.push(['set-sec-diag', '🩺', '诊断']);
  navItems.push(['set-sec-about', 'ℹ️', '关于']);

  const navEl = document.getElementById('settingsNav');
  if (navEl) {
    navEl.innerHTML = navItems.map((it, idx) =>
      `<button class="set-nav-item${idx === 0 ? ' active' : ''}" onclick="settingsNavTo('${it[0]}', this)"><span class="set-nav-ico">${it[1]}</span>${it[2]}</button>`
    ).join('');
  }

  const body = document.getElementById('settingsBody');
  body.style.display = 'flex';
  body.style.flexDirection = 'column';
  body.style.gap = '30px';
  body.innerHTML = `
    <div class="set-section" id="set-sec-download">
      <div class="set-section-head"><h2>下载与源</h2><p>并发、超时、搜索记录与源的优先级、连通性。</p></div>
      <div class="set-card">
        <div class="set-row">
          <div class="set-row-main"><div class="set-row-title">并发数</div><div class="set-row-note">同时下载的任务数</div></div>
          <div class="set-row-control">${concurrencySeg}</div>
        </div>
        <div class="set-row">
          <div class="set-row-main"><div class="set-row-title">超时时间</div><div class="set-row-note">单个请求的等待上限</div></div>
          <div class="set-row-control">${timeoutSeg}</div>
        </div>
        <div class="set-row">
          <div class="set-row-main"><div class="set-row-title">搜索记录</div><div class="set-row-note">保留的历史搜索条数</div></div>
          <div class="set-row-control">${historySeg}</div>
        </div>
      </div>
      <div class="set-section-head set-subsection"><h2>源优先级</h2><p>拖拽调整顺序，排前面的源会先尝试。</p></div>
      <div id="priorityList" class="set-card">${priorityRows}</div>
      <div class="set-head-row set-subsection">
        <div class="set-section-head"><h2>数据源状态</h2><p>检测各下载源当前连通性与响应耗时。</p></div>
        <button class="btn btn-sm btn-ghost" onclick="checkAllSources()" id="checkSourcesBtn">全部检测</button>
      </div>
      <div class="set-card" style="padding:6px 16px"><div id="sourceStatusList" class="source-status-list" style="font-size:13px;color:var(--text-3);padding:8px 0">点击"全部检测"或单个源的"重试"按钮</div></div>
      <div class="set-actions set-subsection">
        <button class="btn btn-ghost btn-sm" onclick="showDiagnostics()">🩺 诊断</button>
        <button class="btn btn-ghost btn-sm" onclick="resetSettings();renderSettings()">恢复默认</button>
      </div>
    </div>

    <div class="set-section" id="set-sec-library">
      <div class="set-section-head"><h2>文件库</h2><p>存放目录、文件夹监听、下载策略与索引状态。</p></div>
      <div class="set-card">
        <div id="libraryStatusBox" class="library-status-box">加载中…</div>
      </div>
    </div>

    ${isAdmin ? `
    <div class="set-section" id="set-sec-qual">
      <div class="set-section-head"><h2>资质订阅</h2><p>CNAS / CMA 机构能力数据，订阅后定时同步至本地。</p></div>
      <div class="qual-settings-tabs set-tabs" style="margin:12px 0 14px">
        <button class="qual-settings-tab set-tab active" data-qual-settings-tab="labs" onclick="switchQualSettingsTab('labs')">订阅管理</button>
        <button class="qual-settings-tab set-tab" data-qual-settings-tab="logs" onclick="switchQualSettingsTab('logs')">同步日志</button>
      </div>
      <div id="qualLabsTab">
        <div class="qual-section-title">推荐订阅</div>
        <div id="qualPresetCnas" style="margin-bottom:14px"><div style="color:var(--text-3);font-size:12px">加载中…</div></div>
        <div class="qual-section-title">CNAS 实验室</div>
        <div id="qualCnasLabs"></div>
        <div class="qual-add-form">
          <input id="qualCnasInput" placeholder="CNAS URL 或 baseInfoId" onkeydown="if(event.key==='Enter')addQualLab('cnas')">
          <button class="btn btn-sm btn-primary" onclick="addQualLab('cnas')">添加</button>
        </div>
        <div class="qual-section-title">CMA 实验室</div>
        <div id="qualCmaLabs"></div>
        <div class="qual-add-form">
          <input id="qualCmaInput" placeholder="输入 CMA 机构名称" onkeydown="if(event.key==='Enter')searchCmaLabCandidates()">
          <button class="btn btn-sm btn-primary" onclick="searchCmaLabCandidates()">搜索机构</button>
        </div>
        <div id="qualCmaCandidates" style="margin-top:8px"></div>
        <div style="text-align:right;margin-top:12px">
          <button class="btn btn-sm btn-ghost" onclick="syncAllQualLabs()">同步全部</button>
        </div>
        <div class="qual-section-title" style="margin-top:24px">最近同步</div>
        <div id="qualLabsSyncLogs" style="max-height:300px;overflow-y:auto;font-size:12px"></div>
      </div>
      <div id="qualLogsTab" style="display:none">
        <div style="display:flex;gap:8px;margin-bottom:12px">
          <button class="qual-filter-btn active" data-log-source="cnas" onclick="switchLogSource(this,'cnas')">CNAS</button>
          <button class="qual-filter-btn" data-log-source="cma" onclick="switchLogSource(this,'cma')">CMA</button>
        </div>
        <div id="qualSyncLogs" style="max-height:400px;overflow-y:auto;font-size:12px"></div>
      </div>
    </div>` : ''}

    ${isAdmin ? `
    <div class="set-section" id="set-sec-autosync">
      <div class="set-section-head"><h2>自动同步</h2><p>定时自动同步资质订阅和 CMA 一单一库能力项目库。</p></div>
      <div class="set-card" style="padding:16px">
        <div class="set-row">
          <div class="set-row-main"><div class="set-row-title">启用自动同步</div><div class="set-row-note">按设定的 cron 表达式定时执行同步</div></div>
          <div class="set-row-control">
            <label class="toggle-switch">
              <input type="checkbox" id="autoSyncEnabledChk" onchange="saveAutoSyncSetting('enabled', this.checked)">
              <span class="toggle-track"><span class="toggle-thumb"></span></span>
            </label>
          </div>
        </div>
        <div class="set-row">
          <div class="set-row-main"><div class="set-row-title">资质订阅同步</div><div class="set-row-note">CNAS / CMA 实验室能力数据（使用 Playwright，建议低峰期）</div></div>
          <div class="set-row-control">
            <label class="toggle-switch">
              <input type="checkbox" id="autoSyncQualEnabledChk" checked onchange="saveAutoSyncSetting('qualEnabled', this.checked)">
              <span class="toggle-track"><span class="toggle-thumb"></span></span>
            </label>
          </div>
        </div>
        <div class="set-row">
          <div class="set-row-main"><div class="set-row-title">资质同步 Cron</div><div class="set-row-note">默认 <code>0 3 * * 0</code>（每周日凌晨 3 点）</div></div>
          <div class="set-row-control" style="display:flex;gap:6px;align-items:center">
            <input type="text" id="autoSyncQualCronInput" class="set-input" style="width:160px" placeholder="0 3 * * 0">
            <button class="btn btn-sm btn-primary" onclick="saveAutoSyncCron('qual')">保存</button>
          </div>
        </div>
        <div class="set-row">
          <div class="set-row-main"><div class="set-row-title">CMA 能力库同步</div><div class="set-row-note">一单一库领域标准数据（使用 HTTP，资源消耗小）</div></div>
          <div class="set-row-control">
            <label class="toggle-switch">
              <input type="checkbox" id="autoSyncCaplibEnabledChk" checked onchange="saveAutoSyncSetting('caplibEnabled', this.checked)">
              <span class="toggle-track"><span class="toggle-thumb"></span></span>
            </label>
          </div>
        </div>
        <div class="set-row">
          <div class="set-row-main"><div class="set-row-title">能力库同步 Cron</div><div class="set-row-note">默认 <code>0 3 * * *</code>（每天凌晨 3 点）</div></div>
          <div class="set-row-control" style="display:flex;gap:6px;align-items:center">
            <input type="text" id="autoSyncCaplibCronInput" class="set-input" style="width:160px" placeholder="0 3 * * *">
            <button class="btn btn-sm btn-primary" onclick="saveAutoSyncCron('caplib')">保存</button>
          </div>
        </div>
      </div>
      <div class="set-card" style="padding:16px;margin-top:12px">
        <div class="set-row">
          <div class="set-row-main"><div class="set-row-title">手动触发</div><div class="set-row-note">立即执行一次自动同步</div></div>
          <div class="set-row-control">
            <button class="btn btn-sm btn-primary" onclick="triggerAutoSync()">立即执行</button>
          </div>
        </div>
        <div id="autoSyncStatusBox" style="margin-top:12px;font-size:12px;color:var(--text-2)">加载中…</div>
      </div>
    </div>` : ''}

    <div class="set-section" id="set-sec-diag">
      <div class="set-section-head"><h2>诊断</h2><p>环境检测、上游延迟、服务端日志。</p></div>
      <div class="set-card" style="padding:14px 16px">
        <button class="btn btn-sm btn-primary" onclick="showDiagnostics()">打开诊断面板</button>
      </div>
    </div>

    <div class="set-section" id="set-sec-about">
      <div class="set-section-head"><h2>关于</h2><p>版本信息与更新日志。</p></div>
      <div class="set-card" id="aboutVersionCard">
        <div class="set-row">
          <div class="set-row-main"><div class="set-row-title">本地版本</div></div>
          <div class="set-row-control" id="aboutLocalVersion" style="color:var(--text-2)">加载中…</div>
        </div>
        <div class="set-row">
          <div class="set-row-main"><div class="set-row-title">最新版本</div><div class="set-row-note">从 GitHub Releases 获取</div></div>
          <div class="set-row-control" id="aboutLatestVersion" style="color:var(--text-2)">检查中…</div>
        </div>
      </div>
      <div class="set-section-head set-subsection"><h2>更新日志</h2></div>
      <div class="set-card" id="aboutReleaseNotes" style="padding:16px;color:var(--text-2);font-size:13px">加载中…</div>
    </div>`;

  initDragSort();
  // 默认只显示第一个 section
  var sections = document.querySelectorAll('#settingsBody .set-section');
  sections.forEach(function (sec, idx) { sec.style.display = idx === 0 ? '' : 'none'; });
  if (isAdmin) loadLibrarySettings();
}

// ── 设置 tab 切换 ──

function settingsNavTo(id, el) {
  if (el && el.parentNode) {
    el.parentNode.querySelectorAll('.set-nav-item').forEach(function (n) { n.classList.remove('active'); });
    el.classList.add('active');
  }
  document.querySelectorAll('#settingsBody .set-section').forEach(function (sec) {
    sec.style.display = sec.id === id ? '' : 'none';
  });
  // 切到资质订阅时重新加载数据（区块从隐藏变可见，DOM 元素才生效）
  if (id === 'set-sec-qual') {
    if (typeof loadQualLabs === 'function') {
      try { loadQualLabs(); } catch (e) { /* ignore */ }
    }
    if (typeof loadLabsSyncLogs === 'function') {
      try { loadLabsSyncLogs(); } catch (e) { /* ignore */ }
    }
  }
  // 切到自动同步时加载设置
  if (id === 'set-sec-autosync') {
    if (typeof loadAutoSyncSettings === 'function') {
      try { loadAutoSyncSettings(); } catch (e) { /* ignore */ }
    }
  }
  // 切到标准库时加载库配置
  if (id === 'set-sec-library') {
    if (typeof loadLibrarySettings === 'function') {
      try { loadLibrarySettings(); } catch (e) { /* ignore */ }
    }
  }
  // 切到关于时加载版本信息
  if (id === 'set-sec-about') {
    loadAboutSection();
  }
}

// ── 关于页面 ──

async function loadAboutSection() {
  const localEl = document.getElementById('aboutLocalVersion');
  const latestEl = document.getElementById('aboutLatestVersion');
  const notesEl = document.getElementById('aboutReleaseNotes');

  // 本地版本
  let version = '';
  try {
    const res = await fetch('/api/health', { cache: 'no-store' });
    const data = await res.json();
    version = (data && data.data && data.data.version) || '';
  } catch {}
  if (localEl) localEl.textContent = version ? 'v' + version : '未知';

  // 最新版本 + 更新日志
  let latestVersion = '';
  let notesMd = '';
  try {
    const res = await fetch('/api/announcements/release-notes?version=' + encodeURIComponent(version), { cache: 'no-store' });
    const data = await res.json();
    const notes = (data && data.data) || data;
    if (notes && notes.available) {
      latestVersion = notes.name || '';
      notesMd = notes.bodyMd || notes.body || '';
    }
  } catch {}

  // 从 GitHub 获取最新 release 信息作为 fallback
  if (!latestVersion) {
    try {
      const res = await fetch('https://api.github.com/repos/atpx4869/stdhub/releases/latest');
      if (res.ok) {
        const gh = await res.json();
        latestVersion = gh.tag_name || '';
        notesMd = notesMd || gh.body || '';
      }
    } catch {}
  }

  if (latestEl) {
    if (latestVersion) {
      const isUpToDate = version && latestVersion.replace(/^v/, '') === version;
      latestEl.innerHTML = isUpToDate
        ? '<span style="color:var(--success)">' + latestVersion + ' (已是最新)</span>'
        : '<span style="color:var(--warning)">' + (latestVersion || '未知') + '</span>';
    } else {
      latestEl.textContent = '无法获取';
    }
  }

  // 渲染更新日志（最近 8 条）
  if (notesEl) {
    try {
      const res = await fetch('https://api.github.com/repos/atpx4869/stdhub/releases?per_page=8');
      if (res.ok) {
        var releases = await res.json();
        if (releases && releases.length) {
          notesEl.innerHTML = releases.map(function (r) {
            var date = r.published_at ? new Date(r.published_at).toLocaleDateString('zh-CN', { year:'numeric', month:'2-digit', day:'2-digit' }) : '';
            var tag = r.tag_name || '';
            var body = r.body || '';
            // 渲染 markdown：将 # 标题 / - 列表 / ` 代码 转为 HTML
            var bodyHtml = body
              .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
              .replace(/^### (.+)$/gm, '<strong style="font-size:13px">$1</strong>')
              .replace(/^## (.+)$/gm, '<h4 style="margin:8px 0 4px;font-size:14px">$1</h4>')
              .replace(/^- (.+)$/gm, '<li style="margin:2px 0;color:var(--text-2)">$1</li>')
              .replace(/(<li[^>]*>.*<\/li>)\n?(<li)/g, '$1$2')
              .replace(/((?:<li[^>]*>.*<\/li>\n?)+)/g, '<ul style="margin:4px 0 8px;padding-left:18px">$1</ul>')
              .replace(/`([^`]+)`/g, '<code style="background:var(--surface);padding:1px 5px;border-radius:3px;font-size:12px">$1</code>')
              .replace(/\n\n/g, '<br>')
              .replace(/\n/g, '<br>');
            return '<div style="margin-bottom:18px;padding-bottom:14px;border-bottom:1px solid var(--border)">'
              + '<div style="display:flex;align-items:baseline;gap:8px;margin-bottom:6px">'
              + '<span style="font-weight:600;font-size:14px;color:var(--text)">' + escapeHtml(tag) + '</span>'
              + (date ? '<span style="font-size:11px;color:var(--text-3)">' + date + '</span>' : '')
              + '</div>'
              + '<div style="font-size:13px;line-height:1.6;color:var(--text-2)">' + bodyHtml + '</div>'
              + '</div>';
          }).join('');
          return;
        }
      }
    } catch {}
    // fallback: 单条
    if (notesMd) {
      if (typeof renderAnnouncementMarkdown === 'function') {
        notesEl.innerHTML = renderAnnouncementMarkdown(notesMd);
      } else {
        notesEl.textContent = notesMd;
      }
    } else {
      notesEl.innerHTML = '<span style="color:var(--text-3)">暂无更新日志。查看 <a href="https://github.com/atpx4869/stdhub/releases" target="_blank" style="color:var(--primary)">GitHub Releases</a></span>';
    }
  }
}

// ── 初始化 ──

function initSettings() {
  renderSettings();
  pollEnvironmentCheck();
}

// ── 自动同步设置 ──

async function loadAutoSyncSettings() {
  try {
    var res = await apiFetch('/api/auto-sync/settings');
    var data = await readApiResponse(res);
    var enabledChk = document.getElementById('autoSyncEnabledChk');
    var qualCronInput = document.getElementById('autoSyncQualCronInput');
    var caplibCronInput = document.getElementById('autoSyncCaplibCronInput');
    var qualChk = document.getElementById('autoSyncQualEnabledChk');
    var caplibChk = document.getElementById('autoSyncCaplibEnabledChk');
    if (enabledChk) enabledChk.checked = data.autosyncEnabled;
    if (qualCronInput) qualCronInput.value = data.autosyncQualCron || '0 3 * * 0';
    if (caplibCronInput) caplibCronInput.value = data.autosyncCaplibCron || '0 3 * * *';
    if (qualChk) qualChk.checked = data.autosyncQualEnabled;
    if (caplibChk) caplibChk.checked = data.autosyncCaplibEnabled;
    loadAutoSyncStatus();
  } catch (e) {
    console.error('加载自动同步设置失败:', e);
  }
}

async function loadAutoSyncStatus() {
  var box = document.getElementById('autoSyncStatusBox');
  if (!box) return;
  try {
    var res = await apiFetch('/api/auto-sync/status');
    var data = await readApiResponse(res);
    var status = data.running ? '运行中' : (data.enabled ? '就绪' : '未启用');
    var lastRun = data.lastRunAt ? new Date(data.lastRunAt).toLocaleString() : '—';
    var nextQualRun = data.nextQualRunAt ? new Date(data.nextQualRunAt).toLocaleString() : '—';
    var nextCaplibRun = data.nextCapLibRunAt ? new Date(data.nextCapLibRunAt).toLocaleString() : '—';
    var resultInfo = '';
    if (data.lastRunResult) {
      var r = data.lastRunResult;
      var duration = (r.durationMs / 1000).toFixed(1);
      resultInfo = ' · 上次耗时 ' + duration + 's';
      if (r.error) resultInfo += ' · <span style="color:var(--danger)">' + escapeHtml(r.error) + '</span>';
      // 显示同步摘要
      if (r.qualSummary) {
        var qs = r.qualSummary;
        var qualParts = [];
        if (qs.cnasSuccess > 0) qualParts.push('CNAS ' + qs.cnasSuccess + '个');
        if (qs.cmaSuccess > 0) qualParts.push('CMA ' + qs.cmaSuccess + '个');
        if (qs.failed > 0) qualParts.push('<span style="color:var(--danger)">' + qs.failed + '个失败</span>');
        if (qualParts.length > 0) resultInfo += '<br>资质: ' + qualParts.join(', ');
      }
      if (r.capLibSummary) {
        var cs = r.capLibSummary;
        var capParts = [];
        if (cs.domainsStarted > 0) capParts.push(cs.domainsStarted + '个领域');
        if (cs.errors > 0) capParts.push('<span style="color:var(--danger)">' + cs.errors + '个错误</span>');
        if (capParts.length > 0) resultInfo += '<br>能力库: ' + capParts.join(', ');
      }
    }
    box.innerHTML = '状态: ' + status + ' · 上次运行: ' + lastRun + resultInfo +
      '<br>资质下次: ' + nextQualRun + ' · 能力库下次: ' + nextCaplibRun;
  } catch (e) {
    var errMsg = (e && e.message) || '未知错误';
    box.innerHTML = '<span style="color:var(--danger)">加载失败: ' + escapeHtml(errMsg) + '</span>';
  }
}

async function saveAutoSyncSetting(key, value) {
  var body = {};
  if (key === 'enabled') body.autosyncEnabled = !!value;
  else if (key === 'qualEnabled') body.autosyncQualEnabled = !!value;
  else if (key === 'caplibEnabled') body.autosyncCaplibEnabled = !!value;
  try {
    var res = await apiFetch('/api/auto-sync/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    await readApiResponse(res);
    showToast('设置已保存');
    loadAutoSyncStatus();
  } catch (e) {
    showToast((e && e.message) || '保存失败', 'fail');
    loadAutoSyncSettings();
  }
}

async function saveAutoSyncCron(type) {
  var inputId = type === 'qual' ? 'autoSyncQualCronInput' : 'autoSyncCaplibCronInput';
  var cronInput = document.getElementById(inputId);
  var saveBtn = cronInput ? cronInput.nextElementSibling : null;
  if (!cronInput) return;
  var cron = cronInput.value.trim();
  if (!cron) { showToast('请输入 cron 表达式', 'fail'); return; }
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = '保存中…'; }
  try {
    var body = type === 'qual' ? { autosyncQualCron: cron } : { autosyncCaplibCron: cron };
    var res = await apiFetch('/api/auto-sync/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    await readApiResponse(res);
    showToast((type === 'qual' ? '资质同步' : '能力库同步') + ' Cron 已保存');
    loadAutoSyncStatus();
  } catch (e) {
    showToast((e && e.message) || '保存失败', 'fail');
  } finally {
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '保存'; }
  }
}

async function triggerAutoSync() {
  var btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('立即执行'));
  if (btn) { btn.disabled = true; btn.textContent = '执行中…'; }
  try {
    showToast('正在执行同步…');
    var res = await apiFetch('/api/auto-sync/trigger', { method: 'POST' });
    var data = await readApiResponse(res);
    if (data.error) {
      showToast(data.error, 'fail');
    } else {
      showToast('同步已启动');
    }
    loadAutoSyncStatus();
  } catch (e) {
    showToast((e && e.message) || '触发失败', 'fail');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '立即执行'; }
  }
}

// 暴露到全局
window.renderSettings = renderSettings;
window.initSettings = initSettings;
window.settingsNavTo = settingsNavTo;
window.checkAllSources = checkAllSources;
window.checkSingleSource = checkSingleSource;
window.showDiagnostics = showDiagnostics;
window.loadLibrarySettings = loadLibrarySettings;
window.rescanLibrary = rescanLibrary;
window.saveLibraryDir = saveLibraryDir;
window.saveLibraryWatcherEnabled = saveLibraryWatcherEnabled;
window.saveDownloadPreferLocal = saveDownloadPreferLocal;
window.toggleDownloadSource = toggleDownloadSource;
window.setConcurrency = setConcurrency;
window.setTimeoutVal = setTimeoutVal;
window.setHistoryLimit = setHistoryLimit;
window.getHistoryLimit = getHistoryLimit;
window.loadAboutSection = loadAboutSection;
window.saveAutoSyncSetting = saveAutoSyncSetting;
window.saveAutoSyncCron = saveAutoSyncCron;
window.triggerAutoSync = triggerAutoSync;
window.loadAutoSyncSettings = loadAutoSyncSettings;
window.loadAutoSyncStatus = loadAutoSyncStatus;

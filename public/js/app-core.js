const API = '';

function escapeHtml(value) { const element = document.createElement('div'); element.textContent = String(value ?? ''); return element.innerHTML; }
function beijingDate() { const d = new Date(new Date().getTime() + 8*3600000); return d.toISOString().slice(0, 10); }

// ── API client ──
// All server JSON responses are { data, error } envelopes (see src/shared/response.ts).
// apiRequest unwraps that envelope: on success returns data; on { error } throws an
// Error with .code and .details attached. Non-JSON (HTML, network errors) raise a
// generic NETWORK_ERROR.
async function apiRequest(path, init) {
  let res;
  try {
    res = await fetch(API + path, init);
  } catch (e) {
    const err = new Error(e && e.message ? e.message : '网络错误');
    err.code = 'NETWORK_ERROR';
    throw err;
  }
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON response */ }
  if (body && typeof body === 'object' && 'data' in body && 'error' in body) {
    if (body.error) {
      const err = new Error(body.error.message || 'Request failed');
      err.code = body.error.code || 'UNKNOWN';
      err.details = body.error.details;
      err.status = res.status;
      throw err;
    }
    return body.data;
  }
  if (!res.ok) {
    const err = new Error('HTTP ' + res.status);
    err.code = 'HTTP_ERROR';
    err.status = res.status;
    throw err;
  }
  // Body present but not a Result envelope — return as-is (used by streaming endpoints).
  return body;
}

// Convenience wrappers
async function apiGet(path) { return apiRequest(path, { method: 'GET' }); }
async function apiPostJson(path, body) {
  return apiRequest(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
}
async function apiPutJson(path, body) {
  return apiRequest(path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
}
async function apiDelete(path) { return apiRequest(path, { method: 'DELETE' }); }

// Legacy-style helper for code that already does `const res = await fetch(...); const data = await res.json();`.
// Parses body, unwraps Result envelope if present, and on error returns { code, message, details }
// so callers can still check `if (!res.ok) throw new Error(data.message)`.
async function readApiResponse(res) {
  const raw = await res.text();
  if (!raw) return {};
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { return { message: raw }; }
  if (parsed && typeof parsed === 'object' && 'data' in parsed && 'error' in parsed) {
    if (parsed.error) {
      return { code: parsed.error.code, message: parsed.error.message, details: parsed.error.details };
    }
    return parsed.data == null ? {} : parsed.data;
  }
  return parsed;
}

// SSE/streaming event parser: server emits `data: {data,error}` lines.
// Returns { ok: bool, value, error } so the consumer doesn't redo this unwrap.
function parseSseEvent(eventData) {
  let parsed;
  try { parsed = JSON.parse(eventData); }
  catch { return { ok: false, error: { code: 'PARSE_ERROR', message: 'Invalid SSE payload' } }; }
  if (parsed && typeof parsed === 'object' && 'data' in parsed && 'error' in parsed) {
    if (parsed.error) return { ok: false, error: parsed.error };
    return { ok: true, value: parsed.data };
  }
  // Pre-envelope payload — pass through
  return { ok: true, value: parsed };
}

// ── Settings ──
const ALL_SOURCES = ['gbw', 'bz', 'by'];
const DEFAULT_DOWNLOAD_SOURCES = ['gbw', 'bz', 'by'];
const SOURCE_LABELS = { gbw: 'BW', bz: 'BZ', by: 'BY', labr: 'LB' };
function srcLabel(s) { return SOURCE_LABELS[s] || s.toUpperCase(); }
const DEFAULT_CONCURRENCY = 5;

const VALID_CONCURRENCY = [1, 2, 3, 4, 5, 6, 8];
const VALID_TIMEOUTS = [10, 15, 20, 30, 60];

function safeJsonParse(raw, fallback) {
  if (!raw) return fallback;
  try { return JSON.parse(raw); }
  catch { return fallback; }
}

function normalizeSourceArray(value, fallback) {
  const list = Array.isArray(value) ? value : fallback;
  const valid = list.filter(s => ALL_SOURCES.includes(s));
  return valid.length ? [...new Set(valid)] : [...fallback];
}

let downloadSources = normalizeSourceArray(safeJsonParse(localStorage.getItem('bzxz_download_sources'), DEFAULT_DOWNLOAD_SOURCES), DEFAULT_DOWNLOAD_SOURCES);
let downloadConcurrency = (v => VALID_CONCURRENCY.includes(v) ? v : DEFAULT_CONCURRENCY)(parseInt(localStorage.getItem('bzxz_concurrency') || ''));
let downloadPriority = normalizeSourceArray(safeJsonParse(localStorage.getItem('bzxz_priority'), ['gbw', 'by', 'bz']), ['gbw', 'by', 'bz']);
let downloadTimeout = (v => VALID_TIMEOUTS.includes(v) ? v : 15)(parseInt(localStorage.getItem('bzxz_timeout') || ''));
let panelPositions = safeJsonParse(localStorage.getItem('bzxz_panel_positions'), {});
let resultDensity = localStorage.getItem('bzxz_result_density') || 'comfortable';
if (!['comfortable', 'compact'].includes(resultDensity)) resultDensity = 'comfortable';
let savedStandards = safeJsonParse(localStorage.getItem('bzxz_saved_standards'), []);
if (!Array.isArray(savedStandards)) savedStandards = [];

function saveSettings() {
  localStorage.setItem('bzxz_download_sources', JSON.stringify(downloadSources));
  localStorage.setItem('bzxz_concurrency', String(downloadConcurrency));
  localStorage.setItem('bzxz_priority', JSON.stringify(downloadPriority));
  localStorage.setItem('bzxz_timeout', String(downloadTimeout));
}
function savePanelPositions() {
  try { localStorage.setItem('bzxz_panel_positions', JSON.stringify(panelPositions)); }
  catch { /* quota exceeded — non-critical */ }
}

const SEARCH_PREFERENCES_KEY = 'bzxz_search_preferences_v1';

function loadSearchPreferences() {
  const fallback = { searchSources: [...ALL_SOURCES], filterSources: [], statuses: [], onlyDownloadable: false, onlyQualified: false, onlySaved: false, sort: 'smart' };
  const saved = safeJsonParse(localStorage.getItem(SEARCH_PREFERENCES_KEY), fallback);
  const sourceList = normalizeSourceArray(saved?.searchSources, ALL_SOURCES);
  return {
    searchSources: sourceList,
    filterSources: Array.isArray(saved?.filterSources) ? saved.filterSources.filter(source => ALL_SOURCES.includes(source)) : [],
    statuses: Array.isArray(saved?.statuses) ? saved.statuses.filter(status => typeof status === 'string') : [],
    onlyDownloadable: Boolean(saved?.onlyDownloadable),
    onlyQualified: Boolean(saved?.onlyQualified),
    onlySaved: Boolean(saved?.onlySaved),
    sort: ['smart', 'downloadable', 'date', 'sourceCount'].includes(saved?.sort) ? saved.sort : 'smart',
  };
}

const savedSearchPreferences = loadSearchPreferences();

function persistSearchPreferences() {
  try {
    localStorage.setItem(SEARCH_PREFERENCES_KEY, JSON.stringify({
      searchSources: [...selectedSources],
      filterSources: [...filterState.sources],
      statuses: [...filterState.statuses],
      onlyDownloadable: filterState.onlyDownloadable,
      onlyQualified: filterState.onlyQualified,
      onlySaved: filterState.onlySaved,
      sort: filterState.sort,
    }));
  } catch { /* Search preferences are non-critical. */ }
}

function resetSearchPreferences() {
  selectedSources = new Set(ALL_SOURCES);
  filterState.sources.clear();
  filterState.statuses.clear();
  filterState.onlyDownloadable = false;
  filterState.onlyQualified = false;
  filterState.onlySaved = false;
  filterState.sort = 'smart';
  persistSearchPreferences();
  document.querySelectorAll('.source-tag').forEach(tag => tag.classList.toggle('active', selectedSources.has(tag.dataset.source)));
  if (typeof renderFilterBar === 'function') renderFilterBar();
  if (typeof renderResults === 'function') renderResults();
  if (typeof updateToolbar === 'function') updateToolbar();
  if (typeof showToast === 'function') showToast('已恢复默认搜索习惯');
}
window.resetSearchPreferences = resetSearchPreferences;

// ── State ──
let results = [];
let selectedSources = new Set(savedSearchPreferences.searchSources);
let selectedIds = new Set();
let logEntries = [];
let isDownloading = false;
let searchAborted = false;
let activePanelId = null;
let filterState = { sources: new Set(savedSearchPreferences.filterSources), statuses: new Set(savedSearchPreferences.statuses), onlyDownloadable: savedSearchPreferences.onlyDownloadable, onlyQualified: savedSearchPreferences.onlyQualified, onlySaved: savedSearchPreferences.onlySaved, sort: savedSearchPreferences.sort };
let sourceCheckCache = {};
let currentDetailContext = null;

function persistSavedStandards() {
  try { localStorage.setItem('bzxz_saved_standards', JSON.stringify(savedStandards.slice(0, 200))); }
  catch { /* non-critical */ }
}

function standardSaveKey(item) {
  return String(item?.standardNumber || item?.id || '').replace(/\s+/g, '').toUpperCase();
}

function isStandardSaved(item) {
  const key = typeof item === 'string' ? item.replace(/\s+/g, '').toUpperCase() : standardSaveKey(item);
  return Boolean(key && savedStandards.some(s => s.key === key));
}

function serializeSavedMetadata() {
  return savedStandards.filter(item => item.standardNumber).map(item => ({ stdCode: item.standardNumber, group: item.group || '', note: item.note || '', downloaded: Boolean(item.downloaded), fileName: item.fileName || '' }));
}

async function saveSavedMetadata() {
  if (typeof apiFetch !== 'function') return;
  try { await apiFetch('/api/check/saved/meta', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: serializeSavedMetadata() }) }); } catch { /* Retry next sync. */ }
}

function applyServerSavedMetadata(items) {
  const byCode = new Map((items || []).map(item => [standardSaveKey({ standardNumber: item.stdCode }), item]));
  savedStandards.forEach(item => { const meta = byCode.get(item.key); if (meta) Object.assign(item, { group: meta.groupName || '', note: meta.note || '', downloaded: Boolean(meta.downloaded), fileName: meta.fileName || '' }); });
}

function mergeServerSavedCodes(codes) {
  const known = new Set(savedStandards.map(item => item.key));
  for (const code of codes || []) {
    const key = standardSaveKey({ standardNumber: code });
    if (!key || known.has(key)) continue;
    savedStandards.unshift({ key, standardNumber: code, title: '', status: '', sources: [], savedAt: Date.now(), synced: true });
    known.add(key);
  }
  persistSavedStandards();
}

async function syncSavedStandardsAcrossDevices() {
  if (typeof apiFetch !== 'function') return;
  try {
    const remote = await apiFetch('/api/check/saved/codes');
    const remoteKeys = new Set((remote?.codes || []).map(code => standardSaveKey({ standardNumber: code })));
    const pending = savedStandards.filter(item => item.standardNumber && !remoteKeys.has(item.key));
    for (const item of pending) {
      try { await apiFetch('/api/check/saved/toggle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stdCode: item.standardNumber }) }); } catch { /* Leave the local record intact for a later retry. */ }
    }
    const refreshed = await apiFetch('/api/check/saved/codes');
    mergeServerSavedCodes(refreshed?.codes || []);
    const metadata = await apiFetch('/api/check/saved/meta');
    applyServerSavedMetadata(metadata?.items || []);
    await saveSavedMetadata();
    if (typeof renderSavedLibrary === 'function') renderSavedLibrary();
    if (typeof renderResults === 'function' && results.length) { renderResults(); renderFilterBar(); updateToolbar(); }
  } catch { /* Offline or unavailable: local favorites remain usable. */ }
}

function scheduleSavedStandardsSync() {
  const run = () => setTimeout(syncSavedStandardsAcrossDevices, 0);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run, { once: true });
  else run();
}
scheduleSavedStandardsSync();

function setResultDensity(mode) {
  resultDensity = mode === 'compact' ? 'compact' : 'comfortable';
  localStorage.setItem('bzxz_result_density', resultDensity);
  document.body.classList.toggle('compact-results', resultDensity === 'compact');
}

setResultDensity(resultDensity);

// ── Panel management (sidebar/tab layout) ──
let activeDrag = null;

// Per-tab cleanup registry: modules owning background pollers/timers register a stop
// function here so switchTab can call them all before activating a new tab.
window._tabCleanup = window._tabCleanup || {};

function switchTab(tab) {
  // Permission check — 'users' 由 sidebar 显示/隐藏控制；'me' 是手机端入口（每个登录态用户都可用）
  if (currentUser && currentUser.allowedTabs && tab !== 'me') {
    if (currentUser.allowedTabs.indexOf(tab) < 0) return;
  }
  // 懒加载页面样式（首次切换时加载）
  if (!window._pagesCssLoaded) {
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = '/css/components-pages.css?v=20260904-phase12-detail';
    document.head.appendChild(link);
    window._pagesCssLoaded = true;
  }
  for (const fn of Object.values(window._tabCleanup)) {
    try { fn(); } catch (e) { /* ignore individual cleanup failure */ }
  }
  document.querySelectorAll('.page').forEach(function(p) { p.style.display = 'none'; });
  var page = document.getElementById('page-' + tab);
  if (page) page.style.display = 'block';
  document.querySelectorAll('.sidebar-item[data-tab]').forEach(function(item) {
    item.classList.toggle('active', item.dataset.tab === tab);
  });
  var titleEl = document.querySelector('.topbar-title');
  if (titleEl) titleEl.textContent = TAB_LABELS[tab] || '标准检索';
  if (tab === 'logs' && typeof loadBackendLogs === 'function') loadBackendLogs();
  if (tab === 'stats') loadStats();
  if (tab === 'history') renderDownloadHistory();
  if (tab === 'me' && typeof loadMeAlerts === 'function') loadMeAlerts();
  if (tab === 'local') {
    if (typeof refreshFileLibrary === 'function') refreshFileLibrary();
    if (typeof loadLibrarySettings === 'function') {
      try { loadLibrarySettings(); } catch (e) { /* ignore */ }
    }
  }
  if (tab === 'settings') {
    renderSettings();
    // 订阅管理 lives inside 系统设置 now — lazy-load labs + recent sync log
    // when the page is opened so the section isn't empty on first view.
    if (typeof loadQualLabs === 'function') {
      try { loadQualLabs(); } catch (e) { /* ignore */ }
    }
    if (typeof loadLabsSyncLogs === 'function') {
      try { loadLabsSyncLogs(); } catch (e) { /* ignore */ }
    }
  }
  if (tab === 'tools') updateBatchSourceHint();
  // page-qual now only hosts 搜索 + 可视化, no eager load needed.

  // ── 搜索类 tab 初始化 stage（手机端 landing/active 两态切换）──
  // 切到 search/qual 时根据当前结果集决定 stage：
  //   有结果 → active（保留之前 sticky 吸顶布局）
  //   无结果 → idle（搜索框居中聚焦）
  // 切到其它 tab 时不动 stage class（用户回来时仍是离开时的态）。
  if (tab === 'search' || tab === 'qual') {
    try { initSearchStageForTab(tab); } catch (e) { /* helper not yet defined → 忽略 */ }
    // scroll 重置：让"连续使用"时每次切回 tab 都从顶端开始
    if (window.scrollTo) {
      try { window.scrollTo({ top: 0, behavior: 'auto' }); } catch (e) { /* ignore */ }
    }
  }

  // ── URL 路由：写回 ?tab=… 同时保留 ?desktop=1 等其他参数 ──
  try {
    var params = new URLSearchParams(window.location.search);
    if (params.get('tab') !== tab) {
      params.set('tab', tab);
      var qs = params.toString();
      var newUrl = window.location.pathname + (qs ? '?' + qs : '') + window.location.hash;
      window.history.replaceState(null, '', newUrl);
    }
  } catch (e) { /* URLSearchParams 异常忽略 */ }

  // ── 派发 tabchange 事件，供 mobile-tabbar 等订阅者同步 active ──
  try {
    window.dispatchEvent(new CustomEvent('tabchange', { detail: { tab: tab } }));
  } catch (e) { /* CustomEvent 兼容性兜底，IE 不在支持范围 */ }
}

// initRouter 解析 URL 的 ?tab=xxx，缺省走 search。
// ?desktop=1 / layout 切换由 app-mobile.js 的 applyLayoutMode 单独处理，与本函数解耦。
function initRouter() {
  var KNOWN_TABS = ['search', 'tools', 'qual', 'cma-diff', 'labr', 'local', 'history', 'settings', 'stats', 'me'];
  // 向后兼容：旧 tab 名映射到新 tab
  var TAB_ALIAS = { check: 'tools', batch: 'tools', complete: 'tools' };
  var requested = 'search';
  var deepQ = '';
  try {
    var params = new URLSearchParams(window.location.search);
    var t = params.get('tab');
    if (t) t = TAB_ALIAS[t] || t;
    if (t && KNOWN_TABS.indexOf(t) >= 0) requested = t;
    // ?q= 来自 Listary 等外部 deep-link 冷启动（主进程把 bzxz://<tab>?q= 拼进首个
    // loadURL）。切 tab 后预填搜索框并触发搜索。消费后从 URL 抹掉，避免刷新重搜。
    deepQ = (params.get('q') || '').trim();
  } catch (e) { /* ignore */ }
  switchTab(requested);
  if (deepQ) {
    applyDeepLink({ tab: requested, q: deepQ });
    try {
      var p2 = new URLSearchParams(window.location.search);
      p2.delete('q');
      var qs2 = p2.toString();
      window.history.replaceState(null, '', window.location.pathname + (qs2 ? '?' + qs2 : '') + window.location.hash);
    } catch (e) { /* ignore */ }
  }
}

// 把外部 deep-link（Listary）的搜索词落到对应 tab 的输入框并触发搜索。
//   search → #searchInput + doSearch()
//   qual   → #qualSearchInput + doQualSearch()（按关键词模式本就兼吃标准号与关键词）
// 窗口已开时由 window.bzxz.onDeepLink 调用；冷启动由 initRouter 调用。
function applyDeepLink(link) {
  if (!link || !link.q) return;
  var tab = link.tab || 'search';
  // 权限闸：无权访问该 tab 时静默放弃（switchTab 内部也会拦，这里提前避免填框）
  if (currentUser && currentUser.allowedTabs && currentUser.allowedTabs.indexOf(tab) < 0) return;
  switchTab(tab);
  var inputId = tab === 'qual' ? 'qualSearchInput' : 'searchInput';
  var trigger = tab === 'qual' ? doQualSearch : doSearch;
  // 延一帧等 tab DOM 显示（switchTab 切 display），再填值触发。
  setTimeout(function () {
    var input = document.getElementById(inputId);
    if (!input) return;
    input.value = link.q;
    try { if (typeof trigger === 'function') trigger(); } catch (e) { /* ignore */ }
  }, 0);
}

// 浏览器前进/后退时按当前 URL 重新派发到对应 tab。
window.addEventListener('popstate', function() {
  try { initRouter(); } catch (e) { /* ignore */ }
});
function toggleSidebar() { document.body.classList.toggle("sidebar-collapsed"); }

function initPanels() {
  initRouter();
  // 桌面端：订阅主进程转发的 bzxz:// deep-link（窗口已开时的热路径）。
  // 冷启动路径由 initRouter 读 ?q= 处理，二者互不干扰。
  try {
    if (window.bzxz && typeof window.bzxz.onDeepLink === 'function') {
      window.bzxz.onDeepLink(function (link) { applyDeepLink(link); });
    }
  } catch (e) { /* 非 Electron 环境忽略 */ }
}

function togglePanel(name) {
  switchTab(name);
}

function openPanel(name) {
  switchTab(name);
}

function closePanel(name) { /* no-op in tab layout */ }

function minimizePanel(name) { /* no-op in tab layout */ }

function activatePanel(name) {
  switchTab(name || "search");
}

function updatePanelZIndices() { /* no-op in tab layout */ }

// ── Search stage helpers ──
// 手机端搜索类 tab（search/qual）的"居中聚焦 ↔ sticky 置顶"两态切换。
// CSS 在当前生产入口的 public/css/components-pages.css。
//
// 设计:
//  - 触发时机不是输入框 input 事件,而是"用户主动调用搜索 / 搜索结果有内容"
//    这样删字符 / 焦点变化不会抽动布局
//  - 桌面端 / force-desktop 不参与（CSS @media + body:not(.force-desktop) 守住）
//
// 用法：
//   setSearchStage('search', 'active')   主动切 active
//   initSearchStageForTab('search')      切 tab 时按当前数据自动判定
//
// 全局暴露,供 app-search/app-qual 调用
function setSearchStage(tab, stage) {
  var page = document.getElementById('page-' + tab);
  if (!page) return;
  page.classList.remove('search-stage-idle', 'search-stage-active');
  page.classList.add('search-stage-' + stage);
}

function initSearchStageForTab(tab) {
  // 按"DOM 里是否已渲出结果"判定初始 stage
  var hasResults = false;
  if (tab === 'search') {
    var rs = document.getElementById('results');
    hasResults = !!(rs && rs.querySelector('.result-card'));
  } else if (tab === 'qual') {
    var qr = document.getElementById('qualResults');
    hasResults = !!(qr && qr.querySelector('.qual-result-group, .qual-unified-list'));
  }
  setSearchStage(tab, hasResults ? 'active' : 'idle');
}

window.setSearchStage = setSearchStage;
window.initSearchStageForTab = initSearchStageForTab;

// ── Tools tab switcher ──
function switchToolsTab(tab) {
  document.querySelectorAll('#page-tools .cap-lib-tab').forEach(t => {
    const active = t.dataset.toolsTab === tab;
    t.classList.toggle('active', active);
    t.setAttribute('aria-selected', String(active));
  });
  document.querySelectorAll('#page-tools .cap-lib-tab-content').forEach(c => c.style.display = 'none');
  const target = document.getElementById('toolsTab' + tab.charAt(0).toUpperCase() + tab.slice(1));
  if (target) target.style.display = '';
  if (tab === 'batch') updateBatchSourceHint();
}
window.switchToolsTab = switchToolsTab;

function loadMeAlerts() {
  const el = document.getElementById('meAlerts');
  if (!el) return;
  const savedCount = Array.isArray(savedStandards) ? savedStandards.length : 0;
  const summary = `${savedCount} 项收藏正在关注 · 最新状态以标准查新结果为准`;
  el.innerHTML = `<div class="me-alert-row"><i class="me-row-icon ti ti-bell" aria-hidden="true"></i><div class="me-alert-copy"><strong>标准提醒</strong><span>${escapeHtml(summary)}</span></div></div>`;
}

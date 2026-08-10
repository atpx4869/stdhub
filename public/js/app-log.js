// ── Run Log System ──

// ══ 运行日志系统（重做：独立「运行日志」页 #page-logs，取代旧底部 #logPanel）══
// 方案见 docs/LOG-SYSTEM-REDESIGN.md。条目扩字段 module/level/完整时间戳/detail，
// localStorage 持久化（滚动保留），#page-logs 内四维筛选（模块/级别/时间/关键词）+ 详细模式。
// addLog 兼容旧两参调用：addLog(msg, 'success'|'fail'|'pending') 仍可用。
const LOG_STORAGE_KEY = 'bzxz_logs_v1';
const LOG_MAX = 10000;            // 滚动保留上限
const LOG_MAX_AGE_MS = 30 * 864e5; // 30 天
let logIdCounter = 0;
let logRenderScheduled = false;
// 日志页筛选态
let logFilter = { module: 'all', level: 'all', time: 'all', kw: '', verbose: false };

const LOG_MODULES = { search:'标准检索', download:'下载', complete:'标准补全', qual:'资质同步', ocr:'验证码 OCR', local:'本地库', system:'系统' };
const LOG_LEVELS  = { success:'成功', fail:'失败', warn:'警告', info:'信息', pending:'进行中' };

function loadPersistedLogs() {
  try {
    const arr = JSON.parse(localStorage.getItem(LOG_STORAGE_KEY) || '[]');
    if (Array.isArray(arr)) {
      logEntries = arr;
      logIdCounter = arr.reduce((m, l) => Math.max(m, l.id || 0), 0);
    }
  } catch { /* 损坏的存储忽略，从空开始 */ }
}
function persistLogs() {
  try {
    // 滚动裁剪：超量 / 超期都丢弃旧条
    const cutoff = Date.now() - LOG_MAX_AGE_MS;
    if (logEntries.length > LOG_MAX) logEntries = logEntries.slice(0, LOG_MAX);
    logEntries = logEntries.filter(l => !l.tsMs || l.tsMs >= cutoff);
    localStorage.setItem(LOG_STORAGE_KEY, JSON.stringify(logEntries));
  } catch { /* 配额超限等：静默，不打断业务 */ }
}

// 旧两参 status 归一到新 level；module 缺省按文本推断兜底
function normalizeLogStatus(s) { return LOG_LEVELS[s] ? s : 'info'; }
function inferModule(msg) {
  const t = String(msg || '');
  if (/验证码|ocr/i.test(t)) return 'ocr';
  if (/搜索/.test(t)) return 'search';
  if (/下载|批量|切源|未匹配|可用下载源/.test(t)) return 'download';
  if (/补全/.test(t)) return 'tools';
  if (/资质|CNAS|CMA|同步/.test(t)) return 'qual';
  if (/库|扫描|文件/.test(t)) return 'local';
  return 'system';
}

// addLog(msg) | addLog(msg, 'success') | addLog(msg, { module, level, detail, verbose })
function addLog(msg, opt) {
  let module, level, detail, verbose;
  if (typeof opt === 'string') { level = normalizeLogStatus(opt); }
  else if (opt && typeof opt === 'object') { module = opt.module; level = opt.level; detail = opt.detail; verbose = opt.verbose; }
  level = level || 'info';
  module = module || inferModule(msg);
  const d = new Date();
  const tsMs = d.getTime();
  const p = n => String(n).padStart(2, '0');
  const time = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  const date = `${p(d.getMonth()+1)}-${p(d.getDate())}`;
  const id = ++logIdCounter;
  logEntries.unshift({ id, tsMs, time, date, module, level, msg, detail: detail || '', verbose: !!verbose });
  scheduleLogRender();
  return id;
}
function updateLog(id, msg, status) {
  const entry = logEntries.find(l => l.id === id);
  if (entry) {
    entry.msg = msg;
    if (status) entry.level = normalizeLogStatus(status);
    scheduleLogRender();
  }
}
function scheduleLogRender() {
  if (logRenderScheduled) return;
  logRenderScheduled = true;
  requestAnimationFrame(() => { renderLogs(); persistLogs(); logRenderScheduled = false; });
}

// Phase 2：后端运行日志（/api/diagnostics/logs，仅管理员可拉）。映射到前端同一形状。
// 后端 level: error→fail（默认可见）、warn→warn（默认可见）、log→info（标 verbose，仅详细模式）。
let backendLogEntries = [];
let backendLogsLoading = false;
async function loadBackendLogs() {
  if (backendLogsLoading) return;
  backendLogsLoading = true;
  try {
    const res = await fetch('/api/diagnostics/logs?limit=500');
    if (!res.ok) { backendLogEntries = []; return; } // 非管理员 403 等 → 静默只显前端日志
    const data = await readApiResponse(res);
    const items = (data && data.items) || [];
    backendLogEntries = items.map((it, i) => {
      const d = it.ts ? new Date(it.ts) : new Date();
      const tsMs = d.getTime();
      const p = n => String(n).padStart(2, '0');
      const level = it.level === 'error' ? 'fail' : it.level === 'warn' ? 'warn' : 'info';
      return {
        id: 'be_' + i,
        tsMs,
        time: `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`,
        date: `${p(d.getMonth()+1)}-${p(d.getDate())}`,
        module: it.module || 'system',
        level,
        msg: it.message || '',
        detail: '',
        verbose: it.level === 'log',   // 普通 log 归调试档，默认折叠
        source: 'backend',
      };
    });
  } catch { backendLogEntries = []; }
  finally { backendLogsLoading = false; renderLogs(); }
}
// 前端 + 后端合并，按时间倒序（新在上）
function getMergedLogs() {
  return logEntries.concat(backendLogEntries).sort((a, b) => (b.tsMs || 0) - (a.tsMs || 0));
}

function renderLogs() {
  const all = getMergedLogs();
  // 概览（始终基于全集，反映"目前累计"）
  const ok = all.filter(l => l.level === 'success').length;
  const bad = all.filter(l => l.level === 'fail').length;
  const warn = all.filter(l => l.level === 'warn').length;
  setText('logStatTotal', all.length);
  setText('logStatOk', ok);
  setText('logStatBad', bad);
  setText('logStatWarn', warn);
  // 侧栏失败角标
  const badge = document.getElementById('logNavBadge');
  if (badge) { badge.textContent = bad; badge.style.display = bad ? '' : 'none'; }

  // 今日概览条
  const todayStart = new Date(); todayStart.setHours(0,0,0,0);
  const todayMs = todayStart.getTime();
  const todayLogs = all.filter(l => l.tsMs && l.tsMs >= todayMs);
  const todayOk = todayLogs.filter(l => l.level === 'success').length;
  const todayBad = todayLogs.filter(l => l.level === 'fail').length;
  const todayTotal = todayLogs.length;
  const todayRate = todayTotal > 0 ? Math.round((todayTotal - todayBad) / todayTotal * 100) : 100;
  const bannerEl = document.getElementById('logTodayBanner');
  if (bannerEl) {
    bannerEl.innerHTML = `<span class="log-banner-item">今日 <strong>${todayTotal}</strong> 条</span>` +
      `<span class="log-banner-item log-banner-ok">成功 ${todayOk}</span>` +
      `<span class="log-banner-item log-banner-fail">失败 ${todayBad}</span>` +
      `<span class="log-banner-item">成功率 <strong>${todayRate}%</strong></span>`;
  }

  // 错误聚合
  const errors = all.filter(l => l.level === 'fail');
  const errAgg = {};
  for (const e of errors) {
    const key = e.msg || '(unknown)';
    if (!errAgg[key]) errAgg[key] = { msg: key, count: 0, lastTime: '' };
    errAgg[key].count++;
    if (!errAgg[key].lastTime || (e.time > errAgg[key].lastTime)) errAgg[key].lastTime = e.time;
  }
  const errSorted = Object.values(errAgg).sort((a, b) => b.count - a.count).slice(0, 10);
  const errAggEl = document.getElementById('logErrorAgg');
  const errAggBody = document.getElementById('logErrorAggBody');
  if (errAggEl && errAggBody) {
    if (errSorted.length) {
      errAggEl.style.display = '';
      errAggBody.innerHTML = errSorted.map(e =>
        `<div class="log-agg-row"><span class="log-agg-msg">${escapeHtml(e.msg.length > 60 ? e.msg.slice(0, 60) + '…' : e.msg)}</span><span class="log-agg-cnt">${e.count} 次</span><span class="log-agg-time">${e.lastTime}</span></div>`
      ).join('');
    } else {
      errAggEl.style.display = 'none';
    }
  }

  // 模块计数（基于"详细模式"决定的 base）
  const base = all.filter(l => logFilter.verbose || !l.verbose);
  setText('logCntAll', base.length);
  for (const k of Object.keys(LOG_MODULES)) setText('logCnt_' + k, base.filter(l => l.module === k).length);

  const body = document.getElementById('logBody');
  if (!body) return;

  const kw = (logFilter.kw || '').trim().toLowerCase();
  const rows = base.filter(l => {
    // 快捷筛选
    if (logQuickFilter === 'errors' && l.level !== 'fail') return false;
    if (logQuickFilter === 'today') {
      const todayStart = new Date(); todayStart.setHours(0,0,0,0);
      if (!l.tsMs || l.tsMs < todayStart.getTime()) return false;
    }
    if (logQuickFilter === 'download' && l.module !== 'download') return false;
    // 标准筛选
    return (logFilter.module === 'all' || l.module === logFilter.module) &&
      (logFilter.level === 'all' || l.level === logFilter.level) &&
      passLogTime(l) &&
      (!kw || (l.msg + ' ' + (l.detail || '')).toLowerCase().includes(kw));
  });
  body.innerHTML = rows.length ? rows.map(l => {
    const full = l.msg + (l.detail ? '\n' + l.detail : '');
    const expandable = /[\n\r]/.test(full) || full.length > 80;
    const open = logExpanded.has(String(l.id));
    const srcBadge = l.source === 'backend' ? '<span class="log-src-badge">后端</span>' : '';
    return `<div class="log-row lv-${l.level}${l.verbose ? ' is-verbose' : ''}${expandable ? ' is-expandable' : ''}${open ? ' is-open' : ''}"${expandable ? ` data-log-id="${l.id}"` : ''}>
      <span class="log-time">${l.time}<small>${l.date}</small></span>
      <span class="log-mod"><span class="log-dot mod-${l.module}"></span>${LOG_MODULES[l.module] || l.module}</span>
      <span class="log-msg">${expandable ? '<span class="log-caret">▸</span>' : ''}${srcBadge}${highlightText(l.msg, kw)}${l.detail ? ` <span class="log-det">· ${highlightText(l.detail, kw)}</span>` : ''}</span>
      <span class="log-lv lv-${l.level}">${LOG_LEVELS[l.level] || l.level}</span>
      ${expandable && open ? `<pre class="log-full">${escapeHtml(full)}</pre>` : ''}
    </div>`;
  }).join('') : `<div class="log-empty">没有符合条件的日志</div>`;
  setText('logFootCount', `显示 ${rows.length} / ${base.length} 条${logFilter.verbose ? '（含调试）' : ''}`);
}
// 点击可展开行 → 切换完整正文（堆栈/长文）。事件委托，绑一次。
let logExpanded = new Set();
function initLogExpandDelegation() {
  const body = document.getElementById('logBody');
  if (!body || body._expandBound) return;
  body._expandBound = true;
  body.addEventListener('click', e => {
    const row = e.target.closest('.log-row.is-expandable');
    if (!row || !row.dataset.logId) return;
    const id = row.dataset.logId;
    // id 可能是数字（前端）或 'be_n'（后端），统一按字符串比对
    if (logExpanded.has(id)) logExpanded.delete(id); else logExpanded.add(id);
    renderLogs();
  });
}
function passLogTime(l) {
  if (logFilter.time === 'all') return true;
  if (!l.tsMs) return true;
  if (logFilter.time === 'today') { const c = new Date(); c.setHours(0,0,0,0); return l.tsMs >= c.getTime(); }
  if (logFilter.time === '7d') return l.tsMs >= Date.now() - 7*864e5;
  return true;
}
function setText(id, v) { const el = document.getElementById(id); if (el) el.textContent = v; }

// 日志页交互入口（HTML onclick 调用）
function setLogModule(b, mod) { logFilter.module = mod; logSelectChip('logModList', b); renderLogs(); }
function setLogLevel(b, lv) { logFilter.level = lv; logSelectChip('logLvList', b); renderLogs(); }
function setLogTime(b, t) { logFilter.time = t; logSelectChip('logTimeSeg', b); renderLogs(); }
function onLogSearch(v) { logFilter.kw = v; renderLogs(); }
function onLogVerbose(checked) { logFilter.verbose = !!checked; renderLogs(); }
function logSelectChip(listId, b) {
  const list = document.getElementById(listId);
  if (list) [...list.children].forEach(x => x.classList.toggle('active', x === b));
}

// ── 快捷筛选 ──
let logQuickFilter = 'all';
function setLogQuick(mode) {
  logQuickFilter = mode;
  const chips = document.querySelectorAll('#logQuickFilters .log-qf-chip:not(.log-qf-auto)');
  chips.forEach(c => c.classList.remove('active'));
  const idx = { all: 0, errors: 1, today: 2, download: 3 }[mode];
  if (idx !== undefined && chips[idx]) chips[idx].classList.add('active');
  // 重置标准筛选器以避免冲突
  logFilter.module = 'all';
  logFilter.level = 'all';
  logFilter.time = 'all';
  logFilter.kw = '';
  document.getElementById('logKw').value = '';
  logSelectChip('logModList', document.querySelector('#logModList .log-chip'));
  logSelectChip('logLvList', document.querySelector('#logLvList .log-chip'));
  logSelectChip('logTimeSeg', document.querySelector('#logTimeSeg button'));
  renderLogs();
}

// ── 自动刷新 ──
let logAutoRefresh = false;
let logAutoRefreshTimer = null;
function stopLogAutoRefresh() {
  if (logAutoRefreshTimer) clearInterval(logAutoRefreshTimer);
  logAutoRefreshTimer = null;
  logAutoRefresh = false;
  const btn = document.getElementById('logAutoRefreshBtn');
  if (btn) btn.classList.remove('active');
}
(window._tabCleanup = window._tabCleanup || {}).logAutoRefresh = stopLogAutoRefresh;

function toggleLogAutoRefresh() {
  if (logAutoRefresh) {
    stopLogAutoRefresh();
    return;
  }
  stopLogAutoRefresh();
  logAutoRefresh = true;
  const btn = document.getElementById('logAutoRefreshBtn');
  if (btn) btn.classList.add('active');
  logAutoRefreshTimer = setInterval(() => { loadBackendLogs(); }, 30000);
}

// ── 搜索高亮 ──
function highlightText(text, kw) {
  if (!kw) return escapeHtml(text);
  const safe = escapeHtml(text);
  const escaped = escapeHtml(kw);
  return safe.replace(new RegExp(escaped.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), m => `<mark>${m}</mark>`);
}
async function clearLogs() {
  // 只清前端本地日志；后端 log-buffer 是服务进程内的环形缓冲，不归这里清（重启服务才滚动覆盖）。
  if (!await showConfirm({ title: '清空日志', body: `确定清空 ${logEntries.length} 条本地（前端）运行日志？后端运行日志不受影响。此操作不可恢复。`, danger: true, confirmText: '清空' })) return;
  logEntries = [];
  persistLogs();
  renderLogs();
  showToast('本地日志已清空');
}

function exportLogs() {
  const all = getMergedLogs();
  // 应用当前筛选条件
  const kw = (logFilter.kw || '').trim().toLowerCase();
  const filtered = all.filter(l => {
    if (logQuickFilter === 'errors' && l.level !== 'fail') return false;
    if (logQuickFilter === 'today') {
      const todayStart = new Date(); todayStart.setHours(0,0,0,0);
      if (!l.tsMs || l.tsMs < todayStart.getTime()) return false;
    }
    if (logQuickFilter === 'download' && l.module !== 'download') return false;
    return (logFilter.module === 'all' || l.module === logFilter.module) &&
      (logFilter.level === 'all' || l.level === logFilter.level) &&
      passLogTime(l) &&
      (!kw || (l.msg + ' ' + (l.detail || '')).toLowerCase().includes(kw));
  });
  if (!filtered.length) { showToast('当前筛选条件下无日志可导出', 'fail'); return; }
  const rows = [['日期', '时间', '模块', '级别', '来源', '消息', '详情']];
  filtered.slice().reverse().forEach(l => rows.push([l.date||'', l.time||'', LOG_MODULES[l.module]||l.module||'', LOG_LEVELS[l.level]||l.level||'', l.source==='backend'?'后端':'前端', l.msg||'', l.detail||'']));
  const csv = rows.map(r => r.map(c => `"${String(c || '').replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `运行日志_${beijingDate()}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
  showToast(`已导出 ${filtered.length} 条日志`);
}

// 启动：恢复持久化日志 + 首屏渲染 + 绑定展开委托
loadPersistedLogs();
requestAnimationFrame(() => { try { renderLogs(); initLogExpandDelegation(); } catch { /* 页面未挂载忽略 */ } });

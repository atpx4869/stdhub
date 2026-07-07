// ── Detail modal ──
function sourceCheckKey(standardNumber) {
  return String(standardNumber || '').replace(/[^A-Z0-9]/gi, '').toUpperCase();
}

function relativeCheckTime(ts) {
  if (!ts) return '';
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (seconds < 5) return '刚刚检测';
  if (seconds < 60) return `${seconds}秒前`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.round(minutes / 60);
  return `${hours}小时前`;
}

function mergeSourceCheckResults(standardNumber, checkedResults) {
  const key = sourceCheckKey(standardNumber);
  if (!key) return;
  const checkedAt = Date.now();
  const enrichedResults = {};
  for (const [source, info] of Object.entries(checkedResults)) {
    enrichedResults[source] = { ...info, checkedAt };
  }
  sourceCheckCache[key] = { ...(sourceCheckCache[key] || {}), ...enrichedResults };
  const result = results.find(r => sourceCheckKey(r.standardNumber) === key);
  if (!result) return;
  result._sourceIds = result._sourceIds || {};
  result._previewAvailableBySource = result._previewAvailableBySource || {};
  result.sources = result.sources || [result._source || result.source].filter(Boolean);
  for (const [source, info] of Object.entries(enrichedResults)) {
    if (info.id) {
      result._sourceIds[source] = info.id;
      if (!result.sources.includes(source)) {
        result.sources.push(source);
        result._multiSource = result.sources.join('+');
      }
    }
    if (info.status === 'text') result._previewAvailableBySource[source] = true;
    if (info.status === 'no_text') result._previewAvailableBySource[source] = false;
  }
  result.previewAvailable = Object.values(result._previewAvailableBySource).some(Boolean);
}

function refreshModalSourcePanel() {
  if (!currentDetailContext) return;
  const panel = document.getElementById('modalSourcePanel');
  if (panel) panel.outerHTML = renderSourceDownloadPanel(currentDetailContext.id, currentDetailContext.detail);
}

async function checkModalSources(source, btn) {
  if (!currentDetailContext) return;
  const detail = currentDetailContext.detail;
  const result = findResultByAnyId(currentDetailContext.id);
  const standardNumber = detail.standardNumber || result?.standardNumber;
  if (!standardNumber) {
    showToast('来源检测失败: 缺少标准号', 'fail');
    return;
  }
  const sources = source ? [source] : ALL_SOURCES;
  const key = sourceCheckKey(standardNumber);
  const pending = {};
  sources.forEach(s => { pending[s] = { status: 'checking' }; });
  sourceCheckCache[key] = { ...(sourceCheckCache[key] || {}), ...pending };
  refreshModalSourcePanel();
  if (btn) btn.disabled = true;
  try {
    const res = await fetch(`${API}/api/standards/source-check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ standardNumber, sources }),
    });
    const data = await readApiResponse(res);
    if (!res.ok) throw new Error(data.message || `HTTP${res.status}`);
    mergeSourceCheckResults(standardNumber, data.results || {});
    refreshModalSourcePanel();
    showToast(source ? `${srcLabel(source)} 检测完成` : '来源检测完成');
  } catch (e) {
    const failed = {};
    sources.forEach(s => { failed[s] = { status: 'error', message: (e && e.message) || '检测失败', checkedAt: Date.now() }; });
    sourceCheckCache[key] = { ...(sourceCheckCache[key] || {}), ...failed };
    refreshModalSourcePanel();
    showToast(`来源检测失败: ${(e && e.message) || '未知错误'}`, 'fail');
  }
}

function renderSourceDownloadPanel(id, detail) {
  const result = findResultByAnyId(id);
  const sourceIds = { ...(result?._sourceIds || {}) };
  const detailSource = detail?._source || detail?.source || sourceFromStandardId(detail?.id || id);
  if (detailSource && detail?.id) sourceIds[detailSource] = detail.id;
  const previewBySource = { ...(result?._previewAvailableBySource || {}) };
  if (detailSource && typeof detail?.previewAvailable === 'boolean') previewBySource[detailSource] = detail.previewAvailable;
  const checked = sourceCheckCache[sourceCheckKey(detail?.standardNumber || result?.standardNumber)] || {};
  Object.entries(checked).forEach(([source, info]) => {
    if (info.id) sourceIds[source] = info.id;
    if (info.status === 'text') previewBySource[source] = true;
    if (info.status === 'no_text') previewBySource[source] = false;
  });
  const orderedSources = [...downloadPriority, ...ALL_SOURCES.filter(s => !downloadPriority.includes(s))];
  const defaultId = result?.id || id;
  const defaultPath = downloadPriority.filter(s => downloadSources.includes(s)).map(s => srcLabel(s)).join(' → ') || '未启用';
  const sourceStats = { text: 0, noText: 0, missing: 0, error: 0, unknown: 0 };
  const rows = orderedSources.map(source => {
    const check = checked[source];
    const matched = Boolean(sourceIds[source]);
    const previewKnown = previewBySource[source];
    const isChecking = check?.status === 'checking';
    const statusText = isChecking ? '检测中' :
      check?.status === 'not_found' ? '未匹配' :
      check?.status === 'error' ? '检测失败' :
      previewKnown === true ? '有文本' :
      previewKnown === false ? '无文本' :
      matched ? '未确认' : '未检测';
    if (previewKnown === true) sourceStats.text++;
    else if (previewKnown === false) sourceStats.noText++;
    else if (check?.status === 'not_found') sourceStats.missing++;
    else if (check?.status === 'error') sourceStats.error++;
    else sourceStats.unknown++;
    const statusClass = previewKnown === true ? 'ok' : check?.status === 'error' ? 'bad' : (matched || isChecking) ? 'warn' : 'muted';
    const note = source === 'gbw' ? '自动验证码' : source === 'by' ? '直链PDF' : '合成PDF';
    const timeText = relativeCheckTime(check?.checkedAt);
    const extraText = check?.status === 'error' && check.message ? check.message : timeText;
    const canDownload = matched && !isChecking && check?.status !== 'error' && previewKnown !== false;
    const canCheck = !isChecking;
    const downloadText = previewKnown === true ? '下载' : matched ? '尝试下载' : '下载';
    return `
      <div class="modal-source-row ${matched ? '' : 'disabled'} ${isChecking ? 'checking' : ''}">
        <div class="modal-source-main">
          <span class="source-badge source-${escapeHtml(source)}">${escapeHtml(srcLabel(source))}</span>
          <span class="modal-source-note" title="${escapeHtml(extraText || note)}">${note}</span>
        </div>
        <span class="modal-source-note extra" title="${escapeHtml(extraText || '')}">${extraText ? escapeHtml(extraText) : '—'}</span>
        <span class="modal-source-status ${statusClass}">${statusText}</span>
        <div class="modal-source-actions">
          <button class="btn btn-sm btn-ghost" data-action="modal-source-check" data-source="${escapeHtml(source)}" ${canCheck ? '' : 'disabled'}>${isChecking ? '检测中' : '检测'}</button>
          <button class="btn btn-sm ${canDownload ? 'btn-primary' : 'btn-ghost'}" data-action="modal-source-download" data-id="${escapeHtml(defaultId)}" data-source="${escapeHtml(source)}" ${canDownload ? '' : 'disabled'}>${downloadText}</button>
        </div>
      </div>`;
  }).join('');
  return `
    <div class="modal-source-panel" id="modalSourcePanel">
      <div class="modal-source-title-row">
        <div>
          <div class="modal-source-title">来源下载</div>
          <div class="modal-source-subtitle">检测后可按指定来源下载，也可继续使用默认策略。</div>
        </div>
        <div class="modal-source-stats">
          <span class="ok">${sourceStats.text} 有文本</span>
          <span class="${sourceStats.noText ? 'bad' : ''}">${sourceStats.noText} 无文本</span>
          <span>${sourceStats.unknown + sourceStats.missing} 未确认</span>
        </div>
      </div>
      <div class="modal-source-default">
        <div>
          <strong>默认下载</strong>
          <span>${escapeHtml(defaultPath)}</span>
        </div>
        <div class="modal-source-actions">
          <button class="btn btn-sm btn-ghost" data-action="modal-source-check-all">检测全部来源</button>
          <button class="btn btn-sm btn-primary" data-action="modal-download" data-id="${escapeHtml(defaultId)}">按默认策略下载</button>
        </div>
      </div>
      <div class="modal-source-table-head"><span>来源</span><span>最近信息</span><span>状态</span><span>操作</span></div>
      <div class="modal-source-list">${rows}</div>
    </div>`;
}

function detailInfoItem(label, value, options = {}) {
  if (!value) return '';
  const content = options.html ? value : escapeHtml(value);
  return `<div class="detail-info-item">
    <div class="detail-info-label">${escapeHtml(label)}</div>
    <div class="detail-info-value">${content}</div>
  </div>`;
}

function renderDetailModal(id, detail) {
  const result = findResultByAnyId(id);
  const sources = (result?.sources || detail.moreInfo?.sources || detail.sources || [detail._source || detail.source]).filter(Boolean);
  const srcBadges = sources.map(s => `<span class="source-badge source-${escapeHtml(String(s))}">${escapeHtml(srcLabel(String(s)))}</span>`).join(' ');
  const status = detail.status || result?.status || '';
  const detailType = detail.standardType || result?.standardType || '';
  const publishDate = detail.publishDate || result?.publishDate || '';
  const implementDate = detail.implementDate || result?.implementDate || '';
  const infoItems = [
    detailInfoItem('标准名称', detail.title || result?.title),
    detailInfoItem('英文名', detail.contentText || detail.moreInfo?.enName),
    detailInfoItem('标准类型', detailType),
    detailInfoItem('发布日期', publishDate),
    detailInfoItem('实施日期', implementDate),
    detailInfoItem('来源', srcBadges, { html: true }),
    detailInfoItem('来源ID', detail.sourceId),
  ].join('');
  const statusBadge = status ? `<span class="status-indicator ${statusClass(status)}"><span class="dot"></span>${escapeHtml(status)}</span>` : '';
  return `
    <div class="detail-panel">
      <div class="detail-hero">
        <div class="detail-kicker">标准详情</div>
        <div class="detail-title-row">
          <h3>${escapeHtml(detail.standardNumber || result?.standardNumber || '—')}</h3>
          <button class="btn btn-ghost btn-sm" data-action="modal-copy-standard" data-standard="${escapeHtml(detail.standardNumber || result?.standardNumber || '')}">复制</button>
        </div>
        <p class="detail-title">${escapeHtml(detail.title || result?.title || '—')}</p>
        <div class="detail-chips">
          ${statusBadge}
          ${detailType ? `<span class="detail-chip">${escapeHtml(detailType)}</span>` : ''}
          ${publishDate ? `<span class="detail-chip">发布 ${escapeHtml(publishDate)}</span>` : ''}
          ${implementDate ? `<span class="detail-chip">实施 ${escapeHtml(implementDate)}</span>` : ''}
        </div>
      </div>
      <div class="detail-grid">
        <section class="detail-info-card">
          <div class="detail-section-title">基础信息</div>
          <div class="detail-info-grid">${infoItems || '<div class="detail-empty">暂无更多字段</div>'}</div>
        </section>
        ${renderSourceDownloadPanel(id, detail)}
      </div>
      <div class="detail-actions">
        <button class="btn btn-ghost btn-sm" data-action="modal-close">关闭</button>
      </div>
    </div>`;
}

async function showDetail(id) {
  try {
    const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 10000);
    const res = await fetch(`${API}/api/standards/${encodeURIComponent(id)}`, { signal: ctrl.signal });
    clearTimeout(timer); const d = await readApiResponse(res);
    currentDetailContext = { id, detail: d };
    document.getElementById('modalBody').innerHTML = renderDetailModal(id, d);
    document.getElementById('modalOverlay').classList.add('open');
  } catch (e) {
    currentDetailContext = null;
    document.getElementById('modalBody').innerHTML = `<p style="color:var(--danger)">获取详情失败: ${escapeHtml(e.message)}</p>`;
    document.getElementById('modalOverlay').classList.add('open');
    addLog(`获取详情失败: ${e.message}`, 'fail');
  }
}
document.getElementById('modalClose').addEventListener('click', () => document.getElementById('modalOverlay').classList.remove('open'));
document.getElementById('modalOverlay').addEventListener('click', e => {
  const btn = e.target.closest('[data-action]');
  if (btn) {
    if (btn.dataset.action === 'modal-download') downloadOne(btn.dataset.id);
    else if (btn.dataset.action === 'modal-source-download') downloadSpecificSource(btn.dataset.id, btn.dataset.source, btn);
    else if (btn.dataset.action === 'modal-source-check') checkModalSources(btn.dataset.source, btn);
    else if (btn.dataset.action === 'modal-source-check-all') checkModalSources('', btn);
    else if (btn.dataset.action === 'modal-retry-batch-failed') retryFailedBatchDownload();
    else if (btn.dataset.action === 'modal-copy-standard') { navigator.clipboard.writeText(btn.dataset.standard || ''); showToast('已复制标准号'); }
    else if (btn.dataset.action === 'modal-close') document.getElementById('modalOverlay').classList.remove('open');
  }
  if (e.target === document.getElementById('modalOverlay')) document.getElementById('modalOverlay').classList.remove('open');
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') document.getElementById('modalOverlay').classList.remove('open'); });

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
function toggleLogAutoRefresh() {
  logAutoRefresh = !logAutoRefresh;
  const btn = document.getElementById('logAutoRefreshBtn');
  if (btn) btn.classList.toggle('active', logAutoRefresh);
  if (logAutoRefresh) {
    logAutoRefreshTimer = setInterval(() => { loadBackendLogs(); }, 30000);
  } else {
    clearInterval(logAutoRefreshTimer);
    logAutoRefreshTimer = null;
  }
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

// ── Utils ──
function escapeHtml(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}
function triggerDownload(fileName) {
  // Electron 桌面端：后端已经把文件 fs.rename 到了 standards 库里
  // (moveDownloadToLibrary → addFileToLibrary)。这里再触发浏览器下载流
  // 会让 main.ts 的 will-download 钩子把同一份文件**额外**保存到
  // settings.downloadPath（默认 Desktop/bzxz），造成两份副本占双倍磁盘 +
  // 用户困惑"到底哪份是我的"。库里那份才是单一真相源，直接短路。
  // Web 浏览器访问（手机 / 局域网）仍然需要真正的 HTTP 下载流，才会把文件
  // 落到用户自己设备 —— 所以只在 Electron 上下文里跳过。
  if (window.bzxz && window.bzxz.isElectron) return;
  const a = document.createElement('a');
  a.href = `${API}/api/downloads/${encodeURIComponent(fileName)}`;
  a.download = fileName; a.style.display = 'none';
  document.body.appendChild(a); a.click();
  setTimeout(() => document.body.removeChild(a), 1000);
}
function recordDownload(source, fileName, standardNumber) {
  const now = new Date(new Date().getTime() + 8*3600000);
  const time = `${now.getUTCMonth()+1}/${now.getUTCDate()} ${String(now.getUTCHours()).padStart(2,'0')}:${String(now.getUTCMinutes()).padStart(2,'0')}`;
  addDownloadHistory({ source, fileName, standardNumber: standardNumber || fileName, name: fileName, time });
  const key = String(standardNumber || '').replace(/\s+/g, '').toUpperCase();
  const saved = savedStandards.find(s => s.key === key);
  if (saved) {
    saved.downloaded = true;
    saved.fileName = fileName;
    saved.source = source;
    saved.downloadedAt = Date.now();
    persistSavedStandards();
  }
}

// （旧 exportLogs 已移除——重做版在上方运行日志系统段，用 module/level/detail 字段）

// ── Search history ──
const SEARCH_HISTORY_KEY = 'bzxz_search_history';
function loadSearchHistory() {
  try { return JSON.parse(localStorage.getItem(SEARCH_HISTORY_KEY) || '[]'); } catch { return []; }
}
function saveSearchHistory(query) {
  let hist = loadSearchHistory();
  hist = hist.filter(h => h !== query);
  hist.unshift(query);
  const limit = getHistoryLimit(); if (hist.length > limit) hist = hist.slice(0, limit);
  localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(hist));
}
function getHistoryLimit() {
  try { return parseInt(localStorage.getItem('bzxz_history_limit') || '10', 10) || 10; } catch { return 10; }
}
function setHistoryLimit(n) {
  localStorage.setItem('bzxz_history_limit', String(n));
  renderSettings();
}
function renderSearchHistory() {
  const el = document.getElementById('searchHistory');
  const hist = loadSearchHistory().slice(0, getHistoryLimit());
  if (!hist.length) {
    el.innerHTML = '<div class="search-history-empty">暂无搜索记录</div>';
  } else {
    el.innerHTML = hist.map(q => `<div class="search-history-item" data-query="${escapeHtml(q)}"><span class="hist-icon">🕐</span><span class="hist-query">${escapeHtml(q)}</span></div>`).join('');
  }
  el.classList.add('open');
}
function hideSearchHistory() { document.getElementById('searchHistory').classList.remove('open'); }

document.getElementById('searchInput').addEventListener('focus', () => {
  if (!document.getElementById('searchInput').value) renderSearchHistory();
});
document.getElementById('searchInput').addEventListener('blur', () => {
  setTimeout(hideSearchHistory, 150);
});
document.getElementById('searchHistory').addEventListener('click', e => {
  const item = e.target.closest('.search-history-item');
  if (!item) return;
  document.getElementById('searchInput').value = item.dataset.query;
  hideSearchHistory();
  doSearch();
});

// ── Download history ──
const DL_HISTORY_KEY = 'bzxz_dl_history';
let fileLibraryItems = [];
let fileLibraryTotal = 0;
let fileLibraryLibraryTotal = 0;
let fileLibraryLimit = 200;
let fileLibraryOffset = 0;
let fileLibrarySearchTimer = 0;
let fileLibraryLoading = false;
let fileLibraryAppending = false;
let fileLibraryRequestSeq = 0;
let fileLibrarySelectedIds = new Set();
function loadDownloadHistory() {
  try { return JSON.parse(localStorage.getItem(DL_HISTORY_KEY) || '[]'); } catch { return []; }
}
function addDownloadHistory(entry) {
  const hist = loadDownloadHistory();
  hist.unshift(entry);
  if (hist.length > 100) hist.length = 100;
  localStorage.setItem(DL_HISTORY_KEY, JSON.stringify(hist));
}
function clearDownloadHistory() {
  localStorage.removeItem(DL_HISTORY_KEY);
  renderDownloadHistory();
  showToast('历史已清空');
}
function renderDownloadHistory() {
  renderSavedLibrary();
  const hist = loadDownloadHistory();
  const el = document.getElementById('historyList');
  if (!hist.length) { el.innerHTML = '<div style="color:var(--text-3);text-align:center;padding:32px">暂无下载记录</div>'; return; }
  el.innerHTML = hist.map(h => `<div style="display:flex;align-items:center;gap:10px;padding:8px 12px;border-bottom:1px solid var(--border)">
    <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeHtml(h.name || h.standardNumber)}">${escapeHtml(h.name || h.standardNumber)}</span>
    <span style="color:var(--text-3);font-size:11px">${escapeHtml(h.source || '')}</span>
    <span style="color:var(--text-3);font-size:11px">${escapeHtml(h.time || '')}</span>
    ${h.fileName ? `<button class="btn btn-ghost btn-sm" style="padding:2px 8px;font-size:11px" onclick="triggerDownload('${escapeHtml(h.fileName)}')">重下</button>` : ''}
  </div>`).join('');
}

function renderSavedLibrary() {
  const list = document.getElementById('savedLibraryList');
  const count = document.getElementById('savedLibraryCount');
  if (!list || !count) return;
  count.textContent = String(savedStandards.length);
  if (!savedStandards.length) {
    list.innerHTML = '<div class="library-empty">搜索结果里点“收藏”，常用标准会出现在这里。</div>';
    return;
  }
  list.innerHTML = savedStandards.map(item => `
    <div class="library-item">
      <div class="library-main">
        <strong>${escapeHtml(item.standardNumber || item.key)}</strong>
        <span>${escapeHtml(item.title || item.note || '—')}</span>
        <em>${escapeHtml(item.group || '未分组')} · ${item.downloaded ? '已下载' : '未下载'}</em>
      </div>
      <div class="library-actions">
        ${item.fileName ? `<button class="btn btn-ghost btn-sm" data-download-file="${escapeHtml(item.fileName)}">重下</button>` : ''}
        <button class="btn btn-ghost btn-sm" onclick="editSavedStandard('${escapeHtml(item.key)}')">备注</button>
        <button class="btn btn-ghost btn-sm" onclick="removeSavedStandard('${escapeHtml(item.key)}')">移除</button>
      </div>
    </div>`).join('');
}

function editSavedStandard(key) {
  const item = savedStandards.find(s => s.key === key);
  if (!item) return;
  const group = prompt('分组', item.group || '');
  if (group === null) return;
  const note = prompt('备注', item.note || item.title || '');
  if (note === null) return;
  item.group = group.trim();
  item.note = note.trim();
  persistSavedStandards();
  renderSavedLibrary();
  showToast('收藏信息已更新');
}

function removeSavedStandard(key) {
  savedStandards = savedStandards.filter(s => s.key !== key);
  persistSavedStandards();
  renderSavedLibrary();
  if (typeof renderResults === 'function') { renderResults(); renderFilterBar(); updateToolbar(); }
}

async function refreshFileLibrary(options = {}) {
  const list = document.getElementById('fileLibraryList');
  if (!list) return;
  const append = !!options.append;
  if (append && (fileLibraryLoading || fileLibraryAppending)) return;
  const q = (document.getElementById('fileLibrarySearch')?.value || '').trim();
  const nextOffset = append ? fileLibraryItems.filter(f => f.kind === 'library').length : 0;
  const params = new URLSearchParams({
    limit: String(fileLibraryLimit),
    offset: String(nextOffset),
  });
  if (q) params.set('q', q);
  const seq = ++fileLibraryRequestSeq;
  if (append) {
    fileLibraryAppending = true;
    renderFileLibrary();
  } else {
    fileLibraryLoading = true;
    renderFileLibraryLoading(q ? '正在筛选文件库...' : '正在加载文件库...');
  }
  try {
    const res = await fetch(`/api/downloads?${params.toString()}`);
    const data = await readApiResponse(res);
    if (!res.ok) throw new Error(data.message || '加载失败');
    if (seq !== fileLibraryRequestSeq) return;
    const incoming = data.items || [];
    if (append) {
      const seen = new Set(fileLibraryItems.map(f => `${f.kind}:${f.fileId || f.fileName}`));
      for (const item of incoming) {
        const key = `${item.kind}:${item.fileId || item.fileName}`;
        if (!seen.has(key)) { fileLibraryItems.push(item); seen.add(key); }
      }
    } else {
      fileLibraryItems = incoming;
    }
    fileLibraryTotal = Number(data.total || fileLibraryItems.length);
    fileLibraryLibraryTotal = Number(data.libraryTotal || fileLibraryItems.filter(f => f.kind === 'library').length);
    fileLibraryLimit = Number(data.limit || fileLibraryLimit);
    fileLibraryOffset = Number(data.offset || nextOffset);
    fileLibraryLoading = false;
    fileLibraryAppending = false;
    renderFileLibrary();
  } catch (e) {
    if (seq !== fileLibraryRequestSeq) return;
    fileLibraryLoading = false;
    fileLibraryAppending = false;
    list.innerHTML = `<tr><td colspan="6" class="local-empty fail">文件库加载失败: ${escapeHtml(e.message)}</td></tr>`;
  } finally {
    if (seq === fileLibraryRequestSeq) {
      fileLibraryLoading = false;
      fileLibraryAppending = false;
    }
  }
}

function scheduleFileLibraryRefresh() {
  clearTimeout(fileLibrarySearchTimer);
  fileLibraryOffset = 0;
  fileLibraryLoading = true;
  renderFileLibraryLoading('正在筛选文件库...');
  fileLibrarySearchTimer = setTimeout(refreshFileLibrary, 250);
}

function loadMoreFileLibrary() {
  if (fileLibraryLoading || fileLibraryAppending) return;
  refreshFileLibrary({ append: true });
}

function renderFileLibraryLoading(message) {
  const list = document.getElementById('fileLibraryList');
  const count = document.getElementById('fileLibraryCount');
  if (count) count.textContent = fileLibraryItems.length ? `${fileLibraryItems.length}/${fileLibraryTotal || fileLibraryItems.length}` : '...';
  if (list) list.innerHTML = `<tr><td colspan="6" class="local-empty">${escapeHtml(message || '正在加载...')}</td></tr>`;
  updateLocalSelectionUi();
}

// 本地文件库：表格渲染 + 复选 + 5 个操作（预览/下载/打开路径/编辑/删除）+ 批量删
// 打开路径仅 Electron 桌面端显示（window.bzxz.isElectron 为真），Web 浏览器侧改成"复制路径"
function renderFileLibrary() {
  const list = document.getElementById('fileLibraryList');
  const count = document.getElementById('fileLibraryCount');
  if (!list || !count) return;
  const items = fileLibraryItems;
  const q = (document.getElementById('fileLibrarySearch')?.value || '').trim();
  count.textContent = fileLibraryTotal > items.length ? `${items.length}/${fileLibraryTotal}` : String(items.length);
  // 清理已不在当前过滤集合内的选中项
  const visibleIds = new Set(items.filter(f => f.kind === 'library').map(f => f.fileId));
  fileLibrarySelectedIds.forEach(id => { if (!visibleIds.has(id)) fileLibrarySelectedIds.delete(id); });

  if (!items.length) {
    const emptyText = q ? '暂无匹配文件' : '文件库为空，下载或重扫后会出现在这里';
    list.innerHTML = `<tr><td colspan="6" class="local-empty">${emptyText}</td></tr>`;
    updateLocalSelectionUi();
    return;
  }
  const isElectron = !!(window.bzxz && window.bzxz.isElectron);
  const rows = items.map(f => {
    const isLib = f.kind === 'library';
    const checked = isLib && fileLibrarySelectedIds.has(f.fileId) ? 'checked' : '';
    const previewBtn = isLib && f.previewUrl
      ? `<button class="btn btn-ghost btn-xs" onclick="openLocalPreview(${f.fileId})">预览</button>`
      : '';
    // Win 桌面端：库结果隐藏「下载」（用户可用「打开路径」直接拿物理文件，HTTP 下载多余）
    // Web 浏览器端：保留（远程/内网用户唯一拷文件的路径）
    const downloadBtn = isLib
      ? (isElectron ? '' : `<button class="btn btn-ghost btn-xs" onclick="downloadLocalFile(${f.fileId}, '${escapeAttr(f.fileName)}')">下载</button>`)
      : `<button class="btn btn-ghost btn-xs" data-download-file="${escapeAttr(f.fileName)}">下载</button>`;
    const openPathBtn = isLib && isElectron
      ? `<button class="btn btn-ghost btn-xs" onclick="revealLocalFile(${f.fileId})">打开路径</button>`
      : (isLib ? `<button class="btn btn-ghost btn-xs" onclick="copyFilePath('${escapeAttr(f.path)}')">复制路径</button>` : '');
    const editBtn = isLib
      ? `<button class="btn btn-ghost btn-xs" onclick="renameLocalFile(${f.fileId}, '${escapeAttr(f.fileName)}')">编辑</button>`
      : '';
    const delBtn = isLib
      ? `<button class="btn btn-ghost btn-xs danger" onclick="deleteLibraryFile(${f.fileId}, '${escapeAttr(f.fileName)}')">删除</button>`
      : `<button class="btn btn-ghost btn-xs danger" onclick="deleteExportFile('${escapeAttr(f.fileName)}')">删除</button>`;
    // 标准名称列优先用 title（V2 命名带 title）；老文件 title='' 时 fallback 用 fileName
    // 让用户至少能看到一段标识。tooltip 始终是完整 fileName 便于排查物理路径。
    const nameDisplay = f.title || f.fileName;
    return `<tr data-file-id="${isLib ? f.fileId : ''}">
      <td class="local-col-check" data-label="">${isLib ? `<input type="checkbox" ${checked} onchange="onLocalCheck(${f.fileId}, this.checked)">` : ''}</td>
      <td data-label="标准号" class="local-col-std"><strong>${escapeHtml(f.standardNumber || f.fileName)}</strong><span class="local-col-name" title="${escapeHtml(f.fileName)}">${escapeHtml(nameDisplay)}</span></td>
      <td data-label="来源">${escapeHtml(f.source || (isLib ? '本地' : '导出'))}</td>
      <td data-label="大小">${escapeHtml(formatSize(f.size))}</td>
      <td data-label="时间">${escapeHtml(utcToBeijing(f.mtime))}</td>
      <td class="local-col-actions" data-label="">${previewBtn}${downloadBtn}${openPathBtn}${editBtn}${delBtn}</td>
    </tr>`;
  }).join('');
  const loadedLibrary = items.filter(f => f.kind === 'library').length;
  const moreRow = loadedLibrary < fileLibraryLibraryTotal
    ? `<tr><td colspan="6" class="local-empty"><button class="btn btn-sm btn-ghost" onclick="loadMoreFileLibrary()" ${fileLibraryAppending ? 'disabled' : ''}>${fileLibraryAppending ? '加载中...' : `加载更多（还剩 ${fileLibraryLibraryTotal - loadedLibrary} 项）`}</button></td></tr>`
    : '';
  list.innerHTML = rows + moreRow;
  updateLocalSelectionUi();
}

function escapeAttr(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function updateLocalSelectionUi() {
  const selCount = document.getElementById('fileLibrarySelectedCount');
  const batchBtn = document.getElementById('fileLibraryBatchDelete');
  const normalizeBtn = document.getElementById('fileLibraryBatchNormalize');
  const checkAll = document.getElementById('fileLibraryCheckAll');
  if (selCount) selCount.textContent = String(fileLibrarySelectedIds.size);
  if (batchBtn) batchBtn.disabled = fileLibrarySelectedIds.size === 0;
  if (normalizeBtn) normalizeBtn.disabled = fileLibrarySelectedIds.size === 0;
  if (checkAll) {
    const libCount = fileLibraryItems.filter(f => f.kind === 'library').length;
    checkAll.checked = libCount > 0 && fileLibrarySelectedIds.size === libCount;
    checkAll.indeterminate = fileLibrarySelectedIds.size > 0 && fileLibrarySelectedIds.size < libCount;
  }
}

function onLocalCheck(fileId, checked) {
  if (checked) fileLibrarySelectedIds.add(fileId);
  else fileLibrarySelectedIds.delete(fileId);
  updateLocalSelectionUi();
}

function onLocalCheckAll(checked) {
  if (checked) fileLibraryItems.forEach(f => { if (f.kind === 'library') fileLibrarySelectedIds.add(f.fileId); });
  else fileLibrarySelectedIds.clear();
  renderFileLibrary();
}

function toggleLocalSelectAll() {
  const checkAll = document.getElementById('fileLibraryCheckAll');
  if (!checkAll) return;
  onLocalCheckAll(!checkAll.checked);
}

function openLocalPreview(fileId) {
  // 手机端：overlay + PDF.js canvas 渲染
  if (window.isMobile && window.PDFViewer) {
    const overlay = document.getElementById('previewOverlay');
    const body = document.getElementById('previewBody');
    if (!overlay || !body) return;
    document.getElementById('previewTitle').textContent = '预览';
    overlay.classList.add('open');
    overlay.setAttribute('aria-hidden', 'false');
    body.innerHTML = '';
    const viewer = new PDFViewer(body, {
      url: `/api/preview/file/${fileId}`,
      onDownload: () => { viewer.destroy(); overlay.classList.remove('open'); overlay.setAttribute('aria-hidden', 'true'); },
    });
    viewer.load(`/api/preview/file/${fileId}`);
    return;
  }
  // 桌面端：新 tab 打开（Electron 会被系统浏览器拦截）
  window.open(`/api/preview/file/${fileId}`, '_blank');
}

function downloadLocalFile(fileId, fileName) {
  // 走 attachment=1，让浏览器保存而非内联
  const a = document.createElement('a');
  a.href = `/api/preview/file/${fileId}?attachment=1`;
  a.download = fileName || '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function revealLocalFile(fileId) {
  try {
    const res = await fetch(`/api/preview/file/${fileId}/reveal`, { method: 'POST' });
    const data = await readApiResponse(res);
    if (!res.ok) throw new Error(data.message || '打开失败');
    showToast('已在资源管理器中定位');
  } catch (e) {
    showToast(`打开失败: ${e.message}`, 'fail');
  }
}

function copyFilePath(filePath) {
  navigator.clipboard.writeText(filePath || '');
  showToast('文件路径已复制');
}

async function renameLocalFile(fileId, oldName) {
  // #73 用 modal 取代 native prompt：增加「套用内置格式」prefill 按钮，预览目标名
  const result = await showRenameModal({ fileId, oldName });
  if (!result) return;
  // 「套用内置格式」分支：后端 /normalize 端点（pattern 算出目标名）
  if (result.normalize) {
    return normalizeSingleFile(fileId);
  }
  // 手输分支：PATCH 端点（用户输入）
  const trimmed = (result.fileName || '').trim();
  if (!trimmed || trimmed === oldName) return;
  try {
    const res = await fetch(`/api/preview/file/${fileId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName: trimmed }),
    });
    const data = await readApiResponse(res);
    if (!res.ok) throw new Error(data.message || '改名失败');
    showToast('文件已重命名');
    refreshFileLibrary();
  } catch (e) {
    showToast(`改名失败: ${e.message}`, 'fail');
  }
}

// #73 rename modal：input + 实时显示「按内置格式将变为：xxx」+ 「套用内置格式」按钮 + 取消/确认
// 返回 null（取消）/ { fileName }（手输）/ { normalize: true }（套用内置）
function showRenameModal({ fileId, oldName }) {
  return new Promise(resolve => {
    let overlay = document.getElementById('confirmOverlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'confirmOverlay';
      overlay.className = 'confirm-overlay';
      document.body.appendChild(overlay);
    }
    overlay.innerHTML = `
      <div class="confirm-card" role="dialog" aria-modal="true" style="min-width:480px;max-width:640px">
        <div class="confirm-title">重命名文件</div>
        <div class="confirm-body" style="text-align:left">
          <div style="margin-bottom:8px;font-size:12px;color:var(--text-3)">输入新文件名（保留扩展名 .pdf 可省略）</div>
          <input id="renameInput" type="text" class="library-search" style="width:100%;box-sizing:border-box" value="${escapeAttr(oldName || '')}">
          <div id="renamePreviewBox" class="rename-preview-box" style="display:none">
            <div class="rename-preview-label">按内置格式将变为：</div>
            <div id="renamePreviewName" class="rename-preview-name"></div>
            <button class="btn btn-ghost btn-sm" data-rename-action="normalize" style="margin-top:6px">套用内置格式</button>
          </div>
          <div id="renamePreviewSkip" class="rename-preview-skip" style="display:none"></div>
        </div>
        <div class="confirm-actions">
          <button class="btn btn-ghost btn-sm" data-rename-action="cancel">取消</button>
          <button class="btn btn-primary btn-sm" data-rename-action="confirm">确认</button>
        </div>
      </div>`;
    requestAnimationFrame(() => overlay.classList.add('open'));

    const finish = (result) => {
      overlay.classList.remove('open');
      setTimeout(() => { overlay.innerHTML = ''; }, 200);
      document.removeEventListener('keydown', onKey);
      resolve(result);
    };
    const input = overlay.querySelector('#renameInput');
    const previewBox = overlay.querySelector('#renamePreviewBox');
    const previewNameEl = overlay.querySelector('#renamePreviewName');
    const skipEl = overlay.querySelector('#renamePreviewSkip');
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); finish(null); }
      if (e.key === 'Enter' && document.activeElement === input) { e.preventDefault(); finish({ fileName: input.value }); }
    };
    document.addEventListener('keydown', onKey);
    overlay.querySelector('[data-rename-action="cancel"]').addEventListener('click', () => finish(null));
    overlay.querySelector('[data-rename-action="confirm"]').addEventListener('click', () => finish({ fileName: input.value }));
    // 用 delegation 等动态出现的「套用内置格式」按钮
    overlay.addEventListener('click', (e) => {
      if (e.target && e.target.dataset && e.target.dataset.renameAction === 'normalize') {
        finish({ normalize: true });
      }
    });
    overlay.addEventListener('click', (e) => { if (e.target === overlay) finish(null); }, { once: true });
    input.focus();
    input.select();

    // 异步拉单文件 dryRun 预览 → 填充 preview box
    (async () => {
      try {
        const res = await fetch(`/api/preview/file/${fileId}/normalize?dryRun=1`, { method: 'POST' });
        const data = await readApiResponse(res);
        if (!res.ok) return; // 静默失败，rename 还能用
        if (data.error) {
          skipEl.style.display = '';
          skipEl.textContent = `内置格式不可用：${data.error}`;
          return;
        }
        if (!data.willChange) {
          skipEl.style.display = '';
          skipEl.textContent = '文件名已是内置格式';
          return;
        }
        previewNameEl.textContent = data.normalizedName || '';
        previewBox.style.display = '';
      } catch (e) {
        // 静默
      }
    })();
  });
}

// #73 类似 showConfirm 但 body 支持 HTML（用于格式化预览列表渲染）
// 扩展：confirmDisabled 让按钮 disabled（无可执行项时不诱导用户点）；
//       onMount(overlay) 让调用方在 modal 挂载后挂事件（chip 切换 / 展开等）
function showConfirmHtml({ title = '请确认', bodyHtml = '', confirmText = '确定', cancelText = '取消', danger = false, confirmDisabled = false, onMount } = {}) {
  return new Promise(resolve => {
    let overlay = document.getElementById('confirmOverlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'confirmOverlay';
      overlay.className = 'confirm-overlay';
      document.body.appendChild(overlay);
    }
    overlay.innerHTML = `
      <div class="confirm-card${danger ? ' danger' : ''}" role="dialog" aria-modal="true" style="min-width:560px;max-width:760px">
        <div class="confirm-title">${escapeHtml(title)}</div>
        <div class="confirm-body" style="text-align:left;max-height:60vh;overflow-y:auto">${bodyHtml}</div>
        <div class="confirm-actions">
          <button class="btn btn-ghost btn-sm" data-confirm-action="cancel">${escapeHtml(cancelText)}</button>
          <button class="btn btn-sm ${danger ? 'btn-danger' : 'btn-primary'}" data-confirm-action="confirm"${confirmDisabled ? ' disabled' : ''}>${escapeHtml(confirmText)}</button>
        </div>
      </div>`;
    // 代际守卫：连续弹窗（如关联流程连开两次 showPrompt）复用同一 #confirmOverlay。
    // finish() 里延迟 200ms 清空 innerHTML，若期间已开新弹窗，旧 timer 会把新弹窗的
    // 卡片清掉，只剩带 backdrop-filter 的空遮罩 → 界面卡在高斯模糊。记一个递增 token，
    // 只有"自己仍是最新一次"才真正收起/清空。
    const myGen = (showConfirmHtml._gen = (showConfirmHtml._gen || 0) + 1);
    requestAnimationFrame(() => overlay.classList.add('open'));
    const finish = (result) => {
      document.removeEventListener('keydown', onKey);
      resolve(result);
      // 被后续弹窗接管 → 不要动 overlay（新弹窗自己负责显示/清理）
      if (showConfirmHtml._gen !== myGen) return;
      overlay.classList.remove('open');
      setTimeout(() => { if (showConfirmHtml._gen === myGen) overlay.innerHTML = ''; }, 200);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); finish(false); }
      if (e.key === 'Enter' && !confirmDisabled) { e.preventDefault(); finish(true); }
    };
    document.addEventListener('keydown', onKey);
    overlay.querySelector('[data-confirm-action="cancel"]').addEventListener('click', () => finish(false));
    const confirmBtn = overlay.querySelector('[data-confirm-action="confirm"]');
    if (!confirmDisabled) {
      confirmBtn.addEventListener('click', () => finish(true));
    } else {
      // 即使禁用也允许「关闭」语义（如果文案是「关闭」）
      confirmBtn.addEventListener('click', () => finish(false));
    }
    overlay.addEventListener('click', (e) => { if (e.target === overlay) finish(false); }, { once: true });
    if (typeof onMount === 'function') {
      try { onMount(overlay); } catch (err) { console.error(err); }
    }
    confirmBtn.focus();
  });
}

// 文本输入弹窗 —— 替代 window.prompt（Electron/win 客户端禁用原生 prompt，
// 返回空且控制台报 "prompt() is not supported"，导致依赖 prompt 的功能在 win 端
// 静默失效）。基于 showConfirmHtml 的 onMount 钩子塞一个 input。
// 返回 Promise<string|null>：确认返回输入值（已 trim），取消返回 null。
// opts: { title, label, defaultValue, placeholder, confirmText, multiline }
function showPrompt({ title = '请输入', label = '', defaultValue = '', placeholder = '', confirmText = '确定', multiline = false } = {}) {
  const fieldId = 'promptField_' + Math.random().toString(36).slice(2, 8);
  const field = multiline
    ? `<textarea id="${fieldId}" class="batch-textarea" style="min-height:96px" placeholder="${escapeHtml(placeholder)}">${escapeHtml(defaultValue)}</textarea>`
    : `<input id="${fieldId}" type="text" class="qual-search-input" style="width:100%" placeholder="${escapeHtml(placeholder)}" value="${escapeHtml(defaultValue)}">`;
  const bodyHtml = `${label ? `<div style="margin-bottom:8px;font-size:13px;color:var(--text-2);white-space:pre-wrap">${escapeHtml(label)}</div>` : ''}${field}`;
  return showConfirmHtml({
    title,
    bodyHtml,
    confirmText,
    onMount(overlay) {
      const el = overlay.querySelector('#' + fieldId);
      if (el) {
        el.focus();
        if (!multiline && typeof el.select === 'function') el.select();
        // 单行：Enter 提交（多行交给 showConfirmHtml 默认行为，避免吞掉换行）
        if (!multiline) {
          el.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              const btn = overlay.querySelector('[data-confirm-action="confirm"]');
              if (btn) btn.click();
            }
          });
        }
      }
    },
  }).then(ok => {
    if (!ok) return null;
    const el = document.getElementById(fieldId);
    return el ? el.value.trim() : null;
  });
}

async function deleteLibraryFile(fileId, fileName) {
  if (!await showConfirm({ title: '删除文件', body: `确定删除「${fileName}」？文件将从磁盘移除，此操作不可恢复。`, danger: true, confirmText: '删除' })) return;
  try {
    const res = await fetch(`/api/preview/file/${fileId}`, { method: 'DELETE' });
    const data = await readApiResponse(res);
    if (!res.ok) throw new Error(data.message || '删除失败');
    fileLibrarySelectedIds.delete(fileId);
    showToast('文件已删除');
    refreshFileLibrary();
  } catch (e) {
    showToast(`删除失败: ${e.message}`, 'fail');
  }
}

async function deleteExportFile(fileName) {
  if (!await showConfirm({ title: '删除文件', body: `确定删除「${fileName}」？此操作不可恢复。`, danger: true, confirmText: '删除' })) return;
  try {
    const res = await fetch(`/api/downloads/${encodeURIComponent(fileName)}`, { method: 'DELETE' });
    const data = await readApiResponse(res);
    if (!res.ok) throw new Error(data.message || '删除失败');
    showToast('文件已删除');
    refreshFileLibrary();
  } catch (e) {
    showToast(`删除失败: ${e.message}`, 'fail');
  }
}

// #73 统一命名：按 admin pattern 重渲染。dryRun=true 预览 → modal 确认 → dryRun=false 执行
// 入口（批量）：工具栏「统一命名」按钮（启用条件与「批量删除」一致：有勾选项）
//
// modal 内顶部 chip 切换：[ 仅选中 N 项 ] [ 整个文件库 M 项 ]
// 切换后重新 dryRun 刷新内容；只有当前显示的 scope 项目会被执行。
async function batchNormalizeLibraryFiles() {
  const selectedIds = Array.from(fileLibrarySelectedIds);
  if (!selectedIds.length) return;
  return openNormalizeModal({ scope: 'selected', selectedIds });
}

// 打开 / 重渲 modal。supports scope 切换：
//   - scope='selected'：用 selectedIds
//   - scope='all'：后端忽略 ids 扫全库
async function openNormalizeModal({ scope, selectedIds }) {
  // dryRun 拿数据
  let data;
  try {
    const body = scope === 'all'
      ? { scope: 'all', dryRun: true }
      : { ids: selectedIds, scope: 'selected', dryRun: true };
    const res = await fetch('/api/preview/files/normalize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    data = await readApiResponse(res);
    if (!res.ok) throw new Error(data.message || '预览失败');
  } catch (e) {
    showToast(`预览失败: ${e.message}`, 'fail');
    return;
  }

  const preview = data.preview || [];
  const libraryTotal = data.libraryTotal || 0;
  const willChange = preview.filter(p => p.willChange && !p.error && !p.conflictReason);
  const unchanged = preview.filter(p => !p.willChange && !p.error);
  const conflicts = preview.filter(p => p.conflictReason);
  const errors = preview.filter(p => p.error);

  // chip：仅选中 / 整库
  const chipHtml = `
    <div class="normalize-scope-row">
      <button class="normalize-chip${scope === 'selected' ? ' active' : ''}" data-normalize-scope="selected">仅选中 ${selectedIds.length} 项</button>
      <button class="normalize-chip${scope === 'all' ? ' active' : ''}" data-normalize-scope="all">整个文件库 ${libraryTotal} 项</button>
    </div>
  `;

  // 主区：将重命名 N 项（最多展开 20 行 + "还有 N 项 - 全部展开"）
  let MAX_VISIBLE = 20;
  const allExpandFlag = '__expand_all__';
  // 渲染主列表函数（支持点「全部展开」）
  function renderMainList(showAll) {
    if (!willChange.length) {
      return `<div class="normalize-empty">没有需要重命名的文件</div>`;
    }
    const visible = showAll ? willChange : willChange.slice(0, MAX_VISIBLE);
    const hidden = willChange.length - visible.length;
    const rows = visible.map(p =>
      `<div class="normalize-row"><div class="normalize-from">${escapeHtml(p.from)}</div>`
      + `<div class="normalize-arrow">→</div>`
      + `<div class="normalize-to">${escapeHtml(p.to)}</div></div>`).join('');
    const moreBtn = hidden > 0
      ? `<button class="normalize-more-btn" data-normalize-action="${allExpandFlag}">还有 ${hidden} 项 — 全部展开</button>`
      : '';
    return `<div class="normalize-list">${rows}</div>${moreBtn}`;
  }

  // 折叠分组（其它三类）：默认收起，冲突有内容自动展开
  function renderGroup(key, label, color, items, autoOpen) {
    if (!items.length) return '';
    const sampleHtml = items.slice(0, 50).map(p => {
      const reason = p.conflictReason || p.error || '';
      const reasonText = reason ? ` <span class="normalize-row-reason">— ${escapeHtml(reason)}</span>` : '';
      return `<div class="normalize-row-mini"><span class="normalize-row-name">${escapeHtml(p.from || `(id=${p.id})`)}</span>${reasonText}</div>`;
    }).join('');
    const more = items.length > 50 ? `<div class="normalize-more">…还有 ${items.length - 50} 项</div>` : '';
    return `
      <details class="normalize-group ${color}"${autoOpen ? ' open' : ''}>
        <summary><span class="normalize-group-label">${label}</span><span class="normalize-group-count">${items.length} 项</span></summary>
        <div class="normalize-group-body">${sampleHtml}${more}</div>
      </details>
    `;
  }

  // 组装 body
  function buildBodyHtml(showAll) {
    return `
      ${chipHtml}
      <div class="normalize-summary">将重命名 <strong>${willChange.length}</strong> 项${scope === 'all' ? '（整库）' : ''}</div>
      ${renderMainList(showAll)}
      ${renderGroup('unchanged', '已符合命名', 'neutral', unchanged, false)}
      ${renderGroup('conflict', '冲突（将跳过）', 'conflict', conflicts, conflicts.length > 0)}
      ${renderGroup('error', '无法解析（将跳过）', 'error', errors, false)}
    `;
  }

  const confirmText = willChange.length
    ? `确认重命名 ${willChange.length} 项`
    : '关闭';
  const result = await showConfirmHtml({
    title: '统一命名',
    bodyHtml: buildBodyHtml(false),
    confirmText,
    cancelText: '取消',
    confirmDisabled: !willChange.length,
    // 让回调挂上 chip / 全部展开 点击
    onMount(overlay) {
      const card = overlay.querySelector('.confirm-card');
      const body = overlay.querySelector('.confirm-body');
      // chip 切换 scope
      overlay.querySelectorAll('[data-normalize-scope]').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const nextScope = btn.getAttribute('data-normalize-scope');
          if (nextScope === scope) return;
          // 关掉当前 modal 让 openNormalizeModal 重新打开（避免递归 + 状态闭包）
          overlay.classList.remove('open');
          setTimeout(() => { overlay.innerHTML = ''; }, 200);
          // 用 setTimeout 退到下一 tick 避免 click bubble 关闭新 modal
          setTimeout(() => openNormalizeModal({ scope: nextScope, selectedIds }), 220);
        });
      });
      // 全部展开按钮
      body.addEventListener('click', (e) => {
        const t = e.target;
        if (t && t.dataset && t.dataset.normalizeAction === allExpandFlag) {
          body.innerHTML = buildBodyHtml(true);
          // 重新挂 chip / details 事件
          // chip 重新挂
          overlay.querySelectorAll('[data-normalize-scope]').forEach(btn => {
            btn.addEventListener('click', async (e2) => {
              e2.stopPropagation();
              const nextScope = btn.getAttribute('data-normalize-scope');
              if (nextScope === scope) return;
              overlay.classList.remove('open');
              setTimeout(() => { overlay.innerHTML = ''; }, 200);
              setTimeout(() => openNormalizeModal({ scope: nextScope, selectedIds }), 220);
            });
          });
        }
      });
    },
  });
  if (!result || !willChange.length) return;

  // 执行
  try {
    const body = scope === 'all'
      ? { scope: 'all', dryRun: false }
      : { ids: selectedIds, scope: 'selected', dryRun: false };
    const res = await fetch('/api/preview/files/normalize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const r = await readApiResponse(res);
    if (!res.ok) throw new Error(r.message || '执行失败');
    const okN = (r.renamed || []).length;
    const failN = (r.failed || []).length;
    if (scope === 'selected') fileLibrarySelectedIds.clear();
    showToast(failN ? `已重命名 ${okN} 项，${failN} 项失败` : `已重命名 ${okN} 项`, failN ? 'fail' : 'success');
    refreshFileLibrary();
  } catch (e) {
    showToast(`统一命名失败: ${e.message}`, 'fail');
  }
}

// 单文件格式化：从 rename modal 内「套用内置格式」按钮触发
async function normalizeSingleFile(fileId) {
  try {
    const res = await fetch(`/api/preview/file/${fileId}/normalize`, { method: 'POST' });
    const data = await readApiResponse(res);
    if (!res.ok) throw new Error(data.message || '格式化失败');
    if (data.changed) {
      showToast(`已格式化为「${data.fileName}」`);
      refreshFileLibrary();
    } else {
      showToast('文件名已是规范格式，无需修改', 'info');
    }
  } catch (e) {
    showToast(`格式化失败: ${e.message}`, 'fail');
  }
}

async function batchDeleteLibraryFiles() {
  const ids = Array.from(fileLibrarySelectedIds);
  if (!ids.length) return;
  if (!await showConfirm({ title: '批量删除', body: `确定删除选中的 ${ids.length} 个文件？文件将从磁盘移除，此操作不可恢复。`, danger: true, confirmText: '删除' })) return;
  try {
    const res = await fetch('/api/preview/files/batch-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    const data = await readApiResponse(res);
    if (!res.ok) throw new Error(data.message || '批量删除失败');
    const okN = (data.deleted || []).length;
    const failN = (data.failed || []).length;
    fileLibrarySelectedIds.clear();
    showToast(failN ? `已删 ${okN} 个，失败 ${failN} 个` : `已删 ${okN} 个文件`, failN ? 'fail' : 'success');
    refreshFileLibrary();
  } catch (e) {
    showToast(`批量删除失败: ${e.message}`, 'fail');
  }
}

// ── Toast ──
// type: 'success' | 'fail' | 'warn' | 'info'
// icon 用 BMP 区单色字符(Win7 / 任意 Chrome 都有字形),颜色由 CSS .toast-icon 染白叠状态色背景。
// 之前用 ✅❌ℹ️ 彩色 emoji 在 Win7 显方框 + 与 toast 主体灰色对比突兀,新设计统一视觉。
const TOAST_ICON = { success: '✓', fail: '✕', warn: '!', info: 'i' };
function showToast(msg, type, duration) {
  type = type || 'success'; duration = duration || 3000;
  if (!TOAST_ICON[type]) type = 'info';
  const container = document.getElementById('toastContainer');
  if (!container) return; // 极早期调用(DOM 没起来)直接吞,不抛
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.setAttribute('role', type === 'fail' ? 'alert' : 'status');
  toast.innerHTML = `<span class="toast-icon" aria-hidden="true">${TOAST_ICON[type]}</span><span class="toast-msg">${escapeHtml(msg)}</span><div class="toast-bar" style="animation-duration:${duration}ms"></div>`;
  container.appendChild(toast);
  setTimeout(() => { toast.style.opacity = '0'; toast.style.transition = 'opacity 0.2s'; setTimeout(() => toast.remove(), 200); }, duration);
}

/**
 * Promise-based confirmation modal. Replaces native `confirm()` which is ugly,
 * blocks the page, and on Electron can be inconsistent.
 *   const ok = await showConfirm({ title: '确认删除', body: '...', danger: true });
 * Returns true if user clicked confirm, false otherwise.
 */
function showConfirm(opts) {
  const { title = '请确认', body = '', confirmText = '确定', cancelText = '取消', danger = false } = opts || {};
  return new Promise(resolve => {
    let overlay = document.getElementById('confirmOverlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'confirmOverlay';
      overlay.className = 'confirm-overlay';
      document.body.appendChild(overlay);
    }
    overlay.innerHTML = `
      <div class="confirm-card${danger ? ' danger' : ''}" role="dialog" aria-modal="true">
        <div class="confirm-title">${escapeHtml(title)}</div>
        <div class="confirm-body">${escapeHtml(body)}</div>
        <div class="confirm-actions">
          <button class="btn btn-ghost btn-sm" data-confirm-action="cancel">${escapeHtml(cancelText)}</button>
          <button class="btn btn-sm ${danger ? 'btn-danger' : 'btn-primary'}" data-confirm-action="confirm">${escapeHtml(confirmText)}</button>
        </div>
      </div>`;
    requestAnimationFrame(() => overlay.classList.add('open'));

    const finish = (result) => {
      overlay.classList.remove('open');
      setTimeout(() => { overlay.innerHTML = ''; }, 200);
      document.removeEventListener('keydown', onKey);
      resolve(result);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); finish(false); }
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    };
    document.addEventListener('keydown', onKey);
    overlay.querySelector('[data-confirm-action="cancel"]').addEventListener('click', () => finish(false));
    overlay.querySelector('[data-confirm-action="confirm"]').addEventListener('click', () => finish(true));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) finish(false); }, { once: true });
    overlay.querySelector('[data-confirm-action="confirm"]').focus();
  });
}

// ── Keyboard shortcuts ──
// Guard: if the user is typing inside an input/textarea/contenteditable, only
// allow Escape and Enter to act as global shortcuts. Other accelerators
// (Ctrl+K / Ctrl+D / Alt+1..6 / a) would interrupt typing.
function isEditingContext(target) {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = (target.tagName || '').toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select';
}

document.addEventListener('keydown', e => {
  const editing = isEditingContext(e.target);
  if (e.key === '?' && !editing && !e.ctrlKey && !e.metaKey && !e.altKey) {
    document.getElementById('shortcutsOverlay').classList.add('open');
  }
  if (e.key === 'Escape') {
    document.getElementById('shortcutsOverlay').classList.remove('open');
    document.getElementById('modalOverlay').classList.remove('open');
    closePanel('tools');
    hideSearchHistory();
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
    e.preventDefault();
    document.getElementById('searchInput').focus();
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    doSearch();
  }
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'd') {
    e.preventDefault();
    toggleDownloadCenter();
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd' && !editing) {
    e.preventDefault();
    const btn = document.getElementById('downloadSelected');
    if (btn && !btn.disabled) btn.click();
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'j' && !editing) {
    e.preventDefault();
    setResultDensity(resultDensity === 'compact' ? 'comfortable' : 'compact');
    if (typeof renderSavedToolbar === 'function') renderSavedToolbar();
  }
  if (e.altKey && !e.ctrlKey && !e.metaKey && /^[1-6]$/.test(e.key) && !editing) {
    e.preventDefault();
    const tabs = ['search', 'tools', 'qual', 'history', 'local', 'settings'];
    switchTab(tabs[Number(e.key) - 1]);
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'a' && !editing) {
    e.preventDefault();
    const filtered = getFilteredResults();
    const allSelected = filtered.length > 0 && filtered.every(r => selectedIds.has(r.id));
    filtered.forEach(r => allSelected ? selectedIds.delete(r.id) : selectedIds.add(r.id));
    renderResults(); updateToolbar();
  }
});
document.getElementById('shortcutsOverlay').addEventListener('click', e => {
  if (e.target === document.getElementById('shortcutsOverlay')) {
    document.getElementById('shortcutsOverlay').classList.remove('open');
  }
});

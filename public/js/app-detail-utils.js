// ── Detail Modal & Utilities ── (slimmed: UI components → app-ui-components.js, log → app-log.js, file library → app-file-library.js)

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

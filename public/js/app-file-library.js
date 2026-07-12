// ── File Library & History ──

// ── Search history ──
const SEARCH_HISTORY_KEY = 'bzxz_search_history';
function loadSearchHistory() {
  try { return JSON.parse(localStorage.getItem(SEARCH_HISTORY_KEY) || '[]'); } catch { return []; }
}
function saveSearchHistory(query) {
  let hist = loadSearchHistory();
  hist = hist.filter(h => h !== query);
  hist.unshift(query);
  if (hist.length > 10) hist = hist.slice(0, 10);
  localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(hist));
  renderSearchHistoryTags();
}
function renderSearchHistoryTags() {
  const el = document.getElementById('searchHistoryTags');
  if (!el) return;
  const history = loadSearchHistory().slice(0, 10);
  el.hidden = history.length === 0;
  el.innerHTML = history.length ? `
    <div class="search-tag-row-head">
      <span class="search-tag-row-label">最近搜索</span>
      <button type="button" class="search-history-clear" data-history-action="clear">清空</button>
    </div>
    <div class="search-tag-list">
      ${history.map(query => `<div class="search-history-tag">
        <button type="button" class="search-history-tag-query" data-history-query="${escapeHtml(query)}" title="搜索 ${escapeHtml(query)}">${escapeHtml(query)}</button>
        <button type="button" class="search-history-tag-remove" data-history-remove="${escapeHtml(query)}" aria-label="删除 ${escapeHtml(query)}">×</button>
      </div>`).join('')}
    </div>` : '';
}

document.getElementById('searchHistoryTags')?.addEventListener('click', event => {
  const queryButton = event.target.closest('[data-history-query]');
  if (queryButton) {
    document.getElementById('searchInput').value = queryButton.dataset.historyQuery || '';
    doSearch();
    return;
  }

  const removeButton = event.target.closest('[data-history-remove]');
  if (removeButton) {
    const history = loadSearchHistory().filter(query => query !== removeButton.dataset.historyRemove);
    localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(history));
    renderSearchHistoryTags();
    return;
  }

  if (event.target.closest('[data-history-action="clear"]')) {
    localStorage.removeItem(SEARCH_HISTORY_KEY);
    renderSearchHistoryTags();
  }
});

renderSearchHistoryTags();

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
let fileLibraryQuickFilter = { source: '', year: '', recent: false, duplicates: false };
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
    list.innerHTML = '<div class="library-empty">搜索结果里点"收藏"，常用标准会出现在这里。</div>';
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
  saveSavedMetadata();
  showToast('收藏信息已更新');
}

function removeSavedStandard(key) {
  const item = savedStandards.find(s => s.key === key);
  savedStandards = savedStandards.filter(s => s.key !== key);
  persistSavedStandards();
  renderSavedLibrary();
  if (typeof renderResults === 'function') { renderResults(); renderFilterBar(); updateToolbar(); }
  if (item?.standardNumber && typeof apiFetch === 'function') {
    apiFetch('/api/check/saved/codes')
      .then(remote => (remote?.codes || []).some(code => standardSaveKey({ standardNumber: code }) === key)
        ? apiFetch('/api/check/saved/toggle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stdCode: item.standardNumber }) })
        : null)
      .then(() => syncSavedStandardsAcrossDevices())
      .catch(() => { /* Local removal is retained and sync retries next time. */ });
  }
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
    list.innerHTML = `<div class="local-empty fail">文件库加载失败: ${escapeHtml(e.message)}</div>`;
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
  if (list) list.innerHTML = `<div class="local-empty">${escapeHtml(message || '正在加载...')}</div>`;
  updateLocalSelectionUi();
}

function fileLibraryYear(item) {
  const date = new Date(item.indexedAt || item.mtime || 0);
  return Number.isFinite(date.getTime()) ? String(date.getFullYear()) : '';
}

function normalizedLibraryCode(item) {
  return String(item.standardNumber || item.fileName || '').replace(/[^A-Z0-9]/gi, '').toUpperCase();
}

function filteredFileLibraryItems() {
  const now = Date.now();
  const duplicateCodes = new Map();
  fileLibraryItems.filter(item => item.kind === 'library').forEach(item => {
    const key = normalizedLibraryCode(item);
    if (key) duplicateCodes.set(key, (duplicateCodes.get(key) || 0) + 1);
  });
  return fileLibraryItems.filter(item => {
    if (fileLibraryQuickFilter.source && item.source !== fileLibraryQuickFilter.source) return false;
    if (fileLibraryQuickFilter.year && fileLibraryYear(item) !== fileLibraryQuickFilter.year) return false;
    if (fileLibraryQuickFilter.recent && now - new Date(item.indexedAt || item.mtime || 0).getTime() > 30 * 86400000) return false;
    if (fileLibraryQuickFilter.duplicates && (duplicateCodes.get(normalizedLibraryCode(item)) || 0) < 2) return false;
    return true;
  });
}

function renderFileLibraryQuickFilters() {
  const target = document.getElementById('fileLibraryQuickFilters');
  if (!target) return;
  const library = fileLibraryItems.filter(item => item.kind === 'library');
  const years = [...new Set(library.map(fileLibraryYear).filter(Boolean))].sort().reverse().slice(0, 6);
  const sources = [...new Set(library.map(item => item.source).filter(Boolean))];
  const counts = new Map();
  library.forEach(item => { const key = normalizedLibraryCode(item); if (key) counts.set(key, (counts.get(key) || 0) + 1); });
  const duplicateCount = [...counts.values()].filter(count => count > 1).length;
  const chip = (label, active, action, value = '') => `<button type="button" class="filter-chip${active ? ' active' : ''}" data-library-filter="${action}" data-library-value="${escapeAttr(value)}">${escapeHtml(label)}</button>`;
  target.innerHTML = [
    chip('最近 30 天', fileLibraryQuickFilter.recent, 'recent'),
    duplicateCount ? chip(`重复标准 ${duplicateCount}`, fileLibraryQuickFilter.duplicates, 'duplicates') : '',
    sources.map(source => chip(srcLabel(source), fileLibraryQuickFilter.source === source, 'source', source)).join(''),
    years.map(year => chip(year, fileLibraryQuickFilter.year === year, 'year', year)).join(''),
    (fileLibraryQuickFilter.source || fileLibraryQuickFilter.year || fileLibraryQuickFilter.recent || fileLibraryQuickFilter.duplicates) ? chip('清除筛选', false, 'clear') : '',
  ].join('');
}

function toggleFileLibraryFilter(action, value) {
  if (action === 'source') fileLibraryQuickFilter.source = fileLibraryQuickFilter.source === value ? '' : value;
  if (action === 'year') fileLibraryQuickFilter.year = fileLibraryQuickFilter.year === value ? '' : value;
  if (action === 'recent') fileLibraryQuickFilter.recent = !fileLibraryQuickFilter.recent;
  if (action === 'duplicates') fileLibraryQuickFilter.duplicates = !fileLibraryQuickFilter.duplicates;
  if (action === 'clear') fileLibraryQuickFilter = { source: '', year: '', recent: false, duplicates: false };
  renderFileLibrary();
}

document.getElementById('fileLibraryQuickFilters')?.addEventListener('click', event => {
  const button = event.target.closest('[data-library-filter]');
  if (button) toggleFileLibraryFilter(button.dataset.libraryFilter, button.dataset.libraryValue || '');
});

// 本地文件库：表格渲染 + 复选 + 5 个操作（预览/下载/打开路径/编辑/删除）+ 批量删
// 打开路径仅 Electron 桌面端显示（window.bzxz.isElectron 为真），Web 浏览器侧改成"复制路径"
function renderFileLibrary() {
  const list = document.getElementById('fileLibraryList');
  const count = document.getElementById('fileLibraryCount');
  if (!list || !count) return;
  renderFileLibraryQuickFilters();
  const items = filteredFileLibraryItems();
  const q = (document.getElementById('fileLibrarySearch')?.value || '').trim();
  count.textContent = fileLibraryTotal > items.length ? `${items.length}/${fileLibraryTotal}` : String(items.length);
  // 清理已不在当前过滤集合内的选中项
  const visibleIds = new Set(items.filter(f => f.kind === 'library').map(f => f.fileId));
  fileLibrarySelectedIds.forEach(id => { if (!visibleIds.has(id)) fileLibrarySelectedIds.delete(id); });

  if (!items.length) {
    const emptyText = q ? '暂无匹配文件' : '文件库为空，下载或重扫后会出现在这里';
    list.innerHTML = `<div class="local-empty">${emptyText}</div>`;
    updateLocalSelectionUi();
    return;
  }
  const isElectron = !!(window.bzxz && window.bzxz.isElectron);
  const groupCounts = new Map();
  items.filter(f => f.kind === 'library').forEach(f => { const key = normalizedLibraryCode(f); if (key) groupCounts.set(key, (groupCounts.get(key) || 0) + 1); });
  const groupSeen = new Set();
  const rows = items.map(f => {
    const isLib = f.kind === 'library';
    const checked = isLib && fileLibrarySelectedIds.has(f.fileId) ? 'checked' : '';
    const previewBtn = isLib && f.previewUrl
      ? `<button class="btn btn-ghost btn-xs" onclick="openLocalPreview(${f.fileId})">预览</button>`
      : '';
    const delBtn = isLib
      ? `<button class="btn btn-ghost btn-xs danger" onclick="deleteLibraryFile(${f.fileId}, '${escapeAttr(f.fileName)}')">删除</button>`
      : `<button class="btn btn-ghost btn-xs danger" onclick="deleteExportFile('${escapeAttr(f.fileName)}')">删除</button>`;
    const nameDisplay = f.title || f.fileName;
    const groupKey = normalizedLibraryCode(f);
    const groupHead = isLib && groupCounts.get(groupKey) > 1 && !groupSeen.has(groupKey) ? (groupSeen.add(groupKey), `<div class="local-group-head">${escapeHtml(f.standardNumber || '标准')} · ${groupCounts.get(groupKey)} 个版本 / 来源</div>`) : '';
    return groupHead + `<div class="local-row" data-file-id="${isLib ? f.fileId : ''}">
      <div class="local-row-row1">
        <span class="local-col-check">${isLib ? `<input type="checkbox" ${checked} onchange="onLocalCheck(${f.fileId}, this.checked)">` : ''}</span>
        <span class="local-col-std" title="${escapeHtml(f.fileName)}">${escapeHtml(f.standardNumber || f.fileName)}</span>
        <span class="local-col-actions">${previewBtn}${delBtn}</span>
      </div>
      <span class="local-meta-row">
        <span class="local-col-name" title="${escapeHtml(nameDisplay)}">${escapeHtml(nameDisplay)}</span>
        <span class="local-col-size">${escapeHtml(formatSize(f.size))}</span>
        <span class="local-col-time">${escapeHtml(utcToBeijing(f.indexedAt || f.mtime))}</span>
        <span class="local-col-src"><span class="local-source-chip">${escapeHtml(f.source || (isLib ? '本地' : '导出'))}</span></span>
      </span>
    </div>`;
  }).join('');
  const loadedLibrary = items.filter(f => f.kind === 'library').length;
  const moreRow = loadedLibrary < fileLibraryLibraryTotal
    ? `<div class="local-more"><button class="btn btn-sm btn-ghost" onclick="loadMoreFileLibrary()" ${fileLibraryAppending ? 'disabled' : ''}>${fileLibraryAppending ? '加载中...' : `加载更多（还剩 ${fileLibraryLibraryTotal - loadedLibrary} 项）`}</button></div>`
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
  const selectionBarCount = document.getElementById('fileLibrarySelectionBarCount');
  const selectionBar = document.getElementById('fileLibrarySelectionBar');
  const localPage = document.getElementById('page-local');
  const batchBtn = document.getElementById('fileLibraryBatchDelete');
  const normalizeBtn = document.getElementById('fileLibraryBatchNormalize');
  const checkAll = document.getElementById('fileLibraryCheckAll');
  const selectAllBtn = document.getElementById('fileLibrarySelectAll');
  const selectedCount = fileLibrarySelectedIds.size;
  if (selCount) selCount.textContent = String(selectedCount);
  if (selectionBarCount) selectionBarCount.textContent = String(selectedCount);
  if (selectionBar) {
    selectionBar.hidden = selectedCount === 0;
    selectionBar.setAttribute('aria-hidden', String(selectedCount === 0));
  }
  if (localPage) localPage.classList.toggle('file-library-selecting', selectedCount > 0);
  if (batchBtn) batchBtn.disabled = selectedCount === 0;
  if (normalizeBtn) normalizeBtn.disabled = selectedCount === 0;
  if (checkAll) {
    const libCount = fileLibraryItems.filter(f => f.kind === 'library').length;
    const allSelected = libCount > 0 && selectedCount === libCount;
    checkAll.checked = allSelected;
    checkAll.indeterminate = selectedCount > 0 && selectedCount < libCount;
    if (selectAllBtn) selectAllBtn.textContent = allSelected ? '取消全选' : '全选';
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

function clearLocalSelection() {
  if (!fileLibrarySelectedIds.size) return;
  fileLibrarySelectedIds.clear();
  renderFileLibrary();
}

function openLocalPreview(fileId) {
  // 手机端：overlay + pdfh5 渲染
  if (window.isMobile && window.Pdfh5) {
    const overlay = document.getElementById('previewOverlay');
    const body = document.getElementById('previewBody');
    if (!overlay || !body) return;
    document.getElementById('previewTitle').textContent = '预览';
    overlay.classList.add('open');
    overlay.setAttribute('aria-hidden', 'false');
    body.innerHTML = '';
    new Pdfh5(body, {
      pdfurl: `/api/preview/file/${fileId}`,
      workerSrc: '/vendor/pdfh5/js/pdf.worker.min.js',
      cMapUrl: '/vendor/pdfh5/cmaps/',
      standardFontDataUrl: '/vendor/pdfh5/standard_fonts/',
      iccUrl: '/vendor/pdfh5/iccs/',
      wasmUrl: '/vendor/pdfh5/wasm/',
      pageNum: true,
      loadingBar: true,
      backTop: true,
      zoomEnable: true,
      scrollEnable: true,
      maxZoom: 4,
      minZoom: 0.5,
    });
    return;
  }
  // 桌面端：新 tab 打开
  window.open(`/api/preview/file/${fileId}`, '_blank');
}

function downloadLocalFile(fileId, fileName) {
  const url = `/api/preview/file/${fileId}?attachment=1`;
  // 手机端：fetch → Blob → createObjectURL 强制下载
  if (window.isMobile && window.isMobile()) {
    if (typeof forceDownloadBlob === 'function') {
      forceDownloadBlob(url, fileName);
      return;
    }
  }
  const a = document.createElement('a');
  a.href = url;
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

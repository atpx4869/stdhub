// ── File Library & History ──

// ── Search history ──
// 文件库顶部持久横幅（批量操作结果/失败详情，可手动关闭）
function showLibraryBanner(html, type) {
  type = type || 'info';
  var bar = document.getElementById('libraryBanner');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'libraryBanner';
    bar.className = 'library-feedback-banner';
    var target = document.getElementById('fileLibraryList');
    if (target && target.parentNode) target.parentNode.insertBefore(bar, target);
  }
  if (!bar) return;
  bar.className = 'library-feedback-banner is-' + type;
  bar.style.display = 'flex';
  bar.innerHTML = '<span class="library-feedback-message">' + html + '</span><button class="library-feedback-close" type="button" aria-label="关闭提示" onclick="this.parentElement.style.display=\'none\'"><i class="ti ti-x" aria-hidden="true"></i></button>';
}

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
let fileLibraryLimit = 30;
let fileLibraryOffset = 0;
let fileLibraryPage = 1;
let fileLibrarySearchTimer = 0;
let fileLibraryLoading = false;
let fileLibraryAppending = false;
let fileLibraryRequestSeq = 0;
let fileLibrarySelectedIds = new Set();
let fileLibraryQuickFilter = { source: '', year: '', recent: false, duplicates: false };
let fileLibraryExpandedSeries = new Set();

function openLibraryImport() {
  const input = document.getElementById('fileLibraryImportInput');
  if (!input) return;
  input.value = '';
  input.onchange = () => {
    const files = Array.from(input.files || []);
    if (files.length) importLibraryFiles(files);
  };
  input.click();
}

async function importLibraryFiles(files) {
  const metadata = [];
  for (const file of files) {
    const stem = file.name.replace(/\.pdf$/i, '');
    const code = await showPrompt({
      title: `导入标准（${file.name}）`,
      label: '标准号',
      defaultValue: stem.match(/^[A-Za-z][A-Za-z0-9]*(?:[_\/][A-Za-z][A-Za-z0-9]*)?\s+\d+(?:\.\d+)*(?:\s*-\s*\d{4}[A-Za-z]?)?/)?.[0] || '',
      placeholder: '例如 GB/T 3324-2024',
      confirmText: '下一步',
    });
    if (code === null) return;
    const title = await showPrompt({
      title: `导入标准（${file.name}）`,
      label: '标准名称（可选）',
      defaultValue: stem.replace(code, '').replace(/^\s*[-—]\s*/, '').replace(/\s*[-—]\s*(BW|BZ|BY|LB|BD)$/i, '').trim(),
      placeholder: '例如 木家具通用技术条件',
      confirmText: '继续',
    });
    if (title === null) return;
    const year = code.match(/-\s*(\d{4})[A-Za-z]?\s*$/)?.[1] || '';
    metadata.push({ stdCode: code.trim(), title: title.trim(), year });
  }
  const form = new FormData();
  files.forEach(file => form.append('files', file, file.name));
  form.append('metadata', JSON.stringify(metadata));
  showToast(`正在导入 ${files.length} 个标准…`, 'info');
  try {
    const res = await fetch('/api/preview/files/import', { method: 'POST', body: form });
    const data = await readApiResponse(res);
    if (!res.ok) throw new Error(data.message || '导入失败');
    const ok = (data.imported || []).length;
    const failed = data.failed || [];
    const detail = failed.map(item => `${item.originalName}: ${item.message}`).join('；');
    showLibraryBanner(`已导入 ${ok} 个文件${failed.length ? `，<b>${failed.length} 个失败</b>：${escapeHtml(detail)}` : ''}`, failed.length ? 'warn' : 'success');
    refreshFileLibrary();
  } catch (error) {
    showToast(`导入失败: ${error.message}`, 'fail');
  }
}
function loadDownloadHistory() {
  try { return JSON.parse(localStorage.getItem(DL_HISTORY_KEY) || '[]'); } catch { return []; }
}
function addDownloadHistory(entry) {
  const hist = loadDownloadHistory();
  hist.unshift(entry);
  if (hist.length > 100) hist.length = 100;
  localStorage.setItem(DL_HISTORY_KEY, JSON.stringify(hist));
}
async function clearDownloadHistory() {
  document.querySelectorAll('#page-history .page-action-menu[open]').forEach(menu => { menu.open = false; });
  const history = loadDownloadHistory();
  if (!history.length) {
    showToast('暂无可清空的历史', 'info');
    return;
  }
  if (!await showConfirm({
    title: '清空下载历史',
    body: `确定清空全部 ${history.length} 条下载记录？此操作不会删除已下载的文件。`,
    danger: true,
    confirmText: '清空',
  })) return;
  localStorage.removeItem(DL_HISTORY_KEY);
  renderDownloadHistory();
  showToast('历史已清空');
}
function renderDownloadHistory() {
  renderSavedLibrary();
  const hist = loadDownloadHistory();
  const el = document.getElementById('historyList');
  const count = document.getElementById('historyCount');
  if (count) count.textContent = String(hist.length);
  if (!hist.length) {
    el.innerHTML = '<div class="workspace-empty-state"><i class="ti ti-history" aria-hidden="true"></i><strong>暂无下载记录</strong><span>从标准检索或任务中心完成下载后，记录会按日期显示在这里。</span></div>';
    return;
  }
  const groups = new Map();
  hist.forEach(function (item) {
    const raw = String(item.time || '').trim();
    const date = raw.match(/^\d{4}-\d{2}-\d{2}/)?.[0] || '未标注日期';
    if (!groups.has(date)) groups.set(date, []);
    groups.get(date).push(item);
  });
  el.innerHTML = Array.from(groups.entries()).map(function ([date, items]) {
    return '<section class="history-day"><div class="history-day-head"><strong>' + escapeHtml(date) + '</strong><span>' + items.length + ' 条</span></div>'
      + items.map(function (h) {
        const title = h.standardNumber || h.name || h.fileName || '下载记录';
        const detail = h.name && h.name !== title ? h.name : h.fileName;
        const time = String(h.time || '').replace(/^\d{4}-\d{2}-\d{2}\s*/, '');
        return '<div class="history-row">'
          + '<span class="history-row-icon"><i class="ti ti-download" aria-hidden="true"></i></span>'
          + '<span class="history-row-main"><strong title="' + escapeAttr(title) + '">' + escapeHtml(title) + '</strong>'
          + (detail ? '<span title="' + escapeAttr(detail) + '">' + escapeHtml(detail) + '</span>' : '') + '</span>'
          + '<span class="history-source">' + escapeHtml(h.source || '本地') + '</span>'
          + '<time class="history-time">' + escapeHtml(time || h.time || '') + '</time>'
          + (h.fileName ? '<button class="btn btn-ghost btn-sm history-redownload" data-download-file="' + escapeAttr(h.fileName) + '"><i class="ti ti-download" aria-hidden="true"></i><span>重下</span></button>' : '')
          + '</div>';
      }).join('') + '</section>';
  }).join('');
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
        <button class="btn btn-ghost btn-sm" data-action="edit-saved" data-key="${escapeHtml(item.key)}">备注</button>
        <button class="btn btn-ghost btn-sm" data-action="remove-saved" data-key="${escapeHtml(item.key)}">移除</button>
      </div>
    </div>`).join('');
}

// 事件委托：收藏列表、文件库行操作和下载历史。
(function bindLocalActions() {
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-action],[data-download-file]');
    if (!btn) return;
    var downloadFile = btn.getAttribute('data-download-file');
    if (downloadFile) { triggerDownload(downloadFile); return; }
    var action = btn.getAttribute('data-action');
    if (action === 'edit-saved') { editSavedStandard(btn.getAttribute('data-key')); return; }
    if (action === 'remove-saved') { removeSavedStandard(btn.getAttribute('data-key')); return; }
    if (action === 'preview-local') { openLocalPreview(Number(btn.getAttribute('data-file-id'))); return; }
    if (action === 'download-local') { downloadLocalFile(Number(btn.getAttribute('data-file-id')), btn.getAttribute('data-file-name')); closeLocalRowMenu(btn); return; }
    if (action === 'reveal-local') { revealLocalFile(Number(btn.getAttribute('data-file-id'))); closeLocalRowMenu(btn); return; }
    if (action === 'copy-local-path') { copyFilePath(btn.getAttribute('data-file-path')); closeLocalRowMenu(btn); return; }
    if (action === 'rename-local') { renameLocalFile(Number(btn.getAttribute('data-file-id')), btn.getAttribute('data-file-name')); closeLocalRowMenu(btn); return; }
    if (action === 'delete-library') { closeLocalRowMenu(btn); deleteLibraryFile(Number(btn.getAttribute('data-file-id')), btn.getAttribute('data-file-name')); return; }
    if (action === 'delete-export') { deleteExportFile(btn.getAttribute('data-file-name')); return; }
    if (action === 'toggle-library-series') { toggleFileLibrarySeries(btn.getAttribute('data-series-key')); return; }
    if (action === 'library-page') { goToFileLibraryPage(Number(btn.getAttribute('data-page'))); return; }
  });
  document.addEventListener('change', function (e) {
    var input = e.target.closest('[data-local-check]');
    if (!input) return;
    onLocalCheck(Number(input.getAttribute('data-file-id')), input.checked);
  });
})();

function closeLocalRowMenu(element) {
  const menu = element?.closest('details');
  if (menu) menu.open = false;
}

async function editSavedStandard(key) {
  const item = savedStandards.find(s => s.key === key);
  if (!item) return;
  const group = await showPrompt({ title: '编辑收藏', label: '分组', defaultValue: item.group || '', placeholder: '例如：常用标准', confirmText: '下一步' });
  if (group === null) return;
  const note = await showPrompt({ title: '编辑收藏', label: '备注', defaultValue: item.note || item.title || '', placeholder: '补充说明', confirmText: '保存' });
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
  const requestedPage = Math.max(1, Number(options.page || fileLibraryPage || 1));
  if (fileLibraryLoading) return;
  const q = (document.getElementById('fileLibrarySearch')?.value || '').trim();
  const nextOffset = (requestedPage - 1) * fileLibraryLimit;
  const params = new URLSearchParams({
    kind: 'library',
    group: 'series',
    limit: String(fileLibraryLimit),
    offset: String(nextOffset),
  });
  if (q) params.set('q', q);
  const seq = ++fileLibraryRequestSeq;
  fileLibraryLoading = true;
  renderFileLibraryLoading(q ? '正在筛选文件库...' : '正在加载文件库...');
  try {
    const res = await fetch(`/api/downloads?${params.toString()}`);
    const data = await readApiResponse(res);
    if (!res.ok) throw new Error(data.message || '加载失败');
    if (seq !== fileLibraryRequestSeq) return;
    fileLibraryItems = data.items || [];
    fileLibraryTotal = Number(data.total || fileLibraryItems.length);
    fileLibraryLibraryTotal = Number(data.libraryTotal || fileLibraryItems.filter(f => f.kind === 'library').length);
    fileLibraryLimit = Number(data.limit || fileLibraryLimit);
    fileLibraryOffset = Number(data.offset || nextOffset);
    const totalPages = Math.max(1, Math.ceil(fileLibraryTotal / fileLibraryLimit));
    if (requestedPage > totalPages) {
      fileLibraryLoading = false;
      fileLibraryAppending = false;
      refreshFileLibrary({ page: totalPages });
      return;
    }
    fileLibraryPage = requestedPage;
    fileLibraryLoading = false;
    fileLibraryAppending = false;
    renderFileLibrary();
    loadFileLibraryBadges(seq);
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
  fileLibraryPage = 1;
  clearLocalSelection();
  fileLibrarySearchTimer = setTimeout(function () { refreshFileLibrary({ page: 1 }); }, 250);
}

function resetFileLibraryView() {
  clearTimeout(fileLibrarySearchTimer);
  fileLibraryOffset = 0;
  fileLibraryPage = 1;
  fileLibraryQuickFilter = { source: '', year: '', recent: false, duplicates: false };
  const searchInput = document.getElementById('fileLibrarySearch');
  if (searchInput) searchInput.value = '';
  clearLocalSelection();
}

function goToFileLibraryPage(page) {
  const totalPages = Math.max(1, Math.ceil(fileLibraryTotal / fileLibraryLimit));
  const nextPage = Math.min(totalPages, Math.max(1, Number(page) || 1));
  if (nextPage === fileLibraryPage || fileLibraryLoading) return;
  clearLocalSelection();
  refreshFileLibrary({ page: nextPage });
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
  return String(item.standardNumber || item.fileName || '')
    .replace(/[-—]\s*\d{4}\s*$/, '')
    .replace(/[^A-Z0-9]/gi, '')
    .toUpperCase();
}

function librarySeriesLabel(item) {
  return String(item.standardNumber || item.fileName || '').replace(/[-—]\s*\d{4}\s*$/, '').trim() || '标准';
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
  var banner = document.getElementById('libraryBanner');
  if (banner) banner.style.display = 'none';
  const list = document.getElementById('fileLibraryList');
  const count = document.getElementById('fileLibraryCount');
  if (!list || !count) return;
  renderFileLibraryQuickFilters();
  const items = filteredFileLibraryItems();
  const q = (document.getElementById('fileLibrarySearch')?.value || '').trim();
  const visibleSeries = new Set(items.filter(item => item.kind === 'library').map(normalizedLibraryCode));
  count.textContent = fileLibraryTotal > visibleSeries.size
    ? `${visibleSeries.size}/${fileLibraryTotal} 个系列`
    : `${visibleSeries.size} 个系列`;
  const visibleIds = new Set(items.filter(f => f.kind === 'library').map(f => f.fileId));
  fileLibrarySelectedIds.forEach(id => { if (!visibleIds.has(id)) fileLibrarySelectedIds.delete(id); });

  if (!items.length) {
    const emptyText = q
      ? '<div class="workspace-empty-state"><i class="ti ti-file-search" aria-hidden="true"></i><strong>暂无匹配文件</strong><span>尝试缩短标准号、名称或清除快捷筛选。</span></div>'
      : '<div class="workspace-empty-state"><i class="ti ti-library" aria-hidden="true"></i><strong>文件库为空</strong><span>下载标准后会自动入库，也可以在系统设置中配置目录并扫描已有 PDF。</span></div>';
    list.innerHTML = `<div class="local-empty">${emptyText}</div>`;
    renderFileLibraryPager();
    updateLocalSelectionUi();
    return;
  }
  const groups = new Map();
  const groupOrder = [];
  items.forEach(function (item, index) {
    const key = item.kind === 'library' ? normalizedLibraryCode(item) : `export:${index}`;
    if (!groups.has(key)) { groups.set(key, []); groupOrder.push(key); }
    groups.get(key).push(item);
  });
  const renderFileRow = function (f, child = false) {
    const isLib = f.kind === 'library';
    const checked = isLib && fileLibrarySelectedIds.has(f.fileId) ? 'checked' : '';
    const previewBtn = isLib && f.previewUrl
      ? `<button class="btn btn-ghost btn-xs" data-action="preview-local" data-file-id="${f.fileId}"><i class="ti ti-eye" aria-hidden="true"></i><span>预览</span></button>`
      : '';
    const actionMenu = isLib
      ? `<details class="local-row-menu">
          <summary class="btn btn-ghost btn-xs" aria-label="更多文件操作" title="更多文件操作"><i class="ti ti-dots-vertical" aria-hidden="true"></i></summary>
          <div class="local-row-menu-popover">
            <button type="button" data-action="download-local" data-file-id="${f.fileId}" data-file-name="${escapeAttr(f.fileName)}"><i class="ti ti-download" aria-hidden="true"></i><span>下载</span></button>
            ${window.bzxz?.isElectron
              ? `<button type="button" data-action="reveal-local" data-file-id="${f.fileId}"><i class="ti ti-folder-open" aria-hidden="true"></i><span>打开位置</span></button>`
              : `<button type="button" data-action="copy-local-path" data-file-path="${escapeAttr(f.path || '')}"><i class="ti ti-copy" aria-hidden="true"></i><span>复制路径</span></button>`}
            <button type="button" data-action="rename-local" data-file-id="${f.fileId}" data-file-name="${escapeAttr(f.fileName)}"><i class="ti ti-pencil" aria-hidden="true"></i><span>重命名</span></button>
            <button type="button" class="danger" data-action="delete-library" data-file-id="${f.fileId}" data-file-name="${escapeAttr(f.fileName)}"><i class="ti ti-trash" aria-hidden="true"></i><span>删除</span></button>
          </div>
        </details>`
      : `<button class="btn btn-ghost btn-xs danger" data-action="delete-export" data-file-name="${escapeAttr(f.fileName)}"><i class="ti ti-trash" aria-hidden="true"></i><span>删除</span></button>`;
    const nameDisplay = f.title || f.fileName;
    const qualificationBadge = isLib && typeof qualBadgeHtml === 'function' ? qualBadgeHtml(f.standardNumber) : '';
    const capLibBadge = isLib && typeof capLibBadgeHtml === 'function' ? capLibBadgeHtml(f.standardNumber) : '';
    const natCmaBadge = isLib && typeof natCmaBadgeHtml === 'function' ? natCmaBadgeHtml(f.standardNumber) : '';
    return `<div class="local-row${child ? ' local-series-child' : ''}" data-file-id="${isLib ? f.fileId : ''}">
      <div class="local-row-row1">
        <span class="local-col-check">${isLib ? `<label class="workspace-visually-hidden" for="localFile_${f.fileId}">选择 ${escapeHtml(f.standardNumber || f.fileName)}</label><input id="localFile_${f.fileId}" type="checkbox" ${checked} data-local-check data-file-id="${f.fileId}">` : ''}</span>
        <span class="local-col-std" title="${escapeHtml(f.fileName)}"><span class="local-std-code">${escapeHtml(f.standardNumber || f.fileName)}</span>${qualificationBadge}${capLibBadge}${natCmaBadge}</span>
        <span class="local-col-actions">${previewBtn}${actionMenu}</span>
      </div>
      <span class="local-meta-row">
        <span class="local-col-name" title="${escapeHtml(nameDisplay)}">${escapeHtml(nameDisplay)}</span>
        <span class="local-col-size">${escapeHtml(formatSize(f.size))}</span>
        <span class="local-col-time">${escapeHtml(utcToBeijing(f.indexedAt || f.mtime))}</span>
        <span class="local-col-src"><span class="local-source-chip">${escapeHtml(f.source || (isLib ? '本地' : '导出'))}</span></span>
      </span>
    </div>`;
  };
  list.innerHTML = groupOrder.map(function (key) {
    const groupItems = groups.get(key) || [];
    if (groupItems.length === 1) return renderFileRow(groupItems[0]);
    const lead = groupItems[0];
    const versionCount = new Set(groupItems.map(item => String(item.standardNumber || '').match(/[-—]\s*(\d{4})\s*$/)?.[1] || '未标注')).size;
    const title = groupItems.find(item => item.title)?.title || '';
    const expanded = fileLibraryExpandedSeries.has(key);
    const toggleValue = escapeAttr(key);
    return `<section class="local-series-card${expanded ? ' is-expanded' : ''}">
      <button class="local-series-summary" type="button" data-action="toggle-library-series" data-series-key="${toggleValue}" aria-expanded="${expanded}" aria-label="${expanded ? '收起' : '展开'} ${escapeAttr(librarySeriesLabel(lead))} 的版本列表">
        <span class="local-series-toggle" aria-hidden="true">▸</span>
        <span class="local-series-main">
          <strong class="local-series-code">${escapeHtml(librarySeriesLabel(lead))}</strong>
          ${title ? `<span class="local-series-title">${escapeHtml(title)}</span>` : ''}
        </span>
        <span class="local-series-meta">${versionCount} 个版本 · ${groupItems.length} 个文件</span>
      </button>
      <div class="local-series-children"${expanded ? '' : ' hidden'}>${groupItems.map(item => renderFileRow(item, true)).join('')}</div>
    </section>`;
  }).join('');
  renderFileLibraryPager();
  updateLocalSelectionUi();
}

function toggleFileLibrarySeries(seriesKey) {
  if (fileLibraryExpandedSeries.has(seriesKey)) fileLibraryExpandedSeries.delete(seriesKey);
  else fileLibraryExpandedSeries.add(seriesKey);
  renderFileLibrary();
}

function renderFileLibraryPager() {
  const pager = document.getElementById('fileLibraryPager');
  if (!pager) return;
  const totalPages = Math.max(1, Math.ceil(fileLibraryTotal / fileLibraryLimit));
  if (fileLibraryTotal <= fileLibraryLimit) { pager.innerHTML = ''; return; }
  const start = Math.max(1, fileLibraryPage - 2);
  const end = Math.min(totalPages, start + 4);
  const pages = [];
  for (let page = start; page <= end; page++) {
    pages.push(`<button class="btn btn-sm btn-ghost${page === fileLibraryPage ? ' active' : ''}" data-action="library-page" data-page="${page}" ${page === fileLibraryPage ? 'disabled' : ''}>${page}</button>`);
  }
  pager.innerHTML = `<span>第 ${fileLibraryPage} / ${totalPages} 页 · 共 ${fileLibraryTotal} 项</span><div><button class="btn btn-sm btn-ghost" data-action="library-page" data-page="${fileLibraryPage - 1}" ${fileLibraryPage <= 1 ? 'disabled' : ''}>上一页</button>${pages.join('')}<button class="btn btn-sm btn-ghost" data-action="library-page" data-page="${fileLibraryPage + 1}" ${fileLibraryPage >= totalPages ? 'disabled' : ''}>下一页</button></div>`;
}

async function loadFileLibraryBadges(requestSeq) {
  const stdCodes = [...new Set(fileLibraryItems.filter(item => item.kind === 'library' && item.standardNumber).map(item => item.standardNumber))];
  if (!stdCodes.length) return;
  if (typeof fetchQualBadges === 'function') {
    await fetchQualBadges(stdCodes);
    if (requestSeq === fileLibraryRequestSeq) renderFileLibrary();
  }
  if (typeof fetchCapLibBadges === 'function') await fetchCapLibBadges(stdCodes);
  if (typeof fetchNatCmaBadges === 'function') await fetchNatCmaBadges(stdCodes);
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
  const batchDownloadBtn = document.getElementById('fileLibraryBatchDownload');
  if (batchDownloadBtn) batchDownloadBtn.disabled = selectedCount === 0;
  if (checkAll) {
    const libCount = filteredFileLibraryItems().filter(f => f.kind === 'library').length;
    const allSelected = libCount > 0 && selectedCount === libCount;
    checkAll.checked = allSelected;
    checkAll.indeterminate = selectedCount > 0 && selectedCount < libCount;
    if (selectAllBtn) {
      const label = selectAllBtn.querySelector('span');
      if (label) label.textContent = allSelected ? '取消全选' : '全选';
      else selectAllBtn.textContent = allSelected ? '取消全选' : '全选';
    }
  }
}

function onLocalCheck(fileId, checked) {
  if (checked) fileLibrarySelectedIds.add(fileId);
  else fileLibrarySelectedIds.delete(fileId);
  updateLocalSelectionUi();
}

function onLocalCheckAll(checked) {
  if (checked) filteredFileLibraryItems().forEach(f => { if (f.kind === 'library') fileLibrarySelectedIds.add(f.fileId); });
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
  if (typeof openPreviewOverlay === 'function' && typeof renderPreviewWithCurrentFile === 'function') {
    openPreviewOverlay('预览');
    renderPreviewPreparing('正在打开本地标准 PDF…');
    renderPreviewWithCurrentFile('', '预览', { fileId });
    return;
  }
  window.open(`/api/files/${encodeURIComponent(fileId)}/pdf/view`, '_blank', 'noopener');
}

function downloadLocalFile(fileId, fileName) {
  const url = `/api/files/${encodeURIComponent(fileId)}/pdf/download`;
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * 文件库「批量下载到本地」：把选中的库文件逐个触发浏览器下载。
 * 注意：浏览器会拦截同时触发的多个下载，这里逐个触发并间隔 400ms，
 * 让浏览器把每个都当作独立用户手势接受。超过一定数量提示分批。
 */
async function batchDownloadLibraryFiles() {
  const ids = Array.from(fileLibrarySelectedIds);
  if (!ids.length) return;
  const MAX = 20;
  if (ids.length > MAX) {
    showToast(`一次最多下载 ${MAX} 个，请分批选择`, 'warn');
    return;
  }
  const downloadBtn = document.getElementById('fileLibraryBatchDownload');
  const downloadLabel = downloadBtn?.querySelector('span');
  if (downloadBtn) downloadBtn.disabled = true;
  if (downloadLabel) downloadLabel.textContent = '下载中…';
  let ok = 0, fail = 0;
  for (const fileId of ids) {
    try {
      // 从当前渲染的列表里拿文件名；取不到就只传 fileId（后端 Content-Disposition 兜底）
      const item = filteredFileLibraryItems().find(f => f.kind === 'library' && f.fileId === fileId);
      downloadLocalFile(fileId, item?.fileName || '');
      ok++;
    } catch (e) {
      fail++;
      console.warn('[file-library] batch download failed:', fileId, e);
    }
    // 间隔触发，避免浏览器拦截连续下载
    await new Promise(r => setTimeout(r, 400));
  }
  if (downloadBtn) downloadBtn.disabled = false;
  if (downloadLabel) downloadLabel.textContent = '批量下载';
  showToast(`已触发 ${ok} 个文件下载${fail ? `，${fail} 个失败` : ''}`, ok && !fail ? 'success' : 'warn');
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

async function copyFilePath(filePath) {
  if (!filePath) {
    showToast('暂无可复制的文件路径', 'warn');
    return;
  }
  try {
    await navigator.clipboard.writeText(filePath);
    showToast('文件路径已复制');
  } catch (e) {
    showToast('复制路径失败', 'fail');
  }
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
async function showRenameModal({ fileId, oldName }) {
  let inputValue = oldName || '';
  const bodyHtml = `
    <div style="margin-bottom:8px;font-size:12px;color:var(--text-3)">输入新文件名（保留扩展名 .pdf 可省略）</div>
    <input id="renameInput" type="text" class="library-search" style="width:100%;box-sizing:border-box" value="${escapeAttr(oldName || '')}">
    <div id="renamePreviewBox" class="rename-preview-box" style="display:none">
      <div class="rename-preview-label">按内置格式将变为：</div>
      <div id="renamePreviewName" class="rename-preview-name"></div>
      <button class="btn btn-ghost btn-sm" data-rename-action="normalize" style="margin-top:6px">套用内置格式</button>
    </div>
    <div id="renamePreviewSkip" class="rename-preview-skip" style="display:none"></div>`;
  const result = await showConfirmHtml({
    title: '重命名文件',
    bodyHtml,
    confirmText: '确认',
    wide: false,
    initialFocus: '#renameInput',
    onMount(overlay, controls) {
      const input = overlay.querySelector('#renameInput');
      const previewBox = overlay.querySelector('#renamePreviewBox');
      const previewNameEl = overlay.querySelector('#renamePreviewName');
      const skipEl = overlay.querySelector('#renamePreviewSkip');
      input?.addEventListener('input', () => { inputValue = input.value; });
      input?.addEventListener('keydown', event => {
        if (event.key === 'Enter') { event.preventDefault(); inputValue = input.value; controls.finish(true); }
      });
      overlay.querySelector('[data-rename-action="normalize"]')?.addEventListener('click', () => controls.finish('normalize'));
      if (input) { inputValue = input.value; input.select(); }

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
    },
  });
  if (result === 'normalize') return { normalize: true };
  if (!result) return null;
  return { fileName: inputValue };
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
    onMount(overlay, controls) {
      const body = overlay.querySelector('.confirm-body');
      const switchScope = (nextScope) => {
        if (nextScope === scope) return;
        controls.finish(false);
        setTimeout(() => openNormalizeModal({ scope: nextScope, selectedIds }), 220);
      };
      // chip 切换 scope
      overlay.querySelectorAll('[data-normalize-scope]').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          switchScope(btn.getAttribute('data-normalize-scope'));
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
            btn.addEventListener('click', (e2) => {
              e2.stopPropagation();
              switchScope(btn.getAttribute('data-normalize-scope'));
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
    showLibraryBanner(failN ? '已重命名 ' + okN + ' 项，<b>' + failN + ' 项失败</b>' : '已重命名 ' + okN + ' 项', failN ? 'warn' : 'success');
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
    const failedNames = (data.failed || []).map(function (f) { return f.fileName || f; }).join('、');
    fileLibrarySelectedIds.clear();
    if (failN) {
      showLibraryBanner('已删 ' + okN + ' 个，<b>' + failN + ' 个失败</b>' + (failedNames ? '：' + escapeHtml(failedNames) : ''), 'warn');
    } else {
      showLibraryBanner('已删 ' + okN + ' 个文件', 'success');
    }
    refreshFileLibrary();
  } catch (e) {
    showToast(`批量删除失败: ${e.message}`, 'fail');
  }
}

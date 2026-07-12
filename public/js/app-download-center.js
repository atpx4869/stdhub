// ── Download Center & Helpers ──
let downloadAborted = false;
let downloadTaskSeq = 0;
const DOWNLOAD_TASK_STORAGE_KEY = 'bzxz_download_tasks_v1';

function restoreDownloadTasks() {
  try {
    const tasks = JSON.parse(localStorage.getItem(DOWNLOAD_TASK_STORAGE_KEY) || '[]');
    return Array.isArray(tasks) ? tasks.map(task => task.status === 'running'
      ? { ...task, status: 'fail', error: '页面已刷新，请重新发起下载', progress: '页面已刷新，任务状态未知' }
      : task).slice(0, 30) : [];
  } catch {
    return [];
  }
}

function persistDownloadTasks() {
  try {
    localStorage.setItem(DOWNLOAD_TASK_STORAGE_KEY, JSON.stringify(downloadTasks.slice(0, 30).map(({ retry, ...task }) => task)));
  } catch { /* Ignore unavailable storage. */ }
}

let downloadTasks = restoreDownloadTasks();
let lastBatchFailedItems = [];

const TASK_TYPE_LABELS = {
  download: '下载',
  sync: '同步',
  export: '导出',
};

function createTaskCenterTask(task) {
  const type = task?.type || 'download';
  return createDownloadTask({
    mode: task?.mode || TASK_TYPE_LABELS[type] || '任务',
    ...task,
  });
}

function updateTaskCenterTask(id, patch) {
  updateDownloadTask(id, patch);
}

function completeTaskCenterTask(id, status, patch = {}) {
  completeDownloadTask(id, status, patch);
}

function renderMobileTaskDock(running, failed) {
  const dock = document.getElementById('mobileTaskDock');
  if (!dock) return;
  const total = running + failed;
  dock.hidden = total === 0;
  dock.classList.toggle('warn', failed > 0);
  dock.textContent = failed ? `任务中心 · ${failed} 项需处理` : `任务进行中 · ${running} 项`;
}

let serverTaskHistory = [];
async function loadServerTaskHistory() {
  try { const data = await readApiResponse(await fetch('/api/stats/activity?limit=30')); serverTaskHistory = (data.items || []).filter(item => ['download', 'complete'].includes(item.eventType)); renderDownloadCenter(); } catch { /* History is optional when stats access is unavailable. */ }
}
function toggleDownloadCenter(force) {
  const panel = document.getElementById('downloadCenterPanel');
  if (!panel) return;
  const open = typeof force === 'boolean' ? force : !panel.classList.contains('open');
  panel.classList.toggle('open', open);
  if (open) loadServerTaskHistory();
}

function createDownloadTask(task) {
  const id = ++downloadTaskSeq;
  downloadTasks.unshift({
    id,
    status: 'running',
    progress: '排队中',
    startedAt: Date.now(),
    updatedAt: Date.now(),
    ...task,
  });
  renderDownloadCenter();
  return id;
}

function updateDownloadTask(id, patch) {
  const task = downloadTasks.find(t => t.id === id);
  if (!task) return;
  Object.assign(task, patch, { updatedAt: Date.now() });
  renderDownloadCenter();
}

function completeDownloadTask(id, status, patch = {}) {
  updateDownloadTask(id, { status, finishedAt: Date.now(), percent: status === 'success' ? 100 : undefined, phase: status === 'success' ? 'complete' : 'failed', ...patch });
}

function applyDownloadProgress(id, update) {
  const percent = Number.isFinite(update?.percent) ? Math.max(0, Math.min(100, Math.round(update.percent))) : undefined;
  updateDownloadTask(id, {
    progress: formatDownloadProgress(update),
    phase: update?.phase,
    source: update?.source,
    serverTaskId: update?.serverTaskId,
    current: update?.current,
    total: update?.total,
    percent,
  });
}

function formatDownloadProgress(update) {
  if (typeof update === 'string') return update;
  if (!update) return '';
  const source = update.source ? `${srcLabel(update.source)} ` : '';
  const label = { queued: '排队中', connecting: '连接来源', downloading: '下载中', verifying: '校验文件', saving: '正在入库', complete: '下载完成', failed: '下载失败' }[update.phase] || update.phase || '处理中';
  const pages = update.current && update.total ? ` · ${update.current}/${update.total} 页` : '';
  return update.text || `${source}${label}${pages}`;
}

async function cancelDownloadTask(id) {
  const task = downloadTasks.find(t => t.id === id);
  if (!task?.cancel) return;
  updateDownloadTask(id, { progress: '正在取消...' });
  try { await task.cancel(); } catch { updateDownloadTask(id, { progress: '取消请求失败，请稍后重试' }); }
}

function retryDownloadTask(id) {
  const task = downloadTasks.find(t => t.id === id);
  if (!task?.retry) return;
  task.retry();
}

function clearCompletedDownloadTasks() {
  downloadTasks = downloadTasks.filter(t => t.status !== 'success');
  renderDownloadCenter();
}

function renderDownloadCenter() {
  const body = document.getElementById('downloadCenterBody');
  const summary = document.getElementById('downloadCenterSummary');
  const badge = document.getElementById('downloadCenterBadge');
  if (!body || !summary || !badge) return;

  const running = downloadTasks.filter(t => t.status === 'running').length;
  const failed = downloadTasks.filter(t => t.status === 'fail').length;
  const done = downloadTasks.filter(t => t.status === 'success').length;
  persistDownloadTasks();
  renderMobileTaskDock(running, failed);
  badge.textContent = String(running || failed || downloadTasks.length);
  badge.classList.toggle('warn', failed > 0);
  summary.innerHTML = downloadTasks.length
    ? `<span>${running} 进行中</span><span>${done} 成功</span><span class="${failed ? 'bad' : ''}">${failed} 失败</span><button class="mini-link" onclick="clearCompletedDownloadTasks()">清理完成项</button>`
    : '暂无任务';

  const type = document.getElementById('taskHistoryType')?.value || '';
  const result = document.getElementById('taskHistoryResult')?.value || '';
  const history = serverTaskHistory.filter(item => (!type || item.eventType === type) && (!result || item.result === result)).map(item => `<div class="download-task ${item.result === 'fail' ? 'fail' : 'success'}"><div class="download-task-main"><div class="download-task-title">${escapeHtml(item.label || item.standardId || (item.eventType === 'download' ? '下载任务' : '导出任务'))}</div><div class="download-task-meta"><span>${escapeHtml(item.eventType === 'download' ? '下载' : '导出')}</span><span>${escapeHtml(item.createdAt || '')}</span></div><div class="download-task-progress">${escapeHtml(item.error || (item.result === 'fail' ? '任务失败' : '已完成'))}</div></div></div>`).join('');
  if (!downloadTasks.length && !history) {
    body.innerHTML = '<div class="download-center-empty">下载、同步和导出任务会显示在这里。</div>';
    return;
  }

  body.innerHTML = downloadTasks.map(task => {
    const elapsed = ((Date.now() - task.startedAt) / 1000).toFixed(0);
    const size = task.fileSize ? ` · ${formatSize(task.fileSize)}` : '';
    const sources = (task.sources || []).map(s => `<span class="source-badge source-${escapeHtml(s)}">${escapeHtml(srcLabel(s))}</span>`).join('');
    const cancel = task.status === 'running' && task.cancel ? `<button class="btn btn-sm btn-ghost" onclick="cancelDownloadTask(${task.id})">取消</button>` : '';
    const retry = task.status === 'fail' && task.retry ? `<button class="btn btn-sm btn-ghost" onclick="retryDownloadTask(${task.id})">重试</button>` : '';
    const open = task.fileName ? `<button class="btn btn-sm btn-ghost" data-download-file="${escapeHtml(task.fileName)}">重下</button>` : '';
    const calculatedPercent = Number.isFinite(task.percent) ? task.percent : (task.current && task.total ? Math.round(task.current / task.total * 100) : null);
    const progressBar = calculatedPercent !== null ? `<div class="download-task-track" aria-label="下载进度 ${calculatedPercent}%"><span style="width:${calculatedPercent}%"></span></div><span class="download-task-percent">${calculatedPercent}%</span>` : '';
    return `
      <div class="download-task ${task.status}">
        <div class="download-task-main">
          <div class="download-task-title">${escapeHtml(task.label || task.standardNumber || task.standardId || '下载任务')}</div>
          <div class="download-task-meta">${sources}<span>${escapeHtml(task.mode || '')}</span><span>${elapsed}s${size}</span></div>
          <div class="download-task-progress">${escapeHtml(task.progress || task.error || '')}${progressBar}</div>
        </div>
        <div class="download-task-actions">${cancel}${retry}${open}</div>
      </div>`;
  }).join('') + history;
}

document.getElementById('taskHistoryType')?.addEventListener('change', renderDownloadCenter);
document.getElementById('taskHistoryResult')?.addEventListener('change', renderDownloadCenter);

document.addEventListener('click', e => {
  const btn = e.target.closest('[data-download-file]');
  if (!btn) return;
  triggerDownload(btn.dataset.downloadFile);
});

function findResultByAnyId(id) {
  return results.find(r => r.id === id || (r._sourceIds && Object.values(r._sourceIds).includes(id)));
}

/**
 * 下载成功后把 fileId 写回 _libraryFileIds 并刷新绿点。
 * 避免用户等到下次搜索 / library-check 才看到"已下载"提示 —— 现在按下载完按钮
 * 几百毫秒内对应行的预览按钮右上角就亮绿点。
 *
 * resultId 是搜索结果上的 r.id（也是 DOM data-id），而非 source-specific 的 srcId。
 * 4 个下载入口（单源 / 指定源 / 批量勾选 / 批量级联）拿到 winner.fileId 后统一调这里。
 */
function markLibraryHit(resultId, fileId) {
  if (!resultId || !fileId) return;
  if (typeof _libraryFileIds === 'undefined') return; // app-search.js 还没加载
  _libraryFileIds.set(resultId, fileId);
  if (typeof applyLibraryDots === 'function') applyLibraryDots();
}

function sourceFromStandardId(id) {
  return String(id || '').split(':')[0];
}

function getSourceIdForDownload(result, source, fallbackId) {
  if (result && result._sourceIds && result._sourceIds[source]) return result._sourceIds[source];
  if (fallbackId && sourceFromStandardId(fallbackId) === source) return fallbackId;
  if (result && result.source === source) return result.id;
  return '';
}

// readApiResponse is now defined in app-core.js (loaded before this file).

function downloadErrorMessage(label, res, data) {
  const meta = data?.meta || {};
  // libraryError 优先 —— 后端 status:'library_failed' 时这是唯一能解释「下下来但没入库」
  // 的字段；如果用 data.status 兜底用户只会看到 "BW library_failed" 这种没营养的提示。
  const base = data?.libraryError
    ? `入库失败: ${data.libraryError}`
    : meta.error || data?.message || data?.error || data?.status || `HTTP${res.status}`;
  const suffix = res.ok ? '' : ` (HTTP${res.status})`;
  return `${label} ${base}${suffix}`;
}

function getOrderedDownloadSourcesForResult(r) {
  const available = (r?.sources || [r?._source]).filter(Boolean);
  const enabled = new Set(downloadSources);
  const ordered = [...downloadPriority, ...available.filter(s => !downloadPriority.includes(s))];
  return [...new Set(ordered)].filter(s => enabled.has(s) && available.includes(s));
}

renderDownloadCenter();

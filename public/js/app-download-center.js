// ── Download Center & Helpers ──
let downloadAborted = false;
let downloadTaskSeq = 0;
const DOWNLOAD_TASK_STORAGE_KEY = 'bzxz_download_tasks_v1';
const MAX_PERSISTED_TASK_ID = 1_000_000_000;

function restoreDownloadTasks() {
  try {
    const tasks = JSON.parse(localStorage.getItem(DOWNLOAD_TASK_STORAGE_KEY) || '[]');
    if (!Array.isArray(tasks)) return [];
    const cutoff = Date.now() - 24 * 60 * 60 * 1000; // 超过24小时的失败/成功任务自动清理
    return tasks
      .map(task => task.status === 'running'
        ? { ...task, status: 'fail', error: '页面已刷新，请重新发起下载', progress: '页面已刷新，任务状态未知' }
        : task)
      .filter(task => task.status === 'running' || (task.startedAt || task.updatedAt || 0) > cutoff)
      .slice(0, 30);
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
downloadTaskSeq = downloadTasks.reduce((maxId, task) => {
  const id = task && task.id;
  return Number.isSafeInteger(id) && id > maxId && id <= MAX_PERSISTED_TASK_ID ? id : maxId;
}, 0);
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

function createDownloadTask(task) {
  let id = downloadTaskSeq;
  do {
    id = id >= Number.MAX_SAFE_INTEGER ? 1 : id + 1;
  } while (downloadTasks.some(existing => existing && existing.id === id));
  downloadTaskSeq = id;
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
  downloadTasks = downloadTasks.filter(t => t.status === 'running');
  renderDownloadCenter();
}

function renderDownloadCenter() {
  persistDownloadTasks();
}

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

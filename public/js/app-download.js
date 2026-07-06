// ── Download functions ──
let downloadAborted = false;
let downloadTaskSeq = 0;
let downloadTasks = [];
let lastBatchFailedItems = [];

function toggleDownloadCenter(force) {
  const panel = document.getElementById('downloadCenterPanel');
  if (!panel) return;
  const open = typeof force === 'boolean' ? force : !panel.classList.contains('open');
  panel.classList.toggle('open', open);
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
  updateDownloadTask(id, { status, finishedAt: Date.now(), ...patch });
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
  badge.textContent = String(running || failed || downloadTasks.length);
  badge.classList.toggle('warn', failed > 0);
  summary.innerHTML = downloadTasks.length
    ? `<span>${running} 进行中</span><span>${done} 成功</span><span class="${failed ? 'bad' : ''}">${failed} 失败</span><button class="mini-link" onclick="clearCompletedDownloadTasks()">清理完成项</button>`
    : '暂无下载任务';

  if (!downloadTasks.length) {
    body.innerHTML = '<div class="download-center-empty">下载任务会显示在这里。</div>';
    return;
  }

  body.innerHTML = downloadTasks.map(task => {
    const elapsed = ((Date.now() - task.startedAt) / 1000).toFixed(0);
    const size = task.fileSize ? ` · ${formatSize(task.fileSize)}` : '';
    const sources = (task.sources || []).map(s => `<span class="source-badge source-${escapeHtml(s)}">${escapeHtml(srcLabel(s))}</span>`).join('');
    const retry = task.status === 'fail' && task.retry ? `<button class="btn btn-sm btn-ghost" onclick="retryDownloadTask(${task.id})">重试</button>` : '';
    const open = task.fileName ? `<button class="btn btn-sm btn-ghost" data-download-file="${escapeHtml(task.fileName)}">重下</button>` : '';
    return `
      <div class="download-task ${task.status}">
        <div class="download-task-main">
          <div class="download-task-title">${escapeHtml(task.label || task.standardNumber || task.standardId || '下载任务')}</div>
          <div class="download-task-meta">${sources}<span>${escapeHtml(task.mode || '')}</span><span>${elapsed}s${size}</span></div>
          <div class="download-task-progress">${escapeHtml(task.progress || task.error || '')}</div>
        </div>
        <div class="download-task-actions">${retry}${open}</div>
      </div>`;
  }).join('');
}

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

async function downloadByCurrentMode(rowId, sources, label, onProgress) {
  // 级联模式：按优先级逐源尝试，第一个成功返回；全部失败抛 AggregateError。
  // 早期版本支持 race（同时发起多源），实践证明在多用户共享出口 IP 场景下放大频控
  // 风险，且竞速"赢家"取决于源速度差异，跟"省时"诉求并不对齐。已删除。
  const errors = [];
  for (const source of sources) {
    if (downloadAborted || batchAborted) throw new Error('已中止');
    try {
      onProgress?.(`尝试 ${srcLabel(source)}...`);
      return await raceSource(rowId, source, label, onProgress);
    } catch (e) {
      errors.push(e);
      onProgress?.(`${srcLabel(source)} 失败，继续下一个来源`);
    }
  }
  throw new AggregateError(errors, '所有来源下载失败');
}

/**
 * 本地库命中场景的"下载" —— 零联网，纯文件复制。
 *
 * 复用 /api/preview/file/:id?attachment=1（已存在）：后端走纯本地流式读，
 * isInsideLibrary 二次校验，不碰任何源 adapter。
 *
 * 行为对齐普通下载：setRowDownloadState/markLibraryHit/recordDownload/Toast/history。
 * 唯一差异在 Toast 文案前缀「本地库命中」，便于用户排查「这次为什么秒完成」。
 *
 * 记录到 history 的 source 用 r.sources[0]（首选源）而非 'local'，避免
 * 历史里多出一个 source 分类污染按源统计。
 */
async function downloadFromLocal(r, fileId) {
  const sourceForHistory = (r.sources && r.sources[0]) || r._source || 'local';
  const logId = addLog(`${r.standardNumber} 本地库命中，复制...`, 'pending');
  const taskId = createDownloadTask({
    standardId: r.id,
    label: r.standardNumber,
    sources: [sourceForHistory],
    mode: '本地命中',
    retry: () => downloadOne(r.id),
  });
  setRowDownloadState(r.id, 'downloading');
  try {
    // 通过物理文件名走 fetch + HEAD-less 拉取（用 GET 拿 Content-Disposition 反解文件名）
    const res = await fetch(`/api/preview/file/${fileId}?attachment=1`);
    if (!res.ok) throw new Error(`HTTP${res.status}`);
    const disposition = res.headers.get('Content-Disposition') || '';
    let fileName = r.standardNumber + '.pdf';
    const utf8m = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
    if (utf8m) {
      try { fileName = decodeURIComponent(utf8m[1]); } catch {}
    }
    const fileSize = Number(res.headers.get('Content-Length')) || undefined;
    setRowDownloadState(r.id, 'success');
    markLibraryHit(r.id, fileId);
    // 用 downloadLocalFile 而不是 triggerDownload：后者在 Electron 时直接 return（避免
    // 「源下载完已 rename 进库 + 再 will-download 拷一份」的双副本问题），但本地命中场景
    // 文件本来就在库里，没有 rename 这步 —— Electron 用户**需要**触发 will-download 把
    // 库里那份复制一份到 Desktop/bzxz/（用户自己的「我下载的文件」位置），跟普通下载体验一致。
    downloadLocalFile(fileId, fileName);
    recordDownload(sourceForHistory, fileName, r.standardNumber);
    updateLog(logId, `${r.standardNumber} ✅ 本地库命中 ${fileName}`, 'success');
    completeDownloadTask(taskId, 'success', { source: sourceForHistory, fileName, fileSize, progress: '本地库命中' });
    showToast(`本地库命中，复制完成: ${fileName}`);
  } catch (e) {
    const msg = e?.message || '本地复制失败';
    // 本地命中失败几乎只有「文件被用户在资源管理器里删了 / 移走了」一种可能 ——
    // 这种降级到走源是正确做法，否则用户体验等于「绿点亮着但下载按钮罢工」。
    updateLog(logId, `${r.standardNumber} 本地复制失败：${msg}，回退源下载`, 'pending');
    completeDownloadTask(taskId, 'fail', { error: msg, progress: '本地复制失败，回退源下载' });
    // 清掉脏缓存，downloadOne 重入时不会再触发本地短路
    if (typeof _libraryFileIds !== 'undefined') _libraryFileIds.delete(r.id);
    if (typeof applyLibraryDots === 'function') applyLibraryDots();
    return downloadOne(r.id);
  }
}

function summarizeDownloadError(e) {
  if (e instanceof AggregateError) {
    return [...new Set(e.errors.map(err => err.message || String(err)))].slice(0, 3).join('; ');
  }
  return e?.message || '未知错误';
}

async function downloadOne(id, btn) {
  const r = findResultByAnyId(id); if (!r) return;
  downloadAborted = false;

  // 本地优先短路：命中绿点 + 用户没关 download_prefer_local 时走本地文件直发，
  // 跳过所有源 adapter。labr/by/gbw 有日配额，命中场景里再发一遍请求纯属浪费。
  // 「指定来源下载」不走这里（用户明确指定源 = 隐含「我要这个源的版本」语义）。
  // 默认 true：用户原话"本地有就优先本地"。 admin 在「文件库」设置区可关。
  const preferLocal = !window.bzxzPublicSettings || window.bzxzPublicSettings.downloadPreferLocal !== false;
  const localFid = (typeof _libraryFileIds !== 'undefined') ? _libraryFileIds.get(r.id) : null;
  if (preferLocal && localFid) {
    return downloadFromLocal(r, localFid);
  }

  const sources = getOrderedDownloadSourcesForResult(r);
  if (!sources.length) { addLog(`${r.standardNumber} 无可用下载源`, 'fail'); return; }
  setRowDownloadState(r.id, 'downloading');
  const logId = addLog(`${r.standardNumber} 下载 [${sources.map(s => srcLabel(s)).join(' → ')}]`, 'pending');
  const taskId = createDownloadTask({
    standardId: r.id,
    label: r.standardNumber,
    sources,
    mode: '级联',
    retry: () => downloadOne(id),
  });
  try {
    const winner = await downloadByCurrentMode(r.id, sources, r.standardNumber, (msg) => {
      updateLog(logId, msg, 'pending');
      updateDownloadTask(taskId, { progress: msg });
    });
    const sizeStr = winner.fileSize ? ` ${formatSize(winner.fileSize)}` : '';
    updateLog(logId, `${r.standardNumber} ✅ ${srcLabel(winner.source)}完成 ${winner.fileName}${sizeStr}`, 'success');
    setRowDownloadState(r.id, 'success');
    markLibraryHit(r.id, winner.fileId);
    if (winner.fileName) { triggerDownload(winner.fileName); recordDownload(winner.source, winner.fileName, r.standardNumber); }
    completeDownloadTask(taskId, 'success', { source: winner.source, fileName: winner.fileName, fileSize: winner.fileSize, progress: `${srcLabel(winner.source)} 下载完成` });
    showToast(`${srcLabel(winner.source)} 下载完成: ${winner.fileName || r.standardNumber}`);
  } catch (e) {
    const msgs = summarizeDownloadError(e);
    updateLog(logId, `${r.standardNumber} ❌ ${msgs}`, 'fail');
    setRowDownloadState(r.id, 'fail');
    completeDownloadTask(taskId, 'fail', { error: msgs, progress: msgs });
    showToast(`下载失败: ${msgs}`, 'fail', 7000);
  }
}

async function downloadSpecificSource(id, source, btn) {
  const r = findResultByAnyId(id);
  const label = r?.standardNumber || id;
  const rowId = r?.id || id;
  downloadAborted = false;
  const originalText = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = '下载中'; }
  setRowDownloadState(rowId, 'downloading');

  // 构建重试源列表：先尝试指定源，失败后按优先级尝试其他源
  const allSources = getOrderedDownloadSourcesForResult(r);
  const retrySources = [source, ...allSources.filter(s => s !== source)];

  const logId = addLog(`${label} 尝试 ${retrySources.map(s => srcLabel(s)).join(' → ')}...`, 'pending');
  const taskId = createDownloadTask({
    standardId: r.id,
    label,
    sources: retrySources,
    mode: '级联重试',
    retry: () => downloadSpecificSource(id, source),
  });

  const errors = [];
  for (const src of retrySources) {
    if (downloadAborted) break;
    const srcId = getSourceIdForDownload(r, src, id);
    if (!srcId) continue;

    try {
      onProgress => updateLog(logId, `尝试 ${srcLabel(src)}...`, 'pending');
      const result = await raceSource(srcId, src, label, (msg) => {
        updateLog(logId, msg, 'pending');
        updateDownloadTask(taskId, { progress: msg });
      });
      const sizeStr = result.fileSize ? ` ${formatSize(result.fileSize)}` : '';
      updateLog(logId, `${label} ✅ ${srcLabel(result.source)} ${result.fileName || ''}${sizeStr}`, 'success');
      setRowDownloadState(rowId, 'success');
      markLibraryHit(rowId, result.fileId);
      if (result.fileName) { triggerDownload(result.fileName); recordDownload(result.source, result.fileName, label); }
      completeDownloadTask(taskId, 'success', { source: result.source, fileName: result.fileName, fileSize: result.fileSize, progress: `${srcLabel(result.source)} 下载完成` });
      showToast(`${srcLabel(result.source)} 下载完成: ${result.fileName || label}`);
      return;
    } catch (e) {
      errors.push(e);
      updateLog(logId, `${srcLabel(src)} 失败，尝试下一个来源...`, 'pending');
    }
  }

  // 所有源都失败
  const msgs = summarizeDownloadError(new AggregateError(errors, '所有来源下载失败'));
  updateLog(logId, `${label} ❌ ${msgs}`, 'fail');
  setRowDownloadState(rowId, 'fail');
  completeDownloadTask(taskId, 'fail', { error: msgs, progress: msgs });
  showToast(`下载失败: ${msgs}`, 'fail', 7000);
  if (btn) { btn.disabled = false; btn.textContent = originalText || '下载'; }
}

function raceSource(standardId, source, label, onProgress) {
  // Use source-specific ID if available (from multi-source search dedup)
  const r = findResultByAnyId(standardId);
  const srcId = (r && r._sourceIds && r._sourceIds[source]) || standardId;
  switch (source) {
    case 'gbw': return downloadGbw(srcId, onProgress);
    case 'bz':  return downloadBz(srcId, onProgress);
    case 'by':    return downloadBy(srcId, onProgress);
    default: return Promise.reject(new Error(`Unknown source ${source}`));
  }
}

async function downloadGbw(id, onProgress) {
  if (onProgress) onProgress('BW 识别验证码...');
  const res = await fetch(`${API}/api/standards/${encodeURIComponent(id)}/auto-download`, { method: 'POST' });
  const data = await readApiResponse(res);
  if (!res.ok) throw new Error(downloadErrorMessage('BW', res, data));
  if (data.status === 'downloaded') {
    const meta = data.meta || {};
    // fileId 是入库后的库文件主键。后端 moveDownloadToLibrary 入库成功时填入响应；
    // 入库失败（library_failed 分支）也会走 throw 不到这里。带出来给绿点 + 预览秒开复用。
    return { source: 'gbw', fileName: meta.fileName || data.fileName || '', fileSize: meta.fileSize, fileId: data.fileId };
  }
  throw new Error(downloadErrorMessage('BW', res, data));
}

async function downloadBz(id, onProgress) {
  const res = await fetch(`${API}/api/standards/${encodeURIComponent(id)}/export`, { method: 'POST' });
  const data = await readApiResponse(res);
  if (!res.ok) throw new Error(downloadErrorMessage('BZ', res, data));
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const es = new EventSource(`${API}/api/tasks/${data.id}/stream`);
    const timeout = setTimeout(() => { es.close(); reject(new Error('BZ轮询超时')); }, 120000);
    es.onmessage = (e) => {
      const ev = parseSseEvent(e.data);
      if (!ev.ok) { clearTimeout(timeout); es.close(); reject(new Error(`BZ ${ev.error.message || '失败'}`)); return; }
      const td = ev.value;
      if (td.currentPage && td.totalPages && onProgress) onProgress(`BZ 下载 ${td.currentPage}/${td.totalPages} 页`);
      if (td.status === 'success') { clearTimeout(timeout); es.close(); const elapsed = ((Date.now() - t0) / 1000).toFixed(1); const sizeStr = td.fileSize ? ` ${formatSize(td.fileSize)}` : ''; resolve({ source: 'bz', fileName: td.fileName || '', fileSize: td.fileSize, fileId: td.fileId, meta: `${elapsed}s${sizeStr}` }); }
      if (td.status === 'failed') { clearTimeout(timeout); es.close(); reject(new Error(`BZ ${td.errorMessage || '失败'}`)); }
    };
    es.onerror = () => { clearTimeout(timeout); es.close(); reject(new Error('BZ SSE连接失败')); };
  });
}

async function downloadBy(id, onProgress) {
  const res = await fetch(`${API}/api/standards/${encodeURIComponent(id)}/export`, { method: 'POST' });
  const data = await readApiResponse(res);
  if (!res.ok) throw new Error(downloadErrorMessage('BY', res, data));
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const es = new EventSource(`${API}/api/tasks/${data.id}/stream`);
    const timeout = setTimeout(() => { es.close(); reject(new Error('BY轮询超时')); }, 60000);
    es.onmessage = (e) => {
      const ev = parseSseEvent(e.data);
      if (!ev.ok) { clearTimeout(timeout); es.close(); reject(new Error(`BY ${ev.error.message || '失败'}`)); return; }
      const td = ev.value;
      if (td.status === 'running' && onProgress) onProgress('BY 下载中...');
      if (td.status === 'success') { clearTimeout(timeout); es.close(); const elapsed = ((Date.now() - t0) / 1000).toFixed(1); const sizeStr = td.fileSize ? ` ${formatSize(td.fileSize)}` : ''; resolve({ source: 'by', fileName: td.fileName || '', fileSize: td.fileSize, fileId: td.fileId, meta: `${elapsed}s${sizeStr}` }); }
      if (td.status === 'failed') { clearTimeout(timeout); es.close(); reject(new Error(`BY ${td.errorMessage || '失败'}`)); }
    };
    es.onerror = () => { clearTimeout(timeout); es.close(); reject(new Error('BY SSE连接失败')); };
  });
}

function stopAllDownloads() { downloadAborted = true; addLog('⏹ 中止下载', 'fail'); }

document.getElementById('downloadSelected').addEventListener('click', async () => {
  if (isDownloading) return;
  isDownloading = true; downloadAborted = false;
  document.getElementById('downloadSelected').disabled = true;
  document.getElementById('stopDownload').style.display = 'inline-block';
  const selected = results.filter(r => selectedIds.has(r.id));
  const total = selected.length; let completed = 0, success = 0, failed = 0; const wins = {};
  const t0 = Date.now();
  const progress = document.getElementById('progressWrap'); const fill = document.getElementById('progressFill');
  const progressText = document.getElementById('progressText');
  progress.classList.add('visible');
  const queue = [...selected];
  const started = Date.now();
  function updateProgress() {
    const elapsed = ((Date.now() - started) / 1000).toFixed(0);
    fill.style.width = `${(completed / total) * 100}%`;
    progressText.textContent = `${completed}/${total} · ${downloadConcurrency}并发 · ${elapsed}s`;
  }
  async function worker() {
    while (queue.length > 0 && !downloadAborted) {
      const item = queue.shift();
      const sources = getOrderedDownloadSourcesForResult(item);
      if (!sources.length) { completed++; failed++; updateProgress(); continue; }
      setRowDownloadState(item.id, 'downloading');
      const logId = addLog(`${item.standardNumber} 下载 [${sources.map(s => srcLabel(s)).join(' → ')}]`, 'pending');
      const taskId = createDownloadTask({
        standardId: item.id,
        label: item.standardNumber,
        sources,
        mode: '级联',
        retry: () => downloadOne(item.id),
      });
      try {
        const winner = await downloadByCurrentMode(item.id, sources, item.standardNumber, (msg) => {
          updateLog(logId, msg, 'pending');
          updateDownloadTask(taskId, { progress: msg });
        });
        success++; wins[winner.source] = (wins[winner.source] || 0) + 1;
        const sizeStr = winner.fileSize ? ` ${formatSize(winner.fileSize)}` : '';
        updateLog(logId, `${item.standardNumber} ✅ ${srcLabel(winner.source)}完成 ${winner.fileName}${sizeStr}`, 'success');
        setRowDownloadState(item.id, 'success');
        markLibraryHit(item.id, winner.fileId);
        if (winner.fileName) { triggerDownload(winner.fileName); recordDownload(winner.source, winner.fileName, item.standardNumber); }
        completeDownloadTask(taskId, 'success', { source: winner.source, fileName: winner.fileName, fileSize: winner.fileSize, progress: `${srcLabel(winner.source)} 下载完成` });
      } catch (e) {
        failed++;
        const msgs = summarizeDownloadError(e);
        updateLog(logId, `${item.standardNumber} ❌ ${msgs}`, 'fail');
        setRowDownloadState(item.id, 'fail');
        completeDownloadTask(taskId, 'fail', { error: msgs, progress: msgs });
      }
      completed++; updateProgress();
    }
  }
  const workers = Array.from({ length: downloadConcurrency }, () => worker());
  await Promise.all(workers);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const winSummary = Object.entries(wins).map(([k, v]) => `${srcLabel(k)}:${v}`).join(' ');
  addLog(`完成 ${success}/${total} · ${elapsed}s · ${winSummary || '无'}`, 'success');
  if (success > 0) showToast(`下载完成 ${success}/${total} · ${elapsed}s`);
  setTimeout(() => { progress.classList.remove('visible'); fill.style.width = '0%'; progressText.textContent = ''; }, 2000);
  document.getElementById('stopDownload').style.display = 'none'; isDownloading = false; updateToolbar();
});
document.getElementById('stopDownload').addEventListener('click', stopAllDownloads);

// ── Batch download (floating panel) ──
let batchResolved = [], batchUnmatched = [], batchDownloading = false, batchAborted = false;

function updateBatchSourceHint() {
  const sources = downloadPriority.filter(s => downloadSources.includes(s));
  const labels = { gbw: 'BW', by: 'BY', bz: 'BZ' };
  const el = document.getElementById('batchSourceHint');
  if (el) el.textContent = `级联顺序：${sources.map(s => labels[s]||s).join(' → ')}（超时 ${downloadTimeout}s）`;
}

function getBatchAvailableSources(item) {
  const ids = item?.sourceIds || item?._sourceIds || {};
  const available = item?.sources?.length ? item.sources : Object.keys(ids);
  const ordered = [...downloadPriority, ...available.filter(s => !downloadPriority.includes(s))];
  const list = [...new Set(ordered)].filter(s => available.includes(s) || ids[s] || s === item?.source);
  return list.length ? list : [item?.source].filter(Boolean);
}

function getBatchSourceIds(item, sources) {
  const result = typeof results !== 'undefined'
    ? results.find(r => r.id === item.standardId || (r._sourceIds && Object.values(r._sourceIds).includes(item.standardId)))
    : null;
  const ids = item.sourceIds || item._sourceIds || {};
  const sourceIds = {};
  sources.forEach(s => {
    const srcId = ids[s] || getSourceIdForDownload(result, s, item.standardId) || (s === item.source ? item.standardId : '');
    if (srcId) sourceIds[s] = srcId;
  });
  return sourceIds;
}

function setBatchCardState(standardId, state, message = '') {
  const card = [...document.querySelectorAll('#batchResults .batch-result-card[data-standard-id]')]
    .find(el => el.dataset.standardId === standardId);
  if (!card) return;
  card.classList.remove('is-downloading', 'is-success', 'is-fail');
  if (state) card.classList.add(`is-${state}`);
  const note = card.querySelector('[data-batch-note]');
  if (note) note.textContent = message || ({ downloading: '下载中', success: '已完成', fail: '失败' }[state] || '');
}

async function doBatchResolve() {
  const raw = document.getElementById('batchInput').value;
  const lines = raw.split(/[\n\r]+/).map(s => s.trim()).filter(Boolean);
  if (!lines.length) { addLog('请粘贴标准号', 'fail'); return; }
  document.getElementById('batchResolveBtn').disabled = true;
  document.getElementById('batchResolveBtn').innerHTML = '<span class="spinner"></span>解析中';
  document.getElementById('batchSummary').innerHTML = '解析中...';
  document.getElementById('batchResults').innerHTML = '<div class="batch-results-empty">正在按来源优先级匹配标准号...</div>';
  batchResolved = []; batchUnmatched = []; lastBatchFailedItems = [];
  try {
    const sources = downloadPriority.filter(s => downloadSources.includes(s));
    const res = await fetch(`${API}/api/standards/resolve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lines, sources }) });
    const data = await readApiResponse(res);
    batchResolved = data.resolved || []; batchUnmatched = data.unmatched || [];
    document.getElementById('batchSummary').innerHTML = `解析完成 · 匹配 ${batchResolved.length} / 未匹配 ${batchUnmatched.length} / 总计 ${lines.length}`;
    renderBatchResults();
    addLog(`批量解析: ${batchResolved.length} 匹配, ${batchUnmatched.length} 未匹配`, 'success');
  } catch (e) {
    document.getElementById('batchSummary').innerHTML = `<span style="color:var(--danger)">解析失败</span>`;
    document.getElementById('batchResults').innerHTML = `<div class="batch-results-empty fail">解析失败: ${escapeHtml(e.message)}</div>`;
    addLog(`解析失败: ${e.message}`, 'fail');
  }
  document.getElementById('batchResolveBtn').disabled = false;
  document.getElementById('batchResolveBtn').innerHTML = '解析标准号';
}

function renderBatchResults() {
  const total = batchResolved.length + batchUnmatched.length;
  const summary = total ? `
    <div class="batch-stats">
      <div class="batch-stat"><strong>${batchResolved.length}</strong><span>已匹配</span></div>
      <div class="batch-stat ${batchUnmatched.length ? 'warn' : ''}"><strong>${batchUnmatched.length}</strong><span>未匹配</span></div>
      <div class="batch-stat"><strong>${total}</strong><span>总计</span></div>
    </div>` : '';
  const resolvedCards = batchResolved.map((r, i) => {
    const available = getBatchAvailableSources(r);
    const sourceTitle = available.map(srcLabel).join(' → ');
    return `
    <div class="batch-result-card" data-standard-id="${escapeHtml(r.standardId)}">
      <input type="checkbox" id="br_${i}" data-batch-index="${i}" checked onchange="updateBatchToolbar()">
      <span class="card-num" title="${escapeHtml(r.standardNumber)}">${escapeHtml(r.standardNumber)}</span>
      <span class="card-title" title="${escapeHtml(r.title)}">${escapeHtml(r.title)}</span>
      <span class="card-src" title="可下载来源：${escapeHtml(sourceTitle)}">${escapeHtml(sourceTitle)}</span>
      <span class="batch-result-note" data-batch-note>待下载</span>
    </div>`;
  }).join('');
  const unmatchedCards = batchUnmatched.map(u => `
    <div class="batch-result-card unmatched">
      <span class="card-num">${escapeHtml(u.input)}</span>
      <span class="card-title">${escapeHtml(u.reason)}</span>
    </div>`).join('');
  const toolbar = batchResolved.length > 0 ? `
    <div class="batch-toolbar">
      <span class="badge-count" id="batchSelectedCount">已选 ${batchResolved.length}</span>
      <button class="btn btn-sm btn-primary" id="batchDownloadBtn" onclick="doBatchDownload()">下载选中</button>
      <button class="btn btn-sm btn-ghost" id="batchStopBtn" onclick="stopBatchDownload()" style="display:none;color:var(--danger);border-color:var(--danger)">停止</button>
      <button class="btn btn-sm btn-ghost" id="batchRetryFailedBtn" onclick="retryFailedBatchDownload()" disabled>重试失败项</button>
      <button class="btn btn-sm btn-ghost" onclick="toggleBatchSelect()">全选/取消</button>
    </div>` : '';
  document.getElementById('batchResults').innerHTML = summary + toolbar + `<div class="batch-results-list">${resolvedCards + unmatchedCards}</div>`;
  updateBatchSourceHint();
  updateBatchToolbar();
}

function toggleBatchSelect() {
  const checks = document.querySelectorAll('#batchResults input[type="checkbox"]');
  const allChecked = [...checks].every(c => c.checked);
  checks.forEach(c => { c.checked = !allChecked; });
  updateBatchToolbar();
}

function updateBatchToolbar() {
  const checks = document.querySelectorAll('#batchResults input[type="checkbox"]:checked');
  const el = document.getElementById('batchSelectedCount');
  if (el) el.textContent = `已选 ${checks.length}`;
  const retry = document.getElementById('batchRetryFailedBtn');
  if (retry) retry.disabled = batchDownloading || lastBatchFailedItems.length === 0;
}

async function doBatchDownload() {
  return doCascadeDownload();
}

async function doCascadeDownload() {
  if (batchDownloading) return;
  batchDownloading = true; batchAborted = false;
  const checks = document.querySelectorAll('#batchResults input[type="checkbox"]:checked');
  const items = []; checks.forEach(c => { items.push(batchResolved[Number(c.dataset.batchIndex)]); });
  if (!items.length) { batchDownloading = false; return; }
  document.getElementById('batchDownloadBtn').disabled = true;
  document.getElementById('batchStopBtn').style.display = 'inline-block';
  document.getElementById('batchProgressWrap').classList.add('visible');
  const fill = document.getElementById('batchProgressFill'); fill.style.width = '0%';
  const progressText = document.getElementById('batchProgressText');
  const sources = downloadPriority.filter(s => downloadSources.includes(s));
  const total = items.length; let completed = 0, success = 0; const successItems = [], allFailedItems = [];
  const t0 = Date.now();
  function updateProgress() {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
    fill.style.width = `${Math.round((completed / total) * 100)}%`;
    progressText.textContent = `${completed}/${total} · ${downloadConcurrency}并发 · ${elapsed}s`;
  }

  addLog(`━━ 后端自动切源下载 (${items.length}条, 优先级: ${sources.map(s => srcLabel(s)).join(' → ')})`, 'pending');
  const queue = [...items];
  async function worker() {
    while (queue.length > 0 && !batchAborted) {
      const item = queue.shift();
      const sourceIds = getBatchSourceIds(item, sources);
      setRowDownloadState(item.standardId, 'downloading');
      setBatchCardState(item.standardId, 'downloading', '下载中');
      const logId = addLog(`${item.standardNumber} 下载中...`, 'pending');
      const taskId = createDownloadTask({
        standardId: item.standardId,
        label: item.standardNumber,
        sources,
        mode: '批量级联',
        retry: () => retryBatchItem(item),
      });
      try {
        const resp = await fetch(`${API}/api/standards/multi-download`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sourceIds, sources }),
        });
        const data = await readApiResponse(resp);
        if (resp.ok && data.status === 'downloaded') {
          const sizeStr = data.fileSize ? ` ${formatSize(data.fileSize)}` : '';
          updateLog(logId, `${item.standardNumber} ✅ ${srcLabel(data.source)} ${data.fileName || ''}${sizeStr}`, 'success');
          setRowDownloadState(item.standardId, 'success');
          setBatchCardState(item.standardId, 'success', srcLabel(data.source));
          markLibraryHit(item.standardId, data.fileId);
          success++; successItems.push(item);
          if (data.fileName) { triggerDownload(data.fileName); recordDownload(data.source, data.fileName, item.standardNumber); }
          completeDownloadTask(taskId, 'success', { source: data.source, fileName: data.fileName, fileSize: data.fileSize, progress: `${srcLabel(data.source)} 下载完成` });
        } else if (resp.ok && data.status === 'library_failed') {
          // 文件下下来了但没进库（留在 data/exports/），算失败让用户能在结果弹窗里看到原因。
          // /api/downloads/:filename 兜底仍能拉到，所以 triggerDownload 还是给用户一份本地副本。
          const errMsg = `入库失败: ${data.libraryError || '未知'}`;
          updateLog(logId, `${item.standardNumber} ⚠ ${srcLabel(data.source)} ${errMsg}`, 'fail');
          setRowDownloadState(item.standardId, 'fail');
          setBatchCardState(item.standardId, 'fail', '入库失败');
          if (data.fileName) { triggerDownload(data.fileName); recordDownload(data.source, data.fileName, item.standardNumber); }
          allFailedItems.push({ ...item, _failReason: errMsg });
          completeDownloadTask(taskId, 'fail', { error: errMsg, progress: errMsg });
        } else {
          const perSource = data.details?.perSource || data.errors;
          const errMsg = data.message || (perSource ? Object.values(perSource).join('; ') : '下载失败');
          updateLog(logId, `${item.standardNumber} ❌ ${errMsg}`, 'fail');
          setRowDownloadState(item.standardId, 'fail');
          setBatchCardState(item.standardId, 'fail', '下载失败');
          allFailedItems.push({ ...item, _failReason: errMsg });
          completeDownloadTask(taskId, 'fail', { error: errMsg, progress: errMsg });
        }
      } catch (e) {
        const msg = (e && e.message) || '请求失败';
        updateLog(logId, `${item.standardNumber} ❌ ${msg}`, 'fail');
        setRowDownloadState(item.standardId, 'fail');
        setBatchCardState(item.standardId, 'fail', '请求失败');
        allFailedItems.push({ ...item, _failReason: msg });
        completeDownloadTask(taskId, 'fail', { error: msg, progress: msg });
      }
      completed++; updateProgress();
    }
  }
  const workers = Array.from({ length: downloadConcurrency }, () => worker());
  await Promise.all(workers);
  const finalFailed = items.filter(it => !successItems.some(s => s.standardId === it.standardId));
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  addLog(`━━ 批量下载完成: ${success}/${total} 成功 (${elapsed}s)`, 'success');
  if (success > 0) showToast(`批量完成 ${success}/${total} · ${elapsed}s`);
  showBatchResultModal(successItems, allFailedItems, finalFailed, elapsed);
  batchDownloading = false;
  document.getElementById('batchDownloadBtn').disabled = false;
  document.getElementById('batchStopBtn').style.display = 'none';
  updateBatchToolbar();
}

async function doRaceDownload() {
  // 竞速模式已废弃（多用户共享出口 IP 时放大频控风险，且 race 赢家随源速度差异不稳定）。
  // 保留函数名导出以兼容旧 onclick / localStorage 状态，实际转发到级联实现。
  return doCascadeDownload();
}

function stopBatchDownload() { batchAborted = true; addLog('⏹ 中止批量下载', 'fail'); }

function raceSourceWithTimeout(standardId, source, label, timeoutMs, onProgress) {
  // 见 doRaceDownload 注释。raceSource 已经在 fetch 里通过 fetchWithTimeoutAndRetry 走超时，
  // 这里包一层 setTimeout 的逻辑跟竞速绑定，废弃后保留 thin wrapper 防止内部其它调用断链。
  return Promise.race([
    raceSource(standardId, source, label, onProgress),
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
  ]);
}

function retryBatchItem(item) {
  const idx = batchResolved.findIndex(r => r.standardId === item.standardId);
  if (idx < 0) {
    showToast('重试失败: 当前批量结果中找不到该项目', 'fail');
    return;
  }
  document.querySelectorAll('#batchResults input[type="checkbox"]').forEach(cb => {
    cb.checked = Number(cb.dataset.batchIndex) === idx;
  });
  updateBatchToolbar();
  doBatchDownload();
}

function retryFailedBatchDownload() {
  if (!lastBatchFailedItems.length) return;
  const failedIds = new Set(lastBatchFailedItems.map(item => item.standardId));
  document.querySelectorAll('#batchResults input[type="checkbox"]').forEach(cb => {
    const item = batchResolved[Number(cb.dataset.batchIndex)];
    cb.checked = Boolean(item && failedIds.has(item.standardId));
  });
  updateBatchToolbar();
  document.getElementById('modalOverlay').classList.remove('open');
  doBatchDownload();
}

function raceSourceWithTimeout(standardId, source, label, timeoutMs, onProgress) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
    const p = raceSource(standardId, source, label, onProgress);
    p.then(
      result => { clearTimeout(timer); resolve(result); },
      err => { clearTimeout(timer); reject(err); }
    );
  });
}

function showBatchResultModal(successItems, allFailedItems, finalFailed, elapsed) {
  lastBatchFailedItems = finalFailed;
  updateBatchToolbar();
  const total = successItems.length + finalFailed.length;
  const successRows = successItems.map(it => `
    <div style="display:flex;align-items:center;gap:8px;padding:6px 0;font-size:13px;border-bottom:1px solid var(--border)">
      <span style="color:var(--success)">✅</span>
      <span style="font:500 13px 'DM Mono',monospace;color:var(--accent);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(it.standardNumber)}</span>
    </div>`).join('');
  const failRows = finalFailed.map(it => `
    <div style="display:flex;align-items:flex-start;gap:8px;padding:6px 0;font-size:13px;border-bottom:1px solid var(--border)">
      <span style="color:var(--danger);flex:0 0 auto">❌</span>
      <div style="min-width:0;flex:1">
        <div style="font:500 13px 'DM Mono',monospace;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(it.standardNumber)}</div>
        ${it._failReason ? `<div style="font-size:11px;color:var(--text-3);margin-top:2px;line-height:1.4">${escapeHtml(it._failReason)}</div>` : ''}
      </div>
    </div>`).join('');
  document.getElementById('modalBody').innerHTML = `
    <h3 style="margin-bottom:16px">📊 批量下载结果</h3>
    <div style="display:flex;gap:16px;margin-bottom:20px">
      <div style="flex:1;text-align:center;padding:12px;background:oklch(68% 0.16 158 / 0.08);border-radius:var(--radius-sm)">
        <div style="font-size:24px;font-weight:600;color:var(--success)">${successItems.length}</div>
        <div style="font-size:11px;color:var(--text-3);margin-top:2px">成功</div>
      </div>
      <div style="flex:1;text-align:center;padding:12px;background:oklch(58% 0.20 25 / 0.08);border-radius:var(--radius-sm)">
        <div style="font-size:24px;font-weight:600;color:var(--danger)">${finalFailed.length}</div>
        <div style="font-size:11px;color:var(--text-3);margin-top:2px">失败</div>
      </div>
      <div style="flex:1;text-align:center;padding:12px;background:var(--surface-h);border-radius:var(--radius-sm)">
        <div style="font-size:24px;font-weight:600;color:var(--text)">${total}</div>
        <div style="font-size:11px;color:var(--text-3);margin-top:2px">总计</div>
      </div>
      <div style="flex:1;text-align:center;padding:12px;background:var(--surface-h);border-radius:var(--radius-sm)">
        <div style="font-size:24px;font-weight:600;color:var(--text-2)">${elapsed}s</div>
        <div style="font-size:11px;color:var(--text-3);margin-top:2px">耗时</div>
      </div>
    </div>
    ${successItems.length > 0 ? `<div style="margin-bottom:8px;font-size:12px;color:var(--success);font-weight:500">成功条目 (${successItems.length})</div><div style="max-height:240px;overflow-y:auto;margin-bottom:16px">${successRows}</div>` : ''}
    ${finalFailed.length > 0 ? `<div style="margin-bottom:8px;font-size:12px;color:var(--danger);font-weight:500">失败条目 (${finalFailed.length})</div><div style="max-height:200px;overflow-y:auto;margin-bottom:16px">${failRows}</div>` : ''}
    <div style="display:flex;gap:8px;margin-top:12px">
      ${finalFailed.length > 0 ? '<button class="btn btn-primary btn-sm" data-action="modal-retry-batch-failed">重试失败项</button>' : ''}
      <button class="btn btn-primary btn-sm" data-action="modal-close">关闭</button>
    </div>`;
  document.getElementById('modalOverlay').classList.add('open');
}

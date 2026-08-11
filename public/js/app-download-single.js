// ── Single Download ──
function makeDownloadProgress(source, phase, detail = {}) {
  const current = detail.current ?? detail.currentPage;
  const total = detail.total ?? detail.totalPages;
  const percent = current && total ? current / total * 100 : undefined;
  return { source, phase, current, total, percent, text: detail.text, serverTaskId: detail.serverTaskId };
}

function cancelServerDownloadTask(serverTaskId) {
  if (!serverTaskId) return Promise.resolve();
  return fetch(`${API}/api/tasks/${encodeURIComponent(serverTaskId)}/cancel`, { method: 'POST' })
    .then(readApiResponse)
    .then(() => undefined);
}

function isCancelledDownloadError(error) {
  return /已取消/.test(error?.message || String(error));
}

async function downloadByCurrentMode(rowId, sources, label, onProgress) {
  // 级联模式：按优先级逐源尝试，第一个成功返回；全部失败抛 AggregateError。
  // 早期版本支持 race（同时发起多源），实践证明在多用户共享出口 IP 场景下放大频控
  // 风险，且竞速"赢家"取决于源速度差异，跟"省时"诉求并不对齐。已删除。
  const errors = [];
  for (const source of sources) {
    if (downloadAborted || batchAborted) throw new Error('已中止');
    try {
      onProgress?.(makeDownloadProgress(source, 'connecting', { text: `尝试 ${srcLabel(source)}...` }));
      return await raceSource(rowId, source, label, onProgress);
    } catch (e) {
      errors.push(e);
      onProgress?.(makeDownloadProgress(source, 'connecting', { text: `${srcLabel(source)} 失败，继续下一个来源` }));
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
    const winner = await downloadByCurrentMode(r.id, sources, r.standardNumber, (update) => {
      updateLog(logId, formatDownloadProgress(update), 'pending');
      applyDownloadProgress(taskId, update);
      if (update.serverTaskId) updateDownloadTask(taskId, { cancel: () => cancelServerDownloadTask(update.serverTaskId) });
    });
    const sizeStr = winner.fileSize ? ` ${formatSize(winner.fileSize)}` : '';
    updateLog(logId, `${r.standardNumber} ✅ ${srcLabel(winner.source)}完成 ${winner.fileName}${sizeStr}`, 'success');
    setRowDownloadState(r.id, 'success');
    markLibraryHit(r.id, winner.fileId);
    // 默认只入库服务器，不触发浏览器下载弹窗（用户需本机副本时去任务中心/文件库手动下载）
    if (winner.fileName) { recordDownload(winner.source, winner.fileName, r.standardNumber); }
    completeDownloadTask(taskId, 'success', { source: winner.source, fileName: winner.fileName, fileSize: winner.fileSize, progress: `${srcLabel(winner.source)} 下载完成` });
    showToast(`${srcLabel(winner.source)} 下载完成: ${winner.fileName || r.standardNumber}`);
  } catch (e) {
    const msgs = summarizeDownloadError(e);
    updateLog(logId, `${r.standardNumber} ❌ ${msgs}`, 'fail');
    setRowDownloadState(r.id, 'fail');
    completeDownloadTask(taskId, isCancelledDownloadError(e) ? 'cancelled' : 'fail', { error: msgs, progress: msgs });
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
      applyDownloadProgress(taskId, makeDownloadProgress(src, 'connecting', { text: `尝试 ${srcLabel(src)}...` }));
      const result = await raceSource(srcId, src, label, (update) => {
        updateLog(logId, formatDownloadProgress(update), 'pending');
        applyDownloadProgress(taskId, update);
      });
      const sizeStr = result.fileSize ? ` ${formatSize(result.fileSize)}` : '';
      updateLog(logId, `${label} ✅ ${srcLabel(result.source)} ${result.fileName || ''}${sizeStr}`, 'success');
      setRowDownloadState(rowId, 'success');
      markLibraryHit(rowId, result.fileId);
      // 默认只入库服务器，不触发浏览器下载弹窗
      if (result.fileName) { recordDownload(result.source, result.fileName, label); }
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
  onProgress?.(makeDownloadProgress('bz', 'connecting', { serverTaskId: data.id }));
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const es = new EventSource(`${API}/api/tasks/${data.id}/stream`);
    const timeout = setTimeout(() => { es.close(); reject(new Error('BZ轮询超时')); }, 120000);
    es.onmessage = (e) => {
      const ev = parseSseEvent(e.data);
      if (!ev.ok) { clearTimeout(timeout); es.close(); reject(new Error(`BZ ${ev.error.message || '失败'}`)); return; }
      const td = ev.value;
      if (onProgress) onProgress(makeDownloadProgress('bz', td.phase || 'downloading', { currentPage: td.currentPage, totalPages: td.totalPages }));
      if (td.status === 'success') { clearTimeout(timeout); es.close(); const elapsed = ((Date.now() - t0) / 1000).toFixed(1); const sizeStr = td.fileSize ? ` ${formatSize(td.fileSize)}` : ''; resolve({ source: 'bz', fileName: td.fileName || '', fileSize: td.fileSize, fileId: td.fileId, meta: `${elapsed}s${sizeStr}` }); }
      if (td.status === 'failed') { clearTimeout(timeout); es.close(); reject(new Error(`BZ ${td.errorMessage || '失败'}`)); }
      if (td.status === 'cancelled') { clearTimeout(timeout); es.close(); reject(new Error('下载已取消')); }
    };
    es.onerror = () => { clearTimeout(timeout); es.close(); reject(new Error('BZ SSE连接失败')); };
  });
}

async function downloadBy(id, onProgress) {
  const res = await fetch(`${API}/api/standards/${encodeURIComponent(id)}/export`, { method: 'POST' });
  const data = await readApiResponse(res);
  if (!res.ok) throw new Error(downloadErrorMessage('BY', res, data));
  onProgress?.(makeDownloadProgress('by', 'connecting', { serverTaskId: data.id }));
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const es = new EventSource(`${API}/api/tasks/${data.id}/stream`);
    const timeout = setTimeout(() => { es.close(); reject(new Error('BY轮询超时')); }, 60000);
    es.onmessage = (e) => {
      const ev = parseSseEvent(e.data);
      if (!ev.ok) { clearTimeout(timeout); es.close(); reject(new Error(`BY ${ev.error.message || '失败'}`)); return; }
      const td = ev.value;
      if (td.status === 'running' && onProgress) onProgress(makeDownloadProgress('by', td.phase || 'downloading'));
      if (td.status === 'success') { clearTimeout(timeout); es.close(); const elapsed = ((Date.now() - t0) / 1000).toFixed(1); const sizeStr = td.fileSize ? ` ${formatSize(td.fileSize)}` : ''; resolve({ source: 'by', fileName: td.fileName || '', fileSize: td.fileSize, fileId: td.fileId, meta: `${elapsed}s${sizeStr}` }); }
      if (td.status === 'failed') { clearTimeout(timeout); es.close(); reject(new Error(`BY ${td.errorMessage || '失败'}`)); }
      if (td.status === 'cancelled') { clearTimeout(timeout); es.close(); reject(new Error('下载已取消')); }
    };
    es.onerror = () => { clearTimeout(timeout); es.close(); reject(new Error('BY SSE连接失败')); };
  });
}

function stopAllDownloads() { downloadAborted = true; addLog('⏹ 中止下载', 'fail'); }

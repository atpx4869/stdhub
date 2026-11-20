// ── Batch Download ──
const downloadClient = window.StdHub.downloads;
let activeSearchDownloadRun, activeToolsDownloadRun, resetSearchDownloadProgress;

function createBatchDownloadRun(key) {
  const run = { stopped: false, detached: false, operations: new Set() };
  run.close = window.StdHub.lifecycle.register('tab', key, () => { run.detached = true; });
  return run;
}

function stopBatchDownloadRun(run, text) {
  if (!run || run.stopped || run.detached) return;
  run.stopped = true;
  for (const operation of run.operations) operation.cancel();
  addLog(text, 'info');
}

async function downloadSelectedResults() {
  if (isDownloading) return;
  const selected = results.filter(item => selectedIds.has(item.id));
  if (!selected.length) return;
  resetSearchDownloadProgress?.();
  const run = activeSearchDownloadRun = createBatchDownloadRun('download-search-batch');
  isDownloading = true;
  const downloadButton = document.getElementById('downloadSelected');
  const stopButton = document.getElementById('stopDownload');
  downloadButton.disabled = true;
  stopButton.style.display = 'inline-block';
  stopButton.disabled = false;
  const total = selected.length;
  const wins = {};
  let completed = 0, success = 0, cancelled = 0, unknown = 0, alreadyRunning = 0;
  const started = Date.now();
  const progress = document.getElementById('progressWrap');
  const fill = document.getElementById('progressFill');
  const progressText = document.getElementById('progressText');
  progress.classList.add('visible');
  const queue = [...selected];
  const activeProgress = new Map();
  function updateProgress() {
    if (run.detached) return;
    const elapsed = ((Date.now() - started) / 1000).toFixed(0);
    const partial = [...activeProgress.values()].reduce((sum, item) => sum + (Number.isFinite(item.percent) ? item.percent / 100 : 0), 0);
    fill.style.width = Math.min(100, (completed + partial) / total * 100) + '%';
    const detail = [...activeProgress.values()][0];
    progressText.textContent = completed + '/' + total + ' · ' + downloadConcurrency + '并发 · ' + (detail ? formatDownloadProgress(detail) : elapsed + 's');
  }
  async function worker() {
    while (queue.length && !run.stopped && !run.detached) {
      const item = queue.shift();
      const releaseRow = downloadClient.claimSearchRow(item.id);
      if (!releaseRow) { alreadyRunning++; completed++; updateProgress(); continue; }
      const candidates = downloadClient.resolveCandidates(item, getOrderedDownloadSourcesForResult(item));
      const sources = candidates.map(candidate => candidate.source);
      setRowDownloadState(item.id, 'downloading');
      const logId = addLog(item.standardNumber + ' 下载 [' + sources.map(srcLabel).join(' → ') + ']', 'pending');
      const taskId = createDownloadTask({ standardId: item.id, label: item.standardNumber, sources, mode: '级联', retry: () => downloadOne(item.id) });
      const operation = downloadClient.createOperation(taskId);
      run.operations.add(operation);
      activeProgress.set(taskId, downloadClient.makeProgress(null, 'queued'));
      updateProgress();
      try {
        const winner = await downloadClient.fromSearchResult(item, candidates, operation, update => {
          activeProgress.set(taskId, update);
          updateLog(logId, formatDownloadProgress(update), 'pending');
          applyDownloadProgress(taskId, update);
          updateProgress();
        });
        success++;
        const label = winner.local ? '本地库命中' : srcLabel(winner.source);
        wins[label] = (wins[label] || 0) + 1;
        const size = winner.fileSize ? ' ' + formatSize(winner.fileSize) : '';
        updateLog(logId, item.standardNumber + ' ✅ ' + label + '完成 ' + (winner.fileName || '') + size + downloadClient.formatTimings(winner.timingsMs), 'success');
        setRowDownloadState(item.id, 'success');
        markLibraryHit(item.id, winner.fileId);
        if (winner.fileId && (winner.local || currentUser?.role !== 'admin')) {
          downloadLocalFile(winner.fileId, winner.fileName || item.standardNumber + '.pdf');
        }
        if (winner.fileName) recordDownload(winner.source, winner.fileName, item.standardNumber, winner.fileId);
        downloadClient.completeSuccess(taskId, winner);
      } catch (error) {
        const outcome = downloadClient.completeFailure(taskId, item.id, item.standardNumber, logId, error);
        if (outcome.status === 'cancelled') cancelled++;
        if (outcome.status === 'unknown') unknown++;
      } finally {
        operation.close();
        releaseRow();
        run.operations.delete(operation);
        activeProgress.delete(taskId);
        completed++;
        updateProgress();
      }
    }
  }
  const clearProgress = () => {
    progress.classList.remove('visible');
    fill.style.width = '0%';
    progressText.textContent = '';
  };
  try {
    await Promise.all(Array.from({ length: downloadConcurrency }, worker));
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    if (!run.detached) {
      const winSummary = Object.entries(wins).map(([label, count]) => label + ':' + count).join(' ');
      const summary = '成功 ' + success + '/' + total + ' · ' + elapsed + 's' + (winSummary ? ' · ' + winSummary : '')
        + (cancelled ? ' · 已取消 ' + cancelled : '') + (unknown ? ' · 状态未知 ' + unknown : '')
        + (alreadyRunning ? ' · 正由其他操作下载 ' + alreadyRunning : '');
      const level = unknown ? 'warn' : run.stopped || alreadyRunning === total ? 'info' : success ? 'success' : 'fail';
      addLog((run.stopped ? '已停止批量下载，' : '批量下载完成，') + summary, level);
      if (success || cancelled || unknown || alreadyRunning) showToast(summary, level);
    }
  } finally {
    if (run.detached) clearProgress();
    else {
      const timer = setTimeout(() => resetSearchDownloadProgress?.(), 2000);
      resetSearchDownloadProgress = window.StdHub.lifecycle.register('tab', 'download-search-progress', () => {
        clearTimeout(timer);
        clearProgress();
        resetSearchDownloadProgress = undefined;
      });
    }
    run.close();
    activeSearchDownloadRun = undefined;
    stopButton.style.display = 'none';
    isDownloading = false;
    updateToolbar();
  }
}

function stopSelectedDownloads() {
  document.getElementById('stopDownload').disabled = true;
  stopBatchDownloadRun(activeSearchDownloadRun, '已停止派发勾选下载，正在取消在途任务…');
}

document.getElementById('downloadSelected').addEventListener('click', downloadSelectedResults);
document.getElementById('stopDownload').addEventListener('click', stopSelectedDownloads);

// ── Batch download (floating panel) ──
let batchResolved = [], batchUnmatched = [], batchDownloading = false;

function updateBatchSourceHint() {
  const sources = downloadPriority.filter(s => downloadSources.includes(s));
  const labels = { gbw: 'BW', by: 'BY', bz: 'BZ', sby: 'SBY' };
  const el = document.getElementById('batchSourceHint');
  if (el) el.textContent = `级联顺序：${sources.map(s => labels[s]||s).join(' → ')}（进度静默 ${downloadTimeout}s 后核对任务）`;
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
  document.getElementById('batchResolveBtn').innerHTML = '<span class="spinner" aria-hidden="true"></span><span>解析中</span>';
  document.getElementById('batchSummary').innerHTML = '解析中...';
  document.getElementById('batchResults').innerHTML = '<div class="batch-results-empty">正在按来源优先级匹配标准号...</div>';
  batchResolved = []; batchUnmatched = []; lastBatchFailedItems = [];
  try {
    const sources = downloadPriority.filter(s => downloadSources.includes(s));
    const data = await window.StdHub.api.post(API + '/api/standards/resolve', { lines, sources });
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
  document.getElementById('batchResolveBtn').innerHTML = '<i class="ti ti-list-search" aria-hidden="true"></i><span>解析标准号</span>';
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
      <input type="checkbox" id="br_${i}" data-batch-index="${i}" checked>
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
      <button class="btn btn-sm btn-primary" id="batchDownloadBtn" data-batch-action="download">下载选中</button>
      <button class="btn btn-sm btn-ghost" id="batchStopBtn" data-batch-action="stop" style="display:none;color:var(--danger);border-color:var(--danger)">停止</button>
      <button class="btn btn-sm btn-ghost" id="batchRetryFailedBtn" data-batch-action="retry" disabled>重试失败项</button>
      <button class="btn btn-sm btn-ghost" data-batch-action="toggle-select">全选/取消</button>
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
  batchDownloading = true;
  const checks = document.querySelectorAll('#batchResults input[type="checkbox"]:checked');
  const items = []; checks.forEach(c => { items.push(batchResolved[Number(c.dataset.batchIndex)]); });
  if (!items.length) { batchDownloading = false; return; }
  const run = activeToolsDownloadRun = createBatchDownloadRun('download-tools-batch');
  document.getElementById('batchDownloadBtn').disabled = true;
  document.getElementById('batchStopBtn').style.display = 'inline-block';
  document.getElementById('batchStopBtn').disabled = false;
  document.getElementById('batchProgressWrap').classList.add('visible');
  const fill = document.getElementById('batchProgressFill'); fill.style.width = '0%';
  const progressText = document.getElementById('batchProgressText');
  const sources = downloadPriority.filter(s => downloadSources.includes(s));
  const total = items.length; let completed = 0, success = 0;
  const successItems = [], outcomes = new Map();
  const activeProgress = new Map();
  const t0 = Date.now();
  function updateProgress() {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
    const partial = [...activeProgress.values()].reduce((sum, item) => sum + (Number.isFinite(item.percent) ? item.percent / 100 : 0), 0);
    fill.style.width = `${Math.min(100, Math.round((completed + partial) / total * 100))}%`;
    const detail = [...activeProgress.values()][0];
    progressText.textContent = `${completed}/${total} · ${downloadConcurrency}并发 · ${detail ? formatDownloadProgress(detail) : `${elapsed}s`}`;
  }

  addLog(`━━ 级联下载 (${items.length}条, 优先级: ${sources.map(s => srcLabel(s)).join(' → ')})`, 'pending');
  const queue = [...items];
  async function worker() {
    while (queue.length && !run.stopped && !run.detached) {
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
      const operation = downloadClient.createOperation(taskId);
      run.operations.add(operation);
      const progressState = downloadClient.makeProgress(null, 'queued');
      activeProgress.set(taskId, progressState);
      updateProgress();
      try {
        const candidates = downloadClient.resolveCandidates({ _sourceIds: sourceIds }, sources);
        const data = await downloadClient.fromSources(candidates, operation, (update) => {
          activeProgress.set(taskId, update);
          updateLog(logId, formatDownloadProgress(update), 'pending');
          setBatchCardState(item.standardId, 'downloading', formatDownloadProgress(update));
          applyDownloadProgress(taskId, update);
          updateProgress();
        });
        const sizeStr = data.fileSize ? ` ${formatSize(data.fileSize)}` : '';
        updateLog(logId, `${item.standardNumber} ✅ ${srcLabel(data.source)} ${data.fileName || ''}${sizeStr}${downloadClient.formatTimings(data.timingsMs)}`, 'success');
        setRowDownloadState(item.standardId, 'success');
        setBatchCardState(item.standardId, 'success', srcLabel(data.source));
        markLibraryHit(item.standardId, data.fileId);
        success++; successItems.push(item);
        // 默认只入库服务器，不触发浏览器下载弹窗
        if (data.fileName) { recordDownload(data.source, data.fileName, item.standardNumber, data.fileId); }
        downloadClient.completeSuccess(taskId, data);
      } catch (error) {
        const outcome = downloadClient.completeFailure(taskId, item.standardId, item.standardNumber, logId, error);
        const retryable = outcome.status === 'fail' && error?.kind !== 'library-failed';
        setBatchCardState(item.standardId, retryable ? 'fail' : '', outcome.message);
        outcomes.set(item.standardId, { ...item, _failReason: outcome.message, _retryable: retryable });
      } finally {
        operation.close();
        run.operations.delete(operation);
        activeProgress.delete(taskId);
        completed++; updateProgress();
      }
    }
  }
  try {
    await Promise.all(Array.from({ length: downloadConcurrency }, worker));
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    if (!run.detached) {
      const finalFailed = items.filter(it => !successItems.some(done => done.standardId === it.standardId))
        .map(item => outcomes.get(item.standardId) || { ...item, _failReason: '已停止，未发起下载', _retryable: true });
      addLog('━━ 批量下载' + (run.stopped ? '已停止' : '结束') + '：' + success + '/' + total + ' 成功 (' + elapsed + 's)', run.stopped ? 'info' : success ? 'success' : 'warn');
      if (success > 0) showToast('批量完成 ' + success + '/' + total + ' · ' + elapsed + 's');
      showBatchResultModal(successItems, finalFailed, elapsed);
    }
  } finally {
    run.close();
    activeToolsDownloadRun = undefined;
    batchDownloading = false;
    document.getElementById('batchDownloadBtn').disabled = false;
    document.getElementById('batchStopBtn').style.display = 'none';
    updateBatchToolbar();
  }
}

function stopBatchDownload() {
  document.getElementById('batchStopBtn').disabled = true;
  stopBatchDownloadRun(activeToolsDownloadRun, '已停止派发批量下载，正在取消在途任务…');
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
  closeModalOverlay();
  doBatchDownload();
}

function showBatchResultModal(successItems, finalFailed, elapsed) {
  lastBatchFailedItems = finalFailed.filter(item => item._retryable);
  updateBatchToolbar();
  const total = successItems.length + finalFailed.length;
  const successRows = successItems.map(it => `
    <div style="display:flex;align-items:center;gap:8px;padding:6px 0;font-size:13px;border-bottom:1px solid var(--border)">
      <i class="ti ti-circle-check" aria-hidden="true" style="color:var(--success)"></i>
      <span style="font:500 13px 'DM Mono',monospace;color:var(--accent);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(it.standardNumber)}</span>
    </div>`).join('');
  const failRows = finalFailed.map(it => `
    <div style="display:flex;align-items:flex-start;gap:8px;padding:6px 0;font-size:13px;border-bottom:1px solid var(--border)">
      <i class="ti ti-circle-x" aria-hidden="true" style="color:var(--danger);flex:0 0 auto"></i>
      <div style="min-width:0;flex:1">
        <div style="font:500 13px 'DM Mono',monospace;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(it.standardNumber)}</div>
        ${it._failReason ? `<div style="font-size:11px;color:var(--text-3);margin-top:2px;line-height:1.4">${escapeHtml(it._failReason)}</div>` : ''}
      </div>
    </div>`).join('');
  document.getElementById('modalBody').innerHTML = `
    <h3 style="margin-bottom:16px"><i class="ti ti-chart-bar" aria-hidden="true"></i> 批量下载结果</h3>
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
      ${lastBatchFailedItems.length > 0 ? '<button class="btn btn-primary btn-sm" data-action="modal-retry-batch-failed">重试失败项</button>' : ''}
      <button class="btn btn-primary btn-sm" data-action="modal-close">关闭</button>
    </div>`;
  openModalOverlay({ label: '批量下载结果', focusSelector: '[data-action="modal-close"]' });
}

document.getElementById('batchResults')?.addEventListener('change', event => {
  if (event.target.matches('input[type="checkbox"][data-batch-index]')) updateBatchToolbar();
});

document.getElementById('batchResults')?.addEventListener('click', event => {
  const action = event.target.closest('[data-batch-action]')?.dataset.batchAction;
  if (action === 'download') doBatchDownload();
  else if (action === 'stop') stopBatchDownload();
  else if (action === 'retry') retryFailedBatchDownload();
  else if (action === 'toggle-select') toggleBatchSelect();
});

// ── Batch Download ──
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

function stopBatchDownload() { batchAborted = true; addLog('⏹ 中止批量下载', 'fail'); }

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

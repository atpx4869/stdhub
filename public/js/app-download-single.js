// ── Download task client and single-result actions ──
(function initializeDownloads() {
  const api = window.StdHub.api;
  const CREATE_TIMEOUT_MS = 30_000;
  const REQUEST_TIMEOUT_MS = 8_000;
  const OBSERVATION_BUDGET_MS = 5 * 60_000;
  const POLL_INTERVAL_MS = 2_000;
  const MAX_STATUS_READ_FAILURES = 3;
  const states = new Set(['queued', 'running', 'success', 'failed', 'cancelled']);
  const activeSearchRows = new Set();

  function claimSearchRow(id) {
    if (activeSearchRows.has(id)) return null;
    activeSearchRows.add(id);
    return () => activeSearchRows.delete(id);
  }

  function issue(kind, message, timingsMs) {
    return Object.assign(new Error(message), { kind, timingsMs });
  }

  function makeProgress(source, phase, detail = {}) {
    const current = detail.currentPage;
    const total = detail.totalPages;
    const percent = Number.isFinite(current) && total > 0 ? current / total * 100 : undefined;
    return { source, phase, current, total, percent, text: detail.text, serverTaskId: detail.serverTaskId };
  }

  function createOperation(taskId) {
    const lifetime = new AbortController();
    const observation = new AbortController();
    let cancelRequested = false;
    const release = window.StdHub.lifecycle.register('tab', 'download-task:' + taskId, () => {
      const error = issue('detached', '已离开下载页面；如已提交，任务可能仍在后台运行，请稍后查看文件库');
      lifetime.abort(error);
      observation.abort(error);
    });
    const operation = {
      signal: lifetime.signal,
      observationSignal: observation.signal,
      get cancelRequested() { return cancelRequested; },
      cancel() {
        if (cancelRequested || lifetime.signal.aborted) return;
        cancelRequested = true;
        updateDownloadTask(taskId, { progress: '正在请求取消…' });
        // Keep creation alive long enough to receive its ID. Disconnecting while POST
        // is pending would discard the only way to cancel a possibly-created task.
        observation.abort(issue('cancel-requested', '正在请求取消'));
      },
      close: release,
    };
    updateDownloadTask(taskId, { cancel: operation.cancel });
    return operation;
  }

  function ensureOperationActive(operation) {
    if (operation.signal.aborted) throw operation.signal.reason;
    if (operation.cancelRequested) throw issue('cancelled', '下载已取消');
  }

  async function requestWithin(startRequest, signal, timeoutMs = REQUEST_TIMEOUT_MS) {
    if (signal.aborted) throw signal.reason;
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let rejectOnAbort;
    const interrupted = new Promise((_resolve, reject) => {
      rejectOnAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', rejectOnAbort, { once: true });
    });
    try {
      return await Promise.race([startRequest(controller.signal), interrupted]);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      controller.signal.removeEventListener('abort', rejectOnAbort);
    }
  }

  function delay(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(signal.reason); return; }
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', abort);
        resolve();
      }, ms);
      function abort() {
        clearTimeout(timer);
        reject(signal.reason);
      }
      signal.addEventListener('abort', abort, { once: true });
    });
  }

  function taskPath(taskId) { return API + '/api/tasks/' + encodeURIComponent(taskId); }
  function isSnapshot(task, taskId) { return task?.id === taskId && states.has(task.status); }
  function isActive(task) { return task?.status === 'queued' || task?.status === 'running'; }

  function terminalResult(task, source, cancelRequested = false) {
    const label = srcLabel(source);
    if (task.libraryError) {
      throw issue('library-failed', label + ' 已取得正文，但入库失败：' + task.libraryError, task.timingsMs);
    }
    if (task.status === 'cancelled') {
      throw issue('cancelled', label + ' ' + (task.errorMessage || '下载已取消'), task.timingsMs);
    }
    if (task.status === 'failed') {
      const message = label + ' ' + (task.errorMessage || '下载失败');
      if (cancelRequested) throw issue('cancelled', '已停止后续来源；服务器报告 ' + message, task.timingsMs);
      throw issue('source-failed', message, task.timingsMs);
    }
    return { source, fileName: task.fileName, fileSize: task.fileSize, fileId: task.fileId, timingsMs: task.timingsMs };
  }

  function observeStream(taskId, signal, deadline, onSnapshot) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(signal.reason); return; }
      let stream, timer, settled = false;
      const finish = (task, error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        if (stream) {
          stream.onmessage = stream.onerror = null;
          stream.close();
        }
        if (error) reject(error);
        else resolve(task);
      };
      const abort = () => finish(null, signal.reason);
      const armSilenceCheck = () => {
        clearTimeout(timer);
        timer = setTimeout(() => finish(null), Math.max(0, Math.min(downloadTimeout * 1_000, deadline - Date.now())));
      };
      signal.addEventListener('abort', abort, { once: true });
      try {
        stream = new EventSource(taskPath(taskId) + '/stream');
        stream.onmessage = event => {
          const envelope = parseSseEvent(event.data);
          const task = envelope.ok ? envelope.value : null;
          if (!isSnapshot(task, taskId)) { finish(null); return; }
          if (!isActive(task)) { finish(task); return; }
          onSnapshot(task);
          armSilenceCheck();
        };
        stream.onerror = () => finish(null);
        armSilenceCheck();
      } catch { finish(null); }
    });
  }

  async function getSnapshot(taskId, signal, timeoutMs) {
    const task = await requestWithin(requestSignal => api.get(taskPath(taskId), { signal: requestSignal, cache: 'no-store' }), signal, timeoutMs);
    if (!isSnapshot(task, taskId)) throw new Error('服务未返回有效的任务状态');
    return task;
  }

  async function pollTask(taskId, signal, deadline, source, onSnapshot) {
    let failures = 0;
    for (;;) {
      // Even if the stream used the whole budget, do one final GET before
      // deciding whether the task is terminal, active or no longer observable.
      const timeout = Math.min(REQUEST_TIMEOUT_MS, Math.max(1_000, deadline - Date.now()));
      let snapshot;
      try {
        snapshot = await getSnapshot(taskId, signal, timeout);
        failures = 0;
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        failures++;
        if (error?.status === 404 || failures >= MAX_STATUS_READ_FAILURES) {
          throw issue('status-unknown', srcLabel(source) + ' 连接中断，无法确认原下载任务状态；任务可能仍在后台运行，请稍后查看文件库');
        }
      }
      if (snapshot) {
        if (!isActive(snapshot)) return snapshot;
        onSnapshot(snapshot);
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw issue('observation-timeout', srcLabel(source) + ' 已达下载观察期限，原任务可能仍在后台运行，请稍后查看文件库');
      }
      await delay(Math.min(POLL_INTERVAL_MS, remaining), signal);
    }
  }

  async function cancelTask(taskId, lastSnapshot, source, signal, onSnapshot) {
    let terminal = isSnapshot(lastSnapshot, taskId) && !isActive(lastSnapshot) ? lastSnapshot : null;
    if (!terminal) {
      try {
        const reply = await requestWithin(requestSignal => api.post(taskPath(taskId) + '/cancel', {}, { signal: requestSignal }), signal);
        if (isSnapshot(reply?.task, taskId) && !isActive(reply.task)) terminal = reply.task;
      } catch { if (signal.aborted) throw signal.reason; }
    }
    if (!terminal) {
      try {
        const snapshot = await getSnapshot(taskId, signal);
        if (!isActive(snapshot)) terminal = snapshot;
      } catch { if (signal.aborted) throw signal.reason; }
    }
    if (!terminal) {
      throw issue('cancel-unknown', srcLabel(source) + ' 未能确认服务器已取消；已停止后续来源，原任务可能仍在后台运行');
    }
    onSnapshot(terminal);
    return terminalResult(terminal, source, true);
  }

  function isRejectedBeforeCreation(error) {
    // These matched HTTP/envelope pairs originate in validation and admission,
    // before createTask. A proxy error, generic HTTP error or network failure
    // could instead mean a lost response to a successful POST.
    return (error?.status === 400 && error.code === 'BAD_REQUEST')
      || (error?.status === 429 && error.code === 'TOO_MANY_REQUESTS');
  }

  async function downloadSource({ standardId, source }, operation, onProgress) {
    ensureOperationActive(operation);
    onProgress?.(makeProgress(source, undefined, { serverTaskId: null, text: '正在提交 ' + srcLabel(source) + ' 下载…' }));
    let created;
    try {
      created = await requestWithin(signal => api.post(API + '/api/standards/' + encodeURIComponent(standardId) + '/export', {}, { signal }), operation.signal, CREATE_TIMEOUT_MS);
    } catch (error) {
      if (operation.signal.aborted) throw operation.signal.reason;
      if (isRejectedBeforeCreation(error)) {
        ensureOperationActive(operation);
        throw issue('not-created', srcLabel(source) + ' 未创建下载任务：' + error.message);
      }
    }
    const taskId = typeof created?.id === 'string' && created.id.trim() ? created.id : null;
    if (!taskId) {
      const message = operation.cancelRequested ? '已停止后续来源，但未能确认原任务已取消' : '下载请求未收到任务编号，无法确认是否已创建';
      throw issue('creation-unknown', srcLabel(source) + ' ' + message + '；请稍后查看文件库');
    }
    const signal = operation.observationSignal;
    let lastSnapshot;
    const onSnapshot = task => {
      lastSnapshot = task;
      const phase = task.phase || { queued: 'queued', running: 'connecting', success: 'complete', failed: 'failed', cancelled: 'cancelled' }[task.status];
      onProgress?.(makeProgress(source, phase, { ...task, serverTaskId: taskId }));
    };
    if (isSnapshot(created, taskId)) onSnapshot(created);
    else onProgress?.(makeProgress(source, undefined, { serverTaskId: taskId, text: srcLabel(source) + ' 已提交，正在确认任务状态…' }));

    let terminal = lastSnapshot && !isActive(lastSnapshot) ? lastSnapshot : null;
    if (!terminal && !operation.cancelRequested) {
      const deadline = Date.now() + OBSERVATION_BUDGET_MS;
      try {
        if (lastSnapshot) terminal = await observeStream(taskId, signal, deadline, onSnapshot);
        if (!terminal && !signal.aborted) {
          if (lastSnapshot) {
            onProgress?.(makeProgress(source, lastSnapshot.phase, { ...lastSnapshot, serverTaskId: taskId, text: srcLabel(source) + ' 进度连接中断，正在核对原任务…' }));
          }
          terminal = await pollTask(taskId, signal, deadline, source, onSnapshot);
        }
      } catch (error) {
        if (!signal.aborted) throw error;
      }
    }
    if (operation.signal.aborted) throw operation.signal.reason;
    if (operation.cancelRequested) return cancelTask(taskId, terminal || lastSnapshot, source, operation.signal, onSnapshot);
    onSnapshot(terminal);
    return terminalResult(terminal, source);
  }

  function planSearchSlots(result, sources, fallbackId = result?.id) {
    return [...new Set(sources)].filter(source => ALL_SOURCES.includes(source)).map(source => ({
      source,
      standardId: getSourceIdForDownload(result, source, fallbackId) || '',
    }));
  }

  function resolveCandidates(result, sources, fallbackId = result?.id) {
    return planSearchSlots(result, sources, fallbackId).filter(candidate => candidate.standardId);
  }

  function normalizeDownloadStdKey(value) {
    return String(value || '')
      .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
      .replace(/[Ａ-ｚ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
      .replace(/　/g, ' ')
      .replace(/[‐-―－]/g, '-')
      .replace(/[／]/g, '/')
      .replace(/[：]/g, ':')
      .replace(/[:](\d{4}\b)/, '-$1')
      .replace(/\s+/g, '')
      .toUpperCase();
  }

  function downloadStdIdentity(value) {
    const key = normalizeDownloadStdKey(value);
    const yearMatch = key.match(/-(\d{4})/);
    const year = yearMatch ? yearMatch[1] : '';
    return { key: year ? key.slice(0, key.indexOf('-' + year) + 5) : key, year, amendment: /修改单/.test(String(value || '')) };
  }

  function matchExactDownloadEdition(wanted, hit) {
    const expected = downloadStdIdentity(wanted);
    const actual = downloadStdIdentity(hit?.standardNumber || '');
    if (!expected.year || !actual.year || expected.year !== actual.year || !expected.key || expected.key !== actual.key) return 'mismatch';
    if (!expected.amendment && (/修改单/.test(hit?.standardNumber || '') || /修改单/.test(hit?.title || ''))) return 'amendment';
    return 'match';
  }

  function rememberSourceId(item, source, id) {
    if (!item || !id) return;
    item._sourceIds = { ...(item._sourceIds || {}), [source]: id };
    if (Array.isArray(item.sources) && !item.sources.includes(source)) item.sources.push(source);
  }

  function describeLookupSkip(reason) {
    return ({
      no_year: '缺少完整年版，无法补查',
      empty: '未检索到记录',
      no_same_year: '没有同号同年记录',
      amendment: '命中为修改单，已跳过',
      ambiguous: '同号同年不唯一，已跳过',
      lookup_failed: '补查失败',
    })[reason] || reason;
  }

  function noteLookup(source, reason, extra, operation) {
    const text = srcLabel(source) + ' ' + describeLookupSkip(reason) + (extra ? '：' + extra : '');
    if (typeof addLog === 'function') {
      addLog(text, { module: 'download', level: reason === 'lookup_failed' ? 'warn' : 'info', verbose: true });
    }
    if (typeof appendLogDetail === 'function' && operation?.logId) appendLogDetail(operation.logId, text);
    return text;
  }

  async function lookupExactCandidate(item, source, operation, onProgress) {
    const wanted = item?.standardNumber || '';
    const identity = downloadStdIdentity(wanted);
    if (!identity.year || !identity.key) {
      onProgress?.(makeProgress(source, 'failed', { text: noteLookup(source, 'no_year', '', operation) }));
      return null;
    }
    onProgress?.(makeProgress(source, undefined, { text: srcLabel(source) + ' 按标准号补查同年记录…' }));
    try {
      const path = API + '/api/standards/search?q=' + encodeURIComponent(wanted) + '&source=' + encodeURIComponent(source);
      const data = await requestWithin(signal => api.get(path, { signal }), operation.observationSignal, 12_000);
      const items = Array.isArray(data?.items) ? data.items : [];
      const matches = [];
      let sawAmendment = false;
      for (const hit of items) {
        const verdict = matchExactDownloadEdition(wanted, hit);
        if (verdict === 'match') matches.push(hit);
        if (verdict === 'amendment') sawAmendment = true;
      }
      const uniqueIds = [...new Set(matches.map(hit => hit.id).filter(id => (
        typeof id === 'string' && id.startsWith(source + ':') && id.length > source.length + 1
      )))];
      if (uniqueIds.length === 1) {
        rememberSourceId(item, source, uniqueIds[0]);
        if (typeof addLog === 'function') {
          addLog(srcLabel(source) + ' 补查命中 ' + uniqueIds[0], { module: 'download', level: 'info', verbose: true });
        }
        return { source, standardId: uniqueIds[0] };
      }
      const reason = uniqueIds.length > 1 ? 'ambiguous' : sawAmendment && !matches.length ? 'amendment' : items.length ? 'no_same_year' : 'empty';
      onProgress?.(makeProgress(source, 'failed', { text: noteLookup(source, reason, '', operation) }));
      return null;
    } catch (error) {
      if (operation.signal.aborted) throw operation.signal.reason;
      if (operation.cancelRequested) throw issue('cancelled', '下载已取消');
      if (error?.kind === 'detached' || error?.kind === 'cancelled') throw error;
      onProgress?.(makeProgress(source, 'failed', { text: noteLookup(source, 'lookup_failed', error?.message || String(error), operation) }));
      return null;
    }
  }

  async function fromSources(candidates, operation, onProgress) {
    const failures = [];
    for (const [index, candidate] of candidates.entries()) {
      try { return await downloadSource(candidate, operation, onProgress); }
      catch (error) {
        if (error?.kind !== 'source-failed' && error?.kind !== 'not-created') throw error;
        ensureOperationActive(operation);
        failures.push(error);
        if (index + 1 < candidates.length) {
          onProgress?.(makeProgress(candidate.source, 'failed', { text: error.message + '，尝试下一个来源' }));
        }
      }
    }
    if (failures.length === 1) throw failures[0];
    throw issue('source-failed', failures.length ? failures.map(error => error.message).join('；') : '无可用下载源', failures.at(-1)?.timingsMs);
  }

  async function downloadSearchSlots(item, slots, operation, onProgress) {
    const failures = [];
    const planned = (slots || []).filter(slot => ALL_SOURCES.includes(slot.source));
    for (const [index, slot] of planned.entries()) {
      ensureOperationActive(operation);
      let candidate = slot.standardId ? { source: slot.source, standardId: slot.standardId } : null;
      if (!candidate) {
        candidate = await lookupExactCandidate(item, slot.source, operation, onProgress);
        if (!candidate) continue;
      }
      try { return await downloadSource(candidate, operation, onProgress); }
      catch (error) {
        if (error?.kind !== 'source-failed' && error?.kind !== 'not-created') throw error;
        ensureOperationActive(operation);
        failures.push(error);
        if (index + 1 < planned.length) {
          onProgress?.(makeProgress(candidate.source, 'failed', { text: error.message + '，尝试下一个来源' }));
        }
      }
    }
    if (failures.length === 1) throw failures[0];
    throw issue('source-failed', failures.length ? failures.map(error => error.message).join('；') : '无可用下载源', failures.at(-1)?.timingsMs);
  }

  async function fromSearchResult(item, candidates, operation, onProgress, preferLocal = true) {
    ensureOperationActive(operation);
    const fileId = preferLocal && window.bzxzPublicSettings?.downloadPreferLocal !== false
      && typeof _libraryFileIds !== 'undefined' && _libraryFileIds.get(item.id);
    if (fileId) {
      const source = item.sources?.[0] || item._source || 'local';
      onProgress?.(makeProgress(source, undefined, { text: '本地库命中，正在读取文件…' }));
      try {
        // Confirm that the library file still exists. The browser then downloads
        // directly from its local file endpoint instead of buffering a second PDF.
        const response = await requestWithin(signal => api.fetch(API + '/api/files/' + fileId + '/pdf/download', { method: 'HEAD', signal }), operation.observationSignal);
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const encodedName = /filename\*=UTF-8''([^;]+)/i.exec(response.headers.get('Content-Disposition') || '')?.[1];
        let fileName = item.standardNumber + '.pdf';
        try { if (encodedName) fileName = decodeURIComponent(encodedName); } catch { /* Keep the standard number. */ }
        return { local: true, source, fileName, fileId, fileSize: Number(response.headers.get('Content-Length')) || undefined };
      } catch (error) {
        ensureOperationActive(operation);
        _libraryFileIds.delete(item.id);
        if (typeof applyLibraryDots === 'function') applyLibraryDots();
        onProgress?.(makeProgress(source, undefined, { text: '本地文件不可用，尝试来源下载' }));
      }
    }
    return downloadSearchSlots(item, candidates, operation, onProgress);
  }

  function formatTimings(timings) {
    return Object.entries({ queue: '排队', transfer: '传输', compose: '合成', library: '入库' })
      .filter(([key]) => Number.isFinite(timings?.[key]) && timings[key] >= 0)
      .map(([key, label]) => ' · ' + label + ' ' + Math.round(timings[key]) + 'ms').join('');
  }

  function completeSuccess(taskId, winner) {
    const { source, fileName, fileSize, timingsMs } = winner;
    completeDownloadTask(taskId, 'success', {
      source, fileName, fileSize, timingsMs,
      progress: winner.local ? '本地库命中' : srcLabel(source) + ' 下载完成' + formatTimings(timingsMs),
    });
  }

  function completeFailure(taskId, rowId, label, logId, error) {
    const unknown = ['detached', 'status-unknown', 'observation-timeout', 'creation-unknown', 'cancel-unknown'].includes(error?.kind);
    const status = unknown ? 'unknown' : error?.kind === 'cancelled' ? 'cancelled' : 'fail';
    const message = error?.message || '下载失败';
    const level = status === 'fail' ? 'fail' : status === 'unknown' && error?.kind !== 'detached' ? 'warn' : 'info';
    updateLog(logId, label + ' ' + (status === 'fail' ? '❌ ' : '') + message + formatTimings(error?.timingsMs), level);
    setRowDownloadState(rowId, status === 'fail' ? 'fail' : '');
    completeDownloadTask(taskId, status, {
      error: message, progress: message + formatTimings(error?.timingsMs), timingsMs: error?.timingsMs,
      ...(unknown || error?.kind === 'library-failed' ? { retry: null } : {}),
    });
    return { status, level, message };
  }

  async function runSingle(item, candidates, { button, explicit, retry } = {}) {
    const rowId = item.id;
    const label = item.standardNumber || rowId;
    const releaseRow = claimSearchRow(rowId);
    if (!releaseRow) return;
    const sources = candidates.map(candidate => candidate.source);
    const plan = candidates.map(candidate => srcLabel(candidate.source) + (candidate.standardId ? '' : '/补查')).join(' → ');
    const detail = candidates.map(candidate => srcLabel(candidate.source) + (candidate.standardId ? ' 行内 ' + candidate.standardId : ' 缺候选，将按完整标准号补查同年记录')).join('\n');
    const logId = addLog(label + ' 下载 [' + plan + ']', { module: 'download', level: 'pending', detail });
    const taskId = createDownloadTask({ standardId: rowId, label, sources, mode: explicit ? '指定来源优先' : '级联', retry });
    const operation = createOperation(taskId);
    operation.logId = logId;
    const originalContent = button?.innerHTML;
    const originallyDisabled = button?.disabled;
    const cancelClick = event => {
      event.preventDefault();
      event.stopImmediatePropagation();
      button.disabled = true;
      button.textContent = '正在取消…';
      operation.cancel();
    };
    setRowDownloadState(rowId, 'downloading');
    if (button) {
      button.disabled = false;
      button.textContent = '取消下载';
      button.addEventListener('click', cancelClick, true);
    }
    try {
      const result = await fromSearchResult(item, candidates, operation, update => {
        updateLog(logId, formatDownloadProgress(update), 'pending');
        applyDownloadProgress(taskId, update);
      }, !explicit);
      const labelSource = result.local ? '本地库命中' : srcLabel(result.source) + ' 完成';
      const size = result.fileSize ? ' ' + formatSize(result.fileSize) : '';
      updateLog(logId, label + ' ✅ ' + labelSource + ' ' + (result.fileName || '') + size + formatTimings(result.timingsMs), 'success');
      setRowDownloadState(rowId, 'success');
      markLibraryHit(rowId, result.fileId);
      // Local hits still trigger a direct browser download. For a new export,
      // admins keep the file in the library and guests receive it immediately.
      if (result.fileId && (result.local || currentUser?.role !== 'admin')) {
        downloadLocalFile(result.fileId, result.fileName || label + '.pdf');
      }
      if (result.fileName) recordDownload(result.source, result.fileName, label, result.fileId);
      completeSuccess(taskId, result);
      showToast(labelSource + '：' + (result.fileName || label));
    } catch (error) {
      const { status, level, message } = completeFailure(taskId, rowId, label, logId, error);
      if (error?.kind !== 'detached') showToast(status === 'fail' ? '下载失败：' + message : message, level, 7000);
    } finally {
      if (button) {
        button.removeEventListener('click', cancelClick, true);
        button.innerHTML = originalContent;
        button.disabled = originallyDisabled;
      }
      operation.close();
      releaseRow();
    }
  }

  function downloadOne(id, button) {
    const item = findResultByAnyId(id);
    if (!item) return;
    const candidates = planSearchSlots(item, getOrderedDownloadSourcesForResult(item));
    // The legacy detail dispatcher doesn't pass its button.
    if (!button) {
      const action = document.getElementById('modalSourcePanel')?.querySelector('[data-action="modal-download"]');
      if (action?.dataset.id === id) button = action;
    }
    return runSingle(item, candidates, { button, retry: () => downloadOne(id) });
  }

  function downloadSpecificSource(id, source, button) {
    const item = findResultByAnyId(id) || { id, standardNumber: id };
    const candidates = planSearchSlots(item, [source, ...getOrderedDownloadSourcesForResult(item)], id);
    return runSingle(item, candidates, { button, explicit: true, retry: () => downloadSpecificSource(id, source) });
  }

  window.StdHub.downloads = { claimSearchRow, createOperation, makeProgress, resolveCandidates, planSearchSlots, matchExactDownloadEdition, fromSources, fromSearchResult, formatTimings, completeSuccess, completeFailure };
  window.downloadOne = downloadOne;
  window.downloadSpecificSource = downloadSpecificSource;
})();

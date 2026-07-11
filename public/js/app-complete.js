// ── Standard completion ──
let completePreviewSeq = 0;
let completePreviewTimer = null;

function setCompleteFlow(state) {
  const states = {
    idle: { active: 'file', done: [] },
    selected: { active: 'process', done: ['file'] },
    processing: { active: 'process', done: ['file'] },
    success: { active: 'download', done: ['file', 'process'] },
    error: { active: 'process', done: ['file'], error: 'process' },
  };
  const cfg = states[state] || states.idle;
  document.querySelectorAll('[data-complete-step]').forEach(step => {
    const key = step.dataset.completeStep;
    step.classList.toggle('active', cfg.active === key);
    step.classList.toggle('done', cfg.done.includes(key));
    step.classList.toggle('error', cfg.error === key);
  });
}

function setCompleteStatus(message, type = 'idle') {
  const el = document.getElementById('completeSummary');
  el.className = `complete-status ${type}`;
  el.innerHTML = message;
}

function normalizeCompleteColumnInput(value, fallback) {
  const raw = String(value || fallback || '').trim().toUpperCase();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    return Number.isInteger(n) && n >= 1 && n <= 16384 ? String(n) : null;
  }
  return /^[A-Z]{1,3}$/.test(raw) ? raw : null;
}

function completeColumnToIndex(value) {
  if (/^\d+$/.test(value)) return Number(value) - 1;
  let index = 0;
  for (const ch of value) index = index * 26 + (ch.charCodeAt(0) - 64);
  return index - 1;
}

function getCompleteOptions(showToastOnError = false) {
  const inputEl = document.getElementById('completeInputColumn');
  const outputEl = document.getElementById('completeOutputColumn');
  const inputColumn = normalizeCompleteColumnInput(inputEl.value, 'A');
  const outputColumn = normalizeCompleteColumnInput(outputEl.value, 'B');
  const sameColumn = Boolean(inputColumn && outputColumn && completeColumnToIndex(inputColumn) === completeColumnToIndex(outputColumn));
  let message = '';
  if (!inputColumn) message = '输入列只能填写 A-ZZZ 或 1-16384';
  else if (!outputColumn) message = '输出起始列只能填写 A-ZZZ 或 1-16384';
  else if (sameColumn) message = '输出起始列不能与输入列相同';

  inputEl.classList.toggle('invalid', !inputColumn || sameColumn);
  outputEl.classList.toggle('invalid', !outputColumn || sameColumn);
  if (message && showToastOnError) showToast(message, 'fail');
  return { ok: !message, message, inputColumn, outputColumn };
}

function appendCompleteFormOptions(form, opts) {
  form.append('sources', JSON.stringify(downloadPriority.filter(s => downloadSources.includes(s))));
  form.append('inputColumn', opts.inputColumn);
  form.append('outputColumn', opts.outputColumn);
  form.append('preserveStyle', String(document.getElementById('completePreserveStyle').checked));
  form.append('includeStatus', String(document.getElementById('completeIncludeStatus').checked));
  form.append('includeSource', String(document.getElementById('completeIncludeSource').checked));
  form.append('includeDownloadLink', String(document.getElementById('completeIncludeLink').checked));
  form.append('includeTextFlag', String(document.getElementById('completeIncludeText').checked));
}

function renderCompletePreview(data) {
  const rows = (data.previewRows || []).map(row => `
    <div class="complete-preview-row">
      <span>第 ${escapeHtml(String(row.rowNumber))} 行</span>
      <strong title="${escapeHtml(row.value)}">${escapeHtml(row.value)}</strong>
    </div>`).join('');
  const header = data.skippedHeader ? `已跳过第 1 行表头，从第 ${data.startRow} 行读取` : '未识别到表头行';
  return `
    <strong>文件预览</strong>
    <div class="complete-preview-meta">
      <span>${escapeHtml(data.sheetName || 'Sheet1')}</span>
      <span>${escapeHtml(data.inputColumn)} 列读取</span>
      <span>${escapeHtml(data.outputColumn)} 列写入</span>
      <span>${escapeHtml(header)}</span>
    </div>
    <div class="complete-result-stats compact">
      <div><strong>${data.total}</strong><span>待补全</span></div>
      <div><strong>${data.unique}</strong><span>唯一号</span></div>
      <div class="${data.duplicates ? 'warn' : ''}"><strong>${data.duplicates}</strong><span>重复</span></div>
    </div>
    <div class="complete-preview-list">${rows || '<div class="complete-preview-empty">当前列没有可预览的标准号</div>'}</div>`;
}

async function refreshCompletePreview(immediate = false) {
  if (!immediate) {
    clearTimeout(completePreviewTimer);
    completePreviewTimer = setTimeout(() => refreshCompletePreview(true), 280);
    return;
  }

  const input = document.getElementById('completeFileInput');
  const file = input.files?.[0];
  const btn = document.getElementById('completeUploadBtn');
  const seq = ++completePreviewSeq;
  document.getElementById('completeDownload').innerHTML = '';
  if (!file) {
    btn.disabled = true;
    setCompleteFlow('idle');
    setCompleteStatus('等待选择文件', 'idle');
    return;
  }

  const opts = getCompleteOptions();
  if (!opts.ok) {
    btn.disabled = true;
    setCompleteFlow('error');
    setCompleteStatus(`<strong>配置有误</strong><span>${escapeHtml(opts.message)}</span>`, 'fail');
    return;
  }

  btn.disabled = true;
  setCompleteFlow('selected');
  setCompleteStatus(`<strong>读取预览中</strong><span>${escapeHtml(file.name)}</span>`, 'working');
  try {
    const form = new FormData();
    form.append('file', file);
    appendCompleteFormOptions(form, opts);
    const res = await fetch(`${API}/api/standards/complete/preview`, { method: 'POST', body: form });
    const data = await readApiResponse(res);
    if (seq !== completePreviewSeq) return;
    if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
    btn.disabled = data.total === 0;
    setCompleteFlow(data.total > 0 ? 'selected' : 'error');
    setCompleteStatus(renderCompletePreview(data), data.total > 0 ? 'ready' : 'fail');
  } catch (e) {
    if (seq !== completePreviewSeq) return;
    btn.disabled = true;
    setCompleteFlow('error');
    setCompleteStatus(`<strong>预览失败</strong><span>${escapeHtml(e.message)}</span>`, 'fail');
  }
}

function onCompleteFileSelected() {
  const input = document.getElementById('completeFileInput');
  const file = input.files?.[0];
  document.getElementById('completeFileName').textContent = file ? file.name : '未选择文件';
  refreshCompletePreview(true);
}

async function doComplete() {
  const input = document.getElementById('completeFileInput');
  const file = input.files?.[0]; if (!file) return;
  const opts = getCompleteOptions(true);
  if (!opts.ok) {
    setCompleteFlow('error');
    setCompleteStatus(`<strong>配置有误</strong><span>${escapeHtml(opts.message)}</span>`, 'fail');
    return;
  }

  const btn = document.getElementById('completeUploadBtn');
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>处理中';
  setCompleteFlow('processing');
  setCompleteStatus(`<strong>处理中</strong><span>正在识别 ${escapeHtml(opts.inputColumn)} 列标准号并按来源优先级补全...</span>`, 'working');
  document.getElementById('completeDownload').innerHTML = '';
  const taskId = createTaskCenterTask({ type: 'export', label: '标准补全 · ' + file.name, progress: '正在识别与补全…' });
  try {
    const form = new FormData(); form.append('file', file);
    appendCompleteFormOptions(form, opts);
    const res = await fetch(`${API}/api/standards/complete`, { method: 'POST', body: form });
    const data = await readApiResponse(res);
    if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
    const summary = data.summary || {};
    setCompleteFlow('success');
    setCompleteStatus(`
      <div class="complete-result-stats">
        <div><strong>${summary.resolved}</strong><span>已补全</span></div>
        <div class="${summary.unmatched ? 'warn' : ''}"><strong>${summary.unmatched}</strong><span>未匹配</span></div>
        <div class="${summary.duplicates ? 'warn' : ''}"><strong>${summary.duplicates || 0}</strong><span>重复</span></div>
        <div><strong>${summary.total}</strong><span>总计</span></div>
      </div>
      <div class="complete-result-detail">
        ${escapeHtml(summary.sheetName || 'Sheet1')} · ${escapeHtml(summary.inputColumn || opts.inputColumn)} 列读取 · ${escapeHtml(summary.outputColumn || opts.outputColumn)} 列写入
      </div>`, 'success');
    const dlUrl = data.downloadUrl;
    if (dlUrl && !dlUrl.startsWith('/')) throw new Error('Invalid download URL');
    document.getElementById('completeDownload').innerHTML = `
      <div class="complete-download-card">
        <div>
          <strong>${escapeHtml(data.fileName || '补全结果')}</strong>
          <span>已生成补全文件</span>
        </div>
        <a class="btn btn-primary btn-sm" href="${escapeHtml(API + dlUrl)}" download="${escapeHtml(data.fileName)}">下载结果</a>
      </div>`;
    completeTaskCenterTask(taskId, 'success', { progress: '完成 · ' + summary.resolved + '/' + summary.total + ' 项已补全' });
    addLog(`标准补全: ${summary.resolved}/${summary.total} 匹配`, 'success');
  } catch (e) {
    completeTaskCenterTask(taskId, 'fail', { error: e.message, progress: e.message });
    setCompleteFlow('error');
    setCompleteStatus(`<strong>处理失败</strong><span>${escapeHtml(e.message)}</span>`, 'fail');
    addLog(`标准补全失败: ${e.message}`, 'fail');
  }
  btn.disabled = false; btn.innerHTML = '上传并补全';
}

function initCompleteControls() {
  ['completeInputColumn', 'completeOutputColumn'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('input', () => refreshCompletePreview());
    el.addEventListener('blur', () => {
      const fallback = id === 'completeInputColumn' ? 'A' : 'B';
      const normalized = normalizeCompleteColumnInput(el.value, fallback);
      if (normalized) el.value = normalized;
      refreshCompletePreview(true);
    });
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initCompleteControls);
} else {
  initCompleteControls();
}

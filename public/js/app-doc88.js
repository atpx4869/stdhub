// ── Doc88 文库：关键词搜索 → 串行生成位图 PDF → 本地库预览/重命名 ──
var doc88State = {
  keyword: '', page: 1, pageSize: 20, hasMore: false, items: [],
  tasks: new Map(), streams: new Map(), healthLoaded: false,
};

function renderDoc88State(icon, title, description, tone) {
  return '<div class="workspace-empty-state' + (tone ? ' is-' + tone : '') + '"><i class="ti ' + icon + '" aria-hidden="true"></i><strong>' + escapeHtml(title) + '</strong><span>' + escapeHtml(description) + '</span></div>';
}

async function loadDoc88Health(force) {
  if (doc88State.healthLoaded && !force) return;
  var target = document.getElementById('doc88Health');
  if (!target) return;
  try {
    var res = await window.StdHub.api.fetch('/api/doc88/health');
    var data = await readApiResponse(res);
    if (!res.ok) throw new Error(data.message || '状态读取失败');
    doc88State.healthLoaded = true;
    target.className = 'doc88-health ' + (data.configured ? 'is-ready' : 'is-warning');
    target.textContent = data.configured
      ? (data.busy ? '生成器忙碌中 · 排队 ' + data.queueLength + ' 项' : '生成器已就绪 · 单任务串行处理')
      : '尚未配置 DOC88_COOKIE / DOC88_COOKIE_FILE，当前只能搜索，不能生成 PDF';
  } catch (error) {
    target.className = 'doc88-health is-error';
    target.textContent = error.message || String(error);
  }
}

async function doDoc88Search(page) {
  var input = document.getElementById('doc88SearchInput');
  var keyword = String(input && input.value || '').trim();
  var results = document.getElementById('doc88Results');
  if (!keyword) {
    results.innerHTML = renderDoc88State('ti-photo-scan', '检索 Doc88 文库', '输入标准号或关键词，搜索 PDF 文档。');
    document.getElementById('doc88Pager').innerHTML = '';
    return;
  }
  doc88State.keyword = keyword;
  doc88State.page = Number.isInteger(page) && page > 0 ? page : 1;
  if (typeof setSearchStage === 'function') setSearchStage('search', 'active');
  results.innerHTML = '<div class="workspace-loading-state"><span class="spinner" aria-hidden="true"></span><span>正在检索 Doc88 文库…</span></div>';
  document.getElementById('doc88Pager').innerHTML = '';
  try {
    var url = '/api/doc88/search?keyword=' + encodeURIComponent(keyword) + '&page=' + doc88State.page + '&pageSize=' + doc88State.pageSize;
    var res = await window.StdHub.api.fetch(url);
    var data = await readApiResponse(res);
    if (!res.ok) throw new Error(data.message || '搜索失败');
    doc88State.items = data.items || [];
    doc88State.hasMore = !!data.hasMore;
    renderDoc88Results();
    renderDoc88Pager();
  } catch (error) {
    results.innerHTML = renderDoc88State('ti-alert-circle', 'Doc88 搜索失败', error.message || String(error), 'error');
  }
}

function doc88ItemByPcode(pcode) {
  return doc88State.items.find(function (item) { return String(item.pcode) === String(pcode); });
}

function renderDoc88Results() {
  var target = document.getElementById('doc88Results');
  if (!doc88State.items.length) {
    target.innerHTML = renderDoc88State('ti-file-off', '未找到 PDF 文档', '尝试缩短关键词或使用完整标准号搜索。');
    return;
  }
  target.innerHTML = '<div class="doc88-results-head"><span>第 ' + doc88State.page + ' 页 · ' + doc88State.items.length + ' 条</span><span>生成任务全局单并发</span></div><div class="doc88-rows">' + doc88State.items.map(function (item) {
    var task = doc88State.tasks.get(String(item.pcode));
    var standard = item.standardNumber || '';
    var title = item.cleanTitle || item.title || '';
    var localFileId = Number(item.localFileId || task && task.fileId || 0);
    var progress = task ? renderDoc88Task(task) : '';
    var action = localFileId
      ? '<button class="btn btn-ghost btn-sm" data-doc88-action="preview" data-file-id="' + localFileId + '"><i class="ti ti-eye" aria-hidden="true"></i><span>本地预览</span></button><button class="btn btn-ghost btn-sm" data-doc88-action="rename" data-file-id="' + localFileId + '" data-file-name="' + escapeAttr(task && task.fileName || '') + '"><i class="ti ti-pencil" aria-hidden="true"></i><span>重命名</span></button>'
      : '<button class="btn btn-primary btn-sm" data-doc88-action="generate" data-pcode="' + escapeAttr(item.pcode) + '"' + (task && ['queued', 'running'].includes(task.status) ? ' disabled' : '') + '><i class="ti ti-file-type-pdf" aria-hidden="true"></i><span>生成 PDF</span></button>';
    return '<article class="doc88-result-item" data-pcode="' + escapeAttr(item.pcode) + '"><div class="doc88-result-main"><div class="doc88-result-title">' + (standard ? '<span class="doc88-code">' + escapeHtml(standard) + '</span>' : '') + '<strong>' + escapeHtml(title || item.title) + '</strong></div><div class="doc88-result-meta"><span>PDF</span><span>' + escapeHtml(item.pages || '?') + ' 页</span>' + (item.date ? '<span>' + escapeHtml(item.date) + '</span>' : '') + '<span>编号 ' + escapeHtml(item.pcode) + '</span></div>' + progress + '</div><div class="doc88-result-actions">' + action + '</div></article>';
  }).join('') + '</div>';
}

function renderDoc88Task(task) {
  if (task.status === 'failed') return '<div class="doc88-task-state is-error"><span>' + escapeHtml(task.error && task.error.message || '生成失败') + '</span></div>';
  if (task.status === 'cancelled') return '<div class="doc88-task-state is-muted">已取消</div>';
  if (task.status === 'success') return '<div class="doc88-task-state is-success"><i class="ti ti-check"></i><span>' + escapeHtml(task.message || '生成完成') + '</span></div>';
  var percent = task.total ? Math.round(task.current * 100 / task.total) : 0;
  return '<div class="doc88-task-state is-running"><div><span>' + escapeHtml(task.message || '等待执行') + '</span><em>' + (task.total ? task.current + '/' + task.total : task.phase) + '</em></div><span class="doc88-progress"><i style="width:' + percent + '%"></i></span><button class="btn btn-ghost btn-xs" data-doc88-action="cancel" data-task-id="' + escapeAttr(task.id) + '">取消</button></div>';
}

function renderDoc88Pager() {
  var target = document.getElementById('doc88Pager');
  target.innerHTML = '<span>第 ' + doc88State.page + ' 页</span><div><button class="btn btn-ghost btn-sm" data-doc88-page="' + (doc88State.page - 1) + '"' + (doc88State.page <= 1 ? ' disabled' : '') + '>上一页</button><button class="btn btn-ghost btn-sm" data-doc88-page="' + (doc88State.page + 1) + '"' + (!doc88State.hasMore ? ' disabled' : '') + '>下一页</button></div>';
}

async function startDoc88Generation(item) {
  var standardNumber = item.standardNumber || '';
  if (!standardNumber) {
    standardNumber = await showPrompt({ title: '填写标准号', label: 'Doc88 标题未能可靠识别标准号，请确认', placeholder: '例如 GB/T 3325-2024', confirmText: '开始生成' });
    if (standardNumber === null) return;
  } else {
    var confirmed = await showConfirmHtml({ title: '生成并写入文件库', bodyHtml: '<div class="doc88-confirm"><label>标准号<strong>' + escapeHtml(standardNumber) + '</strong></label><label>标准名称<strong>' + escapeHtml(item.cleanTitle || item.title) + '</strong></label><p>Doc88 产物是逐页渲染的位图 PDF，任务将按顺序在后台处理。</p></div>', confirmText: '开始生成', cancelText: '取消' });
    if (!confirmed) return;
  }
  try {
    var res = await window.StdHub.api.fetch('/api/doc88/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pcode: String(item.pcode), title: item.title || '', standardNumber: standardNumber.trim(), cleanTitle: item.cleanTitle || item.title || '' }) });
    var task = await readApiResponse(res);
    if (!res.ok) throw new Error(task.message || '任务创建失败');
    doc88State.tasks.set(String(item.pcode), task);
    renderDoc88Results();
    followDoc88Task(item.pcode, task.id);
    loadDoc88Health(true);
  } catch (error) { showToast(error.message || String(error), 'fail'); }
}

function followDoc88Task(pcode, taskId) {
  var previous = doc88State.streams.get(taskId);
  if (previous) previous.close();
  var stream = new EventSource('/api/doc88/tasks/' + encodeURIComponent(taskId) + '/stream');
  doc88State.streams.set(taskId, stream);
  stream.onmessage = function (event) {
    try {
      var envelope = JSON.parse(event.data);
      var task = envelope.data || envelope;
      doc88State.tasks.set(String(pcode), task);
      renderDoc88Results();
      if (['success', 'failed', 'cancelled'].includes(task.status)) {
        stream.close(); doc88State.streams.delete(taskId); loadDoc88Health(true);
        if (task.status === 'success') showToast('Doc88 PDF 已生成并写入文件库');
        if (task.status === 'failed') showToast(task.error && task.error.message || 'Doc88 生成失败', 'fail');
      }
    } catch (_) { /* ignore malformed event */ }
  };
  stream.onerror = function () { stream.close(); doc88State.streams.delete(taskId); };
}

async function cancelDoc88Task(taskId) {
  try {
    var res = await window.StdHub.api.fetch('/api/doc88/tasks/' + encodeURIComponent(taskId) + '/cancel', { method: 'POST' });
    var task = await readApiResponse(res);
    if (!res.ok) throw new Error(task.message || '取消失败');
    doc88State.tasks.set(String(task.pcode), task); renderDoc88Results();
  } catch (error) { showToast(error.message || String(error), 'fail'); }
}

document.getElementById('doc88Results')?.addEventListener('click', function (event) {
  var button = event.target.closest('[data-doc88-action]');
  if (!button) return;
  var action = button.dataset.doc88Action;
  if (action === 'generate') { var item = doc88ItemByPcode(button.dataset.pcode); if (item) startDoc88Generation(item); }
  if (action === 'cancel') cancelDoc88Task(button.dataset.taskId);
  if (action === 'preview') openLocalPreview(Number(button.dataset.fileId));
  if (action === 'rename') renameLocalFile(Number(button.dataset.fileId), button.dataset.fileName || '');
});

document.getElementById('doc88Pager')?.addEventListener('click', function (event) {
  var button = event.target.closest('[data-doc88-page]');
  if (button && !button.disabled) doDoc88Search(Number(button.dataset.doc88Page));
});

window.doDoc88Search = doDoc88Search;
window.loadDoc88Health = loadDoc88Health;

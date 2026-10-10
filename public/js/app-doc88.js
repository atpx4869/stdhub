// ── Doc88 文库：关键词搜索 → 串行生成位图 PDF → 本地库预览/重命名 ──
var doc88State = {
  keyword: '', page: 1, pageSize: 20, hasMore: false, items: [],
  tasks: new Map(), streams: new Map(), healthLoaded: false,
  searchSeq: 0, searchController: null, polls: new Map(), pending: new Set(), restored: false,
};

function renderDoc88State(icon, title, description, tone) {
  return '<div class="workspace-empty-state' + (tone ? ' is-' + tone : '') + '"><i class="ti ' + icon + '" aria-hidden="true"></i><strong>' + escapeHtml(title) + '</strong><span>' + escapeHtml(description) + '</span></div>';
}

async function restoreDoc88Tasks() {
  if (doc88State.restored) return;
  try {
    var res = await window.StdHub.api.fetch('/api/doc88/tasks');
    var data = await readApiResponse(res);
    if (!res.ok) return;
    doc88State.restored = true;
    (data.items || []).forEach(function (task) {
      if (!doc88State.tasks.has(String(task.pcode))) doc88State.tasks.set(String(task.pcode), task);
      if (['queued', 'running'].includes(task.status)) followDoc88Task(task.pcode, task.id);
    });
    renderDoc88Results();
  } catch (_) { /* tasks can be restored on the next visit */ }
}

async function loadDoc88Health(force) {
  restoreDoc88Tasks();
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
  var seq = ++doc88State.searchSeq;
  if (doc88State.searchController) doc88State.searchController.abort();
  doc88State.searchController = new AbortController();
  if (!keyword) {
    doc88State.items = [];
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
    var res = await window.StdHub.api.fetch(url, { signal: doc88State.searchController.signal });
    var data = await readApiResponse(res);
    if (seq !== doc88State.searchSeq) return;
    if (!res.ok) throw new Error(data.message || '搜索失败');
    doc88State.items = data.items || [];
    doc88State.hasMore = !!data.hasMore;
    renderDoc88Results();
    renderDoc88Pager();
  } catch (error) {
    if (seq !== doc88State.searchSeq || error.name === 'AbortError') return;
    results.innerHTML = renderDoc88State('ti-alert-circle', 'Doc88 搜索失败', error.message || String(error), 'error');
  }
}

function doc88ItemByPcode(pcode) {
  return doc88State.items.find(function (item) { return String(item.pcode) === String(pcode); });
}

function renderDoc88TaskHistory() {
  var panel = document.getElementById('doc88TaskHistory');
  var target = document.getElementById('doc88TaskHistoryList');
  if (!panel || !target) return;
  var tasks = Array.from(doc88State.tasks.values()).slice(0, 20);
  panel.hidden = !tasks.length;
  if (tasks.some(function (task) { return ['queued', 'running'].includes(task.status); })) panel.open = true;
  target.innerHTML = tasks.map(function (task) {
    var fileId = Number(task.fileId || 0);
    return '<article class="doc88-result-item"><div class="doc88-result-main"><strong>' + escapeHtml(task.standardNumber || task.title) + '</strong>' + renderDoc88Task(task) + '</div><div class="doc88-result-actions">' + (fileId ? '<button class="btn btn-ghost btn-sm" data-doc88-action="preview" data-file-id="' + fileId + '">预览</button><button class="btn btn-ghost btn-sm" data-doc88-action="download" data-file-id="' + fileId + '" data-file-name="' + escapeAttr(task.fileName || '') + '">下载</button><button class="btn btn-ghost btn-sm" data-doc88-action="rename" data-file-id="' + fileId + '" data-file-name="' + escapeAttr(task.fileName || '') + '">重命名</button>' : '') + '</div></article>';
  }).join('');
}

function renderDoc88Results() {
  renderDoc88TaskHistory();
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
    var fileName = item.localFileName || task && task.fileName || '';
    var action = localFileId
      ? '<button class="btn btn-ghost btn-sm" data-doc88-action="preview" data-file-id="' + localFileId + '"><i class="ti ti-eye" aria-hidden="true"></i><span>本地预览</span></button><button class="btn btn-ghost btn-sm" data-doc88-action="download" data-file-id="' + localFileId + '" data-file-name="' + escapeAttr(fileName) + '"><i class="ti ti-download" aria-hidden="true"></i><span>下载</span></button><button class="btn btn-ghost btn-sm" data-doc88-action="rename" data-file-id="' + localFileId + '" data-file-name="' + escapeAttr(fileName) + '"><i class="ti ti-pencil" aria-hidden="true"></i><span>重命名</span></button>'
      : '<button class="btn btn-primary btn-sm" data-doc88-action="generate" data-pcode="' + escapeAttr(item.pcode) + '"' + (doc88State.pending.has(String(item.pcode)) || task && ['queued', 'running'].includes(task.status) ? ' disabled' : '') + '><i class="ti ti-file-type-pdf" aria-hidden="true"></i><span>生成 PDF</span></button>';
    return '<article class="doc88-result-item" data-pcode="' + escapeAttr(item.pcode) + '"><div class="doc88-result-main"><div class="doc88-result-title">' + (standard ? '<span class="doc88-code">' + escapeHtml(standard) + '</span>' : '') + '<strong>' + escapeHtml(title || item.title) + '</strong></div><div class="doc88-result-meta"><span>PDF</span><span>' + escapeHtml(item.pages || '?') + ' 页</span>' + (item.date ? '<span>' + escapeHtml(item.date) + '</span>' : '') + '<span>编号 ' + escapeHtml(item.pcode) + '</span></div>' + progress + '</div><div class="doc88-result-actions">' + action + '</div></article>';
  }).join('') + '</div>';
}

function renderDoc88Task(task) {
  if (task.status === 'failed') return '<div class="doc88-task-state is-error"><span>' + escapeHtml(task.error && task.error.message || '生成失败') + '</span></div>';
  if (task.status === 'cancelled') return '<div class="doc88-task-state is-muted">已取消</div>';
  if (task.status === 'success') return '<div class="doc88-task-state is-success"><i class="ti ti-check"></i><span>' + escapeHtml(task.message || '生成完成') + '</span></div>';
  var percent = task.total ? Math.round(task.current * 100 / task.total) : 0;
  return '<div class="doc88-task-state is-running"><div><span>' + escapeHtml(task.message || '等待执行') + '</span><em>' + (task.total ? task.current + '/' + task.total : task.phase) + '</em></div><span class="doc88-progress"><i style="width:' + percent + '%"></i></span><button class="btn btn-ghost btn-xs" data-doc88-action="cancel" data-task-id="' + escapeAttr(task.id) + '"' + (task.phase === 'indexing' ? ' disabled' : '') + '>取消</button></div>';
}

function renderDoc88Pager() {
  var target = document.getElementById('doc88Pager');
  target.innerHTML = '<span>第 ' + doc88State.page + ' 页</span><div><button class="btn btn-ghost btn-sm" data-doc88-page="' + (doc88State.page - 1) + '"' + (doc88State.page <= 1 ? ' disabled' : '') + '>上一页</button><button class="btn btn-ghost btn-sm" data-doc88-page="' + (doc88State.page + 1) + '"' + (!doc88State.hasMore ? ' disabled' : '') + '>下一页</button></div>';
}

async function startDoc88Generation(item) {
  var pcode = String(item.pcode);
  if (doc88State.pending.has(pcode)) return;
  doc88State.pending.add(pcode);
  renderDoc88Results();
  var standardNumber = item.standardNumber || '';
  var cleanTitle = item.cleanTitle || item.title || '';
  try {
    var confirmed = await showConfirmHtml({
      title: '生成并写入文件库',
      bodyHtml: '<div class="doc88-confirm"><label>标准号<input id="doc88NamingCode" value="' + escapeAttr(standardNumber) + '" placeholder="例如 GB/T 3325-2024"></label><label>标准名称<input id="doc88NamingTitle" value="' + escapeAttr(cleanTitle) + '"></label><p>' + (standardNumber ? '' : '标题未能可靠识别标准号，请手动填写。') + '产物为位图 PDF；按文件库命名规则保存，可在生成后重命名。</p></div>',
      confirmText: '开始生成', cancelText: '取消', initialFocus: '#doc88NamingCode',
      onMount: function (overlay) {
        overlay.querySelector('#doc88NamingCode').addEventListener('input', function (event) { standardNumber = event.target.value; });
        overlay.querySelector('#doc88NamingTitle').addEventListener('input', function (event) { cleanTitle = event.target.value; });
      },
    });
    if (!confirmed) return;
    var res = await window.StdHub.api.fetch('/api/doc88/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pcode: String(item.pcode), title: item.title || '', standardNumber: standardNumber.trim(), cleanTitle: cleanTitle.trim() }) });
    var task = await readApiResponse(res);
    if (!res.ok) throw new Error(task.message || '任务创建失败');
    doc88State.tasks.set(String(item.pcode), task);
    renderDoc88Results();
    followDoc88Task(item.pcode, task.id);
    loadDoc88Health(true);
  } catch (error) { showToast(error.message || String(error), 'fail'); }
  finally { doc88State.pending.delete(pcode); renderDoc88Results(); }
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
        if (task.status === 'success') {
          showToast('Doc88 PDF 已生成并写入文件库');
          if (typeof recordDownload === 'function') recordDownload('doc88', task.fileName, task.standardNumber, task.fileId);
        }
        if (task.status === 'failed') showToast(task.error && task.error.message || 'Doc88 生成失败', 'fail');
      }
    } catch (_) { /* ignore malformed event */ }
  };
  stream.onerror = function () {
    stream.close(); doc88State.streams.delete(taskId);
    pollDoc88Task(pcode, taskId);
  };
}

async function pollDoc88Task(pcode, taskId) {
  if (doc88State.polls.has(taskId)) return;
  doc88State.polls.set(taskId, 0);
  try {
    var res = await window.StdHub.api.fetch('/api/doc88/tasks/' + encodeURIComponent(taskId));
    var task = await readApiResponse(res);
    if (!res.ok) throw new Error(task.message || '任务状态读取失败');
    doc88State.tasks.set(String(pcode), task); renderDoc88Results();
    if (!['success', 'failed', 'cancelled'].includes(task.status)) {
      var timer = setTimeout(function () { doc88State.polls.delete(taskId); pollDoc88Task(pcode, taskId); }, 2000);
      doc88State.polls.set(taskId, timer);
    } else doc88State.polls.delete(taskId);
  } catch (_) { doc88State.polls.delete(taskId); }
}

async function renameDoc88File(fileId, fileName) {
  await renameLocalFile(fileId, fileName);
  doc88State.restored = false;
  doc88State.tasks.forEach(function (task, key) { if (Number(task.fileId) === fileId) doc88State.tasks.delete(key); });
  await restoreDoc88Tasks();
  if (doc88State.keyword) await doDoc88Search(doc88State.page);
}

async function cancelDoc88Task(taskId) {
  try {
    var res = await window.StdHub.api.fetch('/api/doc88/tasks/' + encodeURIComponent(taskId) + '/cancel', { method: 'POST' });
    var task = await readApiResponse(res);
    if (!res.ok) throw new Error(task.message || '取消失败');
    doc88State.tasks.set(String(task.pcode), task); renderDoc88Results();
  } catch (error) { showToast(error.message || String(error), 'fail'); }
}

function handleDoc88Action(event) {
  var button = event.target.closest('[data-doc88-action]');
  if (!button) return;
  var action = button.dataset.doc88Action;
  if (action === 'generate') { var item = doc88ItemByPcode(button.dataset.pcode); if (item) startDoc88Generation(item); }
  if (action === 'cancel') cancelDoc88Task(button.dataset.taskId);
  if (action === 'preview') openLocalPreview(Number(button.dataset.fileId));
  if (action === 'download') downloadLocalFile(Number(button.dataset.fileId), button.dataset.fileName || '');
  if (action === 'rename') renameDoc88File(Number(button.dataset.fileId), button.dataset.fileName || '');
}
document.getElementById('doc88Results')?.addEventListener('click', handleDoc88Action);
document.getElementById('doc88TaskHistoryList')?.addEventListener('click', handleDoc88Action);

document.getElementById('doc88Pager')?.addEventListener('click', function (event) {
  var button = event.target.closest('[data-doc88-page]');
  if (button && !button.disabled) doDoc88Search(Number(button.dataset.doc88Page));
});

window.doDoc88Search = doDoc88Search;
window.loadDoc88Health = loadDoc88Health;

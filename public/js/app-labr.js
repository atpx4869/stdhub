// ── Labr 库检索（第四源：labr.cc）──
// 前端交互层：搜索 / 分页 / 单条下载 / 批量下载。
// 业务路径 / 错误码 / kind 路由都在后端 labr-service 处理，前端只展示结果。
//
// 关键字段（来自 LabrListItem）：
//   did / title / hl_title / pubdt / kind / ext / is_free / price
//   kind=0 → 匿名直拉（filesystem 真路径），无登录消耗
//   kind=1 → 需登录走 preview2（5/天限速）→ 用红色徽章提示
//
// 状态机：
//   labrState.keyword 现在搜的关键词（用于翻页比对）
//   labrState.page    当前页（1-based）
//   labrState.pageSize 默认 100
//   labrState.lastResult 当前页结果（用于批量下载从勾选 did 拿数据）

var labrState = {
  keyword: '',
  page: 1,
  pageSize: 100,
  total: 0,
  hasMore: false,
  lastResult: [],
  selected: new Set(),  // 已勾选的 did
  searchToken: 0,       // 防止慢速资质查询覆盖后发搜索
  qualificationData: {}, // LABR 专用资质数据：允许以“跨年”方式提示
  libraryFileIds: {},    // 标准号 → 本地标准库 fileId，预览时跳过 LABR 上游
  details: new Map(),
  detailLoading: new Set(),
};

async function doLabrSearch(page) {
  var input = document.getElementById('labrSearchInput');
  var kw = (input && input.value || '').trim();
  if (!kw) {
    document.getElementById('labrResults').innerHTML = '<div class="qual-empty">请输入关键词</div>';
    document.getElementById('labrPager').innerHTML = '';
    return;
  }
  // 手机端 landing → active：搜索框 sticky 吸顶
  if (typeof setSearchStage === 'function') setSearchStage('labr', 'active');
  // 翻页时 keyword 不变；新搜索时重置 selected 集合
  if (kw !== labrState.keyword) {
    labrState.selected = new Set();
  }
  labrState.keyword = kw;
  labrState.page = (typeof page === 'number' && page >= 1) ? page : 1;
  var searchToken = ++labrState.searchToken;

  var resultsEl = document.getElementById('labrResults');
  resultsEl.innerHTML = '<div style="padding:24px;text-align:center"><span class="spinner"></span> 正在检索 labr.cc…</div>';
  document.getElementById('labrPager').innerHTML = '';

  try {
    var url = '/api/labr/search?keyword=' + encodeURIComponent(kw)
      + '&page=' + labrState.page
      + '&pageSize=' + labrState.pageSize;
    var res = await fetch(url);
    var data = await readApiResponse(res);
    if (!res.ok) throw new Error(data.message || '搜索失败');
    labrState.lastResult = data.list || [];
    labrState.total = data.total || 0;
    labrState.hasMore = !!data.hasMore;
    renderLabrResults();
    renderLabrPager();
    updateLabrBatchBtn();
    loadLabrQualificationBadges(searchToken);
  } catch (e) {
    resultsEl.innerHTML = '<div class="qual-empty" style="color:var(--danger)">搜索失败: ' + escapeHtml(e.message || String(e)) + '</div>';
  }
}

function renderLabrResults() {
  var out = document.getElementById('labrResults');
  var list = labrState.lastResult;
  if (!list.length) {
    out.innerHTML = '<div class="qual-empty">未找到匹配的标准</div>';
    return;
  }

  var rowsHtml = list.map(function (item) {
    var did = item.did;
    var checked = labrState.selected.has(did) ? 'checked' : '';
    // hl_title 含 <font color=red> 高亮 — 由 labr 后端给出，已经做过基本清洗。
    // 直接渲染前必须 sanitize：只允许 <font color="red"> / <mark> / <b>，其他 strip。
    // 后端已切出标准号，名称单独显示，避免“标准号徽章 + 原标题”重复。
    var titleHtml = sanitizeLabrTitle(item.cleanTitle || item.hl_title || item.title || '');
    var stdCode = getLabrStdCode(item);
    var stdCodeBadge = stdCode
      ? '<span class="labr-std-code">' + escapeHtml(stdCode) + '</span>'
      : '';
    // LABR 专用资质查询允许跨年提示；严格命中仍优先显示。
    var labrQuals = labrState.qualificationData[stdCode];
    var qualificationBadge = stdCode && typeof qualBadgeHtml === 'function'
      ? qualBadgeHtml(stdCode, labrQuals)
      : '';
    var capLibBadge = stdCode && typeof capLibBadgeHtml === 'function'
      ? capLibBadgeHtml(stdCode)
      : '';
    var natCmaBadge = stdCode && typeof natCmaBadgeHtml === 'function'
      ? natCmaBadgeHtml(stdCode)
      : '';
    var localFileId = stdCode && labrState.libraryFileIds[stdCode];
    var localBadge = localFileId
      ? '<span class="labr-local-badge" title="本地标准库已有，预览会直接打开本地文件">已下载</span>'
      : '';

    // kind 徽章：0=直拉无消耗，1=登录消耗 5/天 配额
    var kindBadge = item.kind === 1
      ? '<span class="labr-kind-badge labr-kind-1" title="此条需要登录 labr.cc + 消耗 5/天 配额">登录</span>'
      : '<span class="labr-kind-badge labr-kind-0" title="直拉 — 无配额消耗">直拉</span>';

    var extBadge = item.ext
      ? '<span class="labr-ext-badge labr-ext-' + escapeHtml(item.ext) + '">' + escapeHtml(item.ext.toUpperCase()) + '</span>'
      : '';

    var freeBadge = item.is_free === 0 && item.price > 0
      ? '<span class="labr-paid-badge" title="付费资源，下载可能失败">¥' + item.price + '</span>'
      : '';

    var pubdt = item.pubdt ? '<span class="labr-pubdt">' + escapeHtml(item.pubdt) + '</span>' : '';

    return '<div class="labr-result-item" style="margin-bottom:4px"><div class="labr-row" data-did="' + did + '">'
      + '<label class="labr-row-check">'
      + '<input type="checkbox" data-labr-did="' + did + '" ' + checked + ' onchange="toggleLabrSelect(' + did + ', this.checked)">'
      + '</label>'
      + '<div class="labr-row-main">'
      +   '<div class="labr-row-title">' + stdCodeBadge + qualificationBadge + capLibBadge + natCmaBadge + localBadge + ' ' + titleHtml + '</div>'
      +   '<div class="labr-row-meta">' + kindBadge + ' ' + extBadge + ' ' + freeBadge + ' ' + pubdt + '</div>'
      + '</div>'
      + '<div class="labr-row-actions">'
      +   '<button class="btn btn-ghost btn-sm" onclick="toggleLabrDetail(' + did + ')">' + (labrState.details.has(did) || labrState.detailLoading.has(did) ? '收起' : '详情') + '</button> '
      +   (String(item.ext || '').toLowerCase() === 'pdf' ? '<button class="btn btn-ghost btn-sm" onclick="previewLabrPdf(' + did + ', this)">' + (localFileId ? '本地预览' : '预览') + '</button> ' : '')
      +   '<button class="btn btn-ghost btn-sm" onclick="doLabrDownload(' + did + ', this)">下载</button>'
      + '</div>'
      + '</div>'
      + renderLabrDetailPanel(did)
      + '</div>';
  }).join('');

  var header = '<div class="labr-results-header">'
    + '<label class="labr-select-all"><input type="checkbox" onchange="toggleLabrSelectAll(this.checked)"> 全选本页</label>'
    + '<span class="labr-results-count">本页 ' + list.length + ' 条 / 总 ' + (labrState.total || '?') + '</span>'
    + '</div>';

  out.innerHTML = header + '<div class="labr-rows">' + rowsHtml + '</div>';
}

function getLabrStdCode(item) {
  var source = item && item.stdCode;
  // 兼容刚升级时浏览器缓存中的旧接口对象，避免再次渲染为 [object Object]。
  if (source && typeof source === 'object') source = source.stdCode;
  return String(source || (item && extractStdCodeFromLabrTitle(item.title || '')) || '').trim();
}

function renderLabrDetailPanel(did) {
  if (labrState.detailLoading.has(did)) {
    return '<div style="margin:0 10px 8px;padding:10px 12px;border:1px solid var(--border);border-radius:8px;color:var(--text-3);font-size:12px">正在加载详情…</div>';
  }
  var payload = labrState.details.get(did);
  if (!payload) return '';
  var info = payload.info || {};
  var detail = payload.detail || {};
  var price = info.isFree === 0 && Number(info.price) > 0 ? ('¥' + escapeHtml(info.price)) : '免费或未标价';
  var rows = [
    ['文件类型', detail.filetype || info.ext || '—'],
    ['文件名', detail.filename || '—'],
    ['发布日期', info.pubdt || '—'],
    ['下载次数', detail.downloads ?? '—'],
    ['资源方式', Number(info.kind) === 1 ? '登录获取（可能消耗配额）' : '直连获取'],
    ['价格', price],
  ];
  return '<div style="margin:0 10px 8px;padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:var(--surface);font-size:12px">'
    + '<div style="font-weight:600;color:var(--text);margin-bottom:8px">资源详情</div>'
    + rows.map(function (row) { return '<div style="display:flex;gap:10px;line-height:1.8"><span style="width:64px;flex:none;color:var(--text-3)">' + escapeHtml(row[0]) + '</span><span style="min-width:0;overflow-wrap:anywhere;color:var(--text-2)">' + (row[0] === '价格' ? row[1] : escapeHtml(row[1])) + '</span></div>'; }).join('')
    + '</div>';
}

async function toggleLabrDetail(did) {
  if (labrState.details.has(did)) {
    labrState.details.delete(did);
    renderLabrResults();
    return;
  }
  if (labrState.detailLoading.has(did)) return;
  labrState.detailLoading.add(did);
  renderLabrResults();
  try {
    var res = await fetch('/api/labr/detail/' + encodeURIComponent(did));
    var data = await readApiResponse(res);
    if (!res.ok) throw new Error(data.message || '详情加载失败');
    labrState.details.set(did, data);
  } catch (error) {
    if (typeof showToast === 'function') showToast(error.message || String(error), 'fail');
  } finally {
    labrState.detailLoading.delete(did);
    renderLabrResults();
  }
}

function startLabrTask(label, progress) {
  return typeof createTaskCenterTask === 'function'
    ? createTaskCenterTask({ type: 'download', label: label, progress: progress, phase: 'preparing' })
    : null;
}
function updateLabrTask(taskId, patch) {
  if (taskId !== null && typeof updateTaskCenterTask === 'function') updateTaskCenterTask(taskId, patch);
}
function finishLabrTask(taskId, status, patch) {
  if (taskId !== null && typeof completeTaskCenterTask === 'function') completeTaskCenterTask(taskId, status, patch || {});
}

async function loadLabrQualificationBadges(searchToken) {
  var stdCodes = labrState.lastResult
    .map(function (item) { return getLabrStdCode(item); })
    .filter(Boolean);
  if (!stdCodes.length) return;
  var unique = Array.from(new Set(stdCodes));
  await Promise.all([
    loadLabrQualifications(unique),
    loadLabrLibraryFiles(unique),
    typeof fetchCapLibBadges === 'function' ? fetchCapLibBadges(unique) : Promise.resolve(),
    typeof fetchNatCmaBadges === 'function' ? fetchNatCmaBadges(unique) : Promise.resolve(),
  ]);
  // 搜索期间用户可能已翻页或输入了新关键词，只刷新仍在显示的那一页。
  if (searchToken === labrState.searchToken) renderLabrResults();
}

async function loadLabrQualifications(stdCodes) {
  try {
    var res = await fetch('/api/qualifications/batch-query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stdCodes: stdCodes, includeCrossYear: true }),
    });
    var data = res.ok ? await readApiResponse(res) : {};
    stdCodes.forEach(function (code) {
      labrState.qualificationData[code] = data[code] || [];
    });
  } catch (_) {
    stdCodes.forEach(function (code) {
      labrState.qualificationData[code] = [];
    });
  }
}

async function loadLabrLibraryFiles(stdCodes) {
  try {
    var items = stdCodes.map(function (stdCode) {
      var yearMatch = /-\s*(\d{4})\s*$/.exec(stdCode);
      return yearMatch ? { stdCode: stdCode, year: yearMatch[1] } : { stdCode: stdCode };
    });
    var res = await fetch('/api/preview/library-check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: items }),
    });
    var data = res.ok ? await readApiResponse(res) : {};
    var fileIds = data.fileIds || [];
    stdCodes.forEach(function (stdCode, index) {
      if (fileIds[index]) labrState.libraryFileIds[stdCode] = fileIds[index];
      else delete labrState.libraryFileIds[stdCode];
    });
  } catch (_) {
    // 本地标记是增强体验；接口临时不可用时仍保留正常 LABR 搜索与预览。
  }
}

function renderLabrPager() {
  var pager = document.getElementById('labrPager');
  var html = '';
  var page = labrState.page;
  if (page > 1) html += '<button class="btn btn-ghost btn-sm" onclick="doLabrSearch(' + (page - 1) + ')">上一页</button>';
  html += '<span style="font-size:12px;color:var(--text-3);padding:0 12px;align-self:center">第 ' + page + ' 页</span>';
  if (labrState.hasMore) html += '<button class="btn btn-ghost btn-sm" onclick="doLabrSearch(' + (page + 1) + ')">下一页</button>';
  pager.innerHTML = html;
}

function toggleLabrSelect(did, on) {
  if (on) labrState.selected.add(did);
  else labrState.selected.delete(did);
  updateLabrBatchBtn();
}

function toggleLabrSelectAll(on) {
  var checks = document.querySelectorAll('#labrResults input[data-labr-did]');
  checks.forEach(function (cb) {
    cb.checked = on;
    var did = Number(cb.getAttribute('data-labr-did'));
    if (on) labrState.selected.add(did);
    else labrState.selected.delete(did);
  });
  updateLabrBatchBtn();
}

function updateLabrBatchBtn() {
  var btn = document.getElementById('labrBatchBtn');
  if (!btn) return;
  var n = labrState.selected.size;
  btn.disabled = n === 0;
  btn.textContent = n > 0 ? ('批量下载选中 (' + n + ')') : '批量下载选中';
}

async function doLabrDownload(did, btn) {
  var item = labrState.lastResult.find(function (entry) { return Number(entry.did) === did; });
  var taskId = startLabrTask('LABR 下载 · ' + getLabrStdCode(item || {}), '正在准备下载…');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>'; }
  try {
    updateLabrTask(taskId, { phase: 'downloading', progress: '正在从 LABR 获取文件…' });
    var res = await fetch('/api/labr/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ did: did }),
    });
    var data = await readApiResponse(res);
    if (!res.ok) {
      // 限速 / 鉴权失败由后端给出 code
      var msg = data.message || '下载失败';
      if (data.code === 'LABR_RATE_LIMIT') msg = 'labr.cc 5/天 配额已用完，请明天再试';
      if (data.code === 'LABR_AUTH') msg = 'labr.cc 登录态失效，请联系管理员检查凭据';
      throw new Error(msg);
    }
    var info = data.reused
      ? ('已存在库中（' + (data.fileName || '') + '）')
      : ('已落地到标准库（' + (data.fileName || '') + '）');
    finishLabrTask(taskId, 'success', { phase: 'complete', progress: data.reused ? '已从本地标准库复用' : '已下载并入库' });
    if (typeof showToast === 'function') showToast(info, 'success');
    var stdCode = getLabrStdCode(item) || data.stdCode;
    if (data.fileId && stdCode) {
      labrState.libraryFileIds[stdCode] = data.fileId;
      renderLabrResults();
    }
    if (btn) { btn.disabled = false; btn.textContent = data.reused ? '已存在' : '已下载'; }
  } catch (e) {
    finishLabrTask(taskId, 'fail', { phase: 'failed', progress: e.message || String(e) });
    if (typeof showToast === 'function') showToast(e.message || String(e), 'fail');
    if (btn) { btn.disabled = false; btn.textContent = '下载'; }
  }
}

async function previewLabrPdf(did, btn) {
  var item = labrState.lastResult.find(function (entry) { return Number(entry.did) === did; });
  if (!item) return;
  if (String(item.ext || '').toLowerCase() !== 'pdf') {
    if (typeof showToast === 'function') showToast('该资源不是 PDF，暂不支持在线预览，请下载后用本地应用打开', 'warning');
    return;
  }
  var stdCode = getLabrStdCode(item);
  var localFileId = stdCode && labrState.libraryFileIds[stdCode];
  if (localFileId && typeof openLocalPreview === 'function') {
    openLocalPreview(localFileId);
    if (typeof showToast === 'function') showToast('已直接打开本地标准库文件', 'success');
    return;
  }
  if (item.kind === 1 && typeof showConfirm === 'function') {
    var approved = await showConfirm({
      title: '准备 LABR PDF 预览',
      body: '首次预览会把文件保存到本地标准库；该条目需要登录，可能消耗 labr.cc 当日配额。',
      confirmText: '继续预览',
    });
    if (!approved) return;
  }

  var originalText = btn ? btn.textContent : '';
  var taskId = startLabrTask('LABR 预览 · ' + getLabrStdCode(item), '正在准备预览…');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>'; }
  var title = (item.title || '').replace(/<[^>]+>/g, '').trim() || 'LABR 标准预览';
  if (typeof openPreviewOverlay === 'function') openPreviewOverlay(title);
  if (typeof setPreviewBody === 'function') setPreviewBody('<div class="preview-loading">正在准备 LABR PDF 预览…</div>');

  try {
    updateLabrTask(taskId, { phase: 'downloading', progress: '正在下载并入库…' });
    var res = await fetch('/api/labr/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ did: did }),
    });
    var data = await readApiResponse(res);
    if (!res.ok) {
      var message = data.message || '预览准备失败';
      if (data.code === 'LABR_RATE_LIMIT') message = 'labr.cc 5/天 配额已用完，请明天再试';
      if (data.code === 'LABR_AUTH') message = 'labr.cc 登录态失效，请联系管理员检查凭据';
      throw new Error(message);
    }
    if (String(data.ext || '').toLowerCase() !== 'pdf') {
      throw new Error('该资源实际不是 PDF，已保存到本地标准库，请下载后用本地应用打开');
    }

    var url = '/api/preview/file/' + encodeURIComponent(data.fileId);
    if (window.bzxz && window.bzxz.isElectron) {
      window.open((typeof API === 'string' ? API : '') + url, '_blank');
      if (typeof closePreviewOverlay === 'function') closePreviewOverlay();
    } else if (typeof renderPreviewWithCurrentFile === 'function') {
      renderPreviewWithCurrentFile(url, data.stdCode || title, { fileId: data.fileId });
      if (typeof loadPreviewSourcePicker === 'function' && data.stdCode) {
        loadPreviewSourcePicker(data.stdCode, undefined, data.fileId);
      }
    }
    finishLabrTask(taskId, 'success', { phase: 'complete', progress: data.reused ? '已从本地标准库打开预览' : '已入库并打开预览' });
    if (typeof showToast === 'function') showToast(data.reused ? '已从本地标准库打开预览' : '已保存到标准库并打开预览', 'success');
  } catch (error) {
    finishLabrTask(taskId, 'fail', { phase: 'failed', progress: error.message || String(error) });
    if (typeof setPreviewBody === 'function') {
      setPreviewBody('<div class="preview-empty"><div class="preview-empty-title">预览失败</div><div class="preview-empty-hint">' + escapeHtml(error.message || String(error)) + '</div></div>');
    }
    if (typeof showToast === 'function') showToast(error.message || String(error), 'fail');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = originalText || '预览'; }
  }
}

async function doLabrBatchDownload() {
  var dids = Array.from(labrState.selected);
  if (!dids.length) return;
  if (typeof showConfirm === 'function') {
    var ok = await showConfirm({
      title: '批量下载 labr 资源',
      body: '将下载 ' + dids.length + ' 条记录。需登录的条目会消耗 labr.cc 5/天 配额；遇到限速时后续登录类条目会自动跳过。',
      confirmText: '开始下载',
    });
    if (!ok) return;
  }
  var btn = document.getElementById('labrBatchBtn');
  var taskId = startLabrTask('LABR 批量下载 · ' + dids.length + ' 项', '正在准备批量下载…');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> 下载中…'; }

  try {
    updateLabrTask(taskId, { phase: 'downloading', progress: '正在下载 ' + dids.length + ' 项…' });
    var res = await fetch('/api/labr/batch-download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: dids.map(function (d) { return { did: d }; }) }),
    });
    var data = await readApiResponse(res);
    if (!res.ok) throw new Error(data.message || '批量下载失败');
    var results = data.results || [];
    var ok = results.filter(function (r) { return r.ok; }).length;
    var fail = results.length - ok;
    var rateLimited = results.filter(function (r) { return r.code === 'LABR_RATE_LIMIT'; }).length;
    var msg = '完成：成功 ' + ok + ' · 失败 ' + fail
      + (rateLimited ? '（其中 ' + rateLimited + ' 条因 labr 5/天 配额被跳过）' : '');
    finishLabrTask(taskId, fail ? 'fail' : 'success', { phase: fail ? 'failed' : 'complete', progress: msg });
    if (typeof showToast === 'function') showToast(msg, fail ? 'warning' : 'success');

    // 把失败原因渲染到对应行
    results.forEach(function (r) {
      var row = document.querySelector('#labrResults .labr-row[data-did="' + r.did + '"]');
      if (!row) return;
      var act = row.querySelector('.labr-row-actions');
      if (!act) return;
      if (r.ok) {
        var payload = r.result || {};
        var stdCode = payload.stdCode || getLabrStdCode(labrState.lastResult.find(function (item) { return Number(item.did) === Number(r.did); }) || {});
        if (payload.fileId && stdCode) labrState.libraryFileIds[stdCode] = payload.fileId;
        act.innerHTML = '<span style="font-size:11px;color:var(--success)">' + (payload.reused ? '已存在' : '已下载') + '</span>';
      } else {
        act.innerHTML = '<span style="font-size:11px;color:var(--danger)" title="' + escapeHtml(r.message || '') + '">' + (r.code || 'ERR') + '</span>';
      }
    });

    // 清空 selection 后再重绘，避免页面保留旧的勾选状态。
    labrState.selected = new Set();
    renderLabrResults();
  } catch (e) {
    finishLabrTask(taskId, 'fail', { phase: 'failed', progress: e.message || String(e) });
    if (typeof showToast === 'function') showToast(e.message || String(e), 'fail');
  } finally {
    updateLabrBatchBtn();
  }
}

// ─── pure helpers ──────────────────────────────────────────────────────────

/**
 * 从标题里抠出标准号（前置子串）。和后端 extractStdCodeFromTitle 保持等价语义，
 * 用于列表展示徽章。匹配规则：GB/T、ISO、JJG、QB、HG/T、HJ、SN/T、YS/T 等开头 +
 * 数字 + 可选年份。匹配不到就返回空串，让标题原文兜底。
 */
function extractStdCodeFromLabrTitle(title) {
  if (!title) return '';
  var m = title.match(/^([A-Z]{1,6}(?:\/[A-Z]{1,3})?\s*[\d\.\-]+(?:[-—]\d{4})?)/);
  return m ? m[1].trim() : '';
}

/**
 * labr 的 hl_title 含 <font color="red">...</font> 高亮标签。
 * 策略：先把 <font ...> / </font> 整体替换成 <mark> / </mark>（语义对齐搜索高亮，
 * 且无 attribute 需要白名单），然后整串 escape，最后把 <mark>/<b> 解回。
 *
 * 注：之前的实现想白名单保留 <font color=...>，但 escape 后原始 " 没变 &quot;，
 * 正则里写的是 [&quot;'] 永远匹配不上 → 标签被 escape 后字面泄漏成
 * "<font color=\"red\">"。改成统一转 <mark> 后 attribute 数=0，规则更稳。
 */
function sanitizeLabrTitle(html) {
  if (!html) return '';
  // 1) labr 的高亮 <font color="red">x</font> 统一转 <mark>x</mark>
  var converted = String(html).replace(/<font[^>]*>/gi, '<mark>').replace(/<\/font>/gi, '</mark>');
  // 2) 全部 escape
  var safe = converted.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // 3) 把白名单 <mark>/<b> 解回
  return safe.replace(/&lt;(\/?)(mark|b)&gt;/g, '<$1$2>');
}

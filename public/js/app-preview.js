// ── Preview Subsystem: popup, overlay, PDF viewer, source picker ──

// ── PDF 预览（Phase 2 + Phase 3 polish）──
// 流程：POST /api/preview/request →
//   ready       → iframe 加载 /api/preview/file/:id
//   downloading → 后端已起任务，前端 poll /api/preview/task/:id 直到 ready / failed
//                 → ready 切 iframe；failed 提示用户、给「重试」按钮
//
// Phase 3 调整：
// - 后端无 deadline，前端只在 ready / failed / 用户主动关闭时停 poll
// - 失败 UI 加「重试」按钮，触发新的 /api/preview/request（后端按 stdCode+year 去重，
//   若旁路还有 pending/downloading 任务会复用；否则起新任务）
let _previewCurrent = null; // { fileId, url, fileName }
let _mobileViewer = null;   // pdfh5 实例（手机端预览），关闭 overlay 时销毁
let _pdfViewer = null;      // PDFViewer 实例（桌面端 overlay 模式），关闭 overlay 时销毁
// 仅服务 overlay 模式的 pollPreviewTask；closePreviewOverlay 会 abort 它。
// Popup 模式（pollPreviewTaskForPopup）每个 popup 用自己的局部 AbortController，
// 不共享这个全局变量 —— 避免连续点 A→B 时把 A 的 poll 误杀。
let _previewPollAbort = null;
let _previewLastId = null;   // 缓存最近一次预览的结果 id，用于失败重试
let _previewAssetsWarmupStarted = false;

const PREVIEW_SOURCE_LABELS = {
  gbw: '国家标准全文公开系统',
  bz: '标准网',
  by: '标准院',
  labr: 'Labr 补给页',
};

const PREVIEW_PHASE_LABELS = {
  checking_library: '查本地库',
  searching_source: '搜索来源',
  downloading: '下载 PDF',
  moving_to_library: '保存入库',
  ready: '准备打开',
  failed: '处理失败',
};

function schedulePreviewAssetsWarmup() {
  if (_previewAssetsWarmupStarted) return;
  _previewAssetsWarmupStarted = true;
  const warmup = () => {
    if (typeof window.preloadPdfViewerAssets === 'function') {
      window.preloadPdfViewerAssets().catch(err => console.debug('[preview] PDF.js preload skipped:', err?.message || err));
    }
    preloadPdfh5Worker();
  };
  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(warmup, { timeout: 3000 });
  } else {
    window.setTimeout(warmup, 1200);
  }
}

function preloadPdfh5Worker() {
  if (document.querySelector('link[data-preview-preload="pdfh5-worker"]')) return;
  const link = document.createElement('link');
  link.rel = 'prefetch';
  link.href = '/vendor/pdfh5/js/pdf.worker.min.js';
  link.as = 'script';
  link.setAttribute('data-preview-preload', 'pdfh5-worker');
  document.head.appendChild(link);
}

function renderPreviewPreparing(message) {
  setPreviewBody(`
    <div class="preview-loading preview-prepare-card">
      <div class="preview-task-spinner" aria-hidden="true"></div>
      <div class="preview-task-main">
        <div class="preview-task-kicker">准备预览</div>
        <div class="preview-task-message">${escapeHtml(message || '正在准备 PDF 预览资源…')}</div>
        <div class="preview-task-hint">PDF 较大或手机内嵌浏览器较慢时，首次打开可能需要多等几秒。</div>
      </div>
    </div>`);
}

function formatPreviewElapsed(ms) {
  const n = Number(ms || 0);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 1000) return '刚刚开始';
  return `已用 ${Math.round(n / 1000)} 秒`;
}

function getPreviewTaskMessage(data, attempt, fallback) {
  if (data && data.message) return data.message;
  if (data && data.status === 'pending') return '正在准备自动入库…';
  if (data && data.phase === 'searching_source') return '正在搜索可用来源…';
  if (data && data.phase === 'downloading') return '正在下载 PDF…';
  if (data && data.phase === 'moving_to_library') return '下载完成，正在保存到本地标准库…';
  return fallback || `正在自动下载…（${attempt || 1}）`;
}

function renderPreviewTaskProgress(data, attempt, stdCode) {
  const phase = data?.phase || (data?.status === 'pending' ? 'checking_library' : 'downloading');
  const phaseLabel = PREVIEW_PHASE_LABELS[phase] || '自动入库';
  const source = data?.sourceLabel || PREVIEW_SOURCE_LABELS[data?.source] || data?.source || '';
  const elapsed = formatPreviewElapsed(data?.elapsedMs);
  const message = getPreviewTaskMessage(data, attempt, '正在自动下载并保存到本地标准库…');
  const attemptText = data?.attempt ? `第 ${data.attempt} 个来源` : (attempt ? `轮询 ${attempt} 次` : '');
  const meta = [source, elapsed, attemptText].filter(Boolean).map(escapeHtml).join(' · ');
  setPreviewBody(`
    <div class="preview-loading preview-task-card">
      <div class="preview-task-spinner" aria-hidden="true"></div>
      <div class="preview-task-main">
        <div class="preview-task-kicker">${escapeHtml(phaseLabel)}</div>
        <div class="preview-task-title">${escapeHtml(stdCode || '标准预览')}</div>
        <div class="preview-task-message">${escapeHtml(message)}</div>
        ${meta ? `<div class="preview-task-meta">${meta}</div>` : ''}
        <div class="preview-task-hint">首次入库可能 5~30 秒，受源站速度影响；完成后会自动打开预览。</div>
      </div>
    </div>`);
}

/**
 * 用自研 PDFViewer 渲染 PDF（桌面端 overlay 模式）。
 * 替换旧的 iframe 方案，提供底部工具栏：翻页、缩放、下载、关闭。
 */
function _renderPdfWithViewer(url, stdCode) {
  if (_pdfViewer) { try { _pdfViewer.destroy(); } catch {} _pdfViewer = null; }
  var container = document.getElementById('previewBody');
  if (!container) return;
  try {
    if (typeof PDFViewer === 'undefined') throw new Error('PDFViewer class not loaded');
    _pdfViewer = new PDFViewer(container, {
      url: API + url,
      title: stdCode,
      onDownload: function () {
        if (!_previewCurrent) return;
        var a = document.createElement('a');
        a.href = (_previewCurrent.url || url) + '?attachment=1';
        a.download = '';
        document.body.appendChild(a); a.click(); a.remove();
      },
      onClose: function () { closePreviewOverlay(); },
    });
    // 验证 toolbar 确实被创建
    if (!container.querySelector('.pdf-toolbar')) {
      throw new Error('PDFViewer created but .pdf-toolbar not found in DOM');
    }
  } catch (e) {
    console.error('[preview] PDFViewer failed:', e.message || e);
    _pdfViewer = null;
    setPreviewBody('<div class="preview-empty"><div class="preview-empty-title">PDF渲染失败</div><div class="preview-empty-hint">' + escapeHtml(String(e.message || e)) + '</div></div>');
  }
}

async function pollPreviewTask(taskId, stdCode) {
  // 用 AbortController 让"关闭预览 / 重试"能立刻停掉旧 poll。
  const ctrl = new AbortController();
  _previewPollAbort = ctrl;
  let attempt = 0;
  let lastData = null;
  // 无 deadline：只在 ready / failed / abort 时返回。
  // 后端 preview-task-store 有 10 分钟无更新的 TTL 兜底，最坏情况会返回 404。
  while (!ctrl.signal.aborted) {
    attempt++;
    renderPreviewTaskProgress(lastData, attempt, stdCode);
    // 前 5 次 300ms 快速捕获缓存命中（CNAS/By 源 ~1-2s 就完成），之后退化到 1500ms 减负载
    const wait = attempt <= 5 ? 300 : 1500;
    await new Promise(r => setTimeout(r, wait));
    if (ctrl.signal.aborted) return;
    let data;
    let httpOk = true;
    try {
      const res = await fetch(`${API}/api/preview/task/${encodeURIComponent(taskId)}`, { signal: ctrl.signal });
      httpOk = res.ok;
      data = await readApiResponse(res);
    } catch (e) {
      if (ctrl.signal.aborted) return;
      // 轮询接口短暂抖动 → 继续重试
      continue;
    }
    // 任务过期（TTL 兜底命中）→ 当作失败处理，让用户点重试
    if (!httpOk || !data || data.status === undefined) {
      renderPreviewFailedUi(data?.error || '任务已过期或不存在，请重试');
      return;
    }
    if (data.status === 'ready') {
      renderPreviewTaskProgress(data, attempt, stdCode);
      _previewCurrent = { fileId: data.fileId, url: data.url, fileName: stdCode };
      if (data.fileId && _previewLastId) { _libraryFileIds.set(_previewLastId, data.fileId); applyLibraryDots(); }
      // Electron 桌面端：跳系统浏览器（与 runPreviewWithOverlay ready 分支一致）
      if (window.bzxz && window.bzxz.isElectron) {
        window.open(`${API}${data.url}`, '_blank');
        closePreviewOverlay();
        return;
      }
      _renderPdfWithViewer(data.url, stdCode);
      return;
    }
    if (data.status === 'failed') {
      renderPreviewFailedUi(data.error || '所有源都未能下载到此标准。');
      return;
    }
    lastData = data;
    renderPreviewTaskProgress(data, attempt, stdCode);
    // pending / downloading → 继续循环
  }
}

/**
 * 渲染预览失败弹层：「关闭」+「重试」。
 * 重试逻辑：调用 previewStandard(_previewLastId) 重新走 /api/preview/request。
 * 后端会按 stdCode+year 去重，若有活跃任务复用，否则起新任务。
 */
function renderPreviewFailedUi(errorMsg) {
  setPreviewBody(`
    <div class="preview-empty">
      <div class="preview-empty-title">自动下载失败</div>
      <div class="preview-empty-hint">${escapeHtml(errorMsg || '未能下载到此标准。')}</div>
      <div class="preview-empty-actions">
        <button class="btn btn-primary" id="previewRetryBtn">重试</button>
        <button class="btn btn-ghost" id="previewCloseFailedBtn">关闭</button>
      </div>
    </div>`);
  const retry = document.getElementById('previewRetryBtn');
  if (retry) retry.addEventListener('click', () => {
    if (!_previewLastId) { closePreviewOverlay(); return; }
    // 停旧 poll，再走一次完整流程
    if (_previewPollAbort) {
      try { _previewPollAbort.abort(); } catch { /* ignore */ }
      _previewPollAbort = null;
    }
    previewStandard(_previewLastId);
  });
  const cls = document.getElementById('previewCloseFailedBtn');
  if (cls) cls.addEventListener('click', closePreviewOverlay);
}

/**
 * 手机端 poll 下载任务（简化版）。
 * 返回 Promise，resolve 时 data 包含 { status, fileId, url, error? }。
 */

function _pollForMobile(taskId, stdCode) {
  return new Promise((resolve) => {
    let attempt = 0;
    let lastData = null;
    const ctrl = new AbortController();
    _previewPollAbort = ctrl;

    const tick = async () => {
      attempt++;
      renderPreviewTaskProgress(lastData, attempt, stdCode);
      const wait = attempt <= 5 ? 300 : 1500;
      await new Promise(r => setTimeout(r, wait));
      if (ctrl.signal.aborted) { resolve(null); return; }
      try {
        const res = await fetch(`${API}/api/preview/task/${encodeURIComponent(taskId)}`, { signal: ctrl.signal });
        const data = await readApiResponse(res);
        if (data.status === 'ready' || data.status === 'failed' || !res.ok) {
          if (data.status === 'ready') renderPreviewTaskProgress(data, attempt, stdCode);
          resolve(data);
          return;
        }
        lastData = data;
        renderPreviewTaskProgress(data, attempt, stdCode);
        tick();
      } catch {
        if (!ctrl.signal.aborted) tick();
        else resolve(null);
      }
    };
    tick();
  });
}

/**
 * 手机端 pdfh5 canvas 预览。
 * overlay 全屏，pdfh5 自带缩放/翻页/回到顶部工具栏。
 */
async function _previewMobile(id, stdCode, r) {
  // 清理上一次残留
  if (_mobileViewer) { try { _mobileViewer.destroy(); } catch {} _mobileViewer = null; }
  if (_previewPollAbort) { try { _previewPollAbort.abort(); } catch {} _previewPollAbort = null; }

  const title = stdCode + (r.title ? `  ${r.title}` : '');
  openPreviewOverlay(title);
  renderPreviewPreparing('查询本地库…');

  try {
    const yearMatch = stdCode.match(/-\s*(\d{4})\s*$/);
    const year = yearMatch ? yearMatch[1] : undefined;
    const body = year ? { stdCode, year } : { stdCode };
    const res = await fetch(`${API}/api/preview/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await readApiResponse(res);

    let pdfUrl = null;
    if (data.status === 'ready') {
      pdfUrl = `${API}${data.url}`;
      if (data.fileId) { _libraryFileIds.set(id, data.fileId); applyLibraryDots(); }
    } else if (data.status === 'downloading' && data.taskId) {
      // 等待后端自动下载完成
      renderPreviewTaskProgress(data, 1, stdCode);
      const result = await _pollForMobile(data.taskId, stdCode);
      if (!result) return; // aborted
      if (result.status === 'ready') {
        pdfUrl = `${API}${result.url}`;
        if (result.fileId) { _libraryFileIds.set(id, result.fileId); applyLibraryDots(); }
      } else {
        renderPreviewFailedUi(result.error || '所有源都未能下载到此标准。');
        return;
      }
    } else {
      renderPreviewFailedUi(data.error || '预览请求失败，请重试。');
      return;
    }

    if (!pdfUrl) { renderPreviewFailedUi('无法获取 PDF 地址'); return; }

    // 用 pdfh5 替换旧的 PDFViewer
    var container = document.getElementById('previewBody');
    _mobileViewer = new Pdfh5(container, {
      pdfurl: pdfUrl,
      // 显式指定资源路径（pdfh5 的 auto-detect 相对页面 URL 解析，位置不对）
      workerSrc: '/vendor/pdfh5/js/pdf.worker.min.js',
      cMapUrl: '/vendor/pdfh5/cmaps/',
      standardFontDataUrl: '/vendor/pdfh5/standard_fonts/',
      iccUrl: '/vendor/pdfh5/iccs/',
      wasmUrl: '/vendor/pdfh5/wasm/',
      pageNum: true,
      loadingBar: true,
      backTop: true,
      zoomEnable: true,
      scrollEnable: true,
      maxZoom: 4,
      minZoom: 0.5,
    });
    // 监听加载失败，显示错误 UI
    _mobileViewer.on('error', function (msg) {
      console.error('[pdfh5] load error:', msg);
      renderPreviewFailedUi(msg || 'PDF 加载失败');
    });
    _mobileViewer.on('complete', function (status, msg) {
      if (status === 'error') {
        renderPreviewFailedUi(msg || 'PDF 加载失败');
      }
    });
  } catch (e) {
    renderPreviewFailedUi(e?.message || String(e));
  }
}

/**
 * 预览入口（Phase 2 — overlay 流）。
 *
 * 桌面端统一走 overlay + PDFViewer（底部缩放工具栏）；
 * 手机端走 pdfh5；Electron 桌面端跳系统浏览器。
 */
async function previewStandard(id) {
  const r = findResultByAnyId ? findResultByAnyId(id) : results.find(x => x.id === id);
  if (!r) { showToast('未找到该标准', 'fail'); return; }
  const stdCode = r.standardNumber || '';
  if (!stdCode) { showToast('该结果缺少标准号，无法预览', 'fail'); return; }
  _previewLastId = id;

  // ── 手机端：pdfh5 渲染 ──
  if (window.isMobile && window.isMobile() && window.Pdfh5) {
    await _previewMobile(id, stdCode, r);
    return;
  }

  // ── 桌面端：使用 overlay 模式（带缩放控制） ──
  await runPreviewWithOverlay(id, stdCode, r);
}

/**
 * 把简陋的 loading 骨架写进 about:blank 弹窗。
 * 用 popup.document.write 而非 innerHTML 因为新 about:blank 没有 body 节点。
 * 跨同源 origin (about:blank 继承 opener)，写权限 OK；之后 `location.replace`
 * 走掉新 URL 后，我们就再也访问不到这个 document 了 —— 但那时我们也不需要了。
 */
function writePreviewLoadingPage(win, stdCode) {
  try {
    const t = escapeHtml(stdCode);
    win.document.open();
    win.document.write(
      '<!doctype html><html lang="zh"><head><meta charset="utf-8">'
      + '<title>预览 ' + t + '…</title>'
      + '<style>html,body{height:100%;margin:0;background:#0a0d12;color:#c8cfd9;'
      + 'font-family:-apple-system,"Segoe UI",system-ui,sans-serif}'
      + '.box{display:flex;flex-direction:column;align-items:center;justify-content:center;'
      + 'height:100%;gap:14px;padding:24px;text-align:center}'
      + '.ttl{font-size:16px;font-weight:600}.hint{font-size:13px;color:#7c8696;max-width:480px;line-height:1.55}'
      + '.spin{width:38px;height:38px;border:3px solid #2a3140;border-top-color:#59aaf8;'
      + 'border-radius:50%;animation:s .9s linear infinite}'
      + '@keyframes s{to{transform:rotate(360deg)}}</style></head><body>'
      + '<div class="box"><div class="spin"></div>'
      + '<div class="ttl">正在自动下载 ' + t + '…</div>'
      + '<div class="hint" id="hint">首次入库 5~30 秒，受源站速度影响。该标签页会自动跳转到 PDF。</div>'
      + '</div></body></html>'
    );
    win.document.close();
  } catch { /* about:blank navigated away / cross-origin —— 忽略 */ }
}

/**
 * 把错误页写进弹窗（自动下载失败时）。
 * 给一个「关闭」按钮 + 错误文字。重试入口故意不放在弹窗里 —— 失败后用户回主页重点
 * 一次 预览按钮即可，避免把状态机搬到弹窗里。
 */
function writePreviewErrorPage(win, stdCode, msg) {
  try {
    const t = escapeHtml(stdCode);
    const m = escapeHtml(msg || '未能下载到此标准。');
    win.document.open();
    win.document.write(
      '<!doctype html><html lang="zh"><head><meta charset="utf-8">'
      + '<title>预览失败 - ' + t + '</title>'
      + '<style>html,body{height:100%;margin:0;background:#0a0d12;color:#c8cfd9;'
      + 'font-family:-apple-system,"Segoe UI",system-ui,sans-serif}'
      + '.box{display:flex;flex-direction:column;align-items:center;justify-content:center;'
      + 'height:100%;gap:14px;padding:24px;text-align:center}'
      + '.ttl{font-size:18px;font-weight:600;color:#ee5a5a}'
      + '.hint{font-size:13px;color:#7c8696;max-width:520px;line-height:1.55}'
      + 'button{padding:8px 18px;border-radius:6px;border:1px solid #2a3140;background:#161b22;'
      + 'color:#c8cfd9;cursor:pointer;font-size:14px}button:hover{background:#1c222d}</style></head><body>'
      + '<div class="box"><div class="ttl">' + t + ' 预览失败</div>'
      + '<div class="hint">' + m + '</div>'
      + '<button onclick="window.close()">关闭此标签</button>'
      + '</div></body></html>'
    );
    win.document.close();
  } catch { /* 弹窗已关 —— 忽略 */ }
}

/**
 * 弹窗模式：发请求 → 命中直跳 / 未命中轮询任务 → 命中后 navigate 弹窗。
 * 任何阶段失败 → writePreviewErrorPage。
 */
async function runPreviewWithPopup(id, stdCode, popup) {
  // 每个 popup 独立 AbortController，不共享全局 _previewPollAbort（那个只服务
  // overlay 路径）。这样连续点不同标准的预览时，第一个 popup 的 poll 不会被第二个
  // 意外终结。popup.closed 检测仍然保留 —— 用户主动关 tab 就停 poll。
  const ctrl = new AbortController();
  const yearMatch = stdCode.match(/-\s*(\d{4})\s*$/);
  const year = yearMatch ? yearMatch[1] : undefined;
  const body = year ? { stdCode, year } : { stdCode };
  try {
    const res = await fetch(`${API}/api/preview/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const data = await readApiResponse(res);
    if (popup.closed) { ctrl.abort(); return; }
    if (data.status === 'ready' && data.fileId) {
      _libraryFileIds.set(id, data.fileId);
      applyLibraryDots();
      popup.location.replace(`${API}/api/preview/file/${encodeURIComponent(data.fileId)}`);
      return;
    }
    if (data.status === 'downloading' && data.taskId) {
      await pollPreviewTaskForPopup(data.taskId, stdCode, popup, id, ctrl);
      return;
    }
    writePreviewErrorPage(popup, stdCode, '后端返回未知状态：' + JSON.stringify(data));
  } catch (e) {
    if (popup.closed || ctrl.signal.aborted) return;
    writePreviewErrorPage(popup, stdCode, e?.message || String(e));
  }
}

/**
 * 弹窗版任务轮询。
 * - popup.closed → 取消轮询（用户关掉标签 = 不想要了）
 * - ready → navigate popup 到 file URL，同时回填 _libraryFileIds 缓存
 * - failed / 404 → 写错误页
 *
 * ctrl 由调用方（runPreviewWithPopup）传入，每个 popup 一个独立 AbortController，
 * 不再写全局 _previewPollAbort —— 历史 bug：用户连点 A→B 时，B 的入口 abort 全局
 * controller 把 A 的 poll 也杀了，导致 A 标签卡死。
 */
async function pollPreviewTaskForPopup(taskId, stdCode, popup, resultId, ctrl) {
  if (!ctrl) ctrl = new AbortController();
  let attempt = 0;
  while (!ctrl.signal.aborted) {
    if (popup.closed) { ctrl.abort(); return; }
    attempt++;
    // 前 5 次 300ms 快速捕获，之后 1500ms 减负载（与 pollPreviewTask 一致）
    const wait = attempt <= 5 ? 300 : 1500;
    await new Promise(r => setTimeout(r, wait));
    if (ctrl.signal.aborted || popup.closed) return;
    let data, ok = true;
    try {
      const res = await fetch(`${API}/api/preview/task/${encodeURIComponent(taskId)}`, { signal: ctrl.signal });
      ok = res.ok;
      data = await readApiResponse(res);
    } catch (e) {
      if (ctrl.signal.aborted || popup.closed) return;
      continue;
    }
    if (!ok || !data || data.status === undefined) {
      writePreviewErrorPage(popup, stdCode, data?.error || '任务已过期或不存在，请重试');
      return;
    }
    if (data.status === 'ready' && data.fileId) {
      if (resultId) { _libraryFileIds.set(resultId, data.fileId); applyLibraryDots(); }
      popup.location.replace(`${API}/api/preview/file/${encodeURIComponent(data.fileId)}`);
      return;
    }
    if (data.status === 'failed') {
      writePreviewErrorPage(popup, stdCode, data.error || '所有源都未能下载到此标准。');
      return;
    }
    // pending / downloading → 更新弹窗 hint 文案让用户感知到进度
    try {
      const hint = popup.document?.getElementById?.('hint');
      if (hint) hint.textContent = getPreviewTaskMessage(data, attempt, '正在自动下载…') + (data?.elapsedMs ? `（${formatPreviewElapsed(data.elapsedMs)}）` : '');
    } catch { /* 弹窗已 navigate 走或关闭 —— 忽略 */ }
  }
}

/**
 * 老 overlay 路径（popup blocker 拦截时 fallback）。
 * 行为与 Phase 2 之前的 previewStandard 完全一致。
 */
async function runPreviewWithOverlay(id, stdCode, r) {
  if (_previewPollAbort) {
    try { _previewPollAbort.abort(); } catch { /* ignore */ }
    _previewPollAbort = null;
  }
  openPreviewOverlay(stdCode + (r.title ? `  ${r.title}` : ''));
  renderPreviewPreparing('查询本地库…');
  try {
    const yearMatch = stdCode.match(/-\s*(\d{4})\s*$/);
    const year = yearMatch ? yearMatch[1] : undefined;
    const body = year ? { stdCode, year } : { stdCode };
    const res = await fetch(`${API}/api/preview/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await readApiResponse(res);
    if (data.status === 'ready') {
      _previewCurrent = { fileId: data.fileId, url: data.url, fileName: stdCode };
      if (data.fileId) { _libraryFileIds.set(id, data.fileId); applyLibraryDots(); }
      // Electron 桌面端：跳系统浏览器（setWindowOpenHandler 路由到 shell.openExternal）
      // 体验比 overlay iframe 好得多（全屏 / 缩放 / 打印 / 另存为都用浏览器原生）。
      // Web 浏览器侧仍然在 overlay 内用 PDFViewer 渲染。
      if (window.bzxz && window.bzxz.isElectron) {
        window.open(`${API}${data.url}`, '_blank');
        closePreviewOverlay();
        return;
      }
      _renderPdfWithViewer(data.url, stdCode);
      // 多源 picker：仅当此 stdCode 在 ≥2 个源都有文件时显示
      loadPreviewSourcePicker(stdCode, year, data.fileId);
    } else if (data.status === 'downloading' && data.taskId) {
      _previewCurrent = null;
      renderPreviewTaskProgress(data, 1, stdCode);
      await pollPreviewTask(data.taskId, stdCode);
    } else if (data.status === 'not_in_library') {
      // 旧 Phase 1 兜底分支（理论上 Phase 2 后端不再返回这个 status）
      _previewCurrent = null;
      setPreviewBody(`
        <div class="preview-empty">
          <div class="preview-empty-title">本地库尚无此标准</div>
          <div class="preview-empty-hint">先点击下方"下载"按钮把 PDF 拉到本地后，再点预览即可直接打开。</div>
          <div class="preview-empty-actions">
            <button class="btn btn-primary" id="previewDownloadFallbackBtn">立即下载</button>
            <button class="btn btn-ghost" id="previewCloseFallbackBtn">关闭</button>
          </div>
        </div>`);
      const dl = document.getElementById('previewDownloadFallbackBtn');
      if (dl) dl.addEventListener('click', () => {
        closePreviewOverlay();
        const card = document.querySelector(`.result-card[data-sid="${CSS.escape(id)}"]`);
        const btn = card ? card.querySelector('[data-action="download"]') : null;
        if (typeof downloadOne === 'function') downloadOne(id, btn);
      });
      const cls = document.getElementById('previewCloseFallbackBtn');
      if (cls) cls.addEventListener('click', closePreviewOverlay);
    } else {
      setPreviewBody(`<div class="preview-empty"><div class="preview-empty-title">预览失败</div><div class="preview-empty-hint">${escapeHtml(JSON.stringify(data))}</div></div>`);
    }
  } catch (e) {
    setPreviewBody(`<div class="preview-empty"><div class="preview-empty-title">预览失败</div><div class="preview-empty-hint">${escapeHtml(e?.message || String(e))}</div></div>`);
  }
}

function openPreviewOverlay(title) {
  const overlay = document.getElementById('previewOverlay');
  if (!overlay) return;
  document.getElementById('previewTitle').textContent = title || '预览';
  overlay.classList.add('open');
  overlay.setAttribute('aria-hidden', 'false');
}
function closePreviewOverlay() {
  const overlay = document.getElementById('previewOverlay');
  if (!overlay) return;
  overlay.classList.remove('open');
  overlay.setAttribute('aria-hidden', 'true');

  // 桌面端 PDFViewer 销毁
  if (_pdfViewer) {
    try { _pdfViewer.destroy(); } catch (e) { console.warn('[PDFViewer] destroy error:', e); }
    _pdfViewer = null;
  }

  // 手机端 pdfh5 销毁：先清空容器阻止渲染，再销毁实例
  // 大 PDF（100+页）快速滑动时直接 destroy 可能导致界面卡死
  if (_mobileViewer) {
    try {
      // 1. 先清空容器，让 pdfh5 的渲染循环检测到容器已移除
      const body = document.getElementById('previewBody');
      if (body) body.innerHTML = '';
      // 2. 延迟销毁，给 pdfh5 时间完成当前操作
      const viewer = _mobileViewer;
      _mobileViewer = null;
      setTimeout(function () {
        try { viewer.destroy(); } catch (e) { console.warn('[pdfh5] destroy error:', e); }
      }, 50);
    } catch (e) { console.warn('[pdfh5] cleanup error:', e); _mobileViewer = null; }
  }

  const picker = document.getElementById('previewSourcePicker');
  if (picker) { picker.innerHTML = ''; picker.style.display = 'none'; }
  _previewCurrent = null;
  // Phase 2：用户主动关闭 → 取消 poll，避免后台继续抢请求
  if (_previewPollAbort) {
    try { _previewPollAbort.abort(); } catch { /* ignore */ }
    _previewPollAbort = null;
  }
}
function setPreviewBody(html) {
  const body = document.getElementById('previewBody');
  if (body) body.innerHTML = html;
}

(function bindPreviewOverlayEvents() {
  const overlay = document.getElementById('previewOverlay');
  if (!overlay) return;
  schedulePreviewAssetsWarmup();
  document.getElementById('previewClose')?.addEventListener('click', closePreviewOverlay);

  // 点击遮罩空白（panel 外）关闭；点击 panel 内不要触发
  // 手机端用 touchstart/touchend 判断，避免快速滑动时 click 误触发
  var _overlayTouchStartY = 0;
  var _overlayTouchMoved = false;
  overlay.addEventListener('touchstart', function (e) {
    _overlayTouchStartY = e.touches[0].clientY;
    _overlayTouchMoved = false;
  }, { passive: true });
  overlay.addEventListener('touchmove', function (e) {
    if (Math.abs(e.touches[0].clientY - _overlayTouchStartY) > 10) {
      _overlayTouchMoved = true;
    }
  }, { passive: true });
  overlay.addEventListener('click', e => {
    // 如果有触摸且移动过（说明是滑动而非点击），不关闭
    if (_overlayTouchMoved) { _overlayTouchMoved = false; return; }
    if (e.target === overlay) closePreviewOverlay();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && overlay.classList.contains('open')) closePreviewOverlay();
  });
  document.getElementById('previewDownloadBtn')?.addEventListener('click', () => {
    if (!_previewCurrent) return;
    // 走 attachment=1 强制浏览器另存为，避免再次内联打开
    const a = document.createElement('a');
    a.href = `${_previewCurrent.url}?attachment=1`;
    a.download = '';
    document.body.appendChild(a); a.click(); a.remove();
  });
  document.getElementById('previewOpenNewBtn')?.addEventListener('click', () => {
    if (!_previewCurrent) return;
    window.open(_previewCurrent.url, '_blank', 'noopener,noreferrer');
  });

  // ── 左边缘右滑返回手势（手机端） ──
  var panel = overlay.querySelector('.preview-panel');
  if (panel) {
    var swipeStartX = 0, swipeStartY = 0, swiping = false;
    var EDGE_WIDTH = 30;       // 仅左边缘 30px 内触发（缩小范围减少误触）
    var SWIPE_THRESHOLD = 120; // 右滑超过 120px 才关闭（提高阈值防止快速滚动误触）
    var VERTICAL_LOCK_THRESHOLD = 30; // 垂直移动超过此值锁定为滚动，取消滑动关闭

    panel.addEventListener('touchstart', function (e) {
      if (e.touches.length !== 1) return;
      var t = e.touches[0];
      // 不在左边缘 → 不触发滑动关闭
      if (t.clientX > EDGE_WIDTH) return;
      swipeStartX = t.clientX;
      swipeStartY = t.clientY;
      swiping = true;
    }, { passive: true });

    panel.addEventListener('touchmove', function (e) {
      if (!swiping) return;
      var dx = e.touches[0].clientX - swipeStartX;
      var dy = e.touches[0].clientY - swipeStartY;
      var absDy = Math.abs(dy);
      // 如果垂直移动幅度大，说明用户在滚动，取消滑动手势
      if (absDy > VERTICAL_LOCK_THRESHOLD) {
        swiping = false;
        return;
      }
      // 水平为主（右滑）且幅度够才跟随，垂直滑动不拦截
      // 提高比例阈值：水平移动必须大于垂直移动的 1.5 倍才触发
      if (dx > 0 && dx > absDy * 1.5) {
        var progress = Math.min(dx / SWIPE_THRESHOLD, 1);
        panel.style.transform = 'translateX(' + (dx * 0.6) + 'px)';
        panel.style.opacity = 1 - progress * 0.3;
        panel.style.transition = 'none';
      }
    }, { passive: true });

    panel.addEventListener('touchend', function (e) {
      if (!swiping) return;
      swiping = false;
      var dx = (e.changedTouches[0] || {}).clientX - swipeStartX;
      if (dx > SWIPE_THRESHOLD) {
        // 完成滑动 → 关闭
        panel.style.transition = 'transform 0.2s ease, opacity 0.2s ease';
        panel.style.transform = 'translateX(100%)';
        panel.style.opacity = '0';
        setTimeout(function () {
          panel.style.transform = '';
          panel.style.opacity = '';
          panel.style.transition = '';
          closePreviewOverlay();
        }, 200);
      } else {
        // 回弹
        panel.style.transition = 'transform 0.2s ease, opacity 0.2s ease';
        panel.style.transform = '';
        panel.style.opacity = '';
        setTimeout(function () { panel.style.transition = ''; }, 200);
      }
    }, { passive: true });
  }
})();

// ── 多源 preview picker ──
// 后端 /api/preview/files 列出该 (stdCode, year) 在 gbw/bz/by/labr 4 源里能找到的所有文件，
// 按 (year DESC, priority 排序) 给前端。≥2 个候选时显示 picker 让用户切源。
//
// 行为：
// - 高亮当前正在预览的 fileId
// - 点击其它源 → 直接换 iframe src 到 /api/preview/file/:fileId（不重新拉 /preview/request）
// - 只有 1 个候选 → 不显示（picker container 保持 display:none）
async function loadPreviewSourcePicker(stdCode, year, activeFileId) {
  const picker = document.getElementById('previewSourcePicker');
  if (!picker) return;
  picker.innerHTML = '';
  picker.style.display = 'none';
  try {
    const params = new URLSearchParams({ stdCode });
    if (year) params.set('year', String(year));
    const res = await fetch(`${API}/api/preview/files?${params.toString()}`);
    const data = await readApiResponse(res);
    if (!res.ok) return; // 静默失败，picker 不显示
    const items = (data && (data.items || data.files)) || [];
    if (items.length < 2) return; // 只有 1 个源不显示 picker
    const sourceLabel = { gbw: 'GBW', bz: 'BZ', by: 'BY', labr: 'Labr' };
    const html = items.map(it => {
      const active = it.fileId === activeFileId ? 'active' : '';
      const label = sourceLabel[it.source] || it.source;
      const extBadge = it.ext && it.ext !== 'pdf'
        ? `<span class="preview-source-ext">${escapeHtml(it.ext.toUpperCase())}</span>`
        : '';
      const yr = it.year ? `<span class="preview-source-year">${escapeHtml(it.year)}</span>` : '';
      return `<button class="preview-source-btn ${active}" data-fid="${escapeHtml(it.fileId)}" data-source="${escapeHtml(it.source)}" title="${escapeHtml(label + (it.year ? ' / ' + it.year : '') + (it.ext ? ' / ' + it.ext : ''))}">
        <span class="preview-source-name">${escapeHtml(label)}</span>${yr}${extBadge}
      </button>`;
    }).join('');
    picker.innerHTML = `<span class="preview-source-label">源：</span>${html}`;
    picker.style.display = '';
    picker.querySelectorAll('.preview-source-btn').forEach(btn => {
      btn.addEventListener('click', () => switchPreviewSource(btn.dataset.fid, stdCode));
    });
  } catch { /* 静默 */ }
}

function switchPreviewSource(fileId, stdCode) {
  if (!fileId) return;
  var url = '/api/preview/file/' + encodeURIComponent(fileId);
  _previewCurrent = { fileId: fileId, url: url, fileName: stdCode };
  // 如果已有 PDFViewer 实例，直接 load 新 URL（保留缩放/位置状态之外的体验）
  if (_pdfViewer && !_pdfViewer.destroyed) {
    _pdfViewer.load(API + url);
  } else {
    _renderPdfWithViewer(url, stdCode);
  }
  // 高亮换到点中的按钮
  var picker = document.getElementById('previewSourcePicker');
  if (picker) {
    picker.querySelectorAll('.preview-source-btn').forEach(function (b) {
      b.classList.toggle('active', b.dataset.fid === String(fileId));
    });
  }
}

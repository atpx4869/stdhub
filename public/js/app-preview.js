// Unified paginated-image preview. The application never parses or renders PDF bytes.
// Original PDFs are only exposed through explicit browser-native view/download links.

let _previewCurrent = null;
let _previewReader = null;
let _previewPollAbort = null;
let _previewLastId = null;
let _previewReturnFocus = null;

const PREVIEW_SOURCE_LABELS = { gbw: '国家标准全文公开系统', bz: '标准网', by: '标准院', labr: 'Labr 补给页' };
const PREVIEW_PHASE_LABELS = {
  checking_library: '查本地库', searching_source: '搜索来源', downloading: '下载 PDF',
  moving_to_library: '保存入库', ready: '准备图片预览', failed: '处理失败',
};

function previewApi(path) { return `${typeof API === 'string' ? API : ''}${path}`; }
function schedulePreviewAssetsWarmup() { /* WebP previews need no PDF engine warm-up. */ }
function setPreviewBody(html) { const body = document.getElementById('previewBody'); if (body) body.innerHTML = html; }

function setPreviewReaderChrome(visible) {
  for (const id of ['previewPageControl', 'previewReaderControls']) {
    const element = document.getElementById(id); if (element) element.hidden = !visible;
  }
}

function setPreviewSubtitle(text) {
  const subtitle = document.getElementById('previewSubtitle');
  if (subtitle) subtitle.textContent = text || '分页图片阅读';
}

function togglePreviewActionMenu(forceOpen) {
  const menu = document.getElementById('previewActionMenu');
  const scrim = document.getElementById('previewActionScrim');
  const button = document.getElementById('previewMoreButton');
  if (!menu || !button) return;
  const open = typeof forceOpen === 'boolean' ? forceOpen : menu.hidden;
  menu.hidden = !open; if (scrim) scrim.hidden = !open;
  button.setAttribute('aria-expanded', String(open));
  if (open) requestAnimationFrame(() => menu.querySelector('button, a[href]')?.focus());
}

function closePreviewActionMenu() { togglePreviewActionMenu(false); }

function renderPreviewPreparing(message) {
  setPreviewBody(`<div class="preview-loading preview-prepare-card"><div class="preview-task-spinner" aria-hidden="true"></div><div class="preview-task-main"><div class="preview-task-kicker">准备预览</div><div class="preview-task-message">${escapeHtml(message || '正在准备分页图片…')}</div><div class="preview-task-hint">已生成的页面会立即显示，其余页面在后台继续处理。</div></div></div>`);
}

function openPreviewOverlay(title, subtitle) {
  const overlay = document.getElementById('previewOverlay');
  if (!overlay) return;
  if (!overlay.classList.contains('open')) _previewReturnFocus = document.activeElement;
  const titleEl = document.getElementById('previewTitle');
  if (titleEl) titleEl.textContent = title || '预览';
  setPreviewSubtitle(subtitle);
  setPreviewReaderChrome(false);
  closePreviewActionMenu();
  overlay.classList.add('open');
  overlay.setAttribute('aria-hidden', 'false');
  requestAnimationFrame(() => document.getElementById('previewClose')?.focus());
}

function updateOriginalLinks() {
  const setLink = (el, href) => {
    if (!el) return;
    if (href) { el.href = previewApi(href); el.removeAttribute('aria-disabled'); }
    else { el.removeAttribute('href'); el.setAttribute('aria-disabled', 'true'); }
  };
  setLink(document.getElementById('previewOpenNewBtn'), _previewCurrent?.viewUrl);
  setLink(document.getElementById('previewDownloadBtn'), _previewCurrent?.downloadUrl);
}

function closePreviewOverlay() {
  const overlay = document.getElementById('previewOverlay');
  if (!overlay) return;
  overlay.classList.remove('open');
  overlay.setAttribute('aria-hidden', 'true');
  if (_previewReader) { _previewReader.destroy(); _previewReader = null; }
  if (_previewPollAbort) { _previewPollAbort.abort(); _previewPollAbort = null; }
  const picker = document.getElementById('previewSourcePicker');
  if (picker) { picker.innerHTML = ''; picker.hidden = true; }
  const actionSources = document.getElementById('previewActionSources');
  const actionSourceButtons = document.getElementById('previewActionSourceButtons');
  if (actionSources) actionSources.hidden = true; if (actionSourceButtons) actionSourceButtons.innerHTML = '';
  closePreviewActionMenu(); setPreviewReaderChrome(false);
  _previewCurrent = null;
  updateOriginalLinks();
  setPreviewBody('');
  if (_previewReturnFocus?.isConnected) _previewReturnFocus.focus();
  _previewReturnFocus = null;
}

function openPreviewInNativeBrowser(url) {
  const target = url || _previewCurrent?.viewUrl;
  if (!target) { showToast('原始 PDF 还没准备好，稍后再试', 'warn'); return; }
  const link = document.createElement('a');
  link.href = previewApi(target); link.target = '_blank'; link.rel = 'noopener noreferrer';
  document.body.appendChild(link); link.click(); link.remove();
}

function formatPreviewElapsed(ms) {
  const seconds = Math.round(Number(ms || 0) / 1000);
  return seconds > 0 ? `已用 ${seconds} 秒` : '刚刚开始';
}

function renderPreviewTaskProgress(data, attempt, stdCode) {
  const phase = data?.phase || 'checking_library';
  const source = data?.sourceLabel || PREVIEW_SOURCE_LABELS[data?.source] || '';
  const meta = [source, formatPreviewElapsed(data?.elapsedMs), data?.attempt ? `第 ${data.attempt} 个来源` : ''].filter(Boolean).map(escapeHtml).join(' · ');
  setPreviewBody(`<div class="preview-loading preview-task-card"><div class="preview-task-spinner" aria-hidden="true"></div><div class="preview-task-main"><div class="preview-task-kicker">${escapeHtml(PREVIEW_PHASE_LABELS[phase] || '自动入库')}</div><div class="preview-task-title">${escapeHtml(stdCode || '标准预览')}</div><div class="preview-task-message">${escapeHtml(data?.message || `正在自动下载…（${attempt || 1}）`)}</div>${meta ? `<div class="preview-task-meta">${meta}</div>` : ''}<div class="preview-task-hint">原始 PDF 入库后会自动生成分页图片。</div></div></div>`);
}

function startTaskPoll(taskId, handlers) {
  const ctrl = handlers.ctrl || new AbortController();
  let attempt = 0;
  (async () => {
    while (!ctrl.signal.aborted) {
      attempt++;
      await new Promise(resolve => setTimeout(resolve, attempt <= 5 ? 300 : 1500));
      if (ctrl.signal.aborted) return;
      try {
        const response = await fetch(previewApi(`/api/preview/task/${encodeURIComponent(taskId)}`), { signal: ctrl.signal });
        const data = await readApiResponse(response);
        if (!response.ok || !data?.status) return handlers.onFailed(data?.message || '任务不存在或已过期');
        if (data.status === 'ready') return handlers.onReady(data, attempt);
        if (data.status === 'failed') return handlers.onFailed(data.error || '所有来源均失败');
        handlers.onProgress(data, attempt);
      } catch {
        if (!ctrl.signal.aborted) handlers.onProgress({ message: '连接短暂中断，正在重试…' }, attempt);
      }
    }
  })();
  return ctrl;
}

class PaginatedImageReader {
  constructor(container, fileId, title) {
    this.container = container; this.fileId = Number(fileId); this.title = title || '标准预览';
    this.manifest = null; this.scale = 1; this.currentPage = 1; this.pageEls = new Map(); this.loaded = new Set();
    this.mobileMode = typeof window.isMobile === 'function'
      ? window.isMobile()
      : window.matchMedia?.('(max-width: 700px)').matches === true && !document.body?.classList.contains('force-desktop');
    this.prefetched = new Set(); this.prefetchFailed = new Set(); this.prefetchQueued = new Set(); this.prefetchQueue = []; this.prefetchActive = 0;
    this.prefetchAttempts = new Map(); this.prefetchTimer = null; this.pinch = null;
    this.destroyed = false; this.pollTimer = null; this.fetchController = new AbortController();
    this.onScroll = this.onScroll.bind(this); this.onIntersect = this.onIntersect.bind(this); this.onClick = this.onClick.bind(this);
    this.onTouchStart = this.onTouchStart.bind(this); this.onTouchMove = this.onTouchMove.bind(this); this.onTouchEnd = this.onTouchEnd.bind(this);
  }

  async start() { this.renderShell(); await this.refreshManifest(); }

  renderShell() {
    this.container.innerHTML = `<div class="image-reader"><div class="image-reader-progress" data-role="progress">正在读取预览状态…</div><div class="image-reader-pages" data-role="pages"></div></div>`;
    this.pagesEl = this.container.querySelector('[data-role="pages"]');
    this.progressEl = this.container.querySelector('[data-role="progress"]');
    this.pageInput = document.getElementById('previewPageInput');
    this.pageTotal = document.getElementById('previewPageTotal');
    setPreviewReaderChrome(true);
    this.container.addEventListener('scroll', this.onScroll, { passive: true });
    this.container.addEventListener('click', this.onClick);
    this.container.addEventListener('touchstart', this.onTouchStart, { passive: false });
    this.container.addEventListener('touchmove', this.onTouchMove, { passive: false });
    this.container.addEventListener('touchend', this.onTouchEnd, { passive: true });
    this.container.addEventListener('touchcancel', this.onTouchEnd, { passive: true });
    this.observer = new IntersectionObserver(this.onIntersect, { root: this.container, rootMargin: '150% 0px', threshold: 0.01 });
  }

  onClick(event) {
      const target = event.target.closest?.('[data-action]'); const action = target?.dataset.action;
      this.handleAction(action, target);
  }

  handleAction(action, target) {
      if (!action) return;
      if (action === 'fit' || action === 'reset') this.setScale(1);
      if (action === 'zoom-in') this.setScale(this.scale + 0.15);
      if (action === 'zoom-out') this.setScale(this.scale - 0.15);
      if (action === 'fullscreen') this.toggleFullscreen();
      if (action === 'retry-page') this.loadPage(Number(target.dataset.page), true);
      if (action === 'retry-generate') this.retryGeneration();
  }

  jumpToPage(value) {
    const total = Number(this.manifest?.pageCount || 0); if (!total) return;
    const page = Math.max(1, Math.min(total, Math.round(Number(value) || 1)));
    if (this.pageInput) this.pageInput.value = String(page);
    const behavior = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
    this.pageEls.get(page)?.scrollIntoView({ behavior, block: 'start' });
  }

  async refreshManifest() {
    if (this.destroyed) return;
    try {
      const response = await fetch(previewApi(`/api/files/${this.fileId}/preview/manifest`), { signal: this.fetchController.signal });
      const manifest = await readApiResponse(response);
      if (!response.ok) throw new Error(manifest?.message || '无法读取预览状态');
      this.applyManifest(manifest);
      if (manifest.status === 'pending' || manifest.status === 'processing') this.pollTimer = setTimeout(() => this.refreshManifest(), 1200);
    } catch (error) {
      if (!this.destroyed && error?.name !== 'AbortError') this.showFatal(error?.message || String(error));
    }
  }

  applyManifest(manifest) {
    this.manifest = manifest;
    _previewCurrent = { fileId: this.fileId, fileName: this.title, viewUrl: manifest.viewUrl, downloadUrl: manifest.downloadUrl };
    updateOriginalLinks();
    if (this.pageTotal) this.pageTotal.textContent = manifest.pageCount || '—';
    if (this.pageInput) { this.pageInput.max = String(manifest.pageCount || 1); this.pageInput.value = String(Math.min(this.currentPage, manifest.pageCount || 1)); }
    this.ensurePageElements(manifest.pageCount); this.updatePageDimensions(manifest.pages || []);
    for (let page = 1; page <= manifest.completedPages; page++) { const el = this.pageEls.get(page); if (el?.dataset.near === '1') this.loadPage(page); }
    this.enqueueMobilePrefetch(manifest.completedPages);
    if (manifest.status === 'ready') { this.progressEl.hidden = true; this.updatePrefetchStatus(); }
    else if (manifest.status === 'failed') {
      setPreviewSubtitle('预览生成失败');
      this.progressEl.hidden = false; this.progressEl.className = 'image-reader-progress is-error';
      this.progressEl.innerHTML = `<span>${escapeHtml(manifest.error?.message || '预览生成失败')}</span><button type="button" data-action="retry-generate">重试生成</button>`;
    } else {
      setPreviewSubtitle(manifest.pageCount ? `已生成 ${manifest.completedPages} / ${manifest.pageCount} 页` : '正在分析 PDF');
      this.progressEl.hidden = false; this.progressEl.className = 'image-reader-progress';
      this.progressEl.textContent = `分页图片生成中  ${manifest.pageCount ? `${manifest.completedPages} / ${manifest.pageCount} 页` : '正在分析 PDF'}`;
    }
  }

  ensurePageElements(count) {
    if (!count || this.pageEls.size === count) return;
    this.observer.disconnect(); this.pageEls.clear(); this.loaded.clear(); this.pagesEl.innerHTML = '';
    for (let page = 1; page <= count; page++) {
      const el = document.createElement('article'); el.className = 'image-reader-page-shell'; el.dataset.page = String(page);
      el.style.aspectRatio = '1 / 1.4142'; el.innerHTML = `<div class="image-reader-skeleton"><span>第 ${page} 页</span></div>`;
      this.pagesEl.appendChild(el); this.pageEls.set(page, el); this.observer.observe(el);
    }
  }

  updatePageDimensions(pages) {
    for (const page of pages) { const el = this.pageEls.get(page.page); if (el && page.width > 0 && page.height > 0) el.style.aspectRatio = `${page.width} / ${page.height}`; }
  }

  onIntersect(entries) {
    for (const entry of entries) {
      const page = Number(entry.target.dataset.page); entry.target.dataset.near = entry.isIntersecting ? '1' : '0';
      if (!entry.isIntersecting) continue;
      for (let candidate = Math.max(1, page - 2); candidate <= Math.min(this.manifest?.pageCount || 0, page + 2); candidate++) this.loadPage(candidate);
    }
  }

  loadPage(page, force) {
    if (!Number.isInteger(page) || page < 1 || this.destroyed || (!force && this.loaded.has(page))) return;
    if (!this.manifest || page > this.manifest.completedPages) return;
    const shell = this.pageEls.get(page); if (!shell) return;
    this.loaded.add(page); shell.classList.add('is-loading'); shell.innerHTML = '';
    const image = document.createElement('img'); image.alt = `第 ${page} 页`; image.decoding = 'async'; image.loading = 'lazy';
    image.src = this.pageUrl(page);
    image.addEventListener('load', () => { image.classList.add('is-ready'); shell.classList.remove('is-loading'); this.markPageCached(page); }, { once: true });
    image.addEventListener('error', () => { this.loaded.delete(page); shell.classList.remove('is-loading'); shell.innerHTML = `<div class="image-reader-page-error"><span>第 ${page} 页加载失败</span><button type="button" data-action="retry-page" data-page="${page}">重试</button></div>`; }, { once: true });
    shell.appendChild(image);
  }

  pageUrl(page) {
    return previewApi(`/api/files/${this.fileId}/preview/pages/${page}?v=${this.manifest?.sourceHash?.slice(0, 16) || 'pending'}`);
  }

  enqueueMobilePrefetch(completedPages) {
    if (!this.mobileMode || this.destroyed) return;
    for (let page = 1; page <= Number(completedPages || 0); page++) {
      if (this.prefetched.has(page) || this.prefetchQueued.has(page)) continue;
      this.prefetchQueued.add(page); this.prefetchQueue.push(page);
    }
    clearTimeout(this.prefetchTimer);
    this.prefetchTimer = setTimeout(() => this.pumpMobilePrefetch(), 200);
  }

  pumpMobilePrefetch() {
    if (!this.mobileMode || this.destroyed) return;
    while (this.prefetchActive < 4 && this.prefetchQueue.length > 0) {
      const page = this.prefetchQueue.shift();
      if (this.prefetched.has(page)) { this.prefetchQueued.delete(page); continue; }
      this.prefetchActive++;
      fetch(this.pageUrl(page), { cache: 'force-cache', signal: this.fetchController.signal })
        .then(response => { if (!response.ok) throw new Error(`preview page ${page}: ${response.status}`); return response.arrayBuffer(); })
        .then(() => this.markPageCached(page))
        .catch(error => {
          if (this.destroyed || error?.name === 'AbortError') return;
          const attempts = (this.prefetchAttempts.get(page) || 0) + 1; this.prefetchAttempts.set(page, attempts);
          if (attempts < 3) { this.prefetchQueued.add(page); this.prefetchQueue.push(page); }
          else this.prefetchFailed.add(page);
        })
        .finally(() => {
          this.prefetchActive = Math.max(0, this.prefetchActive - 1);
          if (!this.prefetchQueue.includes(page)) this.prefetchQueued.delete(page);
          if (!this.destroyed) { this.updatePrefetchStatus(); this.pumpMobilePrefetch(); }
        });
    }
  }

  markPageCached(page) {
    this.prefetched.add(page); this.prefetchFailed.delete(page); this.prefetchQueued.delete(page); this.prefetchAttempts.delete(page);
    this.updatePrefetchStatus();
  }

  updatePrefetchStatus() {
    if (this.manifest?.status !== 'ready') return;
    if (!this.mobileMode) { setPreviewSubtitle('分页图片阅读'); return; }
    const total = Number(this.manifest.pageCount || 0);
    const cached = Math.min(total, this.prefetched.size);
    if (total > 0 && cached >= total) setPreviewSubtitle(`整本已缓存 · ${total} 页`);
    else if (this.prefetchFailed.size > 0 && this.prefetchActive === 0 && this.prefetchQueue.length === 0) setPreviewSubtitle(`整本缓存 · ${cached} / ${total} 页，${this.prefetchFailed.size} 页失败`);
    else setPreviewSubtitle(`正在缓存整本 · ${cached} / ${total} 页`);
  }

  onScroll() {
    if (this.destroyed) return;
    cancelAnimationFrame(this.scrollFrame);
    this.scrollFrame = requestAnimationFrame(() => {
      const center = this.container.getBoundingClientRect().top + this.container.clientHeight / 2;
      let bestPage = this.currentPage, bestDistance = Infinity;
      for (const [page, el] of this.pageEls) {
        if (el.dataset.near !== '1') continue;
        const rect = el.getBoundingClientRect(); const distance = Math.abs((rect.top + rect.bottom) / 2 - center);
        if (distance < bestDistance) { bestDistance = distance; bestPage = page; }
      }
      this.currentPage = bestPage; if (this.pageInput && document.activeElement !== this.pageInput) this.pageInput.value = String(bestPage);
      for (const page of [...this.loaded]) {
        if (Math.abs(page - bestPage) <= 6) continue;
        const el = this.pageEls.get(page); if (!el) continue;
        if (el.querySelector('img')) { el.innerHTML = `<div class="image-reader-skeleton"><span>第 ${page} 页</span></div>`; this.loaded.delete(page); }
      }
    });
  }

  touchDistance(touches) {
    const dx = touches[0].clientX - touches[1].clientX; const dy = touches[0].clientY - touches[1].clientY;
    return Math.hypot(dx, dy);
  }

  touchCenter(touches) {
    return { x: (touches[0].clientX + touches[1].clientX) / 2, y: (touches[0].clientY + touches[1].clientY) / 2 };
  }

  onTouchStart(event) {
    if (!this.mobileMode || event.touches.length !== 2) return;
    event.preventDefault();
    this.pinch = { distance: this.touchDistance(event.touches), scale: this.scale };
  }

  onTouchMove(event) {
    if (!this.pinch || event.touches.length !== 2) return;
    event.preventDefault();
    const ratio = this.touchDistance(event.touches) / Math.max(1, this.pinch.distance);
    this.setScale(this.pinch.scale * ratio, this.touchCenter(event.touches));
  }

  onTouchEnd(event) { if (event.touches.length < 2) this.pinch = null; }

  setScale(value, anchor) {
    const previousScale = this.scale;
    const rect = this.container.getBoundingClientRect();
    const localX = anchor ? anchor.x - rect.left : this.container.clientWidth / 2;
    const localY = anchor ? anchor.y - rect.top : this.container.clientHeight / 2;
    const previousLeft = this.container.scrollLeft; const previousTop = this.container.scrollTop;
    this.scale = Math.max(0.5, Math.min(3, Number(value) || 1));
    const baseWidth = window.matchMedia?.('(max-width: 700px)').matches ? 100 : 86;
    this.pagesEl.style.setProperty('--preview-page-width', `${baseWidth * this.scale}%`);
    this.pagesEl.classList.toggle('is-zoomed', this.scale > 1);
    if (previousScale !== this.scale) {
      const ratio = this.scale / previousScale;
      this.container.scrollLeft = Math.max(0, (previousLeft + localX) * ratio - localX);
      this.container.scrollTop = Math.max(0, (previousTop + localY) * ratio - localY);
    }
    document.querySelectorAll('#previewOverlay .preview-scale').forEach(el => { el.textContent = `${Math.round(this.scale * 100)}%`; });
  }

  async toggleFullscreen() {
    try { if (!document.fullscreenElement) await this.container.closest('.preview-panel')?.requestFullscreen?.(); else await document.exitFullscreen?.(); } catch { }
  }

  async retryGeneration() {
    this.progressEl.className = 'image-reader-progress'; this.progressEl.textContent = '正在重新创建预览任务…';
    try {
      const response = await fetch(previewApi(`/api/files/${this.fileId}/preview/retry`), { method: 'POST', signal: this.fetchController.signal });
      const data = await readApiResponse(response); if (!response.ok) throw new Error(data?.message || '重试失败');
      this.applyManifest(data); clearTimeout(this.pollTimer); this.pollTimer = setTimeout(() => this.refreshManifest(), 600);
    } catch (error) { this.showFatal(error?.message || String(error)); }
  }

  showFatal(message) { this.progressEl.hidden = false; this.progressEl.className = 'image-reader-progress is-error'; this.progressEl.textContent = message; }
  destroy() {
    this.destroyed = true; clearTimeout(this.pollTimer); clearTimeout(this.prefetchTimer); cancelAnimationFrame(this.scrollFrame); this.fetchController.abort(); this.observer?.disconnect();
    this.container.removeEventListener('scroll', this.onScroll); this.container.removeEventListener('click', this.onClick);
    this.container.removeEventListener('touchstart', this.onTouchStart); this.container.removeEventListener('touchmove', this.onTouchMove);
    this.container.removeEventListener('touchend', this.onTouchEnd); this.container.removeEventListener('touchcancel', this.onTouchEnd);
    this.pageEls.clear(); this.loaded.clear(); this.prefetched.clear(); this.prefetchFailed.clear(); this.prefetchQueue.length = 0; this.prefetchQueued.clear();
  }
}

function renderPreviewWithCurrentFile(_url, title, options = {}) {
  const fileId = Number(options.fileId ?? _previewCurrent?.fileId);
  if (!Number.isInteger(fileId) || fileId <= 0) { renderPreviewFailedUi('缺少本地文件标识，无法加载分页图片', { retry: false }); return; }
  if (_previewReader) _previewReader.destroy();
  const body = document.getElementById('previewBody'); if (!body) return;
  _previewCurrent = { fileId, fileName: title || '预览', viewUrl: `/api/files/${fileId}/pdf/view`, downloadUrl: `/api/files/${fileId}/pdf/download` };
  updateOriginalLinks(); _previewReader = new PaginatedImageReader(body, fileId, title);
  _previewReader.start().catch(error => renderPreviewFailedUi(error?.message || String(error), { retry: false }));
}

function renderPreviewFailedUi(errorMsg, options = {}) {
  const original = _previewCurrent?.viewUrl;
  setPreviewBody(`<div class="preview-empty"><div class="preview-empty-title">${escapeHtml(options.title || '预览失败')}</div><div class="preview-empty-hint">${escapeHtml(errorMsg || '未能准备此标准。')}</div><div class="preview-empty-actions">${original ? `<a class="btn btn-primary" href="${escapeHtml(previewApi(original))}" target="_blank" rel="noopener noreferrer">查看原始 PDF</a>` : ''}${options.retry === false ? '' : '<button class="btn btn-ghost" id="previewRetryBtn">重试</button>'}<button class="btn btn-ghost" id="previewCloseFailedBtn">关闭</button></div></div>`);
  document.getElementById('previewRetryBtn')?.addEventListener('click', () => { if (_previewLastId != null) previewStandard(_previewLastId); });
  document.getElementById('previewCloseFailedBtn')?.addEventListener('click', closePreviewOverlay);
}

async function openResolvedFile(fileId, stdCode, resultId, year) {
  _previewCurrent = { fileId, fileName: stdCode, viewUrl: `/api/files/${fileId}/pdf/view`, downloadUrl: `/api/files/${fileId}/pdf/download` };
  if (fileId && resultId != null && typeof _libraryFileIds !== 'undefined') { _libraryFileIds.set(resultId, fileId); if (typeof applyLibraryDots === 'function') applyLibraryDots(); }
  renderPreviewWithCurrentFile('', stdCode, { fileId }); loadPreviewSourcePicker(stdCode, year, fileId);
}

async function runPreviewWithOverlay(id, stdCode, result) {
  if (_previewPollAbort) _previewPollAbort.abort();
  openPreviewOverlay(stdCode, result?.title || '分页图片阅读'); renderPreviewPreparing('正在查询本地标准库…');
  try {
    const year = stdCode.match(/-\s*(\d{4})\s*$/)?.[1];
    const response = await fetch(previewApi('/api/preview/request'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(year ? { stdCode, year } : { stdCode }) });
    const data = await readApiResponse(response); if (!response.ok) throw new Error(data?.message || '预览请求失败');
    if (data.status === 'ready') return openResolvedFile(data.fileId, stdCode, id, year);
    if (data.status === 'downloading' && data.taskId) {
      renderPreviewTaskProgress(data, 1, stdCode); const ctrl = new AbortController(); _previewPollAbort = ctrl;
      startTaskPoll(data.taskId, { ctrl, onProgress: (next, attempt) => renderPreviewTaskProgress(next, attempt, stdCode), onReady: next => openResolvedFile(next.fileId, stdCode, id, year), onFailed: message => renderPreviewFailedUi(message) });
      return;
    }
    throw new Error(data?.error || '本地库没有可预览文件');
  } catch (error) { renderPreviewFailedUi(error?.message || String(error)); }
}

async function previewStandard(id) {
  const result = typeof findResultByAnyId === 'function' ? findResultByAnyId(id) : results.find(item => item.id === id);
  if (!result) { showToast('未找到该标准', 'fail'); return; }
  const stdCode = result.standardNumber || ''; if (!stdCode) { showToast('该结果缺少标准号，无法预览', 'fail'); return; }
  _previewLastId = id; await runPreviewWithOverlay(id, stdCode, result);
}

function openLocalPreview(fileId) { openPreviewOverlay('本地标准', '分页图片阅读'); renderPreviewPreparing('正在打开本地标准…'); renderPreviewWithCurrentFile('', '本地标准', { fileId }); }

function fetchPreviewPickerData(stdCode, year) {
  const params = new URLSearchParams({ stdCode }); if (year) params.set('year', String(year));
  return fetch(previewApi(`/api/preview/files?${params}`)).then(response => response.ok ? readApiResponse(response) : null).catch(() => null);
}

function renderPreviewSourcePicker(data, stdCode, activeFileId) {
  const picker = document.getElementById('previewSourcePicker'); if (!picker) return;
  const actionSources = document.getElementById('previewActionSources'); const actionButtons = document.getElementById('previewActionSourceButtons');
  const items = data?.items || data?.files || []; picker.innerHTML = ''; picker.hidden = items.length < 2;
  if (actionSources) actionSources.hidden = items.length < 2; if (actionButtons) actionButtons.innerHTML = '';
  if (items.length < 2) return;
  const labels = { gbw: 'GBW', bz: 'BZ', by: 'BY', labr: 'Labr' }; const prefix = document.createElement('span'); prefix.className = 'preview-source-label'; prefix.textContent = '源：'; picker.appendChild(prefix);
  for (const item of items) {
    const makeButton = () => { const button = document.createElement('button'); button.type = 'button'; button.className = `preview-source-btn${String(item.fileId) === String(activeFileId) ? ' active' : ''}`; button.textContent = `${labels[item.source] || item.source}${item.year ? ` · ${item.year}` : ''}`; button.setAttribute('aria-pressed', String(String(item.fileId) === String(activeFileId))); button.addEventListener('click', () => { switchPreviewSource(item.fileId, stdCode); closePreviewActionMenu(); }); return button; };
    picker.appendChild(makeButton()); if (actionButtons) actionButtons.appendChild(makeButton());
  }
}

async function loadPreviewSourcePicker(stdCode, year, activeFileId) { renderPreviewSourcePicker(await fetchPreviewPickerData(stdCode, year), stdCode, activeFileId); }
function switchPreviewSource(fileId, stdCode) { renderPreviewWithCurrentFile('', stdCode, { fileId }); loadPreviewSourcePicker(stdCode, undefined, fileId); }

(function bindPreviewOverlayEvents() {
  const overlay = document.getElementById('previewOverlay'); if (!overlay) return;
  document.getElementById('previewClose')?.addEventListener('click', closePreviewOverlay);
  document.getElementById('previewMoreButton')?.addEventListener('click', () => togglePreviewActionMenu());
  document.getElementById('previewActionScrim')?.addEventListener('click', closePreviewActionMenu);
  document.querySelector('[data-preview-menu-close]')?.addEventListener('click', closePreviewActionMenu);
  overlay.addEventListener('click', event => {
    const actionTarget = event.target.closest?.('[data-preview-action]');
    if (actionTarget) { _previewReader?.handleAction(actionTarget.dataset.previewAction, actionTarget); closePreviewActionMenu(); return; }
    if (event.target === overlay) closePreviewOverlay();
    else if (!event.target.closest?.('#previewActionMenu, #previewMoreButton')) closePreviewActionMenu();
  });
  const pageInput = document.getElementById('previewPageInput');
  pageInput?.addEventListener('change', () => _previewReader?.jumpToPage(pageInput.value));
  pageInput?.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); _previewReader?.jumpToPage(pageInput.value); pageInput.select(); } });
  document.addEventListener('keydown', event => {
    if (!overlay.classList.contains('open')) return;
    if (event.key === 'Escape') {
      if (!document.getElementById('previewActionMenu')?.hidden) closePreviewActionMenu(); else closePreviewOverlay();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [...overlay.querySelectorAll('button:not([disabled]), a[href], input:not([disabled])')].filter(el => !el.hidden && el.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
})();

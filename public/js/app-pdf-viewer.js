// ── PDFViewer: mobile-friendly PDF viewer class ──
// IIFE wrapper, exposes window.PDFViewer
(function () {
  'use strict';

  // ── PDF.js dynamic loader ──
  let pdfjsReady = false;
  let pdfjsLoading = false;
  const pdfjsCallbacks = [];

  function ensurePdfjs() {
    return new Promise((resolve, reject) => {
      if (pdfjsReady && window.pdfjsLib) { resolve(window.pdfjsLib); return; }
      if (pdfjsLoading) { pdfjsCallbacks.push({ resolve, reject }); return; }
      pdfjsLoading = true;

      const script = document.createElement('script');
      script.src = '/vendor/pdf.min.mjs';
      script.type = 'module';
      script.onload = () => {
        pdfjsReady = true;
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.mjs';
        pdfjsCallbacks.forEach(cb => cb.resolve(window.pdfjsLib));
        pdfjsCallbacks.length = 0;
        resolve(window.pdfjsLib);
      };
      script.onerror = (e) => {
        pdfjsLoading = false;
        pdfjsCallbacks.forEach(cb => cb.reject(e));
        pdfjsCallbacks.length = 0;
        reject(new Error('Failed to load PDF.js'));
      };
      document.head.appendChild(script);
    });
  }

  // ── Constants ──
  const BUFFER_PAGES = 1;
  const MIN_SCALE = 0.3;
  const MAX_SCALE = 5;
  const DOUBLE_TAP_DELAY = 300;
  const PAGE_GAP = 12;

  // ── PDFViewer class ──
  class PDFViewer {
    constructor(container, options = {}) {
      this.container = container;
      this.options = {
        url: options.url || '',
        title: options.title || 'PDF',
        onDownload: options.onDownload || null,
        onClose: options.onClose || null,
      };

      // State
      this.pdfDoc = null;
      this.currentPage = 1;
      this.totalPages = 0;
      this.scale = 1;
      this.fitMode = 'page'; // 'width' | 'page' | '100'
      this.destroyed = false;

      // Rendering
      this.renderedPages = new Map(); // pageNum -> { canvas, ctx, height }
      this.pendingRenders = new Map();
      this.scrollContainer = null;
      this.pageElements = new Map(); // pageNum -> placeholder div

      // Touch / gesture state
      this.touches = [];
      this.pinchStartDist = 0;
      this.pinchStartScale = 1;
      this._pinchRatio = 1;       // visual scale during pinch (CSS transform, no re-render)
      this._isPinching = false;
      this.lastTapTime = 0;
      this.tapCount = 0;

      // Toolbar elements
      this.toolbarEl = null;
      this.pageInputEl = null;
      this.pageCounterEl = null;

      // Bound handlers for cleanup
      this._onScroll = this._onScroll.bind(this);
      this._onResize = this._onResize.bind(this);
      this._onTouchStart = this._onTouchStart.bind(this);
      this._onTouchMove = this._onTouchMove.bind(this);
      this._onTouchEnd = this._onTouchEnd.bind(this);
      this._onKeyDown = this._onKeyDown.bind(this);

      this._init();
    }

    async _init() {
      this._buildUI();
      this._bindEvents();
      if (this.options.url) {
        await this.load(this.options.url);
      }
    }

    // ── UI construction ──

    _buildUI() {
      this.container.innerHTML = '';
      this.container.style.cssText = 'display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden;position:relative;';

      // Scroll container for pages
      this.scrollContainer = document.createElement('div');
      this.scrollContainer.className = 'pdf-scroll-container';
      this.scrollContainer.style.cssText = 'flex:1;overflow-y:auto;overflow-x:hidden;-webkit-overflow-scrolling:touch;display:flex;flex-direction:column;align-items:center;padding:12px 0;gap:12px;touch-action:pan-x pan-y;';
      this.container.appendChild(this.scrollContainer);

      // Bottom toolbar
      this.toolbarEl = document.createElement('div');
      this.toolbarEl.className = 'pdf-toolbar';
      this.toolbarEl.style.cssText = 'display:flex;align-items:center;gap:6px;padding:8px 12px;background:rgba(0,0,0,0.85);border-top:1px solid rgba(255,255,255,0.1);flex-shrink:0;user-select:none;-webkit-user-select:none;';

      const btnStyle = 'background:none;border:none;color:#fff;font-size:14px;padding:6px 10px;border-radius:6px;cursor:pointer;white-space:nowrap;';
      const hoverStyle = 'background:rgba(255,255,255,0.1);';

      // Prev button
      this.prevBtn = this._createBtn('◀', '上一页', btnStyle, hoverStyle);
      this.prevBtn.addEventListener('click', () => this.goToPage(this.currentPage - 1));

      // Page counter / input
      this.pageCounterEl = document.createElement('span');
      this.pageCounterEl.style.cssText = 'color:#ccc;font-size:13px;white-space:nowrap;display:flex;align-items:center;gap:4px;';
      this.pageInputEl = document.createElement('input');
      this.pageInputEl.type = 'number';
      this.pageInputEl.min = '1';
      this.pageInputEl.style.cssText = 'width:42px;background:rgba(255,255,255,0.15);border:1px solid rgba(255,255,255,0.2);border-radius:4px;color:#fff;text-align:center;font-size:13px;padding:2px 4px;';
      this.pageInputEl.addEventListener('change', () => {
        const n = parseInt(this.pageInputEl.value, 10);
        if (n >= 1 && n <= this.totalPages) this.goToPage(n);
        else this.pageInputEl.value = this.currentPage;
      });
      this.pageInputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); this.pageInputEl.dispatchEvent(new Event('change')); }
      });
      this.pageCounterEl.appendChild(this.pageInputEl);
      const sep = document.createElement('span');
      sep.textContent = ' / ';
      this.pageCounterEl.appendChild(sep);
      this.pageTotalSpan = document.createElement('span');
      this.pageTotalSpan.textContent = '0';
      this.pageCounterEl.appendChild(this.pageTotalSpan);

      // Next button
      this.nextBtn = this._createBtn('▶', '下一页', btnStyle, hoverStyle);
      this.nextBtn.addEventListener('click', () => this.goToPage(this.currentPage + 1));

      // Zoom fit-width
      this.fitBtn = this._createBtn('适页', '缩放适页', btnStyle, hoverStyle);
      this.fitBtn.addEventListener('click', () => this.toggleFit());

      // Zoom in
      this.zoomInBtn = this._createBtn('🔍+', '放大', btnStyle, hoverStyle);
      this.zoomInBtn.addEventListener('click', () => this.zoomBy(0.25));

      // Zoom out
      this.zoomOutBtn = this._createBtn('🔍-', '缩小', btnStyle, hoverStyle);
      this.zoomOutBtn.addEventListener('click', () => this.zoomBy(-0.25));

      // Download
      this.downloadBtn = this._createBtn('⬇', '下载', btnStyle, hoverStyle);
      this.downloadBtn.addEventListener('click', () => {
        if (this.options.onDownload) this.options.onDownload();
      });

      // Close
      this.closeBtn = this._createBtn('✕', '关闭', btnStyle, hoverStyle);
      this.closeBtn.addEventListener('click', () => {
        if (this.options.onClose) this.options.onClose();
      });

      // Assemble toolbar
      [this.prevBtn, this.pageCounterEl, this.nextBtn, this.fitBtn, this.zoomInBtn, this.zoomOutBtn, this.downloadBtn, this.closeBtn]
        .forEach(el => this.toolbarEl.appendChild(el));

      this.container.appendChild(this.toolbarEl);
      this._updateToolbar();
    }

    _createBtn(text, title, style, hoverStyle) {
      const btn = document.createElement('button');
      btn.textContent = text;
      btn.title = title;
      btn.style.cssText = style;
      btn.addEventListener('mouseenter', () => { btn.style.cssText = style + hoverStyle; });
      btn.addEventListener('mouseleave', () => { btn.style.cssText = style; });
      return btn;
    }

    // ── Public API ──

    async load(url) {
      if (this.destroyed) return;
      this.options.url = url;
      this.scrollContainer.innerHTML = '';
      this.renderedPages.clear();
      this.pendingRenders.clear();
      this.pageElements.clear();
      this.currentPage = 1;
      this.totalPages = 0;
      this._page1Viewport = null; // 适页/适宽计算用，load 时重置
      this._estHeightRef = null;  // 页高基准：切换文档时必须清，避免用旧文档页高建占位符

      try {
        const pdfjsLib = await ensurePdfjs();
        const loadingTask = pdfjsLib.getDocument(url);
        this.pdfDoc = await loadingTask.promise;
        this.totalPages = this.pdfDoc.numPages;
        this._buildPagePlaceholders();
        this._showLargeDocumentHint();
        this._updateToolbar();
        // Apply initial fit mode before rendering to get correct scale
        if (this.fitMode) {
          await this._applyFit();
        }
        // Render first page + buffer
        await this._renderVisiblePages();
        this._updateOverflowX();
      } catch (err) {
        this._showError(err);
      }
    }

    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this._unbindEvents();
      // Cancel pending renders
      this.pendingRenders.forEach(task => task.cancel = true);
      this.pendingRenders.clear();
      // Destroy canvases
      this.renderedPages.forEach(({ canvas }) => {
        if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
      });
      this.renderedPages.clear();
      this.pageElements.clear();
      // Close PDF doc
      if (this.pdfDoc) {
        try { this.pdfDoc.destroy(); } catch (_) {}
        this.pdfDoc = null;
      }
      this.container.innerHTML = '';
    }

    goToPage(num) {
      if (!this.pdfDoc || num < 1 || num > this.totalPages) return;
      this.currentPage = num;
      this._updateToolbar();
      // Scroll to the target page
      const el = this.pageElements.get(num);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    zoomBy(delta) {
      this.fitMode = null;
      this.scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, this.scale + delta));
      this._rescaleRendered();
      this._updateToolbar();
    }

    setScale(s) {
      this.fitMode = null;
      this.scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, s));
      this._rescaleRendered();
      this._updateToolbar();
    }

    toggleFit() {
      if (this.fitMode === 'width') {
        this.fitMode = 'page';
      } else if (this.fitMode === 'page') {
        this.fitMode = '100';
      } else {
        this.fitMode = 'width';
      }
      this._applyFit();
      this._updateToolbar();
    }

    // ── Page placeholders ──

    _buildPagePlaceholders() {
      // Pre-create placeholder divs so the scroll container has correct height.
      // 关键：初始化就按估算页高设 height —— 否则占位符都是 0 高度（空 flex div），
      // 滚动容器总高度只有已渲染页，多页 PDF 滚到第 6 页就到底。
      const est = this._estimatePageHeight();
      for (let i = 1; i <= this.totalPages; i++) {
        const div = document.createElement('div');
        div.className = 'pdf-page-placeholder';
        div.dataset.page = i;
        div.style.cssText = 'width:100%;display:flex;justify-content:center;align-items:flex-start;position:relative;';
        div.style.height = est + 'px';
        this.pageElements.set(i, div);
        this.scrollContainer.appendChild(div);
      }
    }

    _getPageHeight(pageNum) {
      // If rendered, use actual canvas height
      const rendered = this.renderedPages.get(pageNum);
      if (rendered) return rendered.height;

      // Estimate from first page
      if (this.pdfDoc && this.renderedPages.size > 0) {
        const first = this.renderedPages.get(1);
        if (first) return first.height;
      }

      // 统一用 _estimatePageHeight（与滚动窗口估算同一基准），
      // 避免"默认 600×dpr×scale"与实际渲染高度不一致导致的窗口错位
      return this._estimatePageHeight();
    }

    // ── Rendering pipeline ──

    /**
     * 估算单页高度：优先已渲染的第一页实际高度；未渲染时按容器宽高比（A4 纵向 ≈ 1:1.414）兜底。
     * 用于滚动窗口估算（避免逐页 getBoundingClientRect 强制 layout）。
     */
    _estimatePageHeight() {
      const first = this.renderedPages.get(1);
      if (first) return first.height;
      // 已渲染过任意页 → 用最近真实高度，维持窗口基准稳定
      if (this._estHeightRef) return this._estHeightRef;
      return Math.max(240, Math.round((this.scrollContainer.clientWidth || 800) * 1.414));
    }

    async _renderVisiblePages() {
      if (!this.pdfDoc || this.destroyed) return;

      const visible = this._getVisiblePageRange();
      // Render pages in range
      for (let i = visible.start; i <= visible.end; i++) {
        if (!this.renderedPages.has(i) && !this.pendingRenders.has(i)) {
          this._renderPage(i);
        }
      }
      // Destroy pages outside range
      for (const [pageNum, data] of this.renderedPages) {
        if (pageNum < visible.start - BUFFER_PAGES || pageNum > visible.end + BUFFER_PAGES) {
          this._destroyPage(pageNum, data);
        }
      }
    }

    async _renderPage(pageNum) {
      if (this.destroyed || !this.pdfDoc) return;
      if (this.renderedPages.has(pageNum)) return;

      const task = { cancel: false };
      this.pendingRenders.set(pageNum, task);

      try {
        const page = await this.pdfDoc.getPage(pageNum);
        if (task.cancel) return;

        // 标准 PDF.js HiDPI 渲染：viewport 用逻辑 scale，
        // canvas 物理像素 = viewport × dpr，CSS 尺寸 = viewport
        const viewport = page.getViewport({ scale: this.scale });
        const outputScale = window.devicePixelRatio || 1;
        const cssWidth = Math.floor(viewport.width);
        const cssHeight = Math.floor(viewport.height);

        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(viewport.width * outputScale);
        canvas.height = Math.floor(viewport.height * outputScale);
        canvas.style.cssText = `width:${cssWidth}px;height:${cssHeight}px;border-radius:4px;background:#fff;`;
        canvas.dataset.page = pageNum;

        const ctx = canvas.getContext('2d');
        ctx.scale(outputScale, outputScale);

        await page.render({ canvasContext: ctx, viewport }).promise;
        if (task.cancel) { canvas.width = 0; canvas.height = 0; return; }

        const placeholder = this.pageElements.get(pageNum);
        if (placeholder) {
          placeholder.style.height = cssHeight + 'px';
          placeholder.appendChild(canvas);
        }
        // 记录已渲染页高度的"参考基准"：让后续滚动窗口在占位符尚未
        // 渲染时用最近的真实高度估算，避免渲染推进过程中窗口抖动
        if (pageNum === 1 || !this._estHeightRef) {
          this._estHeightRef = cssHeight;
        }

        this.renderedPages.set(pageNum, { canvas, ctx, height: cssHeight, width: cssWidth });
      } catch (err) {
        console.warn('PDF render failed for page', pageNum, err);
      } finally {
        this.pendingRenders.delete(pageNum);
      }
    }

    _destroyPage(pageNum, data) {
      if (data && data.canvas && data.canvas.parentNode) {
        data.canvas.parentNode.removeChild(data.canvas);
      }
      this.renderedPages.delete(pageNum);
      // Reset placeholder height to estimate
      const placeholder = this.pageElements.get(pageNum);
      if (placeholder) {
        placeholder.style.height = '';
        placeholder.innerHTML = '';
      }
    }

    async _rescaleRendered() {
      // Cancel all in-flight renders before re-rendering at new scale
      this.pendingRenders.forEach(task => { task.cancel = true; });
      this.pendingRenders.clear();
      this.renderedPages.forEach((data, pageNum) => {
        this._destroyPage(pageNum, data);
      });
      await this._renderVisiblePages();
      this._updateOverflowX();
    }

    _updateOverflowX() {
      if (!this.scrollContainer || this.renderedPages.size === 0) return;
      const containerW = this.scrollContainer.clientWidth;
      let needX = false;
      this.renderedPages.forEach((data) => {
        if (data.width > containerW + 4) needX = true;
      });
      this.scrollContainer.style.overflowX = needX ? 'auto' : 'hidden';
    }

    /**
     * 累计占位符高度定位当前页窗口（O(log n) 二分，不强制 layout）。
     *
     * 之前 v1.4.14 用均匀 stride 估算，但占位符高度在渲染过程中会从
     * 估算值变为真实 canvas 高度（不均匀），窗口与可见区错位 →
     * "第 5 页划不动 + 页面反复渲染闪烁"。这里改为按逐页实际高度累加
     * 定位，pageElements 的 style.height 不读布局（不触发 reflow）。
     */
    _getVisiblePageRange() {
      const scrollTop = this.scrollContainer.scrollTop;
      const viewHeight = this.scrollContainer.clientHeight;
      // 累计高度数组 + 二分：找 scrollTop 所在的页
      const heights = [];
      let acc = 0;
      for (let i = 1; i <= this.totalPages; i++) {
        const el = this.pageElements.get(i);
        const h = el && el.style.height ? parseFloat(el.style.height) : this._estimatePageHeight();
        heights.push({ page: i, top: acc, bottom: acc + h + PAGE_GAP });
        acc += h + PAGE_GAP;
      }
      // 二分找第一个 bottom > scrollTop 的页
      let lo = 0, hi = heights.length - 1, center = 0;
      while (lo <= hi) {
        center = (lo + hi) >> 1;
        if (heights[center].top <= scrollTop && scrollTop < heights[center].bottom) break;
        if (heights[center].bottom <= scrollTop) lo = center + 1;
        else hi = center - 1;
      }
      // 循环退出（scrollTop 超过最后页底 / 空）时显式钳制，避免引用到倒数第二页
      if (center >= heights.length) center = heights.length - 1;
      const centerPage = Math.max(1, Math.min(this.totalPages, heights[center]?.page || 1));
      const visibleCount = Math.max(1, Math.ceil(viewHeight / this._estimatePageHeight())) + BUFFER_PAGES * 2 + 1;
      const start = Math.max(1, centerPage - Math.floor(visibleCount / 2));
      const end = Math.min(this.totalPages, start + visibleCount - 1);
      return { start, end };
    }

    // ── Scroll detection ──

    _onScroll() {
      if (this.destroyed) return;
      // Debounce via rAF
      if (this._scrollRAF) cancelAnimationFrame(this._scrollRAF);
      this._scrollRAF = requestAnimationFrame(() => {
        // 复用窗口定位逻辑求当前页（累计高度二分，不逐页 rect/强制 layout）
        const visible = this._getVisiblePageRange();
        this.currentPage = Math.max(1, Math.min(this.totalPages, visible.start));
        this._updateToolbar();
        this._renderVisiblePages();
      });
    }

    _onResize() {
      if (this.destroyed) return;
      if (this._resizeTimer) clearTimeout(this._resizeTimer);
      this._resizeTimer = setTimeout(() => {
        if (this.fitMode) this._applyFit();
        this._renderVisiblePages();
      }, 200);
    }

    // ── Touch gestures ──

    _onTouchStart(e) {
      if (this.destroyed) return;
      e.preventDefault(); // isolate: don't propagate to underlying page
      this.touches = Array.from(e.touches);

      if (this.touches.length === 2) {
        this.pinchStartDist = this._touchDist(this.touches);
        this.pinchStartScale = this.scale;
        this._pinchRatio = 1;
        this._isPinching = true;
      } else if (this.touches.length === 1) {
        const now = Date.now();
        if (now - this.lastTapTime < DOUBLE_TAP_DELAY) {
          this.tapCount++;
        } else {
          this.tapCount = 1;
        }
        this.lastTapTime = now;
      }
    }

    _onTouchMove(e) {
      if (this.destroyed) return;
      e.preventDefault(); // isolate: don't propagate to underlying page
      const currentTouches = Array.from(e.touches);

      if (currentTouches.length === 2 && this.touches.length === 2) {
        e.preventDefault();
        const dist = this._touchDist(currentTouches);
        const ratio = dist / this.pinchStartDist;
        const targetScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, this.pinchStartScale * ratio));
        this._pinchRatio = targetScale / this.scale;
        if (Math.abs(this._pinchRatio - 1) > 0.002) {
          this.fitMode = null;
          // Smooth visual: CSS transform on canvases (no re-render during pinch)
          this.renderedPages.forEach((data, pageNum) => {
            data.canvas.style.transform = `scale(${this._pinchRatio})`;
            data.canvas.style.transformOrigin = 'top center';
            // Sync placeholder height so layout doesn't collapse/overflow
            const el = this.pageElements.get(pageNum);
            if (el) el.style.height = (data.height * this._pinchRatio) + 'px';
          });
          this._updateToolbar();
        }
      }

      this.touches = currentTouches;
    }

    _onTouchEnd(e) {
      if (this.destroyed) return;

      // Pinch ended: commit final scale, clear transforms, re-render once
      if (this._isPinching && e.touches.length < 2) {
        this._isPinching = false;
        if (this._pinchRatio !== 1) {
          this.scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, this.scale * this._pinchRatio));
          this._pinchRatio = 1;
          // Clear CSS transforms
          this.renderedPages.forEach((data, pageNum) => {
            data.canvas.style.transform = '';
            data.canvas.style.transformOrigin = '';
            // Restore placeholder height to real rendered height
            const el = this.pageElements.get(pageNum);
            if (el) el.style.height = data.height + 'px';
          });
          this._rescaleRendered();
          this._updateToolbar();
        }
      }

      // Double-tap to toggle fit
      if (this.tapCount >= 2 && e.touches.length === 0) {
        this.tapCount = 0;
        this.toggleFit();
      }

      this.touches = Array.from(e.touches);
    }

    _touchDist(t) {
      const dx = t[0].clientX - t[1].clientX;
      const dy = t[0].clientY - t[1].clientY;
      return Math.sqrt(dx * dx + dy * dy);
    }

    // ── Keyboard ──

    _onKeyDown(e) {
      if (this.destroyed) return;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault();
        this.goToPage(this.currentPage - 1);
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault();
        this.goToPage(this.currentPage + 1);
      } else if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        this.zoomBy(0.25);
      } else if (e.key === '-') {
        e.preventDefault();
        this.zoomBy(-0.25);
      }
    }

    // ── Fit modes ──

    _applyFit() {
      if (!this.pdfDoc) return Promise.resolve();
      // 第一页 viewport 只在 load 时取一次并缓存，适页/适宽/100% 切换不再反复
      // 异步 getPage(1)。缩放改变不影响 scale=1 的 viewport，缓存安全。
      const getVp1 = () => {
        if (this._page1Viewport) return Promise.resolve(this._page1Viewport);
        return this.pdfDoc.getPage(1).then((page) => {
          this._page1Viewport = page.getViewport({ scale: 1 });
          return this._page1Viewport;
        }).catch(() => null);
      };
      return getVp1().then((vp1) => {
        if (this.destroyed || !vp1) return;
        const containerW = this.scrollContainer.clientWidth;
        const containerH = this.scrollContainer.clientHeight;

        if (this.fitMode === 'width') {
          this.scale = containerW / vp1.width;
        } else if (this.fitMode === 'page') {
          const scaleX = containerW / vp1.width;
          const scaleY = containerH / vp1.height;
          this.scale = Math.min(scaleX, scaleY);
        } else if (this.fitMode === '100') {
          this.scale = 1 / (window.devicePixelRatio || 1);
        } else {
          return;
        }
        this.scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, this.scale));
        this._rescaleRendered();
        this._updateToolbar();
      });
    }

    // ── Toolbar state ──

    _updateToolbar() {
      if (!this.toolbarEl) return;
      if (this.prevBtn) this.prevBtn.disabled = this.currentPage <= 1;
      if (this.nextBtn) this.nextBtn.disabled = this.currentPage >= this.totalPages;
      if (this.pageInputEl) this.pageInputEl.value = this.currentPage;
      if (this.pageTotalSpan) this.pageTotalSpan.textContent = this.totalPages || '0';

      if (this.fitBtn) {
        if (this.fitMode === 'width') this.fitBtn.textContent = '适宽';
        else if (this.fitMode === 'page') this.fitBtn.textContent = '适页';
        else if (this.fitMode === '100') this.fitBtn.textContent = '100%';
        else this.fitBtn.textContent = Math.round(this.scale * 100) + '%';
      }
    }

    // ── Error UI ──

    _showError(err) {
      this.scrollContainer.innerHTML = `
        <div style="margin:auto;text-align:center;padding:24px;color:#f88;">
          <div style="font-size:16px;margin-bottom:8px;">PDF 加载失败</div>
          <div style="font-size:13px;color:#aaa;">${err?.message || '未知错误'}</div>
        </div>`;
    }

    _showLargeDocumentHint() {
      if (!this.scrollContainer || this.totalPages < 80) return;
      const hint = document.createElement('div');
      hint.className = 'pdf-large-document-hint';
      hint.textContent = `此 PDF 共 ${this.totalPages} 页，已优先渲染当前页；首次打开大文件时请稍等。`;
      this.scrollContainer.prepend(hint);
    }

    // ── Event binding ──

    _bindEvents() {
      this.scrollContainer.addEventListener('scroll', this._onScroll, { passive: true });
      window.addEventListener('resize', this._onResize);
      this.scrollContainer.addEventListener('touchstart', this._onTouchStart, { passive: false });
      this.scrollContainer.addEventListener('touchmove', this._onTouchMove, { passive: false });
      this.scrollContainer.addEventListener('touchend', this._onTouchEnd, { passive: true });
      window.addEventListener('keydown', this._onKeyDown);
    }

    _unbindEvents() {
      this.scrollContainer.removeEventListener('scroll', this._onScroll);
      window.removeEventListener('resize', this._onResize);
      this.scrollContainer.removeEventListener('touchstart', this._onTouchStart);
      this.scrollContainer.removeEventListener('touchmove', this._onTouchMove);
      this.scrollContainer.removeEventListener('touchend', this._onTouchEnd);
      window.removeEventListener('keydown', this._onKeyDown);
      if (this._scrollRAF) cancelAnimationFrame(this._scrollRAF);
      if (this._resizeTimer) clearTimeout(this._resizeTimer);
    }
  }

  // Expose globally
  window.PDFViewer = PDFViewer;
  window.preloadPdfViewerAssets = ensurePdfjs;
})();

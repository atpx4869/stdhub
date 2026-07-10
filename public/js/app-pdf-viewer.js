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
      this.fitMode = 'width'; // 'width' | 'page' | '100'
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
      this.container.style.cssText = 'display:flex;flex-direction:column;height:100%;overflow:hidden;position:relative;';

      // Scroll container for pages
      this.scrollContainer = document.createElement('div');
      this.scrollContainer.className = 'pdf-scroll-container';
      this.scrollContainer.style.cssText = 'flex:1;overflow-y:auto;overflow-x:hidden;-webkit-overflow-scrolling:touch;display:flex;flex-direction:column;align-items:center;padding:12px 0;gap:12px;';
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
      this.fitBtn = this._createBtn('适宽', '缩放适宽', btnStyle, hoverStyle);
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

      try {
        const pdfjsLib = await ensurePdfjs();
        const loadingTask = pdfjsLib.getDocument(url);
        this.pdfDoc = await loadingTask.promise;
        this.totalPages = this.pdfDoc.numPages;
        this._buildPagePlaceholders();
        this._updateToolbar();
        // Render first page + buffer
        await this._renderVisiblePages();
        // Apply initial fit mode after rendering
        if (this.fitMode) {
          this._applyFit();
        }
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
      // Pre-create placeholder divs so the scroll container has correct height
      for (let i = 1; i <= this.totalPages; i++) {
        const div = document.createElement('div');
        div.className = 'pdf-page-placeholder';
        div.dataset.page = i;
        div.style.cssText = 'width:100%;display:flex;justify-content:center;align-items:flex-start;position:relative;';
        // We'll set height once we know the first page aspect ratio
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

      // Default estimate
      return 600 * (window.devicePixelRatio || 1) * this.scale;
    }

    // ── Rendering pipeline ──

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

        const viewport = page.getViewport({ scale: this.scale * (window.devicePixelRatio || 1) });
        const outputScale = window.devicePixelRatio || 1;
        const cssWidth = viewport.width / outputScale;
        const cssHeight = viewport.height / outputScale;

        const canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
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

    _rescaleRendered() {
      // Re-render all currently rendered pages at new scale
      this.renderedPages.forEach((data, pageNum) => {
        this._destroyPage(pageNum, data);
      });
      this._renderVisiblePages();
    }

    _getVisiblePageRange() {
      const scrollTop = this.scrollContainer.scrollTop;
      const viewHeight = this.scrollContainer.clientHeight;
      let start = 1, end = 1;

      for (let i = 1; i <= this.totalPages; i++) {
        const el = this.pageElements.get(i);
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        const containerRect = this.scrollContainer.getBoundingClientRect();
        const top = rect.top - containerRect.top + scrollTop;
        const bottom = top + rect.height;

        if (bottom >= scrollTop && top <= scrollTop + viewHeight) {
          if (start === 1 || i < start) start = i;
          if (i > end) end = i;
        }
      }

      // Expand by buffer
      start = Math.max(1, start - BUFFER_PAGES);
      end = Math.min(this.totalPages, end + BUFFER_PAGES);

      return { start, end };
    }

    // ── Scroll detection ──

    _onScroll() {
      if (this.destroyed) return;
      // Debounce via rAF
      if (this._scrollRAF) cancelAnimationFrame(this._scrollRAF);
      this._scrollRAF = requestAnimationFrame(() => {
        // Determine current page from scroll position
        const visible = this._getVisiblePageRange();
        // For simplicity, current page = first fully visible page
        const scrollTop = this.scrollContainer.scrollTop;
        for (let i = 1; i <= this.totalPages; i++) {
          const el = this.pageElements.get(i);
          if (!el) continue;
          const containerRect = this.scrollContainer.getBoundingClientRect();
          const rect = el.getBoundingClientRect();
          if (rect.top - containerRect.top >= -rect.height / 2) {
            this.currentPage = i;
            break;
          }
        }
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
      this.touches = Array.from(e.touches);

      if (this.touches.length === 2) {
        e.preventDefault();
        this.pinchStartDist = this._touchDist(this.touches);
        this.pinchStartScale = this.scale;
      } else if (this.touches.length === 1) {
        // Double-tap detection
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
      const currentTouches = Array.from(e.touches);

      if (currentTouches.length === 2 && this.touches.length === 2) {
        e.preventDefault();
        const dist = this._touchDist(currentTouches);
        const ratio = dist / this.pinchStartDist;
        const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, this.pinchStartScale * ratio));
        if (Math.abs(newScale - this.scale) > 0.01) {
          this.fitMode = null;
          this.scale = newScale;
          this._rescaleRendered();
          this._updateToolbar();
        }
      }

      this.touches = currentTouches;
    }

    _onTouchEnd(e) {
      if (this.destroyed) return;

      // Double-tap to toggle fit
      if (this.tapCount >= 2 && e.touches.length === 0) {
        e.preventDefault();
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
      if (!this.pdfDoc) return;
      // Get first page viewport at scale=1 to determine aspect ratio
      this.pdfDoc.getPage(1).then(page => {
        if (this.destroyed) return;
        // Defer to next frame so the browser has finished layout and
        // scrollContainer.clientWidth/Height reflect the actual overlay size.
        // Without this, the initial fit may read 0 or stale dimensions on mobile.
        return new Promise(r => requestAnimationFrame(() => r(page)));
      }).then(page => {
        if (!page || this.destroyed) return;
        const vp1 = page.getViewport({ scale: 1 });
        const containerW = this.scrollContainer.clientWidth - 24; // padding
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
      }).catch(() => {});
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
})();

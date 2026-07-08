# 手机端 PDF 预览 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use compose:subagent (recommended) or compose:execute to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 手机端用 PDF.js canvas 渲染 PDF，解决 iOS Safari iframe 不渲染 + 无手势 + 内存问题；桌面端保持 iframe 不变。

**Architecture:** 渐进增强。新增 `app-pdf-viewer.js` 封装 PDFViewer 类，动态按需加载 PDF.js。手机端预览入口走 PDFViewer canvas 渲染，桌面端走现有 iframe 路径。

**Tech Stack:** PDF.js (pdfjs-dist) 5.x、原生 JS、CSS

## Global Constraints

- Node.js >= 20，无框架依赖（vanilla JS + `<script>` 全局变量）
- PDF.js 文件放 `public/vendor/`，不通过 npm 打包（前端非 module 化）
- 复用现有 `window.isMobile()`（app-mobile.js）判断手机端
- 复用现有 overlay（`#previewOverlay`）作为容器
- 桌面端预览路径零改动

---

### Task 1: 下载 PDF.js 库文件

**Covers:** [S3]

**Files:**
- Create: `public/vendor/pdf.min.mjs`
- Create: `public/vendor/pdf.worker.min.mjs`

- [ ] **Step 1: 下载 PDF.js 主库**

```bash
# 在项目根目录执行
curl -L -o public/vendor/pdf.min.mjs "https://unpkg.com/pdfjs-dist@4.9.155/build/pdf.min.mjs"
```

- [ ] **Step 2: 下载 PDF.js Worker**

```bash
curl -L -o public/vendor/pdf.worker.min.mjs "https://unpkg.com/pdfjs-dist@4.9.155/build/pdf.worker.min.mjs"
```

- [ ] **Step 3: 验证文件完整性**

```bash
# 检查文件大小（主库 ~340KB，Worker ~570KB）
ls -la public/vendor/pdf.min.mjs public/vendor/pdf.worker.min.mjs
# 检查文件头是否为有效 JS
head -c 100 public/vendor/pdf.min.mjs
```

Expected: 文件存在且大小合理，头部包含 JS 代码

- [ ] **Step 4: Commit**

```bash
git add public/vendor/pdf.min.mjs public/vendor/pdf.worker.min.mjs
git commit -m "chore: add PDF.js 4.9.155 for mobile PDF preview"
```

---

### Task 2: 创建 PDFViewer 核心类

**Covers:** [S4]

**Files:**
- Create: `public/js/app-pdf-viewer.js`

**Interfaces:**
- Consumes: `window.pdfjsLib`（动态加载后可用）
- Produces: `window.PDFViewer` 类，供 app-search.js 和 app-detail-utils.js 调用

- [ ] **Step 1: 创建 app-pdf-viewer.js 骨架**

在 `public/js/app-pdf-viewer.js` 中写入以下内容：

```javascript
/**
 * 手机端 PDF 查看器 — 基于 PDF.js canvas 渲染。
 * 仅手机端加载（桌面端走 iframe），动态按需引入 PDF.js。
 *
 * 用法：
 *   const viewer = new PDFViewer(container, { url, title, onDownload });
 *   await viewer.load(url);
 *   viewer.destroy(); // 清理
 */
(function () {
  'use strict';

  // ── PDF.js 动态加载 ──
  let _pdfLoading = null;
  function ensurePdfJs() {
    if (window.pdfjsLib) return Promise.resolve();
    if (_pdfLoading) return _pdfLoading;
    _pdfLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = '/vendor/pdf.min.mjs';
      s.onload = () => {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.mjs';
        resolve();
      };
      s.onerror = () => reject(new Error('PDF.js 加载失败'));
      document.head.appendChild(s);
    });
    return _pdfLoading;
  }

  class PDFViewer {
    /**
     * @param {HTMLElement} container - DOM 容器（通常是 #previewBody）
     * @param {object} options
     * @param {string} options.url - PDF 文件 URL
     * @param {string} [options.title] - 文档标题
     * @param {function} [options.onDownload] - 下载回调
     */
    constructor(container, options = {}) {
      this.container = container;
      this.url = options.url;
      this.title = options.title || '';
      this.onDownload = options.onDownload || null;

      this._pdf = null;
      this._pages = [];          // { div, canvas, rendered, viewport }
      this._scale = 1;
      this._mode = 'continuous'; // 'continuous' | 'single'
      this._destroyed = false;
      this._renderQueue = new Set();
      this._observer = null;
      this._touchState = null;
      this._doubleTapTimer = null;

      // DOM 结构
      this._buildUI();
    }

    _buildUI() {
      this.container.innerHTML = '';
      this.container.style.cssText = 'display:flex;flex-direction:column;height:100%;background:#1a1a1a;overflow:hidden;';

      // 工具栏
      this.toolbar = document.createElement('div');
      this.toolbar.className = 'pdfv-toolbar';
      this.toolbar.innerHTML = `
        <button class="pdfv-btn pdfv-prev" title="上一页">&#9664;</button>
        <span class="pdfv-page-info"><span class="pdfv-page-num">1</span> / <span class="pdfv-page-count">-</span></span>
        <button class="pdfv-btn pdfv-next" title="下一页">&#9654;</button>
        <span class="pdfv-sep"></span>
        <button class="pdfv-btn pdfv-zoom-out" title="缩小">-</button>
        <button class="pdfv-btn pdfv-zoom-fit" title="适宽">适宽</button>
        <button class="pdfv-btn pdfv-zoom-in" title="放大">+</button>
        <span class="pdfv-sep"></span>
        <button class="pdfv-btn pdfv-download" title="下载">&#8681;</button>
        <button class="pdfv-btn pdfv-close" title="关闭">&times;</button>
      `;
      this.container.appendChild(this.toolbar);

      // 页码元素引用
      this._pageNumEl = this.toolbar.querySelector('.pdfv-page-num');
      this._pageCountEl = this.toolbar.querySelector('.pdfv-page-count');

      // 滚动容器
      this.scrollContainer = document.createElement('div');
      this.scrollContainer.className = 'pdfv-scroll';
      this.container.appendChild(this.scrollContainer);

      // 绑定事件
      this._bindEvents();
    }

    _bindEvents() {
      // 翻页按钮
      this.toolbar.querySelector('.pdfv-prev').addEventListener('click', () => this._goToPage(this._currentPage - 1));
      this.toolbar.querySelector('.pdfv-next').addEventListener('click', () => this._goToPage(this._currentPage + 1));

      // 缩放按钮
      this.toolbar.querySelector('.pdfv-zoom-in').addEventListener('click', () => this._zoomBy(0.25));
      this.toolbar.querySelector('.pdfv-zoom-out').addEventListener('click', () => this._zoomBy(-0.25));
      this.toolbar.querySelector('.pdfv-zoom-fit').addEventListener('click', () => this._zoomFitWidth());

      // 下载
      this.toolbar.querySelector('.pdfv-download').addEventListener('click', () => {
        if (this.onDownload) this.onDownload();
      });

      // 关闭
      this.toolbar.querySelector('.pdfv-close').addEventListener('click', () => {
        if (this.onDownload) this.onDownload(); // 复用回调通知外层关闭
      });

      // 滚动监听 — 更新页码 + 按需渲染
      this.scrollContainer.addEventListener('scroll', () => this._onScroll(), { passive: true });

      // 触摸手势
      this._bindTouchEvents();
    }

    // ── 公共 API ──

    async load(url) {
      this.url = url || this.url;
      this.container.querySelector('.pdfv-page-count').textContent = '…';

      try {
        await ensurePdfJs();
        const loadingTask = window.pdfjsLib.getDocument({ url: this.url });
        this._pdf = await loadingTask.promise;
        this._totalPages = this._pdf.numPages;
        this._pageCountEl.textContent = this._totalPages;
        this._currentPage = 1;

        // 计算初始缩放（适宽）
        const firstPage = await this._pdf.getPage(1);
        const viewport = firstPage.getViewport({ scale: 1 });
        const containerWidth = this.scrollContainer.clientWidth || 360;
        this._scale = containerWidth / viewport.width;

        // 创建所有页占位
        this._createPageSlots();
        // 渲染可视区域
        this._renderVisiblePages();
      } catch (e) {
        this.container.innerHTML = `
          <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:#c8cfd9;gap:12px;padding:24px;text-align:center;">
            <div style="font-size:48px;">&#9888;</div>
            <div style="font-size:16px;font-weight:600;">PDF 加载失败</div>
            <div style="font-size:13px;color:#7c8696;">${e.message || '文件可能已损坏或网络中断'}</div>
            <button class="btn btn-primary" onclick="location.reload()" style="margin-top:8px;">重试</button>
          </div>`;
        throw e;
      }
    }

    destroy() {
      if (this._destroyed) return;
      this._destroyed = true;
      if (this._observer) this._observer.disconnect();
      this._renderQueue.clear();
      this._pdf = null;
      this._pages = [];
      this.container.innerHTML = '';
    }

    // ── 内部：页面占位 ──

    _createPageSlots() {
      this.scrollContainer.innerHTML = '';
      this._pages = [];
      for (let i = 1; i <= this._totalPages; i++) {
        const div = document.createElement('div');
        div.className = 'pdfv-page-slot';
        div.dataset.page = i;
        // 用 aspect-ratio 占位（第一页 viewport 比例）
        if (i === 1) {
          const vp = this._pdf.getPage(1).then(p => {
            const v = p.getViewport({ scale: this._scale });
            div.style.aspectRatio = `${v.width} / ${v.height}`;
          });
        }
        this.scrollContainer.appendChild(div);
        this._pages.push({ div, canvas: null, rendered: false, viewport: null });
      }
    }

    // ── 内部：按需渲染 ──

    _onScroll() {
      this._updateCurrentPage();
      this._renderVisiblePages();
    }

    _updateCurrentPage() {
      const scrollTop = this.scrollContainer.scrollTop;
      const containerHeight = this.scrollContainer.clientHeight;
      const center = scrollTop + containerHeight / 2;
      let page = 1;
      for (let i = 0; i < this._pages.length; i++) {
        const rect = this._pages[i].div.getBoundingClientRect();
        const containerRect = this.scrollContainer.getBoundingClientRect();
        const top = rect.top - containerRect.top + scrollTop;
        const bottom = top + rect.height;
        if (center >= top && center < bottom) {
          page = i + 1;
          break;
        }
      }
      if (page !== this._currentPage) {
        this._currentPage = page;
        this._pageNumEl.textContent = page;
      }
    }

    async _renderVisiblePages() {
      if (!this._pdf || this._destroyed) return;
      const scrollTop = this.scrollContainer.scrollTop;
      const viewTop = scrollTop - 200;  // buffer
      const viewBottom = scrollTop + this.scrollContainer.clientHeight + 200;

      for (let i = 0; i < this._pages.length; i++) {
        const p = this._pages[i];
        const slotTop = p.div.offsetTop;
        const slotBottom = slotTop + p.div.offsetHeight;

        if (slotBottom >= viewTop && slotTop <= viewBottom) {
          if (!p.rendered) await this._renderPage(i + 1);
        } else if (p.rendered && p.canvas) {
          // 离开可视区域，释放 canvas 内存
          p.canvas.remove();
          p.canvas = null;
          p.rendered = false;
          p.div.style.aspectRatio = '';
        }
      }
    }

    async _renderPage(num) {
      if (this._destroyed || !this._pdf) return;
      const idx = num - 1;
      const p = this._pages[idx];
      if (p.rendered) return;

      try {
        const page = await this._pdf.getPage(num);
        if (this._destroyed) return;
        const viewport = page.getViewport({ scale: this._scale });
        const outputScale = window.devicePixelRatio || 1;

        const canvas = document.createElement('canvas');
        canvas.className = 'pdfv-canvas';
        canvas.width = Math.floor(viewport.width * outputScale);
        canvas.height = Math.floor(viewport.height * outputScale);
        canvas.style.width = viewport.width + 'px';
        canvas.style.height = viewport.height + 'px';

        p.div.innerHTML = '';
        p.div.appendChild(canvas);
        p.div.style.aspectRatio = `${viewport.width} / ${viewport.height}`;

        const ctx = canvas.getContext('2d');
        const transform = outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : null;

        await page.render({ canvasContext: ctx, viewport, transform }).promise;

        p.canvas = canvas;
        p.rendered = true;
        p.viewport = viewport;
      } catch (e) {
        if (!this._destroyed) console.warn(`[PDFViewer] 渲染第 ${num} 页失败:`, e);
      }
    }

    // ── 内部：翻页 ──

    _goToPage(num) {
      num = Math.max(1, Math.min(this._totalPages, num));
      const slot = this._pages[num - 1];
      if (slot) {
        slot.div.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }

    // ── 内部：缩放 ──

    _zoomBy(delta) {
      this._scale = Math.max(0.3, Math.min(5, this._scale + delta));
      this._rerenderAll();
    }

    _zoomFitWidth() {
      if (!this._pages.length || !this._pages[0].viewport) return;
      const containerWidth = this.scrollContainer.clientWidth || 360;
      const firstVp = this._pdf.getPage(1).then(p => {
        const vp = p.getViewport({ scale: 1 });
        this._scale = containerWidth / vp.width;
        this._rerenderAll();
      });
    }

    async _rerenderAll() {
      for (const p of this._pages) {
        p.rendered = false;
        if (p.canvas) { p.canvas.remove(); p.canvas = null; }
        p.div.style.aspectRatio = '';
      }
      await this._renderVisiblePages();
    }

    // ── 内部：触摸手势 ──

    _bindTouchEvents() {
      const el = this.scrollContainer;
      let startX, startY, lastDist, lastTap;

      el.addEventListener('touchstart', (e) => {
        if (e.touches.length === 2) {
          // pinch start
          const dx = e.touches[0].clientX - e.touches[1].clientX;
          const dy = e.touches[0].clientY - e.touches[1].clientY;
          lastDist = Math.hypot(dx, dy);
          this._touchState = 'pinch';
          e.preventDefault();
        } else if (e.touches.length === 1) {
          startX = e.touches[0].clientX;
          startY = e.touches[0].clientY;
          this._touchState = 'start';

          // 双击检测
          const now = Date.now();
          if (lastTap && now - lastTap < 300) {
            clearTimeout(this._doubleTapTimer);
            this._doubleTapTimer = null;
            lastTap = 0;
            this._zoomFitWidth(); // toggle fit-width
          } else {
            lastTap = now;
          }
        }
      }, { passive: false });

      el.addEventListener('touchmove', (e) => {
        if (this._touchState === 'pinch' && e.touches.length === 2) {
          const dx = e.touches[0].clientX - e.touches[1].clientX;
          const dy = e.touches[0].clientY - e.touches[1].clientY;
          const dist = Math.hypot(dx, dy);
          if (lastDist) {
            const ratio = dist / lastDist;
            const newScale = Math.max(0.3, Math.min(5, this._scale * ratio));
            if (Math.abs(newScale - this._scale) > 0.01) {
              this._scale = newScale;
              this._rerenderAll();
            }
          }
          lastDist = dist;
          e.preventDefault();
        }
      }, { passive: false });

      el.addEventListener('touchend', () => {
        this._touchState = null;
        lastDist = null;
      });
    }
  }

  // 暴露到全局
  window.PDFViewer = PDFViewer;
})();
```

- [ ] **Step 2: 验证语法**

```bash
node -c public/js/app-pdf-viewer.js
```

Expected: 无语法错误输出

- [ ] **Step 3: Commit**

```bash
git add public/js/app-pdf-viewer.js
git commit -m "feat: add PDFViewer class for mobile PDF preview"
```

---

### Task 3: 添加 PDFViewer CSS 样式

**Covers:** [S4]

**Files:**
- Modify: `public/styles.css`（在 PDF 预览 overlay 样式块末尾追加）

**Interfaces:**
- Consumes: 无
- Produces: `.pdfv-*` 样式类，供 app-pdf-viewer.js 使用

- [ ] **Step 1: 在 styles.css 中追加样式**

在 `public/styles.css` 的 `/* 手机端：占满屏幕... */` 注释块之后（约第 3047 行后）追加：

```css
/* ── PDFViewer 手机端样式 ── */
.pdfv-toolbar {
  display: flex; align-items: center; gap: 6px;
  padding: 6px 10px;
  background: rgba(11, 16, 21, 0.95);
  border-bottom: 1px solid rgba(255,255,255,0.08);
  flex-shrink: 0; z-index: 1;
}
.pdfv-btn {
  background: none; border: 1px solid rgba(255,255,255,0.12);
  color: #c8cfd9; font-size: 14px; padding: 4px 10px;
  border-radius: 6px; cursor: pointer; white-space: nowrap;
  -webkit-tap-highlight-color: transparent;
}
.pdfv-btn:active { background: rgba(255,255,255,0.1); }
.pdfv-sep { width: 1px; height: 20px; background: rgba(255,255,255,0.12); }
.pdfv-page-info { font-size: 13px; color: #8a919e; white-space: nowrap; }
.pdfv-scroll {
  flex: 1; overflow-y: auto; overflow-x: hidden;
  -webkit-overflow-scrolling: touch;
  display: flex; flex-direction: column; align-items: center;
  gap: 4px; padding: 8px 0;
}
.pdfv-page-slot {
  width: 100%; max-width: 100%;
  background: #2a2a2a;
  display: flex; align-items: center; justify-content: center;
  flex-shrink: 0;
}
.pdfv-canvas {
  display: block; max-width: 100%;
}
```

- [ ] **Step 2: 验证 CSS 无语法错误**

```bash
# 检查新增样式块存在
grep -c "pdfv-toolbar" public/styles.css
```

Expected: 输出 `1`

- [ ] **Step 3: Commit**

```bash
git add public/styles.css
git commit -m "style: add PDFViewer mobile toolbar and canvas styles"
```

---

### Task 4: 在 index.html 加载 app-pdf-viewer.js

**Covers:** [S3]

**Files:**
- Modify: `public/index.html:789`（在 app-theme.js 之前插入）

**Interfaces:**
- Consumes: 无
- Produces: `window.PDFViewer` 在 app-search.js 之前可用

- [ ] **Step 1: 插入 script 标签**

在 `public/index.html` 第 788 行（`app-pull-refresh.js` 之后）插入：

```html
<script src="/js/app-pdf-viewer.js"></script>
```

即修改后的脚本加载顺序为：

```html
<script src="/js/app-pull-refresh.js"></script>
<script src="/js/app-pdf-viewer.js"></script>
<script src="/js/app-theme.js"></script>
```

- [ ] **Step 2: Commit**

```bash
git add public/index.html
git commit -m "feat: load app-pdf-viewer.js in index.html"
```

---

### Task 5: 集成到 app-search.js 预览入口

**Covers:** [S5]

**Files:**
- Modify: `public/js/app-search.js:977-1003`（previewStandard 函数）

**Interfaces:**
- Consumes: `window.isMobile()`（app-mobile.js）、`window.PDFViewer`（app-pdf-viewer.js）、现有 `openPreviewOverlay`、`readApiResponse`、`API`
- Produces: 手机端预览走 PDFViewer canvas 渲染

- [ ] **Step 1: 修改 previewStandard 函数**

将 `previewStandard` 函数（第 977-1003 行）改为：

```javascript
async function previewStandard(id) {
  const r = findResultByAnyId ? findResultByAnyId(id) : results.find(x => x.id === id);
  if (!r) { showToast('未找到该标准', 'fail'); return; }
  const stdCode = r.standardNumber || '';
  if (!stdCode) { showToast('该结果缺少标准号，无法预览', 'fail'); return; }
  _previewLastId = id;

  // ── 手机端：PDF.js canvas 渲染 ──
  if (window.isMobile && window.PDFViewer) {
    await _previewMobile(id, stdCode, r);
    return;
  }

  // ── 桌面端：现有 iframe 路径（不变）──
  // 热路径：本地命中已知 → 直接跳新 tab
  const cachedFid = _libraryFileIds.get(id);
  if (cachedFid) {
    window.open(`${API}/api/preview/file/${encodeURIComponent(cachedFid)}`, '_blank');
    return;
  }

  // 冷路径：先在 click tick 里占一个 about:blank tab（popup blocker safe）
  let popup = null;
  try { popup = window.open('about:blank', '_blank'); } catch { /* blocked */ }

  if (popup && !popup.closed) {
    writePreviewLoadingPage(popup, stdCode);
    runPreviewWithPopup(id, stdCode, popup);
    return;
  }

  // 弹窗被拦 → fallback 走原 overlay 流程
  await runPreviewWithOverlay(id, stdCode, r);
}
```

- [ ] **Step 2: 添加 _previewMobile 函数**

在 `previewStandard` 函数之后（约第 1004 行前）插入：

```javascript
/**
 * 手机端预览：overlay 全屏 + PDF.js canvas 渲染。
 * 复用现有 overlay 壳和 request/poll 流程，替换内部渲染方式。
 */
async function _previewMobile(id, stdCode, r) {
  const title = stdCode + (r.title ? `  ${r.title}` : '');
  openPreviewOverlay(title);
  setPreviewBody('<div class="preview-loading">查询本地库…</div>');

  let viewer = null;
  const onClose = () => {
    if (viewer) { viewer.destroy(); viewer = null; }
    closePreviewOverlay();
  };

  // 替换 overlay 关闭按钮行为
  const closeBtn = document.getElementById('previewClose');
  if (closeBtn) {
    const oldHandler = closeBtn.onclick;
    closeBtn.onclick = (e) => { e.stopPropagation(); onClose(); };
  }

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
      if (data.fileId) { _libraryFileIds.set(id, data.fileId); applyLibraryDots(); }
      setPreviewBody(''); // 清空 loading
      viewer = new PDFViewer(document.getElementById('previewBody'), {
        url: `${API}${data.url}`,
        title,
        onDownload: onClose,
      });
      await viewer.load(`${API}${data.url}`);
    } else if (data.status === 'downloading' && data.taskId) {
      // 等待下载完成
      setPreviewBody('<div class="preview-loading">自动下载中…</div>');
      const pollRes = await _pollForMobile(data.taskId, stdCode);
      if (pollRes && pollRes.status === 'ready') {
        if (pollRes.fileId) { _libraryFileIds.set(id, pollRes.fileId); applyLibraryDots(); }
        setPreviewBody('');
        viewer = new PDFViewer(document.getElementById('previewBody'), {
          url: `${API}${pollRes.url}`,
          title,
          onDownload: onClose,
        });
        await viewer.load(`${API}${pollRes.url}`);
      } else {
        setPreviewBody('<div class="preview-empty"><div class="preview-empty-title">预览失败</div><div class="preview-empty-hint">自动下载超时，请稍后重试</div></div>');
      }
    } else {
      setPreviewBody(`<div class="preview-empty"><div class="preview-empty-title">预览失败</div><div class="preview-empty-hint">${escapeHtml(JSON.stringify(data))}</div></div>`);
    }
  } catch (e) {
    setPreviewBody(`<div class="preview-empty"><div class="preview-empty-title">预览失败</div><div class="preview-empty-hint">${escapeHtml(e?.message || String(e))}</div></div>`);
  }
}

/**
 * 手机端 poll — 简化版，只返回最终结果。
 */
function _pollForMobile(taskId, stdCode) {
  return new Promise((resolve) => {
    let attempts = 0;
    const maxAttempts = 200; // 200 * 1.5s = 5 min
    const ctrl = new AbortController();
    const poll = async () => {
      if (attempts++ >= maxAttempts) { ctrl.abort(); resolve(null); return; }
      try {
        const res = await fetch(`${API}/api/preview/task/${taskId}`, { signal: ctrl.signal });
        if (res.status === 404) { resolve(null); return; }
        const data = await readApiResponse(res);
        if (data.status === 'ready' || data.status === 'failed') { resolve(data); return; }
        setTimeout(poll, 1500);
      } catch { resolve(null); }
    };
    poll();
  });
}
```

- [ ] **Step 3: 验证语法**

```bash
node -c public/js/app-search.js
```

Expected: 无语法错误

- [ ] **Step 4: Commit**

```bash
git add public/js/app-search.js
git commit -m "feat: mobile preview entry uses PDFViewer canvas rendering"
```

---

### Task 6: 集成到 app-detail-utils.js 文件库预览

**Covers:** [S5]

**Files:**
- Modify: `public/js/app-detail-utils.js:927-930`（openLocalPreview 函数）

**Interfaces:**
- Consumes: `window.isMobile()`、`window.PDFViewer`、现有 `showPreviewOverlay` / `openPreviewOverlay`
- Produces: 手机端文件库预览走 PDFViewer

- [ ] **Step 1: 修改 openLocalPreview 函数**

将 `openLocalPreview` 函数（第 927-930 行）改为：

```javascript
function openLocalPreview(fileId) {
  // 手机端：overlay + PDF.js canvas 渲染
  if (window.isMobile && window.PDFViewer) {
    const overlay = document.getElementById('previewOverlay');
    const body = document.getElementById('previewBody');
    if (!overlay || !body) return;
    document.getElementById('previewTitle').textContent = '预览';
    overlay.classList.add('open');
    overlay.setAttribute('aria-hidden', 'false');
    body.innerHTML = '';
    const viewer = new PDFViewer(body, {
      url: `/api/preview/file/${fileId}`,
      onDownload: () => { viewer.destroy(); overlay.classList.remove('open'); overlay.setAttribute('aria-hidden', 'true'); },
    });
    viewer.load(`/api/preview/file/${fileId}`);
    return;
  }
  // 桌面端：新 tab 打开
  window.open(`/api/preview/file/${fileId}`, '_blank');
}
```

- [ ] **Step 2: 验证语法**

```bash
node -c public/js/app-detail-utils.js
```

Expected: 无语法错误

- [ ] **Step 3: Commit**

```bash
git add public/js/app-detail-utils.js
git commit -m "feat: mobile file library preview uses PDFViewer"
```

---

### Task 7: 端到端验证

**Covers:** [S7]

**Files:**
- 无新增/修改

- [ ] **Step 1: 启动开发服务器**

```bash
npm run dev
```

- [ ] **Step 2: 桌面端回归测试**

打开 `http://localhost:3000`，搜索一个标准，点击预览按钮：
- Expected: 走现有 iframe 路径（新 tab 或 overlay iframe），PDF 正常显示
- 确认 PDF.js 未被加载（DevTools Network 面板无 pdf.min.mjs 请求）

- [ ] **Step 3: 手机端模拟测试**

DevTools 切换到手机模拟模式（iPhone 14），搜索一个标准，点击预览：
- Expected: overlay 全屏打开，PDF.js canvas 渲染 PDF
- 工具栏显示：上一页 / 页码 / 下一页 / 缩放 / 下载 / 关闭
- 滚动翻页正常
- 缩放按钮正常

- [ ] **Step 4: 手势测试**

在手机模拟器或实机上：
- 双指 pinch 缩放正常
- 双击切换 fit-width
- 上下滚动翻页流畅

- [ ] **Step 5: 文件库预览测试**

手机端进入文件库 tab，点击一个 PDF 的预览按钮：
- Expected: overlay 打开，PDFViewer canvas 渲染
- 关闭按钮正常关闭 overlay

- [ ] **Step 6: 错误降级测试**

禁用 `public/vendor/pdf.min.mjs`（重命名文件），点击预览：
- Expected: PDF.js 加载失败，显示错误提示

恢复文件名。

- [ ] **Step 7: Final Commit**

```bash
git add -A
git commit -m "feat: mobile PDF preview via PDF.js canvas (iOS Safari compatible)"
```

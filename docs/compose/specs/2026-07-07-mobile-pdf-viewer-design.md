# 手机端 PDF 预览方案设计

> Spec 日期：2026-07-07
> 状态：待实现

---

## [S1] 问题

当前 PDF 预览统一使用 `<iframe>` 加载后端 `/api/preview/file/:id`，依赖浏览器内置 PDF 渲染器。手机端存在以下问题：

- **iOS Safari iframe 不渲染 PDF**：很多场景下直接弹下载或显示空白
- **无手势控制**：双指缩放被页面拦截，无法精确控制 PDF 缩放
- **无页面导航**：没有上/下页按钮、页码指示器
- **跨浏览器不一致**：Chrome Android 能渲染，iOS Safari 不行
- **内存问题**：大 PDF（100+ 页标准文件）在 iframe 内全量加载，手机容易 OOM

## [S2] 方案

渐进增强：桌面端保持 iframe 不变，手机端用 PDF.js canvas 逐页渲染。

### 方案选型

| 方案 | 优点 | 缺点 | 结论 |
|------|------|------|------|
| PDF.js Canvas | 全平台一致、内存可控、搜索开箱即用 | 需自行实现手势（~300行） | **采用** |
| PDF-A-go-go | 3行集成 | 需 Safari 17.4+、第三方库生态薄 | 不采用 |
| Google Drive Viewer | 1行集成 | 需公网URL、隐私风险、内网不可用 | 排除 |

### 渲染引擎

Mozilla PDF.js（npm: `pdfjs-dist`），Canvas 2D 逐页渲染。

## [S3] 架构

### 触发机制

```
用户点击「预览」
    │
    ├─ 桌面端（!isMobile）→ 现有 iframe 路径，不动
    │
    └─ 手机端（isMobile）→ 新路径：
         overlay 全屏 → PDF.js 加载 → canvas 渲染
```

判断依据：复用 `window.isMobile()`（app-mobile.js 已有）。

### PDF.js 加载策略

动态按需加载。手机端首次点预览时，动态创建 `<script>` 加载 `pdf.min.mjs` + `pdf.worker.min.mjs`（放 `public/vendor/`），后续复用全局 `window.pdfjsLib`。桌面端零开销。

### 文件变更清单

| 文件 | 变更类型 | 说明 |
|------|----------|------|
| `public/vendor/pdf.min.mjs` | 新增 | PDF.js 主库（~340KB） |
| `public/vendor/pdf.worker.min.mjs` | 新增 | PDF.js Worker（~570KB） |
| `public/js/app-pdf-viewer.js` | 新增 | 手机端 PDF 查看器组件（~500行） |
| `public/js/app-search.js` | 修改 | previewStandard 手机端分支（~30行） |
| `public/js/app-detail-utils.js` | 修改 | openLocalPreview 手机端分支（~15行） |
| `public/styles.css` | 修改 | PDFViewer 相关样式（~100行） |
| `public/index.html` | 修改 | 加载 app-pdf-viewer.js（1行） |

## [S4] PDFViewer 组件设计

### 类结构

```javascript
class PDFViewer {
  constructor(container, options)
  // container: DOM 元素（#previewBody）
  // options: { url, title, onDownload, onClose }

  async load(url)           // 加载 PDF，渲染第一页
  destroy()                 // 清理所有 canvas + 取消渲染任务
}
```

### 渲染策略

- **可视区域渲染**：只渲染当前页 ± buffer（前后各 1 页），其余页用占位 div 保持滚动高度
- **Canvas 尺寸**：`viewport.width/height × devicePixelRatio`，CSS 尺寸保持逻辑像素
- **HiDPI 适配**：`outputScale = window.devicePixelRatio || 1`，canvas 内部分辨率放大
- **页面切换**：离开视口的 canvas 销毁，进入视口的 canvas 创建（内存友好）

### 手势交互

| 手势 | 行为 |
|------|------|
| 双指 pinch | 缩放（0.5x ~ 5x），焦点锚定在双指中心 |
| 双击 | fit-width ↔ 2.5x 切换，中心点锚定 |
| 单指左右滑 | 翻页（单页模式） |
| 单指上下滑 | 滚动（连续模式）或翻页 |

### 视图模式

| 模式 | 场景 | 实现 |
|------|------|------|
| 连续滚动（默认） | 手机竖屏 | 所有页纵向排列，只渲染可视区域 |
| 单页翻页 | 大屏/横屏 | 每次显示一页，左右滑切换 |

### 底部工具栏

```
[◀ 上一页]  [12 / 85]  [下一页 ▶]    [🔍]  [缩放适宽]  [⬇ 下载]
```

- 页码可点击输入跳转
- 缩放：fit-width / fit-page / 100%
- 搜索：复用 PDF.js `PDFFindController`
- 下载：复用 `/api/preview/file/:id?attachment=1`

## [S5] 集成点

### previewStandard() 改动

`app-search.js` 的 `previewStandard(id)` 函数：

```javascript
// 现有逻辑
if (window.isMobile && window.PDFViewer) {
  // 手机端：overlay + PDF.js
  openOverlay();
  const url = await requestPreview(stdCode, year);
  new PDFViewer(previewBody, { url, title, onDownload }).load(url);
} else {
  // 桌面端：现有 popup / iframe 路径，不动
  existingPreviewLogic(id);
}
```

### openLocalPreview() 改动

`app-detail-utils.js`：

```javascript
function openLocalPreview(fileId) {
  if (window.isMobile && window.PDFViewer) {
    // 手机端：overlay + PDF.js
    showPreviewOverlay();
    new PDFViewer(previewBody, {
      url: `/api/preview/file/${fileId}`,
    }).load(url);
  } else {
    window.open(`/api/preview/file/${fileId}`, '_blank');
  }
}
```

### overlay 适配

现有 overlay 手机端已全屏（`100vw x 100vh`），只需微调：
- `.preview-head` 工具栏高度减小
- PDFViewer 内部工具栏替代现有预览操作按钮

## [S6] 错误处理

| 场景 | 处理 |
|------|------|
| PDF.js 加载失败 | 降级到 iframe（尝试浏览器原生渲染） |
| PDF 文件损坏/无法解析 | 显示错误提示 + 重试按钮 |
| 网络中断 | 显示加载失败 + 重试按钮 |
| 内存不足（大文件） | 按需渲染策略已缓解，极端情况显示警告 |

## [S7] 测试计划

| 测试项 | 方法 | 优先级 |
|--------|------|--------|
| iOS Safari PDF.js 正常渲染 | 实机 iPhone 测试 | P0 |
| Android Chrome 一致性 | 实机测试 | P0 |
| 大 PDF（200+ 页）内存 | 选大标准文件测试 | P0 |
| pinch-to-zoom 焦点锚定 | 双指缩放验证 | P1 |
| 翻页流畅度 | 快速连续翻页 | P1 |
| 搜索功能 | 关键词高亮验证 | P1 |
| 桌面端不受影响 | PC 浏览器验证 | P0 |
| 降级到 iframe | 禁用 JS 后验证 | P2 |

## [S8] 工作量估算

| 模块 | 行数 |
|------|------|
| app-pdf-viewer.js（新文件） | ~500 |
| app-search.js 集成 | ~30 |
| app-detail-utils.js 集成 | ~15 |
| styles.css 样式 | ~100 |
| index.html | 1 |
| **合计** | **~650** |

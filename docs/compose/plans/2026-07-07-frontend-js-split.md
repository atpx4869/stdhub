# 前端 JS 拆分 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use compose:subagent (recommended) or compose:execute to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 app-search.js（1678行）和 app-detail-utils.js（1518行）按功能拆分为更小的文件。

**Architecture:** 保持全局变量拼装模式，按功能内聚性提取为独立文件，调整 index.html 加载顺序。

**Tech Stack:** 原生 JS，无构建工具

## Global Constraints

- 所有函数保持全局作用域（function 声明式）
- 不引入 ES module
- 不改变任何功能行为
- 备份标签：`pre-js-split-2026-07-07`

---

### Task 1: 拆分 app-detail-utils.js → 4 个文件

**Covers:** [S2]

**Files:**
- Create: `public/js/app-ui-components.js`
- Create: `public/js/app-log.js`
- Create: `public/js/app-file-library.js`
- Modify: `public/js/app-detail-utils.js`（瘦身）

**Interfaces:**
- Produces: 全局函数 showToast/showConfirm/showPrompt/showConfirmHtml/addLog/updateLog/refreshFileLibrary 等

- [ ] **Step 1: 创建 app-ui-components.js**

从 app-detail-utils.js 中提取以下函数到 `public/js/app-ui-components.js`：
- `showToast` (约 L1083-1120)
- `showConfirmHtml` (约 L1122-1140)
- `showPrompt` (约 L1142-1160)
- `showConfirm` (约 L1162-1176)

用 IIFE 包裹，暴露到 window。

- [ ] **Step 2: 创建 app-log.js**

从 app-detail-utils.js 中提取运行日志子系统到 `public/js/app-log.js`：
- 日志相关状态变量（约 L256-280）
- `addLog`, `updateLog`, `hideSearchHistory`, `loadPersistedLogs` 等全部日志函数（约 L280-580）
- 末尾调用 `loadPersistedLogs()` 初始化

- [ ] **Step 3: 创建 app-file-library.js**

从 app-detail-utils.js 中提取文件库功能到 `public/js/app-file-library.js`：
- 文件库状态变量（约 L668-700）
- `refreshFileLibrary`, `renderFileLibrary`, `openLocalPreview`, `downloadLocalFile` 等全部文件库函数（约 L668-1081 + L1178-1410）
- 搜索历史和下载历史相关函数（约 L623-666）

- [ ] **Step 4: 瘦身 app-detail-utils.js**

保留：
- 详情弹窗（`showDetail` 等，约 L1-254）
- 工具函数（`escapeHtml`, `formatSize`, `triggerDownload`, `recordDownload` 等，约 L582-619）
- 键盘快捷键（约 L1475-1534）

- [ ] **Step 5: 更新 index.html 加载顺序**

在 index.html 中：
1. 在 app-settings.js 之后插入 `app-ui-components.js`
2. 在 app-ui-components.js 之后插入 `app-log.js`
3. 在 app-log.js 之后插入 `app-file-library.js`
4. 调整 app-detail-utils.js 的 version 参数

- [ ] **Step 6: 语法验证**

```bash
node -c public/js/app-ui-components.js
node -c public/js/app-log.js
node -c public/js/app-file-library.js
node -c public/js/app-detail-utils.js
```

- [ ] **Step 7: Commit**

```bash
git add public/js/app-ui-components.js public/js/app-log.js public/js/app-file-library.js public/js/app-detail-utils.js public/index.html
git commit -m "refactor: split app-detail-utils.js into 4 focused modules"
```

---

### Task 2: 拆分 app-search.js → 3 个文件

**Covers:** [S2]

**Files:**
- Create: `public/js/app-search-core.js`
- Create: `public/js/app-search-render.js`
- Create: `public/js/app-preview.js`
- Modify: `public/js/app-search.js`（删除已提取的代码）

**Interfaces:**
- Produces: 全局函数 doSearch/previewStandard/renderResults/updateToolbar 等

- [ ] **Step 1: 创建 app-search-core.js**

从 app-search.js 中提取到 `public/js/app-search-core.js`：
- 搜索模式切换（L1-17）
- 状态指示器（L19-32）
- 渲染调度（L34-53）
- 源标签初始化（L55-63）
- GBW 文本轮询（L65-134）
- 源进度条（L136-151）
- 核心搜索 `doSearch`（L153-264）
- 去重/排序辅助（L266-332）
- 输入监听器（L312-332）
- 右键菜单 + vim 导航（L1423-1555）
- 行状态辅助（L1557-1574）
- 工具栏（L1576-1678）

- [ ] **Step 2: 创建 app-search-render.js**

从 app-search.js 中提取到 `public/js/app-search-render.js`：
- 筛选条逻辑（L334-452）
- 渲染常量（L454-460）
- 本地库匹配（L462-560）
- 文本状态/可下载/可预览判断（L563-611）
- 卡片构建 `buildResultCardHtml`（L613-666）
- 渲染函数 `renderResults`, `appendNextResultsBatch`（L679-817）
- 委托事件（L819-863）

- [ ] **Step 3: 创建 app-preview.js**

从 app-search.js 中提取到 `public/js/app-preview.js`：
- 预览状态变量（L865-881）
- `pollPreviewTask`（L883-938）
- `renderPreviewFailedUi`（L939-965）
- `_pollForMobile`（L967-998）
- `_previewMobile`（L1000-1063）
- `previewStandard`（L1065-1098）
- 弹窗辅助（L1100-1158）
- 弹窗预览模式（L1160-1246）
- Overlay 预览模式（L1248-1366）
- 源选择器（L1368-1421）

- [ ] **Step 4: 清空 app-search.js**

将 app-search.js 替换为空壳（仅保留一行注释说明文件已拆分），或直接删除并在 index.html 中移除引用。

推荐保留空文件加注释，避免 git 历史断裂。

- [ ] **Step 5: 更新 index.html 加载顺序**

```html
<script src="/js/app-search-core.js"></script>
<script src="/js/app-search-render.js"></script>
<script src="/js/app-preview.js"></script>
```

移除原 `app-search.js` 的引用。

- [ ] **Step 6: 语法验证**

```bash
node -c public/js/app-search-core.js
node -c public/js/app-search-render.js
node -c public/js/app-preview.js
```

- [ ] **Step 7: Commit**

```bash
git add public/js/app-search-core.js public/js/app-search-render.js public/js/app-preview.js public/js/app-search.js public/index.html
git commit -m "refactor: split app-search.js into core, render, and preview modules"
```

---

### Task 3: 端到端验证

**Covers:** [S4]

- [ ] **Step 1: 启动开发服务器**

```bash
npm run dev
```

- [ ] **Step 2: 验证搜索功能**

搜索一个标准，确认结果正常显示、筛选条正常、下载按钮正常。

- [ ] **Step 3: 验证预览功能**

点击预览按钮，确认 overlay 正常打开、PDF 加载正常。

- [ ] **Step 4: 验证文件库**

切换到文件库 tab，确认文件列表正常、操作按钮正常。

- [ ] **Step 5: 验证日志**

切换到日志 tab，确认日志显示正常。

- [ ] **Step 6: 验证控制台无报错**

打开 DevTools Console，确认无 JS 错误。

- [ ] **Step 7: Final Commit**

```bash
git add -A
git commit -m "refactor: complete frontend JS module split"
```

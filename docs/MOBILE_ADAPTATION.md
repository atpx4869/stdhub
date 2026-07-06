# 手机端适配 & PWA 改造技术文档

> 目标：让局域网 Web 入口（`http://<lan-ip>:5937/`）在手机浏览器上像 app 一样能用。
>
> 范围：**只覆盖手机端的"标准检索"和"资质查询/可视化"**。其他功能默认隐藏。需要桌面布局调试可走 `?desktop=1` URL 参数（开发者逃生口，无 UI 入口）。

> **注:文档中以下历史段落已过期**:`toggleDesktopLayout` / "我"页"切换到完整版"按钮 / localStorage `bzxz.layout` 切换布局 —— 这套功能已下线(切到 desktop 后切不回的设计 bug,用户反馈),只保留 `?desktop=1` URL 逃生口。下文相关章节未逐行重写,以 `app-mobile.js` 与 `public/index.html` 代码为准。

---

## 0. 阅读须知

- 本文是实现指南，不是最终代码。CSS 类名、DOM ID、断点值、文件路径都是建议，可在落地时按现状微调，但**保持语义对齐**。
- 遵守 `CLAUDE.md`：改代码同步改文档；不本地跑 `npm run build`，靠静态核查 + push 后看 Actions。
- 默认端口 **5937 固定**，`start_url` 和二维码都基于这个端口。

### 0.1 关键决策（2026-05-25 定稿）

1. **仅 HTTP（内网场景）**——不上 HTTPS，不做 mkcert 自签。直接结果：**Service Worker 不能注册**（iOS Safari / Chrome Android 都要求 https 或 localhost origin），所以**离线缓存、SW 更新提示、网络拦截全部不做**。PWA 三大支柱（Manifest / SW / HTTPS）只保留 Manifest 一支。文档第 6 节是 manifest-only 方案，不要装 `vite-plugin-pwa`。
2. **手机模式 sidebar 完全隐藏**——不沿用旧的"60px 窄边栏"折叠方案。底部 tab bar 是唯一一级导航。所有 `.sidebar` / `--sidebar-w` 相关规则在 ≤640px 块里要清除。
3. **URL 路由顺带补全**——现状 `initRouter()` 是一行 stub，借这次改造把 `?tab=xxx` / `?desktop=1` 路由做完整。这是 Phase 0 的前置工作。

本节是后续所有章节的前提，与文档原稿冲突时**以本节为准**。

---

## 1. 现状梳理（落笔前必读）

### 入口与构建（2026-05-25 校准）
- **真实入口**：`public/index.html`，由 Express `app.use(express.static(...))` 直接服务（`src/api/app.ts`），**没有构建步骤、没有 Vite**。
- `web/` 目录是规划骨架：`web/src/main.ts` 里 import 了 20+ 个不存在的模块（`@/modules/admin/users`、`@/modules/ui/toast` 等），并没有 `vite.config` / `web:build` 脚本，**当前未被打包也未被服务**。本次改造**全部落在 `public/`** 上，未来 `web/` 接通时再迁移。
- Legacy 业务 JS：`public/js/{app-core,app-search,app-download,app-qual,app-settings,app-detail-utils,app-complete,app-announcements,app-auth-admin}.js`，共 ~5690 行。**不要重构它们**，只在外层加适配 + guard。
- 本次新建：`public/js/app-mobile.js`（手机布局与底部 tabbar 路由）。

### 样式
- 单文件 `public/styles.css` ~1170 行，所有规则。`web/src/styles/*` 是规划稿，不被加载。
- 现有响应式：`public/styles.css` 内有 1100/900/640 三档 `@media` 块。**≤640px 块已被本次 Phase 1 重写**（旧版"sidebar 折叠为 60px 窄条"已删除），现状是「sidebar `display: none` + 底部 mobile-tabbar + content 让出 72px 底部 + result-card 单列 + 大量 `body:not(.force-desktop)` 包裹规则」。
- 已有的 900px 规则：结果卡 7 列网格折单列、settings 三列折单列、source-health-strip 隐藏。**手机改造不动 900px 块**，只重写 ≤640px 那段。
- 调色板隔离：announcement / admin 相关样式（在 `public/styles.css` 内部）用亮色 —— 涉及这两页时保持具体色值不要换 `var(--*)`。

### 桌面端电源开关
- `electron/main.ts` 已有 `DEFAULT_PREFERRED_PORT = 5937`、`webServiceEnabled` 开关、`getLanIps()`、IPC `bzxz:get-web-access-info` 返回 `{ port, bindHost, webServiceEnabled, localUrl, lanUrls, primaryUrl, firewallHint }`。
- 改造不动主进程逻辑，只在**设置页 UI**加"手机访问"展示区，二维码 + 地址来自 `getWebAccessInfo()`。

### 现存 tab 系统（Phase 0 后状态）
- Sidebar 按钮：`<button class="sidebar-item" data-tab="search|batch|complete|qual|local|history|settings|users|stats">`
- 新增 mobile-tabbar：`<nav class="mobile-tabbar" id="mobileTabbar">` 含 search / qual / me 三个 `.mobile-tab[data-tab]` 按钮。
- 切换函数：`switchTab(tabId)`，仍在 **legacy `public/js/app-core.js`**。Phase 0 末尾追加：
  1. `URLSearchParams` 写回 `?tab=…`（保留 `?desktop=1` 等其他参数）
  2. `dispatchEvent(new CustomEvent('tabchange', { detail: { tab } }))` 供 mobile-tabbar 等订阅同步
  3. `'me'` 与 `'users'` 一样跳过 `allowedTabs` 检查（每个登录态都有 me 入口）
- 历史路由：`initRouter()` 现在解析 `?tab=xxx`（白名单校验），缺省 `search`；`window` 监听 `popstate` 重新进路由。
- 桌面/手机切换：`window.toggleDesktopLayout()`（`app-mobile.js`）写 `localStorage['bzxz.layout']`，配合 URL `?desktop=1` 是逃生口。

---

## 2. 总体设计原则

1. **CSS-only 收敛**：手机布局优先用媒体查询隐藏/重排桌面 DOM，不复制一套手机专属 DOM。原因：DOM 重复 = 状态双写 = 不可维护。
2. **桌面 0 视觉回归**：所有改动包裹在 `@media (max-width: 640px)`（或更精确的）里，桌面端 CSS specificity 不变。
3. **逃生口**：URL `?desktop=1` 或 localStorage `bzxz.layout = 'desktop'` 强制桌面布局，绕过手机收敛。
4. **PWA 仅 manifest**：HTTP 内网决定了不能注册 SW（§0.1 决策 1），所以只做"添加到主屏"+独立窗口+图标。要解锁离线/Push 必须先转 HTTPS，留给后续 Phase。
5. **遵守 CLAUDE.md 的 CSS 迁移契约**：不删 `public/styles.css`，新增手机规则放 `web/src/styles/responsive.css` 末尾或单开 `responsive/mobile.css`。

---

## 3. 断点 & 布局策略

```
≤ 640px   手机（核心改造目标）
641-1024  平板（沿用现有 900px 规则，不新增）
> 1024    桌面（不动）
```

**为什么 640 而不是 768**：iPhone 14 Pro 横屏 852pt、竖屏 393pt；640 能精准覆盖竖屏，不误伤平板竖屏。

**body 状态类**：
- 默认无 class
- URL 或 localStorage 触发"完整版" → `<body class="force-desktop">`，所有 `@media (max-width: 640px)` 规则需被 `body:not(.force-desktop)` 包裹

---

## 4. 文件改动清单（Phase 0+1 实际落地，2026-05-25）

> 注：原文档列的 `web/src/modules/mobile/*` / `web/src/styles/*` 路径作废 —— 见 §1。所有手机改造落在 `public/`。

| 文件 | 操作 | Phase | 内容 |
|---|---|---|---|
| `public/js/app-core.js` | 改 | **0 ✅** | `switchTab` 末尾追加 URL 写回 + `tabchange` 事件；`'me'` 跳过 `allowedTabs` 检查；`initRouter` 改为读 `?tab=`；新增 `popstate` 监听 |
| `public/js/app-mobile.js` | **新建** | **1 ✅** | 视口检测 / `applyLayoutMode` / `installMobileTabbar` / `toggleDesktopLayout` / `isMobile`，全部挂 `window` |
| `public/index.html` | 改 | **1 ✅** | 末尾新增 `<nav class="mobile-tabbar">` + `<div id="page-me">` 页；`<script src="/js/app-mobile.js">` |
| `public/styles.css` | 改 | **1 ✅** | 重写 `@media (max-width:640px)` 块：sidebar 隐藏 + content 留 72px + result-card 单列 + 全部规则用 `body:not(.force-desktop)` 包裹；追加 `.mobile-tabbar` / `.mobile-tab` / `.me-section` / `.me-row` 基础样式 |
| `public/js/app-search.js` | 改 | **1 ✅** | 全局 keydown handler 入口加 `if (window.isMobile()) return;`（j/k/g/G/x/d/s 快捷键手机端禁用） |
| `public/js/app-qual.js` | 改 | **1 ✅** | `switchQualTab(tab)` 入口：手机模式强制 `tab='visual'`（搜索子标签 UI 不可用） |
| `public/js/app-auth-admin.js` | 改 | **1 ✅** | `onAuthReady()` 填充 `meUserName/meUserRole/meLogoutBtn`，按 `role` 控制 `meRowStats/meRowUsers` 可见性；`TAB_LABELS` 加 `me:'我'` |

**Phase 2 部分落地（2026-05-25）：**

| 文件 | 操作 | Phase | 内容 |
|---|---|---|---|
| `public/styles.css` | 改 | **2 ✅** | `≤640px` 块内追加可视化页样式：stats 2×2 网格、`.qual-visual-card.collapsed` 折叠态、`.qual-visual-lab-head` sticky、cap 行 44px 触控热区、more 按钮加大 |
| `public/index.html` | 改 | **2 ✅** | 输入 section 加 `id="qualVisualInputCard"`；h3 加 `onclick="expandQualVisualInput()"` |
| `public/js/app-qual.js` | 改 | **2 ✅** | `doQualBatchVisual` 成功后在手机模式给输入卡加 `.collapsed`；新增 `expandQualVisualInput()` 回展开 |

**Phase 2 待做（推迟，复杂度较高）：**

| 文件 | 操作 | Phase | 内容 |
|---|---|---|---|
| `public/js/app-qual.js` | 改 | 2.1 | 统计卡 click 下钻（命中/CNAS/CMA/过期 过滤当前结果） |
| `public/styles.css` + `app-qual.js` | 改 | 2.2 | 同步进度 banner（管理员可见、轮询现有 sync-logs） |

**Phase 3 落地（2026-05-25）：**

| 文件 | 操作 | Phase | 内容 |
|---|---|---|---|
| `public/icon-192.png` / `icon-512.png` / `icon-maskable-512.png` / `apple-touch-icon.png` | **新建** | **3 ✅** | 从 `logo.png` 衍生：192/512 透明缩放、maskable 走 80% 安全区 + #0f1117 深色画布、apple 180px |
| `public/manifest.webmanifest` | **新建** | **3 ✅** | name/short_name/start_url=/?from=pwa/display=standalone/theme_color=#0f1117 + 3 icons |
| `public/index.html` | 改 | **3 ✅** | `<head>` 加 `<link rel="manifest">` + theme-color + 4 个 apple meta + apple-touch-icon |

**Phase 4 部分落地（2026-05-25）：**

| 文件 | 操作 | Phase | 内容 |
|---|---|---|---|
| `public/js/app-settings.js` | 改 | **4 ✅** | `renderWebAccessCard()` 给内网 URL 行加「📱 手机版」徽章；卡片底部增加「📱 手机访问」灰提示框（Wi-Fi 同网 + 添加到主屏指引 + HTTP 无离线缓存说明） |
| `public/styles.css` | 改 | **4 ✅** | `.web-access-phone-hint` 徽章 / `.web-access-phone-tip` 提示框样式 |

> **桌面端原有能力**（URL 列表、复制、打开、`webServiceEnabled` 开关、端口 fallback 红字提示）在 `web-access-card` + `renderPortSettingCard` 内**早已实装**，Phase 4 只做手机使用场景的可见性增强。
>
> **二维码方案废弃**：原文档 §5.6 / §8 提到的 QR 生成永久不做。手动输 IP 或复制按钮已够用，引入 vendored QR 库（~20KB + 加密器代码）收益不成正比。文档中保留 §8 仅供历史参考。
| `public/manifest.webmanifest` | **新建** | 3 | PWA manifest（manifest-only，详见 §6） |
| `public/icon-{192,512,maskable-512}.png` + `apple-touch-icon.png` | **新建** | 3 | PWA 图标，从 logo.png 衍生 |
| `public/index.html` | 改 | 3 | `<head>` 加 `manifest` link + 5 个 apple meta + theme-color |
| `public/js/app-settings.js` | 改 | 4 | 设置页"手机访问"区块 + 二维码（用 `qrcode-generator`，详见 §8） |
| `README.md` | 改 | 5 | 加"手机访问"小节、提到 5937 端口 + URL 路由 |
| `DEVELOPMENT.md` | 改 | 5 | 加"手机调试"小节，标注键盘快捷键桌面专属 |
| `CHANGELOG.md` | 改 | 5 | "手机端 + PWA" 条目 |

**永远不会动：** `electron/main.ts`（端口/LAN 逻辑就绪）、后端任何代码。

---

## 5. UI 规范详解

### 5.1 顶部 Topbar（手机版）

桌面 topbar 高 48px，含 sidebar toggle、品牌、source-health-strip、下载中心、统计、用户。

手机版（≤640px）：
- 高度 56px（拇指可够）
- 隐藏：sidebar toggle（sidebar 整个不显示，toggle 也跟着隐藏）、source-health-strip（已有规则）、下载中心数字（移到下载完成 toast）、统计按钮
- 保留：品牌缩短为 logo + "标准盒子"（隐藏副标题 `StandardsBox`）、用户头像
- 搜索框**不在 topbar**，下移到内容区顶部 sticky

### 5.2 底部 Tab Bar（新建）

DOM 位置：`</body>` 前。**手机模式下 sidebar 完全 `display: none`**（不沿用旧的 60px 折叠方案，详见 §0.1 决策 2），底部 tab bar 是唯一一级导航。

```html
<nav class="mobile-tabbar" role="tablist" aria-label="主导航">
  <button class="mobile-tab" data-tab="search" aria-selected="true">
    <span class="mobile-tab-icon">🔍</span>
    <span class="mobile-tab-label">标准</span>
  </button>
  <button class="mobile-tab" data-tab="qual">
    <span class="mobile-tab-icon">📋</span>
    <span class="mobile-tab-label">资质</span>
  </button>
  <button class="mobile-tab" data-tab="me">
    <span class="mobile-tab-icon">👤</span>
    <span class="mobile-tab-label">我</span>
  </button>
</nav>
```

CSS 要点（`mobile-tabbar.css`）：
- `position: fixed; bottom: 0; left: 0; right: 0; height: 56px;`
- `padding-bottom: env(safe-area-inset-bottom);`
- 背景沿用 `theme/glass.css` 的玻璃拟态变量
- active 态用现有 sidebar 渐变 active 配色（CLAUDE.md：主题统一）
- 默认 `display: none;`，仅 `@media (max-width: 640px) body:not(.force-desktop)` 显示
- 显示时给 `.content` `padding-bottom: calc(56px + env(safe-area-inset-bottom));`

**Tab 与桌面 tab 映射**：
- `mobile-tab[data-tab=search]` → `switchTab('search')`
- `mobile-tab[data-tab=qual]` → `switchTab('qual')`
- `mobile-tab[data-tab=me]` → `switchTab('me')`（**新 tab**，下文 5.5）

**点击逻辑**（`web/src/modules/mobile/layout.ts`）：
- 监听 `click`，调用现有 `switchTab()`，同步 `data-tab` aria-selected
- 监听 `popstate` / `tabchange` 自定义事件保持高亮

### 5.3 "我"页（新建轻量 tab）

不新增 sidebar 项，仅 mobile-tabbar 入口。桌面访问 `?tab=me` 等价于 `?tab=settings`。

内容（纯静态 HTML + 几个 click 处理）：
```
┌─────────────────────────┐
│ 👤 用户名               │
│    [登出]               │
├─────────────────────────┤
│ ⚙ 设置                  │  → switchTab('settings')
│ 📊 使用统计              │  → switchTab('stats')（按权限）
│ 📢 公告                 │  → 公告弹窗
├─────────────────────────┤
│ ☰ 切换到完整版           │  → toggleDesktopLayout()
├─────────────────────────┤
│ v1.0.xxx · 🟢 在线      │
└─────────────────────────┘
```

实现：在 `web/index.html` 加 `<section id="me-tab" class="tab-content" style="display:none">…</section>`，被 `switchTab('me')` 显示。

### 5.4 标准检索手机版

#### 5.4.1 顶部搜索区（sticky）

```html
<div class="search-mobile-bar"> <!-- 仅 ≤640px 显示 -->
  <input class="search-mobile-input" placeholder="搜索标准号或关键词" inputmode="search">
  <button class="search-mobile-clear" aria-label="清除">×</button>
</div>
<div class="search-mobile-chips"> <!-- 横滑源筛选 -->
  <button class="chip active" data-source="all">全部</button>
  <button class="chip" data-source="bz">BZ</button>
  <button class="chip" data-source="gbw">BW</button>
  <button class="chip" data-source="by">BY</button>
</div>
<div class="source-progress-mobile"> <!-- 复用现有 progress-strip 样式 -->
  <span class="bar"></span>
  <span class="label">搜索 2/3 源</span>
</div>
```

CSS：
- `position: sticky; top: 56px; z-index: 5;`（topbar 之下）
- 背景同 topbar 玻璃拟态
- input `font-size: 16px;`（**关键**，防 iOS 缩放）
- chips 容器 `overflow-x: auto; scroll-snap-type: x mandatory;`，每个 chip `scroll-snap-align: start;`
- 桌面端这块 `display: none;`

#### 5.4.2 搜索历史 / 收藏浮层

聚焦 input 时显示，输入字符后隐藏。

```html
<div class="search-mobile-suggest" hidden>
  <h4>最近</h4>
  <div class="chip-row">…</div>
  <h4>收藏</h4>
  <div class="chip-row">…</div>
  <button class="link">清空历史</button>
</div>
```

交互：
- input `focus` → `hidden = false`
- input `input`（有值）→ `hidden = true`
- input `blur` 延迟 200ms 后 `hidden = true`（让 chip 点击先触发）
- chip 点击 → 写回 input + 触发现有搜索

数据源：复用现有 `searchHistory` / `savedStandards`（在 `web/src/lib/state.ts`）。

#### 5.4.3 结果卡片

桌面卡片现有结构（来自 `result-card.css`）：7 列 grid（checkbox / id / body / state / source-line / date / actions）。

900px 已经折单列。手机 ≤640px **追加**：
- **隐藏 `.card-checkbox`**（批量勾选下线）
- **隐藏 `.results-table-head`**（已隐藏）
- **隐藏批量操作栏**（`.batch-toolbar` 或同等）
- **`.card-actions` 重排**：主下载按钮放右下，最小尺寸 `min-width: 44px; min-height: 44px;`
- **`.card-id` 字号略增**到 16px，加粗
- **`.card-body` 标题最多 2 行**：`display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;`
- **资质徽章**（CMA/CNAS）和文本可用 tri-state 合并到一行 `.card-meta`，gap 8px

#### 5.4.4 状态分组

桌面已有 `.result-group` + `.result-group-head` 可折叠。手机：
- `.result-group-head` 改 sticky：`position: sticky; top: <搜索区高度>; z-index: 4;`
- 折叠状态延用 localStorage 持久化逻辑（来自 `app-search.js`）
- 不要动后端、不要动分组算法

#### 5.4.5 详情页

桌面是 modal。手机 ≤640px：
- modal 改成全屏 `position: fixed; inset: 0;`
- 左上角返回箭头（点击 = 现有关闭逻辑）
- 底部 sticky 下载主按钮 + 安全区 padding
- 复用 `web/src/modules/detail/render.ts` 的 `renderDetailModal`，外层 CSS 切换即可

#### 5.4.6 右键菜单 → 长按

桌面 `web/src/styles/components/context-menu.css` 是右键菜单。手机：
- 卡片监听 `touchstart` 计时 + `touchend` 取消 + `touchmove` 取消
- 600ms 触发振动反馈（`navigator.vibrate(50)`，可选）+ 显示同一个 context-menu
- 菜单项：复制编号、复制标题、查看详情、⭐ 收藏 / 取消收藏
- 实现位置：`web/src/modules/mobile/layout.ts` 加 `installLongPressHandler()`

#### 5.4.7 下载反馈

桌面：批量进度条 + 行级 spinner。手机：
- 无批量进度条
- 单条下载：卡片就地 spinner（沿用 `result-card.css` 的 `.btn-spinner`）+ 成功/失败闪烁
- 完成后：现有 `showToast` 在底部 tab 上方弹出（要给 toast 加 `bottom: calc(56px + env(safe-area-inset-bottom) + 12px);` 的手机覆盖）

### 5.5 资质查询手机版（**搜索 + 可视化 双子标签可用**）

> ⚠️ 与初版规划不同：初版要"只保留可视化"，实操发现按钮还在却不响应反而坑用户，
> 已在 1.0.139 改回两个子标签都可用（`app-qual.js:switchQualTab` 去掉强制重定向）。
> 订阅管理 / 同步日志 仍在「系统设置」（已迁移完成）。

#### 5.5.1 子标签布局

桌面 `qualifications.css` 渲染 2 子标签（搜索 / 可视化），订阅管理 / 同步日志 移至系统设置。

手机 ≤640px：
- 两个子标签都点得动（`switchQualTab('search')` / `switchQualTab('visual')`）
- 默认进入「搜索」，可视化作为可选视图
- 子标签栏不再有"订阅管理与同步日志已移至系统设置"提示（已删，提示完成历史使命）

#### 5.5.2 输入区折叠

可视化页桌面是"多行 textarea + 查询按钮"。手机：

**未查询前**：
```html
<div class="qual-mobile-input">
  <textarea placeholder="每行一个标准号或关键词" rows="4"></textarea>
  <button class="primary">查询</button>
</div>
```

**已查询后**自动收起为一行摘要：
```html
<div class="qual-mobile-input collapsed" data-query="GB/T 23440-2009, HJ 535, ...">
  <span>已查询 3 项 · GB/T 23440-2009 …</span>
  <button class="link">修改</button>
</div>
```

点"修改"展开回 textarea。状态用 JS 类切换，CSS 控制 `.collapsed` 形态。

#### 5.5.3 统计面板

桌面已有"命中 / 能力 / 过期"三个统计数字。手机：
- 横排 3 个等宽卡片
- 每个卡片可点击 → 下钻到对应筛选（命中按钮筛全部；过期按钮只看过期；能力按钮回全部）
- 高度 64px，数字大字（24px）

#### 5.5.4 标准号聚合卡片

桌面是横向并排 CMA/CNAS 两列。手机彻底改：

```
┌─────────────────────────────┐
│ 🏷 GB/T 23440-2009          │  ← sticky 分组头
│    CNAS 5 · CMA 8           │
│    [展开 ▼]                 │
├─────────────────────────────┤
│   ▼ CNAS                    │
│     • 实验室A               │
│       注册编号 / 有效期     │
│       [📋 复制] [详情]      │
│     • 实验室B …              │
│                             │
│   ▼ CMA                     │
│     • 机构C …                │
└─────────────────────────────┘
```

CSS：
- `.qual-std-group-head` sticky 在搜索区下方
- CNAS / CMA 内部分段折叠（默认 CNAS 展开，CMA 收起 —— 或两者都展开看数据量再定）
- 单条机构卡片高度 ≥64px，长按弹复制菜单

#### 5.5.5 同步进度提示

仅管理员可见。在可视化页**顶部**条件性渲染：
```html
<div class="qual-sync-banner" hidden>
  ↻ <span class="src">CNAS</span> 同步中 <span class="progress">2541/6521</span> (<span class="percent">39%</span>)
</div>
```

数据：复用现有 2 秒轮询拉 `/api/cnas/sync-logs` / `/api/cma/sync-logs` 的逻辑。轮询代码不动，UI 多一处订阅即可。

#### 5.5.6 空态 & 加载

- 输入框空 + 未查询 → 引导文案"粘贴 Excel 标准号列表，按换行分隔"
- 查询中 → 现有 skeleton + 顶部进度条
- 无结果 → "没有匹配的资质能力。检查标准号是否完整。"

### 5.6 设置页"手机访问"区块（桌面端）

在 `app-settings.js` 渲染的设置页加一节：

```
┌─────────────────────────────┐
│ 手机访问                    │
├─────────────────────────────┤
│ 在同一局域网下扫码或输入：  │
│ http://192.168.1.X:5937     │
│ [QR Code 200×200]           │
│ [复制地址]                  │
│ LAN 访问：[开启] / [关闭]    │
└─────────────────────────────┘
```

实现要点：
- 地址来自 `/api/desktop/access-info`（如已存在则复用，否则加一个 endpoint 暴露 `lanUrls[0]`）
- 二维码用纯 JS 生成（`qrcode-svg` 或手写 SVG），不引外部 CDN
- LAN 开关复用现有 `webServiceEnabled` 设置
- 端口 fallback 时**用红字提示**："默认端口 5937 被占用，本次使用 XXXX。已加到主屏的手机端需要重新扫码。"

---

## 6. PWA 改造（manifest-only）

> 决策见 §0.1：仅 HTTP 内网 → Service Worker **不能注册**（iOS Safari / Chrome Android 都要求 https 或 localhost origin）。所以离线缓存、SW 更新提示、网络拦截、Web Push **全部不做**。本节只保留 manifest 一支。

### 6.1 Manifest

新建 `web/public/manifest.webmanifest`：

```json
{
  "name": "标准盒子",
  "short_name": "标准盒子",
  "description": "多源标准检索与资质能力验证",
  "start_url": "/?from=pwa",
  "scope": "/",
  "display": "standalone",
  "orientation": "portrait",
  "theme_color": "#0f1117",
  "background_color": "#0f1117",
  "lang": "zh-CN",
  "icons": [
    { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png" },
    { "src": "/icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ]
}
```

`web/index.html` 加：
```html
<link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="#0f1117">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="标准盒子">
<link rel="apple-touch-icon" href="/icon-192.png">
```

**注意**：图标三个 PNG（外加一个 apple-touch-icon）放 `web/public/`，Vite 默认会复制到根。手工从 `logo.png` 衍生即可。

### 6.2 manifest-only 模式下能做什么、不能做什么

**能做（manifest 提供的）：**
- iOS Safari「添加到主屏」/ Android Chrome「添加到主屏」生成独立窗口图标
- `display: standalone` 去掉浏览器 UI（地址栏、底栏）
- `theme_color` 控制状态栏配色
- `start_url` 指定打开后的入口
- 图标、品牌、横竖屏方向

**不能做（需要 SW / HTTPS）：**
- 离线访问（HTTP 无 SW 注册）
- 弱网缓存命中加速
- 应用更新提示（manifest 没有版本概念，新版本要靠用户手动刷新）
- Android Chrome 的「安装应用」按钮（需要 SW + HTTPS 才会出现；HTTP 只有「添加到主屏」）
- Web Push 通知
- Background Sync

这套限制是 **HTTP 内网部署的根本约束**，不是配置问题。要解锁这些能力，前置工作是先把局域网接入做成 HTTPS（mkcert 自签 + 用户手动信任），详见 §13。

### 6.3 不要装的依赖

明确**不要**安装：
- `vite-plugin-pwa`
- `workbox-window` / `workbox-*`
- 任何 SW 注册脚本

`web/src/modules/mobile/pwa.ts` 这个文件**不要新建**（之前的 §4 表已删除）。

如果未来转 HTTPS，再装 `vite-plugin-pwa` + 写 SW，那一波算独立的"PWA Phase 2"，不在本次范围。

---

## 7. JS 逻辑改动

### 7.1 视口检测 & 模式切换（`web/src/modules/mobile/layout.ts`）

```ts
const MOBILE_BP = 640;
const STORAGE_KEY = 'bzxz.layout';

export function getLayoutMode(): 'mobile' | 'desktop' {
  // URL 强制
  const urlForce = new URLSearchParams(location.search).get('desktop');
  if (urlForce === '1') return 'desktop';

  // localStorage 强制
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === 'desktop') return 'desktop';

  // 视口判断
  return window.matchMedia(`(max-width: ${MOBILE_BP}px)`).matches ? 'mobile' : 'desktop';
}

export function applyLayoutMode(): void {
  const mode = getLayoutMode();
  document.body.classList.toggle('force-desktop', mode === 'desktop' && window.matchMedia(`(max-width: ${MOBILE_BP}px)`).matches);
  document.body.classList.toggle('layout-mobile', mode === 'mobile');
}

export function toggleDesktopLayout(): void {
  const next = localStorage.getItem(STORAGE_KEY) === 'desktop' ? 'mobile' : 'desktop';
  localStorage.setItem(STORAGE_KEY, next);
  applyLayoutMode();
}

export function isMobile(): boolean {
  return document.body.classList.contains('layout-mobile');
}

window.addEventListener('resize', applyLayoutMode);
applyLayoutMode();
```

挂到 `window.isMobile` 让 legacy `app-qual.js` 等可用。

**关于 URL 路由（Phase 0 前置工作）**：现状 `initRouter()` 是一行 stub `function initRouter() { switchTab("search"); }`，**不读 URL**。本次要把它扩成完整解析：

```ts
// 替换 legacy app-core.js 的 initRouter() stub（或在 web/src/modules/tabs.ts 重写后注入 window）
function initRouter() {
  const params = new URLSearchParams(location.search);
  const tab = params.get('tab') || 'search';
  // ?desktop=1 在 getLayoutMode() 已处理
  switchTab(tab);
}
window.addEventListener('popstate', initRouter);
```

并改 `switchTab(tabId)`：切 tab 时 `history.replaceState(null, '', \`?tab=${tabId}\`)`，同时派发 `tabchange` 事件供 mobile-tabbar 监听。这是新写，不是扩展。

### 7.2 底部 tab 路由

```ts
export function installMobileTabbar(): void {
  document.querySelectorAll('.mobile-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = (btn as HTMLElement).dataset.tab!;
      (window as any).switchTab(tab);
    });
  });

  // 监听 switchTab 后同步 active
  window.addEventListener('tabchange', (e: any) => {
    document.querySelectorAll('.mobile-tab').forEach((btn) => {
      const b = btn as HTMLElement;
      b.classList.toggle('active', b.dataset.tab === e.detail.tab);
    });
  });
}
```

需要在 legacy `app-core.js` 的 `switchTab()` 末尾派发 `tabchange` 自定义事件，或者由 `web/src/modules/tabs.ts` 的包装函数派发（Phase 0 工作的一部分）。

### 7.3 Legacy JS 改动

**`app-search.js`**：
- 文件头加 `const _isMobile = () => window.isMobile?.() ?? false;`
- 批量勾选相关函数入口 `if (_isMobile()) return;`
- 键盘快捷键（`j`/`k`/`g g`/`G` 等）入口同样判断
- 不要删任何代码，只加 guard

**`app-qual.js`**：
- 子标签切换函数 `switchQualSubtab()` 加 `if (_isMobile()) { renderVisual(); return; }`
- 订阅管理 / 同步日志的 render 入口加 guard

**`app-settings.js`**：
- 加渲染"手机访问"区块的函数 + 二维码生成
- 桌面才显示这一节（管理员或所有用户均可见，按团队习惯定）

---

## 8. 二维码方案

不引外部库（CDN 不可靠 + 离线场景）。选项：

**A. 内嵌 SVG 生成器**（推荐）：`qrcode-generator`（npm，~10KB）或手写。
**B. 服务端生成**：加 endpoint `/api/desktop/qr?text=...` 返回 SVG。

建议 A，前端纯静态、易测试。

---

## 9. 测试 & 验证清单

### 9.1 静态核查（impl 完成后必跑）

- `web/src/main.ts` 是否正确 import 新模块
- `web/index.html` 中 `manifest.webmanifest`、`apple-touch-icon` 路径
- `mobile-tabbar.css` 是否被 `index.css` 导入（cascade 位置：在 `responsive.css` 之前或之后都行，但要在 `theme/glass.css` 之前）
- 所有 ≤640px 规则是否包裹 `body:not(.force-desktop)`
- legacy JS 的 guard 是否一致使用 `window.isMobile?.()`

### 9.2 桌面端回归

- 1920×1080 / 1440×900 两个常见尺寸截图，对比改造前后无视觉变化
- sidebar 仍可用、键盘快捷键仍可用、批量下载仍可用
- 设置页"手机访问"区块二维码可见、地址正确

### 9.3 手机端验证（DevTools 模拟）

设备：iPhone 14 Pro / Pixel 7 / iPad mini（竖屏）

- 顶部搜索 sticky，input focus 不缩放
- 底部 tab 切换正常，active 高亮跟随
- 结果卡片单列、状态分组 sticky、长按出菜单
- 资质页只显示可视化、输入框可折叠展开
- 详情页全屏、底部 CTA 不被 tab bar 遮挡
- 切到"完整版" → 桌面 sidebar 出现、URL `?desktop=1` 持久化
- 切回手机版 → 重启浏览器后仍为手机布局

### 9.4 真机验证（push 后）

- iPhone Safari 访问 `http://<lan-ip>:5937` → "添加到主屏" → 图标出现 → 点开独立窗口、无 Safari UI
- Android Chrome 同上 → 只有「添加到主屏」（**不会出现「安装应用」**，HTTP + 无 SW 的预期行为，见 §6.2）
- 弱网：HTTP 无 SW → 网络断了页面就打不开，这是预期。不需要弱网缓存命中验证
- 切到"完整版"逃生口（URL `?desktop=1`）后桌面 sidebar 出现

### 9.5 GitHub Actions 验证

不本地跑构建。改完 push 后看 Actions：
- 当前 PR Check 必须过：`npm run build`、`npm test`、`npm run oklch:check`
- `web/` 仍是规划骨架，未接入独立 `web:*` CI；未来补齐 Vite/TS 后再恢复对应卡口
- backend 不动，应原样通过

---

## 10. 已知坑 & 注意事项

> 前 3 条是 §0.1 决策直接带来的约束，不可绕过；后面是改造期工程细节。

1. **HTTP 内网 → Service Worker 不能注册**（决策性约束）：iOS Safari 和 Chrome Android 都要求 origin 是 https 或 localhost，`http://192.168.x.y:5937` 注册 SW 会被静默忽略或抛 SecurityError。所以离线、SW 更新提示、Web Push 全不做。要解锁就上 HTTPS。

2. **iOS PWA standalone cookie 隔离**：iOS 把"添加到主屏"的独立窗口当作单独的 storage partition，与 Safari 浏览器**不共享 cookie/session**。意味着用户在 Safari 登录后再"添加到主屏"，独立窗口里要重新登录一次。文档/onboard 要提一句。

3. **长按菜单与 iOS 系统菜单冲突**：要给 `.result-card` 加 `-webkit-touch-callout: none; user-select: none;` 屏蔽 iOS 默认的"复制/查询"长按浮层，否则我们的 600ms 长按 context-menu 会和系统菜单打架。但这俩属性会让用户没法系统级"选中复制文本" —— 仅作用在卡片，详情页内文本区域不要加。

4. **`public/styles.css` 双载**：手机 CSS 规则**不要写进** `public/styles.css`。CLAUDE.md 写了两步切换契约，手机改造期不要触发它。

5. **跨文件 `@keyframes` 依赖**（CLAUDE.md 列过）：
   - `btn-spin` / `panelIn` / `toastIn` / `text-badge-pulse` / `cardIn` / `countIn`
   - 加手机 CSS 时不要破坏这些动画的引用顺序。

6. **`pages/announcement.css` & `pages/admin.css` 亮色调色板**：手机改造涉及这两页时（公告弹窗、用户管理）保持具体色值。

7. **legacy `let results = []` vs `uiState.results`**：`web/src/main.ts` 注释里提过这俩不同步。手机端改 `app-search.js` 时遵守现有的"local results"语义，不要乱切换。

8. **iOS Safari 100vh bug**：用 `100dvh`（dynamic viewport）代替 `100vh`，详情页全屏才不会被地址栏遮挡。

9. **`-webkit-tap-highlight-color`**：手机端按钮加 `-webkit-tap-highlight-color: transparent;` 避免点击灰块。

10. **`touch-action`**：横滑 chips 容器加 `touch-action: pan-x;` 防纵向滚动冲突。

11. **下载流 / SSE 不缓存**：未来若上 HTTPS + SW，下载文件流（`/api/downloads/:filename`）和 SSE 任务流（`/api/tasks/:taskId/stream`）**必须 NetworkOnly**，否则验证码、文件流会出错。本次 manifest-only 不涉及，留作未来 SW 配置注意点。

12. **`webServiceEnabled = false`**：用户关掉 LAN 后手机无法访问。设置页"手机访问"区块要清晰提示状态。

13. **端口被占的 fallback**：实际端口 ≠ 5937 时，二维码 + 地址显示要走 `accessInfo.actualPort`，并加红字提醒。

14. **CORS / cookie**：现有 session cookie 是 HttpOnly 默认 SameSite，PWA standalone 模式访问 `http://192.168.x.y:5937/` 与浏览器普通窗口同源，cookie 共享应该正常。如有问题检查 `SameSite=Lax`。

15. **下载文件保存位置**：桌面端 `用户目录/downloads/bzxz`；手机浏览器走标准下载流程（浏览器 Downloads），不需要改后端。

---

## 11. 文档同步清单（按 CLAUDE.md）

落地最后一步必做：

- [ ] `README.md` 加"手机访问"小节，"近期重点"列表加一条
- [ ] `web/README.md` 更新前端结构（新增 `modules/mobile/`、`styles/layout/mobile-tabbar.css`）
- [ ] `DEVELOPMENT.md` 加"手机端调试"小节（DevTools、`?desktop=1`、断点值）；键盘快捷键段加注"≤640px 不可用"
- [ ] `web/src/styles/SECTIONS.md` 如新增 `responsive/mobile.css` 则补一行索引
- [ ] `CHANGELOG.md` 加 "1.x.0 手机端 + PWA" 条目

---

## 12. 落地顺序建议

**Phase 0 · URL 路由（✅ 已完成 2026-05-25）**
1. `app-core.js` `switchTab()` 末尾：URL 写回 `?tab=…` + dispatch `tabchange`；`'me'` 跳过 `allowedTabs`
2. `app-core.js` `initRouter()` 重写：白名单解析 `?tab=…`，缺省 `search`
3. 新增 `popstate` 监听 → 前进/后退按 URL 进路由
4. ⚠️ `web/src/modules/tabs.ts` 不再新建 —— `web/` 未被构建，由 legacy 直接实现（见 §1）

**Phase 1 · 响应式骨架（✅ 已完成 2026-05-25）**
1. `public/index.html` 末尾加 `<nav class="mobile-tabbar">` (search/qual/me) + `<div id="page-me">`
2. `public/styles.css` 重写 ≤640px 块：sidebar `display:none`、content padding-bottom 72px、result-card 单列、44×44 触控热区；新增 `.mobile-tabbar` / `.me-*` 样式
3. 新建 `public/js/app-mobile.js`：`isMobile` / `applyLayoutMode` / `installMobileTabbar` / `toggleDesktopLayout` + tabchange 订阅
4. legacy JS guard：`app-search.js` 全局 keydown / `app-qual.js` `switchQualTab` 入口加 `if (window.isMobile()) return;`
5. `app-auth-admin.js` `onAuthReady` 填充 me 页用户卡 + 按角色控制行可见性

**Phase 1.1 · 排版打磨（✅ 已完成 2026-05-25）**
- 标准检索结果卡片：`.card-title-row` 在手机端改 column 方向，CMA/CNAS 资质徽章另起一行不再挤压标题
- 资质查询结果分组头：`.qual-result-std` 加 `flex-wrap: wrap` + `.qual-std-name` 强制换行并缩进，标准号不再被折断；CMA / CNAS 左右两栏布局保留
- 仅 CSS 改动（`public/styles.css` §11 §12），JS / DOM 零改动

**Phase 2 · 资质可视化手机版（✅ 输入折叠 + 卡片重排已完成 2026-05-25）**
1. `styles.css` ≤640px 块追加可视化样式 ✅
2. `app-qual.js` 输入折叠 + `expandQualVisualInput()` ✅
3. 统计卡点击下钻 / 同步进度 banner ❌ 推迟到 Phase 2.1/2.2

**Phase 3 · PWA（manifest-only）（✅ 已完成 2026-05-25）**
1. ✅ 4 个图标 PNG 落 `public/`：192/512 直接缩放、maskable-512 走 80% 安全区 + 深色画布、apple-touch-icon 180px
2. ✅ `public/manifest.webmanifest`
3. ✅ `public/index.html <head>` 加 manifest link + theme-color + 4 个 apple meta + apple-touch-icon
4. ⚠️ 路径全部 `public/`（非原文档写的 `web/public/`），与 §1 一致

**Phase 4 · 桌面端配套（✅ 已完成 2026-05-25）**
1. ✅ URL 列表/复制/打开/LAN 开关/端口 fallback 红字提示 —— **此前已实装**
2. ✅ 内网行加「📱 手机版」徽章；卡片底加灰提示框（同网 Wi-Fi + 添加到主屏指引）
3. ❌ 二维码生成 —— **不做**：手动输 IP / 复制按钮已够用，vendor QR 库（~20KB + 复杂加密器）收益不成正比

**Phase 5 · 文档同步**
按第 11 节清单全过一遍。

---

## 13. 不在本次范围

**HTTP 内网约束下不可做（要做先上 HTTPS）：**
- **Service Worker / 离线缓存 / 弱网命中** —— HTTP origin 注册不了 SW（见 §0.1、§6.2）
- **应用更新提示 toast** —— 没有 SW 拿不到 `onNeedRefresh`，只能靠用户手动刷新
- **Android Chrome 「安装应用」按钮** —— 需要 SW + HTTPS；HTTP 只能「添加到主屏」
- **Web Push 通知** —— 同上前置
- **真 HTTPS（mkcert / 自签）+ 设置页开关** —— 桌面端集成 mkcert + 用户首次手动信任证书，留给后续

**与本次解耦的其他能力：**
- 桌面端原生通知打通 —— 与本次解耦
- 资质订阅管理 / 同步日志的手机优化 —— 走"完整版"逃生口
- 批量下载手机版 —— 砍掉，永久不做
- 标准补全 / 本地库 / 下载历史的手机版 —— 走"完整版"
- 管理员面板手机版 —— 走"完整版"

---

## 14. 验证收尾

实现完成后，给用户提交以下材料：

1. 一份"待 push 的文件变更列表"
2. 给用户复制的 `git add / commit / push` 命令块（commit message 中文，含 why + how）
3. push 后需要在 Actions 看的关键检查点
4. 手机真机测试的 3-5 个关键路径（搜索 → 下载、资质可视化、添加到主屏、SW 更新提示、切换完整版往返）

完成。

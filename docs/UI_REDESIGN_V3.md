# StdHub Web UI 重构设计方案 V3 ——「卷宗工作台」

> 设计师：UI Designer（像素君）· 版本：V3 · 日期：2026-09-11
> 用途：本文件是下一轮全站 UI 重构的**唯一权威设计规范**，同时提供可直接复制给实现 AI 的分阶段提示词。
> 关联文档：`AGENTS.md`（工程红线）、`docs/WHOLE_APP_UI_REDESIGN.md`（上一轮规范，V3 完成后废止其中视觉条款）、`docs/THEME_DESIGN.md`（主题史）、`findings.md`（全站审计结论）。

> **2026-09-13 产品修订：**运行时主题范围收敛为 **Paper + 经典（Legacy，主要适配老设备）**。本文后续涉及 Dark/Light、四主题切换或四主题验收的旧条款仅保留为设计历史，不再是当前实现要求；当前验收以 Paper/Legacy × 桌面/移动端为准。

---

## 目录

1. [现状诊断](#1-现状诊断)
2. [设计定位与原则](#2-设计定位与原则)
3. [设计系统「卷宗」](#3-设计系统卷宗)
4. [信息架构与导航重构](#4-信息架构与导航重构)
5. [布局框架 AppShell](#5-布局框架-appshell)
6. [核心组件库规格](#6-核心组件库规格)
7. [逐页面设计方案](#7-逐页面设计方案)
8. [响应式与断点策略](#8-响应式与断点策略)
9. [无障碍与主题兼容](#9-无障碍与主题兼容)
10. [实施方向与流程](#10-实施方向与流程)
11. [工程红线（实现 AI 必读）](#11-工程红线实现-ai-必读)
12. [验收清单](#12-验收清单)
13. [给实现 AI 的提示词](#13-给实现-ai-的提示词)

---

## 1. 现状诊断

### 1.1 产品形态

单实例 NAS Web 应用，双角色：

| 角色 | 可用能力 |
|---|---|
| 游客 | 标准检索、资质查询、CMA 一单一库查询、已入库标准预览 |
| 管理员 | 以上全部 + 下载入库、Labr 补给、同步、导出、文件管理、设置、日志、统计 |

9 个顶级功能面：`search`（标准检索 + Labr）、`qual`（资质查询）、`cma-diff`（CMA 一单一库）、`local`（本地文件库）、`history`（下载历史）、`tools`（工具箱：查新/批量下载/标准补全）、`logs`（运行日志）、`stats`（使用统计）、`settings`（系统设置）+ 移动端专属 `me`（我）。

### 1.2 技术底盘（重构不可触碰的部分）

- 前端：**原生全局 JS**（`public/js/` 下 40 个脚本，固定加载顺序），公共层 `window.StdHub`（api/ui/modal/lifecycle/assets），事件委托 `data-stdhub-click`，CSP 已启用，**禁止新增 inline handler**。
- CSS 入口（`public/index.html` 实际加载，9 个主入口 + 5 个 ui-enhance）：
  `/css/theme-tokens.css` → `components-global.css` → `mobile.css` → `pages.css` → `themes.css` → `legacy-theme.css` → `workspace.css` → `preview-reader.css` → `ui-enhance/*`。入口合法性由 `scripts/check-css-entrypoints.mjs` 门禁。
- 主题：`html[data-theme]` 驱动 4 主题（paper/light/dark/legacy），`localStorage 'bzxz.theme'`，legacy 自动嗅探 Chrome ≤109 / Win7。**所有 OKLCH 必须带 sRGB 回退**（`npm run oklch:check` 门禁，当前 1051 处）。
- 图标：Tabler 本地 vendor（`/vendor/tabler-icons/`），全站禁 Emoji 导航。
- PDF 阅读器：分页 WebP 图片阅读器，性能契约（懒加载/缓存/回收）不可改变。

### 1.3 上一轮遗留的痛点（V3 要解决的）

| # | 痛点 | 来源 |
|---|---|---|
| P1 | 断点分裂：CSS 主断点 640px，阅读器 700px，小屏平板在 640-700 之间行为突变 | findings |
| P2 | 字体依赖 Google Fonts，NAS 内网无外网时首屏等待/回退不一致 | index.html |
| P3 | 页面标题与环境警告条（env-warning）垂直碰撞，缺少权威层叠顺序 | findings |
| P4 | 搜索页空态留白过大，来源切换与主搜索动作视觉竞争 | findings |
| P5 | CMA 一单一库命令面过载：5 个页面级动作 + 3 模式 + 高级筛选 + 诊断 + 黑名单 + 订阅 + 同步态 | findings |
| P6 | 文件库浏览/选择/破坏性动作等权混排在一行 | findings |
| P7 | 空态大面积占屏但不解释下一步；统计页零数据时误显 100% 成功率（已修但缺统一空态家族） | findings |
| P8 | 主题覆盖式维护成本高（组件 hardcode 色 + themes.css 大段 override），新颜色改动要改 4 处 | THEME_DESIGN |
| P9 | 视觉密度与层级：标题层级低对比，指标/筛选/说明混作一团 | findings |
| P10 | 无跨页快捷入口：高频用户在 9 个面之间往返只能走侧栏 | 本轮新增目标 |

---

## 2. 设计定位与原则

### 2.1 设计读法（Design Read）

**用户**：标准检测、质量与合规专业人员，**每天高频长时间使用**，检索 → 核对资质 → 下载归档是核心循环。设备跨度大：新电脑（Paper）到 Win7 老机器（Legacy）到手机。

**定位**：这不是营销站，是**专业档案工作台**。界面要像一间安静的档案馆：内容是主角，界面是卷宗封皮。

**设计语言命名：「卷宗 Dossier」**——克制的工业文档感、纸张质感、墨色文字、一个签名色、秩序分明的网格。

**设计拨盘**（延续上轮验证过的取值）：

| 拨盘 | 值 | 含义 |
|---|---:|---|
| DESIGN_VARIANCE | 4 | 结构稳定，允许适度非对称与上下文布局 |
| MOTION_INTENSITY | 3 | 即时反馈优先，无装饰性自动动画 |
| VISUAL_DENSITY | 7 | 高频专业工作的高密度，但分组清晰 |

### 2.2 五条设计原则

1. **文档优先**：屏幕上 80% 像素属于用户的数据（结果、资质、日志），chrome（导航/工具栏）保持安静。
2. **一个动作一个焦点**：每屏只有一个主操作（搜索框 / 同步按钮 / 导出），其余进次级菜单或筛选抽屉。
3. **状态即颜色，颜色即状态**：绿/橙/红只表达真实成功/警告/错误；交互强调色每主题只有一个。
4. **同一组件，到处一致**：SearchWorkbench、DataTable、EmptyState、Drawer 等全站共享，不允许页面私搭组件。
5. **兼容是契约**：Legacy（Chrome 109）与 Paper 同为验收一等公民；无 color-mix/复杂合成，OKLCH 永远带回退。

---

## 3. 设计系统「卷宗」

### 3.1 色彩与主题

当前运行时保留 Paper 与 Legacy 两套主题，语义 token 一套并映射到两套主题。**Paper 为默认与首要验收目标**；下方 Dark/Light 色板仅保留为历史设计记录。

**V3 色彩策略调整**（解决 P8）：把上轮「组件 hardcode + themes.css 大段覆盖」改为**三层 token 架构**：

```
第 1 层  原始色板  --paper-*, --dark-*, ...        （只存在于 theme-tokens.css，页面代码禁止引用）
第 2 层  语义 token --surface, --border, --text-2, --accent, --success ...（组件唯一允许引用的层）
第 3 层  组件 token --btn-bg, --row-hover, --chip-active ...（由语义 token 组合派生，只写在 components-global.css 顶部）
```

规则：**任何 `.css` 页面文件出现第 1 层引用即为验收失败**；新增颜色只允许加语义 token，`oklch:check` 之外新增 `npm run tokens:check`（脚本检查页面 CSS 不含 `--paper-`/`--dark-` 等前缀）。

#### Paper（默认 · 首要验收目标）

| Token | 值（OKLCH + 回退） | 用途 |
|---|---|---|
| `--bg` | `oklch(96% 0.012 80)` / `#f5f2ec` | 页面底 · 亚麻米白，永不纯白 |
| `--surface` | `oklch(98.5% 0.006 85)` / `#faf8f4` | 卡片/面板 |
| `--surface-h` | `oklch(94.5% 0.018 78)` / `#efeadf` | 悬停/hover 面 |
| `--surface-sunken` | `oklch(93% 0.02 75)` / `#e9e3d5` | 输入框、代码区、表格头（**V3 新增**） |
| `--border` | `oklch(87% 0.022 75)` / `#ddd5c6` | 1px 常规边线 |
| `--border-strong` | `oklch(77% 0.032 75)` / `#c2b8a3` | 输入聚焦、强调边 |
| `--text` | `oklch(23% 0.012 60)` / `#3a3831` | 暖墨色主文字 |
| `--text-2` | `oklch(45% 0.016 70)` / `#6b675d` |
| `--text-3` | `oklch(60% 0.018 75)` / `#908b7f` |
| `--accent` | `oklch(56% 0.13 38)` / `#b05c3f` | 签名色 · 深陶土（比上轮深一档保对比度） |
| `--accent-h` | `oklch(50% 0.14 35)` / `#9a4d33` |
| `--accent-soft` | `oklch(93% 0.028 45)` / `#f0e2d8` | 选中底、focus 环底色 |
| `--success` | `oklch(50% 0.12 145)` / `#3f7a4f` 苔绿 |
| `--warning` | `oklch(56% 0.12 75)` / `#a3721f` 琥珀 |
| `--danger` | `oklch(50% 0.17 28)` / `#a4452e` 暖红 |
| `--info` | `oklch(48% 0.10 245)` / `#3e6a96` 冷蓝（仅提示语义） |
| `--shadow-md` | `0 2px 8px rgba(58,50,38,.08)` | **仅**浮层使用 |

#### Dark（炭黑 + 钴蓝）

| Token | 值 |
|---|---|
| `--bg` | `oklch(15% 0.012 260)` / `#1a1c22` |
| `--surface` | `oklch(19% 0.010 260)` / `#23252d` |
| `--surface-h` | `oklch(23% 0.014 260)` / `#2c2f38` |
| `--surface-sunken` | `oklch(13% 0.010 260)` / `#171920` |
| `--border` | `oklch(30% 0.012 260)` / `#3c3f4a` |
| `--border-strong` | `oklch(42% 0.014 260)` / `#565a68` |
| `--text` | `oklch(91% 0.005 255)` / `#e4e5e9` |
| `--text-2` | `oklch(72% 0.010 255)` / `#aab0bc` |
| `--text-3` | `oklch(52% 0.012 255)` / `#7c8290` |
| `--accent` | `oklch(68% 0.16 250)` / `#6a89e8` 钴蓝 |
| `--accent-h` | `oklch(74% 0.17 250)` / `#8aa2ef` |
| `--accent-soft` | `oklch(28% 0.06 250 / .35)` / `rgba(90,120,220,.22)` |
| 语义色 | success `#5aab72` / warning `#c39240` / danger `#d0705a` / info `#7ba0c8` |

#### Light（冷白 · 工程蓝）

| Token | 值 |
|---|---|
| `--bg` | `oklch(97.5% 0.005 245)` / `#f5f7fa` |
| `--surface` | `oklch(99% 0.003 245)` / `#fcfdfe` |
| `--surface-h` | `oklch(95% 0.010 245)` / `#eef2f7` |
| `--surface-sunken` | `oklch(94% 0.012 245)` / `#e8edf4` |
| `--border` | `oklch(89% 0.012 245)` / `#d9dfe8` |
| `--border-strong` | `oklch(80% 0.018 245)` / `#bec8d6` |
| `--text` | `oklch(22% 0.018 245)` / `#2b3340` |
| `--text-2` | `oklch(45% 0.015 245)` / `#5d6878` |
| `--text-3` | `oklch(62% 0.012 245)` / `#8a93a2` |
| `--accent` | `oklch(50% 0.19 250)` / `#2f5fd0` |
| `--accent-h` | `oklch(45% 0.20 250)` / `#2750b4` |
| `--accent-soft` | `oklch(94% 0.025 250)` / `#e2eaf9` |
| 语义色 | success `#2e7d4f` / warning `#9a6b15` / danger `#c0492f` / info `#3a6ea5` |

#### Legacy（Chrome 109 基线）

- **纯 hex，零 OKLCH、零 color-mix、零 backdrop-filter、零 CSS 嵌套**。
- 结构与语义 token 完全同名，色板取 Light 的降饱和版本（对比度 ≥ 4.5:1）。
- 图标走 Tabler 已 vendor 的 webfont（上轮已验证 BMP 伪元素替换方案兼容，继续沿用）。

### 3.2 排版

**V3 关键决策（解决 P2）：默认系统字体栈，Web 字体降级为渐进增强。**

```css
--font-sans: system-ui, -apple-system, "Segoe UI", "PingFang SC",
             "Microsoft YaHei", "Noto Sans CJK SC", sans-serif;
--font-mono: ui-monospace, "Cascadia Mono", Consolas, "SF Mono", Menlo, monospace;
--font-serif: Georgia, "Songti SC", "SimSun", serif;  /* 仅 Paper 主题的页面标题可用 */
```

Google Fonts（DM Sans / Source Serif 4 / DM Mono）保留为 `<link rel="stylesheet" media="print" onload>` 异步加载 + `noscript` 回退，**网络字体加载失败不阻塞渲染、不重排跳字**（字号度量已对齐系统栈）。Legacy 直接跳过网络字体。

字级（五级固定层级，解决 P9）：

| 层级 | 大小/行高 | 字重 | 用途 |
|---|---|---|---|
| Display | 20px / 28 | 600 | 页面标题（每页仅一个） |
| H2 | 16px / 24 | 600 | 区段标题 |
| Body | 14px / 22 | 400 | 正文、表格 |
| Caption | 12px / 18 | 400 | 辅助说明、标签 |
| Mono | 13px / 20 | 400 | 标准号、时间、统计数、日志（**一律等宽**） |

规则：标题色 = `--text`，说明色 = `--text-3`，正文 = `--text-2`；**同一页面字号层级不超过 3 级连续混用**；禁止占位文字充当字段标签。

### 3.3 间距与形状

- 基准单位 4px，刻度：4 / 8 / 12 / 16 / 24 / 32 / 48 / 64。
- 圆角：控件 8px；结构容器 10px；浮层 12px；胶囊 chip 全圆角（仅筛选条件）。
- 层级靠「间距 + 表面变化 + 稀疏 1px 分隔线」，**卡片禁止套卡片**（上轮已立法，V3 增加验收脚本目检项）。
- 阴影仅用于真实浮层（抽屉/菜单/弹窗/命令面板），`--shadow-md/lg` 两档，页面内元素零阴影。

### 3.4 图标

Tabler 线性图标全站统一：`stroke 1.5`，尺寸 16（行内）/ 20（按钮）/ 24（导航）。图标按钮必须有 `aria-label` + `title`。**禁止 Emoji 承担任何业务语义**。

### 3.5 动效

MOTION_INTENSITY 3：

- 允许：hover/active 位移 ≤1px 或背景色变化 120ms；抽屉/弹窗 transform+opacity 180ms；toast 进出 200ms；任务进度条平滑填充。
- 禁止：装饰性循环动画、视差、滚动劫持、GSAP（上轮结论：CSS 过渡已足够，V3 维持零动画依赖）。
- 所有动效包裹 `@media (prefers-reduced-motion: no-preference)`。

---

## 4. 信息架构与导航重构

### 4.1 桌面侧栏（216px）

V3 把 9 个入口重组为**三个语义组**（解决「功能平铺无节奏」）：

```
┌ 标准盒子 StdHub ──────────────────┐
│                                    │
│ 〔检索与验证〕                      │
│  🔍 标准检索        搜索和下载标准  │
│  🛡 资质查询        CNAS/CMA 资质  │
│  ⊞ CMA 一单一库    资质 vs 国家库  │
│                                    │
│ 〔文件与记录〕                      │
│  📁 本地文件库      已下载标准管理  │
│  🕐 下载历史        查看下载记录    │
│  🔧 工具箱          查新/批量/补全  │
│                                    │
│ 〔运维〕                            │
│  📋 运行日志        搜索/下载/同步  │
│  📊 使用统计        查看使用数据    │
│                                    │
│  ⚙ 系统设置                        │
├────────────────────────────────────┤
│  👤 admin · 管理员                  │
└────────────────────────────────────┘
```

- 组标签 12px `--text-3` 大写字距 0.05em，组间距 20px。
- 侧栏可折叠为 56px 图标模式（保留 localStorage 记忆），折叠时组标签隐藏、悬浮显示完整名称。
- 游客模式：Labr/日志/统计/设置入口按 `data-admin-only` 隐藏（契约不变），侧栏组自动收缩不留空洞。

### 4.2 顶栏（56px）

左→右：侧栏折叠钮 · 品牌（logo + 标准盒子/StdHub）· **全局搜索快捷入口（Ctrl K）** · 源健康迷你条 · 主题 · 账户。

**V3 新增：命令面板（Command Palette）**（解决 P10）：

- `Ctrl+K`（Mac `⌘K`）唤起，居中浮层 640px 宽。
- 能力：① 跳转 9 个功能面（输入「日志」→ 回车直达）；② 快捷动作（切换主题）；③ 以当前输入直接发起标准检索（回车即跳搜索页并执行）。
- 实现约束：原生 JS 单文件 `public/js/app-command-palette.js`，挂 `StdHub.commandPalette`，键盘完整可达（↑↓ 选择、Enter 确认、Esc 关闭、焦点圈闭、打开时焦点入框、关闭时焦点还原触发钮）。

### 4.3 移动端（≤700px）

底部四入口 tabbar（检索/资质/文件/我）+ 全局层叠顺序：

```
顶栏 52px（品牌 + 任务角标 + 主题）
环境警告条（条件性）
页面内容（唯一滚动容器，100dvh 计算）
底部 tabbar 56px + safe-area
```

移动端专属规则：搜索框 sticky 吸顶于顶栏之下（毛玻璃仅现代主题，legacy 用纯色）；`input font-size ≥16px` 防 iOS 缩放；所有触控目标 ≥44px；toast 上移避开 tabbar。

---

## 5. 布局框架 AppShell

### 5.1 垂直权威栈（解决 P3）

```
topbar (56px, sticky)
└ env-warning（页面级通知，最多 1 条，可关闭，48px）
  └ page-header（页面标题 + 用途一句话 + 唯一主操作）
    └ work-area（工具栏 / 筛选 / 内容）
```

- page-header 结构：左「Display 标题 + caption 用途」，右「≤1 个主按钮 + 更多菜单（⋯）」；页面状态/数据时间/范围放独立状态区（StatusStrip），不与按钮混排。
- content 最大宽度 1480px 居中，数据密集页（文件库/日志/CMA）可用全宽；左右 padding 24px（桌面）/ 16px（平板）/ 12px（手机）。

### 5.2 PageHeader 模板

```html
<div class="page-header">
  <div class="page-header-text">
    <h1 class="page-title">标准检索</h1>
    <p class="page-purpose">跨来源检索标准，确认状态后预览或下载原始文件。</p>
  </div>
  <div class="page-header-actions">
    <button class="btn btn-primary">…唯一主操作…</button>
    <button class="btn-icon" data-menu="page-more">⋯</button>
  </div>
</div>
```

---

## 6. 核心组件库规格

> 全部组件只消费第 2/3 层 token；状态齐全（default/hover/active/disabled/focus-visible/error/loading/empty）。

### 6.1 SearchWorkbench（搜索工作台 · 全站复用）

标准检索、Labr、资质搜索、CMA 能力库搜索共用骨架（解决 P4）：

```
┌──────────────────────────────────────────────────┐
│ [ 来源 chips：全部|BZ|BW|BY ]   （第二层，视觉降级）│
│ ┌──────────────────────────────┐ ┌────────────┐  │
│ │ 🔍 输入标准号或关键词…        │ │  检索 (主)  │  │
│ └──────────────────────────────┘ └────────────┘  │
│ 最近：GB/T 23440 · HJ 535 · …（仅空态出现）        │
└──────────────────────────────────────────────────┘
```

- 搜索输入 40px 高、`--surface-sunken` 底、聚焦换 `--accent` 边 + `--accent-soft` 外环 3px。
- 来源 chips 是**切换型**控件（非平行按钮），胶囊形、选中态 `--accent-soft` 底 + `--accent` 文字，视觉权重明显低于搜索框。
- 提交按钮是页面唯一 primary；回车提交。
- 空态时展示最近搜索与常用模板（GB/T、YY/T、JJG…），一旦有输入立即隐藏。

### 6.2 ResultRow / DataTable

- 桌面：表头 + 行式表格；行高 44px，斑马纹关闭（用 1px `--border` 分隔），hover 行 `--surface-h`。
- 行信息优先级：标准号（mono，600 字重）→ 名称 → 状态徽章 → 来源徽章 → 资质匹配 → 日期 → 操作。
- 行主操作「预览」直接可见（文本按钮）；下载/收藏/详情为图标按钮；危险动作进右键/⋯ 菜单。
- 选中行为：勾选后**行首出现 SelectionBar**（浮动于内容区顶部，含批量动作 + 已选数 + 取消），未选中时完全不存在（解决 P6）。
- 移动端：转字段优先卡片行（标准号大字 mono → 名称 2 行截断 → 徽章行 → 主操作按钮 44px），**禁止横向压缩表格**。

### 6.3 StatusBadge（状态徽章族）

统一徽章系统，三档尺寸（S16/M20/L24）：

| 语义 | 样式 | 用例 |
|---|---|---|
| 中性 | `--surface-sunken` 底 + `--text-2` | 来源 BZ/BW/BY、年份 |
| 强调 | `--accent-soft` 底 + `--accent` | CNAS 匹配、已入库 |
| 成功 | success 色系 | 现行、在库 |
| 警告 | warning 色系 | 跨年、年版过期 |
| 危险 | danger 色系 | 已废止、不在库 |
| 暂停 | 灰色 + 虚线边 | 国家 CMA 暂停态 |

规则：徽章 = 「8px 圆角胶囊 + 12px 文字 + 左侧 6px 状态点」；状态不只靠颜色，**点形状/文字同时区分**；一单徽章最多 3 个，超出收进「+n」。

### 6.4 FilterBar 与 FilterDrawer

- 常用筛选（≤3 个）平铺在工具栏（排序、来源、状态）；其余全部进「筛选」按钮唤起的右侧 Drawer。
- Drawer：右滑 360px、遮罩 40%、Esc 关闭、焦点圈闭、移动端转底部面板（75% 高、拖拽条）。
- 已激活筛选以 chips 显示在结果区顶部，点 × 移除。

### 6.5 EmptyState（空态家族 · 解决 P7）

六种空态全站一套组件：`未开始 / 无匹配 / 暂无数据 / 加载失败 / 权限不足 / 已暂停`。

结构：图标（24px，`--text-3`）+ 一句主文案 + 一句辅助说明 + **唯一合理的下一步动作**（按钮或示例 chips）。禁止大面积插画；零数据统计页显示「暂无数据」，不计算比率。

### 6.6 TaskCenter（历史方案，当前已移除）

> 2026-09-13 产品决策：不再提供独立任务中心。下载、同步和导出的进度及结果留在各自工作页。本节仅用于解释旧实现，不再作为验收项。

右侧抽屉 400px，非模态（焦点还原但不圈闭）。结构：顶部筛选 chips（全部/进行中/失败）→ 任务流（阶段文案 + 真实百分比 + BZ 页数进度 + 重试/取消）→ 底部「清理已结束」。空态复用 EmptyState。与日志页共享行组件。

### 6.7 Dialog / Confirm / Prompt

统一遮罩（`rgba(20,18,14,.45)` modern / 纯色 legacy）、12px 圆角、标题区 + 内容区 + 右下操作区（主按钮唯一）。焦点管理沿用上轮已修复的契约：打开同步聚焦、关闭还原触发焦点、捕获阶段 Escape 单层关闭。**禁止原生 `alert/confirm/prompt`**。

### 6.8 SettingsRow（设置行）

```
┌────────────────────────────────────────────┐
│ 标签(600)      说明(caption, text-3)   [控件] │
│                                  即时状态文案 │
└────────────────────────────────────────────┘
```

控件类型统一：开关 / 分段控件 / 数字输入 / 选择器 / 文本。危险区（重置、清空）独立分组、danger 边框 + 确认弹窗。

### 6.9 Toast

右下角（桌面）/ tabbar 上方（移动），200ms 进出，语义色左边条 3px，自动消失 4s，可堆叠 ≤3，hover 暂停计时。

---

## 7. 逐页面设计方案

> 每页给出：信息层级 → 关键改动 → 移动端 → 验收要点。**所有 DOM ID、表单字段名、脚本调用关系、API 契约不变。**

### 7.1 标准检索（search · 含 Labr 模式）

- 结构：SearchWorkbench →（执行后）StatusStrip（各源进度 chips：BZ ✓ / BW ⏳ 60% / BY ✓）→ 结果分组表（现行/即将实施/废止分组头 sticky 可折叠）→ SelectionBar。
- 模式切换「标准检索 / Labr 补给」为顶部 SegmentedTabs，管理员可见。
- Labr 行：资源列表形态（非表格复制品）——标准号 + 资质徽章（含跨年提示）+ 已下载标记 + 展开详情 + 预览/下载。
- 移动端：搜索 sticky、结果卡片化、长按上下文菜单；搜索结果不启用下拉刷新，预览失败给「浏览器原生打开」兜底按钮。
- 验收：搜索参数、分组折叠记忆、收藏、批量选择契约不变。

### 7.2 资质查询（qual）

- 模式：普通 / 详细 / 批量（SegmentedTabs 稳定切换）。
- 普通查询：SearchWorkbench（机构关键词）→ 机构结果卡列表 → 点击展开标准明细（增量加载）。
- 标准号查询：快路径结果分三区（精确匹配 / 同系列·跨年 / 全文），区头带数量徽章。
- 详细查询：高级条件进可持续编辑的 FilterDrawer（不再是临时表单）。
- 批量查询：左输入解析摘要（n 个标准号，异常标红）→ 右分组结果。
- 移动端：结果按标准号 sticky 分组，CNAS/CMA 分段折叠。
- 验收：归一化快路径、结果去重、增量加载契约不变。

### 7.3 CMA 一单一库（cma-diff · 渐进披露重灾区）

- 顶部 StatusStrip（固定）：当前范围 · 数据时间 · 同步状态 · 异常计数（点击异常即筛异常）。
- **唯一主操作 = 同步**；导出、诊断、黑名单、清理全部收进「⋯ 更多」菜单（解决 P5）。
- 子导航（能力项目库 / 机构比对 / 领域订阅）为页内 SegmentedTabs。
- 结果表：5 档比对状态用 StatusBadge（在库=绿、仅限引用=info、已废止=红、年版过期=橙、不在库=灰虚线）；默认排序「异常优先」。
- 高级筛选进 Drawer；关键词与领域快捷 chips 留在工具栏。
- 验收：同步/导出/黑名单的 ID 与 handler 不变，只是入口收纳。

### 7.4 本地文件库（local）

- 表格优先：系列父行（标准号 mono + 版本折叠计数 + 资质/能力库徽章）→ 展开版本子行（来源 + 时间 + 大小 + 操作）。
- 工具栏（浏览态）：搜索、系列筛选、统计 chips、分页——全部安静排布。
- SelectionBar（选择态）：批量下载到本地 / 移动 / 删除（danger）——只在勾选后浮现。
- 行操作：预览（主）+ ⋯ 菜单（重命名 / 打开位置 / 复制路径 / 删除）。
- 移动端：卡片 + 底部浮动 SelectionBar；扫描/导入入口在页面 header 的 ⋯ 菜单。
- 验收：rename/delete/补偿逻辑、分页按系列计算契约不变。

### 7.5 下载历史（history）

- 时间轴活动列表：按日期分组（今天/昨天/更早），行 = 标准号 + 来源徽章 + 状态 + 时间 + 操作（重下载 / 定位文件）。
- 筛选：来源 / 状态 / 文本搜索（工具栏级）。
- 「清空历史」在 ⋯ 菜单 + 独立确认（明确「仅删记录不删文件」文案，沿用上轮契约）。
- 空态：EmptyState（未开始）+ 引导去搜索。

### 7.6 工具箱（tools）

三个工具共享「左输入右结果」工作台（SegmentedTabs 切换）：

- **查新**：左 = 清单输入 + 周期说明；右 = 分类变更结果（新增/修订/废止分组）。
- **批量下载**：左 = 多行标准号 textarea + 解析摘要；右 = 来源匹配 + 下载队列（复用 TaskCenter 行组件）。
- **标准补全**：四步向导（选择文件 → 配置字段 → 执行处理 → 下载结果），步骤条 24px。
- 移动端：上下堆叠，输入卡可折叠（沿用现有 collapsed 模式）。

### 7.7 运行日志（logs）

高密度运维控制台：

```
[运行摘要 chips: 今日事件 n · 错误 n · 警告 n]（点击即筛）
[查询框 | 时间范围 | 级别 | 来源]  ← 唯一筛选栏，去重复的快捷筛选
事件流（虚拟滚动，mono 时间戳 + 级别徽章 + 摘要）
  └ 点击行展开载荷详情（缩进 JSON/键值区）
```

- 级别色仅 error/warn//info 三档；行不加装饰状态点。
- 自动刷新开关在工具栏右侧，离开页面自动停（现有契约）。

### 7.8 使用统计（stats）

- 时间范围选择整合进 page-header 右侧（分段控件：今日/7天/30天/自定义）。
- KPI = 一行数字摘要（非三张等权卡片）：总量、成功率、平均耗时、活跃源。
- 主视图 = 趋势折线（Chart.js，颜色从 CSS token 派生 + `themechange` 重绘——上轮已验证方案）；次级 = 来源表现 + 健康异常。
- 总量为零：整页 EmptyState「暂无数据」。

### 7.9 系统设置（settings）

- 桌面：左侧 200px 粘性分区导航（下载 / 文件库 / 订阅 / 同步 / 诊断 / 关于，原顺序）+ 右侧设置内容（SettingsRow 分组）。
- 移动端：分区列表 → 点入单分区视图（返回按钮回列表）。
- 设置行全部带即时状态与保存反馈；危险区（重置/恢复默认）隔离在每组末尾 danger 分组。
- 验收：设置原子更新（批量事务）契约、控件 ID 不变。

### 7.10 我的（me · 移动端专属）

- 账户摘要卡（头像 + 名称 + 角色徽章 + 登出）。
- 主题切换：四个 SegmentedButtons（跟随 allowedTabs 显示快捷入口）。
- 收藏摘要（本地，不上报不 404——沿用上轮决策）。
- 版本号 + 在线状态 caption。

### 7.11 PDF 阅读器（preview）

- 桌面：**单一 56px 工具栏**（返回 + 标题/来源 + 页码 + 缩放/适宽 + 全屏 + ⋯）；生成状态收成 2px 细进度条贴工具栏下沿，就绪即消失（沿用上轮「文档模式」结论）。
- 移动端：52px app bar（返回 + 截断标题 + 页码 + More），多源选择与次级动作进底部 action sheet；`100dvh` + safe-area。
- 画布：安静炭色/纸色（随主题），白页居中，**阅读器内部零装饰**。
- 硬约束：懒加载/缓存/回收/缩放/切源/下载契约一行不动。

---

## 8. 响应式与断点策略

**V3 统一三断点（解决 P1）**，CSS 与 JS（`window.isMobile()` 等逻辑）同源对齐：

| 断点 | 范围 | 形态 |
|---|---|---|
| `--bp-mobile` | ≤ 700px | 底部 tabbar、单列、action sheet、sticky 搜索 |
| `--bp-tablet` | 701–1023px | 侧栏折叠为 56px 图标、双栏降级单栏、Drawer 保持右侧 |
| `--bp-desktop` | ≥ 1024px | 完整侧栏 + 全功能；≥1440px 内容最大 1480px |

- 断点值以 CSS 自定义属性 + PostCSS 不可行（原生 CSS），故**约定字面量统一写入 `theme-tokens.css` 顶部注释块**，各文件 `@media (max-width: 700px)` 必须与 `app-mobile.js` 的 `MOBILE_BP = 700` 一致；新增 `scripts/check-css-entrypoints.mjs` 检查项：**禁止出现 640px 断点**。
- 视口高度一律 `100dvh`；安全区 `env(safe-area-inset-*)` 应用于 tabbar、action sheet、toast。
- 触控目标 ≥44px；`-webkit-tap-highlight-color: transparent`；横向滚动容器 `touch-action: pan-x`。

---

## 9. 无障碍与主题兼容

- 对比度：正文 ≥4.5:1、大字/图形 ≥3:1（WCAG AA）；Paper/Legacy 逐一用工具核验，重点盯 `--text-3` 在 `--surface-sunken` 上的组合。
- 键盘：所有功能可键盘完成；焦点环 `2px solid var(--accent)` + `outline-offset 2px`，**不依赖颜色变化**；Tab 顺序 = 视觉顺序。
- 焦点管理沿用上轮修复契约：模态圈闭/还原、捕获阶段单层 Escape。
- 状态不只靠色：徽章带文字、错误带图标、行选中带 `aria-selected`。
- `prefers-reduced-motion` 全局短路所有过渡。
- 屏幕阅读器：图标按钮 `aria-label`；分组头 `role="group"` + `aria-label`；任务进度 `role="progressbar"` + `aria-valuenow`。
- 主题验收顺序：**Paper → Legacy**；每主题截图对比桌面 1440×900 + 移动 390×844。

---

## 10. 实施方向与流程

### 10.1 总策略

- **不动后端、不动业务 JS 逻辑、不迁移框架**；重构 = CSS 重写为主 + 少量 DOM 结构调整（模板级，不改 ID）+ 命令面板等纯新增文件。
- 上一轮的批次制（每批次 = 一个可验收 PR）继续沿用；**每批次必须独立通过全部门禁后才进下一批**。
- 新增两个门禁脚本：`tokens:check`（页面 CSS 禁止第 1 层 token）、断点检查并入 `css:check`。

### 10.2 阶段划分

| 批次 | 内容 | 主要文件 | 交付物 |
|---|---|---|---|
| **R0 设计令牌基座** | 三层 token 架构落地；Paper/Legacy 色板；字体改系统栈 + 异步 Web 字体；断点统一 700/1024/1440；`tokens:check` 脚本 | `theme-tokens.css`、`themes.css`（重写瘦身）、`legacy-theme.css`、`index.html`（字体加载）、`scripts/check-css-entrypoints.mjs` | 旧组件在新 token 下视觉不回归（允许中性期） |
| **R1 AppShell** | 侧栏三分组 + 折叠；顶栏重排；垂直权威栈（env-warning/page-header）；移动 tabbar 对齐 700px；SelectionBar 骨架 | `workspace.css`、`components-global.css`、`mobile.css`、`index.html`（侧栏/顶栏 DOM 模板）、`app-mobile.js`（BP=700） | 全部 9 页可进入、双主题正常、无 JS 报错 |
| **R2 命令面板** | Ctrl+K 全局跳转 + 快捷动作 + 直达搜索 | 新建 `public/js/app-command-palette.js` + `components-global.css` 追加样式 + `index.html` 挂载点 | 键盘全流程可用、焦点管理达标 |
| **R3 核心检索** | SearchWorkbench / ResultRow / StatusBadge / EmptyState / 状态分组 sticky / Labr 列表 | `pages.css`、`app-search-render.js`（仅模板字符串）、`app-labr.js`（仅模板） | 搜索/批量选择/收藏/预览契约不变 |
| **R4 资质与 CMA** | 三模式工作台、StatusStrip、渐进披露（同步为主操作）、FilterDrawer | `pages.css`、`app-qual*.js` 模板、`app-cma-diff*.js` 模板、`app-filter-drawer.js` | 查询模式/订阅/导出契约不变 |
| **R5 文件与记录** | 文件库表格/SelectionBar/行菜单；历史时间轴；工具箱双栏工作台 | `pages.css`、`app-file-library.js`/`app-download.js`/`app-complete.js` 模板 | rename/delete/补偿/导入契约不变 |
| **R6 运维与配置** | 日志控制台、统计 KPI 行 + 空态、设置双栏、我的页 | `pages.css`、`app-log.js`/`app-auth-stats.js`/`app-settings.js` 模板 | 统计口径/设置保存/日志筛选不变；独立任务中心按产品决策移除 |
| **R7 全局质量** | Dialog/Confirm/Prompt 统一重皮、Toast、动效审计、无障碍专项、双主题 × 双端全量视觉回归、性能（首屏 CSS 体积、Chart.js token 派生核对） | `components-global.css`、`ui-enhance/*`、`preview-reader.css`（阅读器对齐新 token） | 全部验收清单通过 |

### 10.3 每批次完成条件（硬门禁）

1. `npm run build`（tsc）
2. `npm run css:check`（入口合法 + oklch 回退 + **新增：无 640px 断点、无第 1 层 token 引用**）
3. `npm test`（当前基线 28 文件 / 237 用例全绿）
4. `npm run test:e2e`（Chromium 冒烟）
5. `git diff --check`
6. 桌面 1440×900 + 移动 390×844，Paper/Legacy 代表性截图检查（Paper 优先）
7. 更新 `task_plan.md` / `progress.md` / `findings.md`（沿用项目托管协议）

### 10.4 风险与回滚

- 每批次独立 commit，出问题 `git revert` 单批回滚，不跨批修复。
- R0 是唯一「全局性」改动：先在分支跑全量门禁再合入；旧 token 名保留别名（`--surface` 等同名沿用，只新增不删），让未重写的旧组件零成本过渡。
- Legacy 主题每批次必须真机/仿真验证（Chrome 109 无 color-mix、无 OKLCH、无 backdrop-filter）。

---

## 11. 工程红线（实现 AI 必读）

1. **禁止引入 React/Vue/Tailwind/GSAP/任何新构建链**。前端保持原生 JS + 全局脚本 + 原生 CSS。
2. **禁止重命名任何 DOM ID、路由、tab 名、表单字段、API 路径与响应字段**（`{ data, error }` 壳不变）。
3. **禁止新增 inline handler**（`onclick=` 等）；一律 `data-stdhub-click` 或 `addEventListener`。
4. **新增前端代码挂 `window.StdHub`**；请求走 `StdHub.api`；生命周期资源注册 `StdHub.lifecycle`。
5. **所有 `oklch()` 必须带 sRGB hex/rgba 双声明回退**（`npm run oklch:check` 门禁）。
6. **CSS 入口不得增删**（除方案明确列出的新文件）；新样式写进既有分层。
7. **运行时数据库、标准文件、导出、备份、预览缓存、凭据不入库**；`data/bzxz.db` 操作前先 SQLite backup + `PRAGMA integrity_check`。
8. **国家 CMA 无限期暂停**：不得恢复任何 Provider/同步/调度/徽章入口。
9. **PDF 阅读器性能契约不动**：懒加载、缓存、回收、缩放、切源、Range 下载。
10. **主题双套等价支持**：任何视觉改动必须 Paper/Legacy 双主题验证；Legacy 禁 OKLCH/color-mix/嵌套语法/backdrop-filter。
11. 交付前依次跑：`npm run build` → `npm run css:check` → `npm test` → `npm run test:e2e` → `git diff --check`。
12. 动手前先读 `AGENTS.md` + `docs/UI_REDESIGN_V3.md`（本文件）+ `docs/README.md`。

---

## 12. 验收清单

**视觉**

- [x] 双主题（Paper/Legacy）× 双端（桌面/390）代表页面截图无溢出、无对比度违例
- [x] 全站零 Emoji 导航、零卡片嵌套、页面内零装饰性阴影
- [x] 字级五层、间距 4px 刻度、圆角三档全站一致
- [x] 标准号/时间/统计数/日志使用 mono

**交互**

- [x] 每页唯一主操作；CMA 页只剩「同步」一个主按钮
- [x] SelectionBar 仅选中后出现；危险动作全部在确认弹窗之后
- [x] Ctrl+K 命令面板：跳转 9 面 + 主题切换 + 直达搜索
- [x] 抽屉/弹窗：Esc 单层关闭、焦点圈闭与还原；独立任务中心已移除

**响应式**

- [x] 全仓无 640px 断点；700/1024/1440 三档一致（CSS 与 JS 同源）
- [x] 移动端：sticky 搜索不遮内容、toast 避开 tabbar、action sheet 带 safe-area、input ≥16px
- [x] 触控目标 ≥44px；`100dvh`；`prefers-reduced-motion` 短路全部动效

**工程**

- [x] 全部门禁绿（build / css:check / test / e2e / diff --check）
- [x] 页面 CSS 无第 1 层 token 引用（`tokens:check`）
- [x] 无 JS 控制台错误（Paper/Legacy × 双端 × 游客/管理员代表路径）
- [x] 业务契约回归：搜索、下载、预览、文件管理、资质、同步、导出、设置由 240 项单元/集成测试与 6 项 Chromium E2E 覆盖

---

## 13. 给实现 AI 的提示词

> 使用方法：**提示词 0 每次会话开头发一次**（全局上下文与红线），然后按批次顺序逐个发送提示词 R0–R7。实现 AI 在仓库内工作，能读到本文件，提示词保持简短、指向本文件的章节号。

### 提示词 0 · 全局上下文（每次会话必发）

```
你是 StdHub 项目的前端实现工程师。项目位于当前工作目录（Express + SQLite + 原生 JS 前端的单实例 NAS Web 应用）。

先按顺序阅读：
1. AGENTS.md（工程协作红线）
2. docs/UI_REDESIGN_V3.md（本轮 UI 重构的权威设计规范，含设计系统、组件规格、页面方案、实施批次）
3. docs/README.md 与 docs/ARCHITECTURE.md（架构约定）

绝对红线（违反任何一条即返工）：
- 不引入任何框架/构建链（React/Vue/Tailwind/GSAP 禁止），保持原生 JS + 原生 CSS
- 不改任何 DOM ID、路由、tab 名、表单字段名、API 路径与 { data, error } 响应壳
- 不新增 inline handler，统一 data-stdhub-click 或 addEventListener；新代码挂 window.StdHub
- 所有 oklch() 颜色必须带 sRGB hex/rgba 双声明回退（Legacy 主题只允许纯 hex）
- CSS 入口结构按 docs/UI_REDESIGN_V3.md §3.1，不得私自新增入口文件
- PDF 分页图片阅读器的懒加载/缓存/回收/缩放/切源/下载契约一行不动
- 国家 CMA 保持无限期暂停，不得恢复任何入口
- 运行时数据与凭据不入库；涉及 data/bzxz.db 的操作先备份并确认 PRAGMA integrity_check

每完成一个批次，依次运行并通过：npm run build、npm run css:check、npm test、npm run test:e2e、git diff --check；并在桌面 1440×900 与移动 390×844 下检查 Paper、Legacy 双主题无 JS 报错、无横向溢出。完成后更新 task_plan.md / progress.md / findings.md。

现在等待我指定具体批次任务。
```

### 提示词 R0 · 设计令牌基座

```
执行 docs/UI_REDESIGN_V3.md §10.2 批次 R0（设计令牌基座）。要点：

1. 重写 public/css/theme-tokens.css 为三层 token 架构（§3.1）：原始色板层（--paper-*/--dark-*/--light-*/--legacy-* 前缀）→ 语义层（--surface/--border/--text 等，沿用现有命名以保旧组件兼容，只新增不删除，如新增 --surface-sunken、--accent-soft、--info）→ 组件层（--btn-bg 等派生，写在 components-global.css 顶部）。
2. 按 §3.1 的 token 表重写 Paper/Legacy 色板；Legacy 主题纯 hex、零 OKLCH。
3. 字体策略改为系统栈优先（§3.2 --font-sans/--font-mono/--font-serif）：Google Fonts 改为 media="print" onload 异步加载 + noscript 回退，Legacy 跳过；正文/标题字号切换到五级字阶。
4. 断点统一：全仓把 640px 相关媒体查询迁移到 700px（§8），同步 app-mobile.js 的 MOBILE_BP=700；CSS 与 JS 断点必须一致。
5. 在 scripts/check-css-entrypoints.mjs 中新增两项检查：页面 CSS（pages.css/workspace.css/components-*/mobile.css/ui-enhance/*）不得引用第 1 层原始色板 token；不得出现 640px 断点字面量。
6. 本批次不改组件视觉，验收标准是旧页面在新 token 下无布局回归、Paper/Legacy 可切换、全部门禁绿。

完成后报告：token 层级说明、迁移的断点文件清单、门禁运行结果。
```

### 提示词 R1 · AppShell 外壳

```
执行 docs/UI_REDESIGN_V3.md §10.2 批次 R1（AppShell）。按 §4 与 §5 实施：

1. 侧栏（public/index.html 模板 + workspace.css）：9 个入口重组为「检索与验证 / 文件与记录 / 运维」三组 + 底部系统设置（§4.1）；组标签样式、组间距 20px；新增折叠为 56px 图标模式（localStorage 记忆，折叠时悬浮提示完整名称）；游客模式按 data-admin-only 隐藏后组自动收缩。
2. 顶栏：布局按 §4.2（折叠钮/品牌/源健康/主题/账户），为 R2 的命令面板预留一个隐藏入口按钮（aria-label="命令面板"）。
3. 垂直权威栈（§5.1）：topbar → env-warning → page-header → work-area 的层叠顺序在 workspace.css 中固化；每页补 page-header 结构（§5.2 模板，标题与用途文案沿用现有），页面状态放 StatusStrip 独立区。
4. 移动端：mobile.css 对齐 700px 断点，底部四入口 tabbar 保持，层叠与 safe-area 规则按 §4.3。
5. SelectionBar 骨架样式（§6.2）写入 components-global.css，本批次只做样式与容器，不接业务。

约束：所有既有 DOM ID、data-tab 值、switchTab 调用关系保持不变，只允许调整外层模板结构与类名。验收：9 个页面全部可进入、Paper/Legacy 正常、折叠/展开可用、门禁全绿。
```

### 提示词 R2 · 命令面板

```
执行 docs/UI_REDESIGN_V3.md §10.2 批次 R2（命令面板）。按 §4.2 实施：

1. 新建 public/js/app-command-palette.js（纯原生 JS 单文件）与 public/index.html 挂载点，样式追加到 components-global.css。
2. 能力：Ctrl+K / Cmd+K 唤起居中浮层（最大 640px 宽）；① 列出 9 个功能面按输入模糊过滤，回车跳转（复用 switchTab）；② 快捷动作：切换 Paper/Legacy；③ 当输入非空且无导航命中时，提供「检索 "<输入>"」动作，回车后 switchTab('search') 并填充 #searchInput 触发既有搜索流程（不改搜索逻辑）。
3. 键盘契约：↑↓ 选择、Enter 确认、Esc 关闭；打开时焦点入输入框、关闭时焦点还原触发按钮；焦点圈闭在面板内；捕获阶段 Esc 不得同时关闭底层弹层（沿用全局 Escape 单层关闭契约）。
4. 挂载 window.StdHub.commandPalette；注册到 StdHub.lifecycle；触发按钮为 R1 预留的顶栏入口（aria-label="命令面板"，可见快捷键提示 kbd 样式）。
5. 移动端：命令面板不启用（≤700px 隐藏入口），不做移动适配。

验收：键盘全流程、游客/管理员均可用（跳转目标遵守 allowedTabs 与 data-admin-only）、Paper/Legacy 正常、门禁全绿。
```

### 提示词 R3 · 核心检索

```
执行 docs/UI_REDESIGN_V3.md §10.2 批次 R3（核心检索）。按 §6.1、§6.2、§6.3、§6.5 与 §7.1 实施：

1. SearchWorkbench（§6.1）落地到标准检索页与 Labr 模式：搜索输入 40px、--surface-sunken 底、聚焦 --accent 边 + --accent-soft 外环；来源 chips 改为切换型胶囊（选中态 accent-soft 底 + accent 文字），视觉权重低于搜索框；最近搜索与模板仅空态出现。
2. ResultRow（§6.2）：结果行信息优先级重排（标准号 mono 600 → 名称 → 状态徽章 → 来源 → 资质 → 日期 → 操作）；预览为可见主操作；危险动作进 ⋯ 菜单；勾选后浮现 SelectionBar（接入现有批量选择逻辑，不改选择契约）；分组头 sticky 可折叠（沿用折叠记忆）。
3. StatusBadge 族（§6.3）：统一徽章三档尺寸与六种语义（含「暂停」虚线灰），全站替换现有散落徽章样式；一单行最多 3 个，超出 +n 收纳。
4. EmptyState 族（§6.5）：六种空态组件落地（未开始/无匹配/暂无数据/加载失败/权限不足/已暂停），搜索页先接入。
5. 源进度显示改为 StatusStrip chips（BZ ✓ / BW 60% / BY ✓），替换现有进度条形态。
6. 移动端：结果卡片化、44px 主操作、长按上下文菜单沿用，预览失败兜底按钮保留。
7. Labr 行改资源列表形态（§7.1），已下载标记与资质徽章沿用现有数据字段。

约束：app-search*.js / app-labr.js 只允许改模板字符串与类名，禁止改请求参数、状态机与事件契约。验收：搜索、批量选择、收藏、预览、分组折叠全部行为不变；门禁全绿。
```

### 提示词 R4 · 资质与 CMA

```
执行 docs/UI_REDESIGN_V3.md §10.2 批次 R4（资质与 CMA）。按 §6.4、§7.2、§7.3 实施：

1. 资质页（§7.2）：普通/详细/批量三模式换 SegmentedTabs（稳定切换、URL 不变）；标准号查询三分区（精确/同系列·跨年/全文）区头带数量徽章；详细查询的高级条件迁入可持续编辑的 FilterDrawer（§6.4：右侧 360px 抽屉、Esc 关闭、焦点圈闭、移动端转底部面板）；批量查询左输入解析摘要 + 右分组结果。
2. CMA 一单一库（§7.3）：顶部固定 StatusStrip（范围/数据时间/同步状态/异常计数，点异常即筛）；唯一主操作=同步，导出/诊断/黑名单/清理收进 ⋯ 更多菜单（保留原 ID 与 handler，仅收纳入口）；能力项目库/机构比对/领域订阅为页内 SegmentedTabs；结果默认「异常优先」排序，5 档比对状态用 StatusBadge；高级筛选进 FilterDrawer。
3. FilterDrawer 通用化：复用现有 app-filter-drawer.js 的骨架，抽成可复用组件（挂 StdHub.ui.filterDrawer），供资质与 CMA 两页共用。
4. 移动端：资质结果按标准号 sticky 分组 + CNAS/CMA 分段折叠；CMA 的 ⋯ 菜单转底部 action sheet。

约束：app-qual*.js / app-cma-diff*.js / app-filter-drawer.js 只改模板与入口收纳，不改查询参数、订阅、同步、导出契约。验收：三模式查询、订阅、同步、导出、黑名单逐项点验不变；门禁全绿。
```

### 提示词 R5 · 文件与记录

```
执行 docs/UI_REDESIGN_V3.md §10.2 批次 R5（文件与记录）。按 §6.2、§7.4、§7.5、§7.6 实施：

1. 本地文件库（§7.4）：系列父行 + 版本子行表格重排（标准号 mono、版本折叠计数、资质/能力库徽章）；浏览态工具栏（搜索/筛选/统计/分页）安静排布；SelectionBar 接入现有批量逻辑（下载到本地/移动/删除，删除为 danger 红字）；行操作 = 预览主按钮 + ⋯ 菜单（重命名/打开位置/复制路径/删除）；移动端卡片 + 底部浮动 SelectionBar。
2. 下载历史（§7.5）：改日期分组时间轴（今天/昨天/更早），行 = 标准号 + 来源徽章 + 状态 + 时间 + 操作（重下载/定位文件）；筛选进工具栏；清空历史在 ⋯ 菜单 + 独立确认弹窗（文案明确仅删记录不删文件）；空态用 EmptyState。
3. 工具箱（§7.6）：三工具共享左输入右结果工作台（SegmentedTabs）；查新 = 左清单输入 + 右分类变更分组；批量下载 = 左 textarea + 解析摘要 + 右下载队列（复用任务行组件）；标准补全 = 四步向导（选择文件→配置字段→执行→下载结果）带 24px 步骤条；移动端上下堆叠 + 输入卡折叠。

约束：app-file-library.js / app-download*.js / app-complete.js / app-check.js 只改模板与类名；rename/delete/移动的补偿逻辑、分页按系列计算、100 条历史上限契约不变。验收：导入、重命名、删除、扫描、批量下载到本地、重下载、定位文件逐项点验；门禁全绿。
```

### 提示词 R6 · 运维与配置

```
执行 docs/UI_REDESIGN_V3.md §10.2 批次 R6（运维与配置）。按 §6.6、§6.8、§7.7–§7.10 实施：

1. 运行日志（§7.7）：高密度控制台布局——顶部运行摘要 chips（今日事件/错误/警告，点击即筛）、唯一筛选栏（查询/时间/级别/来源）、虚拟滚动事件流（mono 时间戳 + 级别徽章 + 摘要）、行点击展开载荷；自动刷新开关留工具栏、离开页面自动停（现有契约）。
2. 使用统计（§7.8）：时间范围分段控件并入 page-header；KPI 改一行数字摘要（非三卡）；趋势为主视图，Chart.js 颜色从 CSS token 派生并监听 themechange 重绘；总量为零整页 EmptyState。
3. 系统设置（§7.9）：桌面左侧 200px 粘性分区导航 + 右侧 SettingsRow（§6.8 统一标签/说明/控件/即时状态/保存反馈），分组顺序保持（下载/文件库/订阅/同步/诊断/关于）；危险区独立 danger 分组；移动端分区列表 → 单分区视图。
4. 我的页（§7.10）：账户摘要卡 + 主题 SegmentedButtons + 收藏本地摘要 + 版本/在线状态；入口遵守 allowedTabs。
5. 独立任务中心不实施；下载、同步和导出反馈保留在各自工作页（见 §6.6 产品修订）。

约束：app-log.js / app-auth-stats.js / app-settings.js 只改模板与类名；统计口径、设置原子更新、日志筛选契约不变。验收：日志筛选、统计渲染、设置保存与诊断全部点验；门禁全绿。
```

### 提示词 R7 · 全局质量收尾

```
执行 docs/UI_REDESIGN_V3.md §10.2 批次 R7（全局质量收尾）。按 §6.7、§6.9、§9 与 §12 实施：

1. Dialog/Confirm/Prompt 统一重皮（§6.7）：遮罩、圆角 12px、操作区右下、主按钮唯一；核验焦点契约（打开同步聚焦/关闭还原/捕获阶段单层 Esc）；全仓 grep 确认无原生 alert/confirm/prompt 残留。
2. Toast 重皮（§6.9）：语义色左边条 3px、可堆叠 ≤3、hover 暂停、移动端避开 tabbar。
3. PDF 阅读器对齐（§7.11）：preview-reader.css 映射新 token（安静画布、单一工具栏、生成状态细进度条）；严禁改懒加载/缓存/回收/缩放/切源/下载逻辑。
4. 无障碍专项（§9）：焦点环全局统一 2px accent；图标按钮 aria-label 补全；分组 role/aria、进度 role="progressbar"；prefers-reduced-motion 全局短路。
5. 全量视觉回归：桌面 1440×900 + 移动 390×844 × Paper/Legacy（Paper 优先）× 游客/管理员，逐页截图核对 §12 验收清单；控制台零报错、无横向溢出。
6. 清理：删除迁移过程中遗留的死样式与 640px 残留；核对 ui-enhance/* 与新组件无重复实现。
7. 更新文档：README「全站 UI 重构 V3」段落、docs/WHOLE_APP_UI_REDESIGN.md 顶部加废止声明指向本文件、task_plan/progress/findings 记录最终门禁与回归结果。

验收：docs/UI_REDESIGN_V3.md §12 验收清单逐项打勾，全部门禁绿。
```

---

## 附：V3 与上一轮的差异速览

| 维度 | V2（WHOLE_APP_UI_REDESIGN） | V3（本方案） |
|---|---|---|
| 色彩架构 | 组件 hardcode + themes.css 大段覆盖 | 三层 token，页面禁引原始色板，新增 tokens:check 门禁 |
| 字体 | Google Fonts 阻塞加载 | 系统栈优先，Web 字体异步渐进增强 |
| 断点 | 640 为主，阅读器 700，分裂 | 700/1024/1440 统一，CSS/JS 同源，640 被门禁禁止 |
| 导航 | 9 入口平铺 | 三语义分组 + 可折叠 + Ctrl+K 命令面板 |
| 空态 | 分散处理 | 六种空态统一组件族 |
| 组件 | 蓝图描述为主 | 逐组件状态/尺寸/token/契约规格 + SelectionBar 等补全 |
| 验收 | 双主题双端人工检查 | 人工检查 + 两个新增脚本门禁 |

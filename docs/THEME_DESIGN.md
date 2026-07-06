# 主题系统设计文档

> 给"换电脑继续让 AI 设计"准备:一个 AI 拿到这份文档就能续上设计工作,无需重读全部代码。

## 一、当前状态总览

bzxz 项目有 **3 套主题**,由 `<html data-theme="...">` 驱动,localStorage `'bzxz.theme'` 持久化。

| Theme | 关键词 | 灵感 | accent |
|---|---|---|---|
| **dark** (default) | 工业玻璃 | Glass Morphism | `oklch(66% 0.20 250)` 亮蓝 #4f6df0 |
| **light** (Arctic Blue) | 蓝图纸 / 工程师工作台 | Linear / Apple HIG | `oklch(52% 0.20 250)` 深蓝 #2855d4 |
| **paper** (Claude Linen) | 杂志内页 / 印刷品 | Claude.ai / Anthropic | `oklch(58% 0.13 35)` 赤陶 #c96342 |

切换入口:
- 桌面 topbar `📊 ☀️/🌙/📜 👤` 中间图标点击展开 3 选 1 picker
- 手机「我」页 `🎨 主题 [🌙 深色] [☀️ 浅色] [📜 Paper]` chip 行

## 二、核心文件结构

```
web/src/styles/
├── base.css                   ── :root token + :root[data-theme="light/paper"] token 覆写 + 滚动条
├── theme/glass.css            ── 所有主题的 hardcode 色值 override(玻璃面板/btn/cards/徽章 等)
│                                  分 3 段:
│                                    第 1 段 dark 玻璃主题(默认,无 :root[data-theme] 前缀)
│                                    第 2 段 :root[data-theme="light"] 覆写(~290 行)
│                                    第 3 段 :root[data-theme="paper"] 覆写(~280 行)
│                                    第 4 段 Phase 2 补丁(~610 行,light + paper 各 50+ 处灰灰修复)
└── components/result-card.css 等
    ── 各组件本身用 var(--surface/--border/...),自动跟主题切换
    ── 但很多有 hardcode oklch(20% ...) 暗色,需要在 glass.css 用
       :root[data-theme="X"] .selector { ... } 覆盖

public/styles.css ── legacy 入口,必须镜像 web/src/styles/* 所有变更
                     用户的 Electron 安装包入口走 public/index.html,所以两份要严格同步
public/js/app-theme.js ── 主题切换 helper,VALID=['dark','light','paper'],
                          暴露 bzxzTheme.get/set/toggle/togglePicker
```

## 三、设计哲学(按主题)

### 1. dark — Glass Morphism(默认,不动)
- ambient gradient 3 层:`oklch(20% 0.05 270)` 浅蓝 / `oklch(20% 0.04 320)` 浅紫 / `oklch(18% 0.03 200)` 浅青
- body::before 1px 网格:`oklch(100% 0 0 / 0.018)` 极淡白线
- 所有玻璃容器 `backdrop-filter: blur(22-28px) saturate(140%)`
- btn-primary 蓝→紫渐变 `linear-gradient(135deg, oklch(66% 0.22 250), oklch(60% 0.22 285))`
- text 偏冷白 `oklch(92% 0.005 255)`

### 2. light — Arctic Blue 蓝调亮色
**五条核心约束(每条都不能违反):**
1. **永不纯白** — `--bg` 极淡蓝白 `oklch(98% 0.006 245)` / `--surface` 带蓝调 `oklch(99.5% 0.003 245)` / `--surface-elevated` 纯白只留 dropdown
2. **Cold Shadow** — 所有阴影 `hue=245` 蓝调而非纯黑(`--shadow-sm` 用 `oklch(50% 0.05 245 / 0.08)`)
3. **frosted glass 必加 `saturate(180%)`** — 亮底单纯 blur 是灰白糊,要饱和度回拉
4. **accent L=52** — `oklch(52% 0.20 250)` ≈ `#2855d4`,保 a11y 对比度
5. **同色系明暗渐变** — btn-primary 走 `56%→48%` 同蓝不同明度,不用廉价双色

ambient gradient 3 层(替换 dark 的深色版本):
- 左上 `oklch(85% 0.08 240 / 0.40)` 极淡天蓝
- 右下 `oklch(85% 0.06 290 / 0.30)` 淡薰衣草
- 中下 `oklch(88% 0.05 200 / 0.25)` 淡青蓝

body::before 网格:`oklch(35% 0.10 245 / 0.04)` 深蓝 4% 蓝调暗线(蓝图纸感)

### 3. paper — Claude Linen 温暖印刷品
**五条核心约束:**
1. **米白不是白** — `--bg` 奶油亚麻 `oklch(95% 0.018 75)`,永不让屏幕反光晃眼
2. **边界靠 1px 边线,不靠阴影** — claude.ai 卡 99% 是白底 + 米褐边,几乎无 shadow
3. **accent 是 Burnt Sienna 赤陶** — Anthropic 品牌色 `oklch(58% 0.13 35)` ≈ `#c96342`
4. **文字带暖色调** — `--text` 带 `hue=60` 黄褐倾向,油墨印刷感
5. **frosted glass 全面退场** — topbar/sidebar/search-row 全部 `backdrop-filter: none`

**差异点**(独有,与 light/dark 不同):
- html 纯 `var(--bg)` 米色平铺,**不做 ambient radial gradient**
- body::before 网格 **`display: none`**(纸面要干净)
- btn-primary 用 **纯色赤陶**,不用渐变(claude.ai 风格)

## 四、完整 token 表(从 base.css 复制过来,AI 续作时直接查)

### dark(默认 :root)

```
--bg:        oklch(14% 0.018 255)
--surface:   oklch(19% 0.014 255)
--surface-h: oklch(23% 0.018 255)
--border:    oklch(27% 0.012 255)
--text:      oklch(92% 0.005 255)
--text-2:    oklch(72% 0.012 255)
--text-3:    oklch(50% 0.015 255)
--accent:    oklch(66% 0.20 250)   蓝
--accent-h:  oklch(72% 0.22 250)
--accent-g:  oklch(66% 0.10 250)
--success:   oklch(70% 0.16 158)
--danger:    oklch(60% 0.20 25)
--warning:   oklch(70% 0.14 85)
--glass-bg:     oklch(17% 0.016 255 / 0.72)
--glass-border: oklch(32% 0.014 255 / 0.45)
```

### light (Arctic Blue)

```
--bg:        oklch(98% 0.006 245)
--surface:   oklch(99.5% 0.003 245)
--surface-h: oklch(96% 0.012 245)
--surface-elevated: oklch(100% 0 0)
--border:    oklch(90% 0.015 245)
--border-strong: oklch(82% 0.020 245)
--text:      oklch(20% 0.02 245)
--text-2:    oklch(45% 0.018 245)
--text-3:    oklch(62% 0.015 245)
--accent:    oklch(52% 0.20 250)   深蓝
--accent-h:  oklch(48% 0.22 250)
--accent-g:  oklch(72% 0.10 245)
--accent-soft: oklch(95% 0.025 245)
--success:   oklch(48% 0.16 158)
--danger:    oklch(54% 0.20 25)
--warning:   oklch(58% 0.14 80)
--glass-bg:     oklch(100% 0 0 / 0.78)
--glass-bg-strong: oklch(100% 0 0 / 0.92)
--glass-border: oklch(85% 0.020 245 / 0.6)
--shadow-sm: 0 1px 2px oklch(50% 0.05 245 / 0.08)
--shadow-md: 0 4px 12px -2px oklch(50% 0.10 245 / 0.10), 0 2px 6px oklch(50% 0.05 245 / 0.06)
--shadow-lg: 0 12px 32px -8px oklch(50% 0.12 245 / 0.16), 0 4px 12px oklch(50% 0.08 245 / 0.08)
--shadow-glow-accent: 0 0 0 4px oklch(52% 0.20 250 / 0.10), 0 8px 24px -6px oklch(52% 0.20 250 / 0.25)
```

### paper (Claude Linen)

```
--bg:        oklch(95% 0.018 75)   奶油亚麻
--surface:   oklch(98% 0.010 80)
--surface-h: oklch(93% 0.020 75)
--surface-elevated: oklch(100% 0 0)
--border:    oklch(86% 0.025 75)   米褐
--border-strong: oklch(76% 0.035 75)
--text:      oklch(22% 0.012 60)   暖墨色
--text-2:    oklch(45% 0.018 70)
--text-3:    oklch(60% 0.020 75)
--accent:    oklch(58% 0.13 35)    Burnt Sienna 赤陶
--accent-h:  oklch(53% 0.14 32)
--accent-g:  oklch(70% 0.04 60)
--accent-soft: oklch(93% 0.030 50)
--success:   oklch(52% 0.13 130)   苔藓绿
--danger:    oklch(50% 0.18 30)    暖红(赤陶同系)
--warning:   oklch(58% 0.13 75)    琥珀金
--glass-bg:     oklch(98% 0.010 80 / 0.78)
--glass-bg-strong: oklch(100% 0 0 / 0.94)
--glass-border: oklch(86% 0.025 75 / 0.6)
--shadow-sm: 0 1px 2px oklch(40% 0.04 70 / 0.05)
--shadow-md: 0 4px 12px -2px oklch(40% 0.04 70 / 0.08), 0 2px 6px oklch(40% 0.04 70 / 0.04)
--shadow-lg: 0 12px 32px -8px oklch(40% 0.05 70 / 0.12), 0 4px 12px oklch(40% 0.04 70 / 0.06)
--shadow-glow-accent: 0 0 0 4px oklch(58% 0.13 35 / 0.12), 0 6px 18px -4px oklch(58% 0.13 35 / 0.22)
```

## 五、覆盖到的组件清单(共 ~80 处)

主题切换时,以下组件必须在 light + paper 都正确显示。改任何一个组件的色值时,要同步更新两套覆盖。

### 全局
- html(ambient gradient)
- body::before(grid)
- ::webkit-scrollbar-thumb

### 布局
- topbar / .topbar-logo / .topbar-btn:hover / #downloadCenterBadge / .source-health-mini
- sidebar / .sidebar-item:hover/.active / .sidebar-item.active::before / .sidebar-user-avatar / .sidebar-sep
- mobile-tabbar / .mobile-tab.active

### 控件
- .btn-primary(渐变 / 阴影)
- .btn-primary:hover
- .btn-ghost / .btn-ghost:hover
- .btn:disabled / .btn[disabled]

### 搜索
- .search-row / .search-row:focus-within
- .search-templates button / hover
- .source-tag.active / .filter-chip.active
- .toolbar / .toolbar .btn.active / .badge-count / .filter-sep / .filter-sort select
- .src-prog-chip / -loading / -ok / -fail
- .status-group-header / hover
- .search-history / .search-history-item:hover

### 结果卡
- .result-card / .result-card:hover / .row-active / .saved
- .result-card .card-actions button(各 disabled / save.saved / download)
- .source-bz / .source-gbw / .source-by(BZ/BW/BY 源徽章)
- .has-text-badge / .no-text-badge / .text-badge-checking
- .status-indicator.current / .expired / .upcoming

### 资质
- .qual-badge-cnas / .qual-badge-cma
- .qual-source-chip-cnas / .qual-source-chip-cma
- .qual-scope-badge.scope-all / .scope-partial
- .qual-result-group(手机端卡片化)

### 弹层
- .confirm-card / .confirm-overlay
- .modal / .modal-overlay
- .preview-overlay
- .download-center / .user-dropdown / .shortcuts-panel / .auth-card-fallback
- .ctx-menu / .ctx-menu-item:hover
- .detail-chip

### batch / complete / labr
- .batch-card / .batch-mode-pill / .batch-results-empty / .batch-stat
- .batch-result-card / hover / .card-src
- .batch-textarea / :focus
- .complete-card / .complete-step / .step.active/.done/.error
- .complete-dropzone / .complete-status / .complete-options .check-option
- .complete-result-stats div / .complete-download-card
- .labr-row(手机端卡片化)

### 进度条
- .progress-track / .progress-fill

### 日志
- .log-panel / .log-header:hover / .log-summary span / .log-item

### 「我」页主题切换
- .me-theme-btn.active
- .topbar-theme-picker / -item:hover / .active

## 六、改一处怎么改(workflow)

**场景:用户说"X 组件在 light 主题下颜色不对"**

1. **定位**:`grep -n ".组件名" web/src/styles/` 找到组件定义
2. **检查**:看组件的 base CSS 是否用 `var(--surface)` / `var(--border)` 等 token
   - **如果是** → 加 / 调 token 即可
   - **如果不是**(hardcode oklch 深色)→ 在 `glass.css` 末尾 "Phase 2 补丁段"加 `:root[data-theme="light"] .组件名 { ... }` override
3. **paper 同步**:加完 light 立即在 paper 段加同款 override(配色换 paper 系)
4. **镜像**:把 web/src/styles/theme/glass.css 的改动同步到 public/styles.css 末尾(legacy 入口契约)
5. **测试**:切换 3 主题验证

## 七、CLAUDE.md 强制约定(不能改的硬约束)

- 所有新写 `oklch(...)` 必须有 sRGB hex/rgba **双声明 fallback**(Win7 Chrome ≤109 兼容)
- 所有 CSS 改动**两份同步**:`web/src/styles/*` + `public/styles.css`
- `web/src/styles/pages/announcement.css` 和 `pages/admin.css` 用**亮色调色板**,**不要用 var(--*)**(会被全局暗色主题覆写)
- 主题不影响 announcement / admin 这两个页面(它们独立调色板)

## 八、可能的下一步(给续作 AI 的建议)

如果用户希望:
- **加第 4 主题**(比如 nord 北欧极简) → 复制 paper 的 token 表 + glass.css 覆盖段,改色板;app-theme.js VALID 数组加 'nord';index.html 加 chip / picker 项
- **token 简化**(消除大量 override) → 把组件级 hardcode oklch 逐步迁移到 `var(--surface)` 系列,这样切主题不需要写一堆 override。但工作量极大,建议保持现有"覆盖式"模式
- **每个主题专属字体** → base.css `:root[data-theme="paper"] html { font-family: 'Crimson Pro', ... }`,但要加字体加载(performance 成本)
- **chart.js 颜色跟主题** → 订阅 `document.addEventListener('themechange', ...)`,JS 端重绘图表色板

## 九、关键 commit 索引

| commit | 内容 |
|---|---|
| `769576a` | feat: 双主题切换底层 + dark default |
| `48f5a43` | redesign light: Arctic Blue 完整版 |
| `e4bca5f` | feat: paper 主题 + 3-way picker |
| (本次)  | fix: 50+ Phase 2 补丁修复"灰灰"残留 |

## 十、AI 续作起手指南

读这份文档 + 看 `web/src/styles/base.css` `:root[data-theme]` 段 + 看 `web/src/styles/theme/glass.css` 全部,基本可以接手。

如果用户描述模糊("某 X 颜色不对"),先**截图 + 切到 dark 对比** —— 大概率是 hardcode 色没被 light/paper 覆盖,按"workflow"加 override。

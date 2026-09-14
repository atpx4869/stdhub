# 手机端标准检索页首屏密度优化方案

> 状态：待评审（尚未落地代码）
> 适用版本：当前 `public/` 静态前端（`index.html` + `css/` + `js/`）
> 基准视口：390 × 844（iPhone 14 / Mate 60 同档），`--topbar-h: 56px`，底部 tabbar 56px

---

## 一、问题现象

用户反馈（附两图）：

1. 手机端搜索页上半部分占用过高，**核心搜索结果列表被挤到屏幕最下方**，首屏几乎看不到结果卡片。
2. **最近搜索**占用过大 → 要求缩小字体与框体，最好只占一行。
3. **常用模板**占用过高 → 同样要求压到一行。

第二张图中还能看到「最近搜索 / 常用模板」的文字**浮在结果卡片之上**——这是吸顶区未收敛产生的视觉残影。

---

## 二、实测根因（已定位到具体文件与行号）

### R1 · 全局 44px 最小尺寸污染了所有 chip

`public/css/ui-enhance/mobile.css:32-53`

```css
@media (max-width: 700px) {
  body:not(.force-desktop) button, ... { min-height: 44px; }

  .btn, .btn-sm, .sidebar-item, .source-tag, .filter-chip, .mobile-tab,
  .search-templates button, .search-history-tag-query, .search-history-tag-remove,
  .topbar-btn, .topbar-toggle { min-height: 44px; min-width: 44px; }
}
```

来源圆点、模板 chip、历史 chip 全部被强制 **44px 高 / 44px 宽**。
→ 这是「字体框体改小一点」这个诉求的**首要拦路石**：即使改了字号，高度也不会降。

### R2 · `polish.css` 再次把来源标签钉死在 44px 并居中

`public/css/ui-enhance/polish.css:477-482`

```css
body:not(.force-desktop) #page-search .source-tags { justify-content: center; order: 0; }
body:not(.force-desktop) #page-search .source-tag { min-width: 44px; min-height: 44px; }
```

`polish.css` 是最后一个加载的样式表（`index.html:79`），优先级最高，所以手机端 BZ / BW / BY 变成三个 44px 的圆点并居中独占一行。

### R3 · 搜索区内 5 个子块之间统一 16px 间距

`public/css/ui-enhance/polish.css:316-320`

```css
#page-search .search-area { display: grid; gap: 16px; }
```

source-tags / search-row / caption / history / templates → **4 × 16 = 64px 纯间距**。

### R4 · 「最近搜索」标题独占一行

`public/js/app-file-library.js:38-48` 渲染出的 DOM：

```html
<div class="search-tag-row-head">
  <span class="search-tag-row-label">最近搜索</span>
  <button class="search-history-clear">清空</button>
</div>
<div class="search-tag-list">…</div>
```

`.search-tag-row-head` 是 `display:flex` 的独立块（`components-global.css:66`），**标题与清空按钮占掉一整行**，与 chip 列表上下堆叠。

### R5 · chip 列表 `flex-wrap: wrap` → 模板折成两行

`public/css/components-global.css:68`

```css
.search-tag-list { display: flex; flex-wrap: wrap; gap: 6px; }
```

6 个模板（GB/T、GB、YY/T、JJG、DB44/T、ISO）在 390px 宽度下必然折成 2 行，每行 44px → 加上 gap 与标题，**常用模板块实测 111px**。

### R6 · 吸顶是整块 `.search-area` 吸顶，不是只吸输入框 ★ 最大元凶

`public/css/mobile.css:631-647`

```css
body:not(.force-desktop) #page-search.search-stage-active .search-area {
  position: sticky;
  top: var(--topbar-h);
  z-index: 50;
  background: oklch(18% 0.018 260 / 0.92);
  backdrop-filter: blur(14px) saturate(140%);
  ...
}
```

`.search-area` 包含 **source-tags + search-row + caption + history + templates** 五个子块。

**实测吸顶高度 ≈ 370px**，占 844px 视口的 **44%**，且带半透明背景 + 模糊——
结果卡片从其下方滚过时，就成了第二张截图里那层「浮在卡片上的字」。

### R7 · 提示文案与 placeholder 语义重复

`public/css/ui-enhance/polish.css:399-404`

```css
#page-search .search-input-caption { margin: -8px 0 0; font-size: 12px; line-height: 18px; }
```

「标准号包含年份时，请填写完整的 4 位年份。」独占一行 17px + 8px gap = **25px**，信息与 placeholder 高度重叠。

### R8 · 结果统计与来源进度分两行

`public/index.html:208-209` —— `#summary`（找到 36 条结果）与 `#sourceProgressStrip`（BZ 20 条 / BW 20 条 / BY 0 条）是兄弟节点，各自占一行 ≈ 54px。

### R9 · 手机端仍显示管理型工具栏，与既有契约矛盾

`public/css/mobile.css:593-605` 已明确写着手机端定位是「查阅而非管理」，并已隐藏：

- `.result-card [data-action="save"]`
- `[data-filter-toggle="saved"]`
- `#meRowHistory` / `.sidebar-item[data-tab="history"]`

但 `#toolbar`（已选 0 / 下载选中 / 全选）**依然显示**，占 56px。逻辑上应当一并收掉。

### 已确认的非问题

- `.search-page-intro { display: none }`（`public/css/workspace.css:1634-1636`）—— 页面大标题在手机端**已经隐藏**，无需再动。

---

## 三、现状高度预算表

| 区块 | 现状 | 目标 | 差额 |
|---|---:|---:|---:|
| 顶栏 | 56 | 56 | 0 |
| content padding-top | 16 | 12 | −4 |
| 模式标签（标准检索 / Labr 补给） | 52 | 42 | −10 |
| 来源行 BZ / BW / BY | 44 | 30 | −14 |
| 搜索框 | 56 | 46 | −10 |
| 提示文案 | 17 | 0 | −17 |
| 最近搜索 | 82 | 30 | −52 |
| 常用模板 | 111 | 30 | −81 |
| 结果统计 + 来源进度 | 54 | 30 | −24 |
| 工具栏 | 56 | 0 | −56 |
| 筛选折叠按钮 | 48 | 34 | −14 |
| **search-area 内 4 处 16px 间距** | 64 | 32 | −32 |
| search-area margin-bottom | 24 | 12 | −12 |
| **顶部占用合计** | **716** | **356** | **−360** |
| **首屏可用结果区** | **72** | **432** | **+360** |

可达卡片数：0.4 张 → **约 2.5 张完整卡片**。

滚动后（吸顶收敛）另有 −116px：吸顶区 370 → 46px，可用结果区 362 → 686px。

---

## 四、优化方案

### P0 —— 纯 CSS，零结构风险（合计 −193px）

#### P0-1 解除 44px 最小尺寸对 chip 的污染

文件：`public/css/ui-enhance/mobile.css`

从 L40-53 的选择器列表中**移除**下列四项，其余（`.btn` / `.filter-chip` / `.topbar-btn` 等）保持不动：

- `.source-tag`
- `.search-templates button`
- `.search-history-tag-query`
- `.search-history-tag-remove`

在同文件末尾追加：

```css
@media (max-width: 700px) {
  body:not(.force-desktop) {
    --m-chip-h: 30px;
  }
  body:not(.force-desktop) .source-tag,
  body:not(.force-desktop) .search-templates button,
  body:not(.force-desktop) .search-history-tag-query,
  body:not(.force-desktop) .search-history-tag-remove {
    min-height: var(--m-chip-h);
    min-width: 0;   /* 必须覆盖，否则 44px 宽会撑开 DB44/T 这类 chip */
  }
}

/* 视觉 30px、热区 44px：用透明伪元素补足触控面积 */
@media (max-width: 700px) and (pointer: coarse) {
  body:not(.force-desktop) .source-tag,
  body:not(.force-desktop) .search-templates button { position: relative; }
  body:not(.force-desktop) .source-tag::after,
  body:not(.force-desktop) .search-templates button::after {
    content: ''; position: absolute; inset: -7px -2px;
  }
}
```

> 收益 −14px，且解锁后续所有尺寸压缩。

#### P0-2 来源行收 30px、搜索区间距 16 → 8

文件：`public/css/ui-enhance/polish.css`，替换 L477-482：

```css
@media (max-width: 700px) {
  body:not(.force-desktop) #page-search .source-tags {
    justify-content: flex-start;   /* 不再居中，与左边缘对齐 */
    gap: 6px;
    margin: 0;
  }
  body:not(.force-desktop) #page-search .source-tag {
    min-height: 30px;
    min-width: 0;
    padding: 0 12px;
    font-size: 12px;
  }
  body:not(.force-desktop) #page-search .search-area { row-gap: 8px; }
}
```

> 收益 −14（来源行）− 32（间距）= **−46px**

#### P0-3 最近搜索压成单行（82 → 30px）

文件：`public/css/mobile.css` 或 `polish.css` 末段。**不改 DOM、不改 JS**，纯靠 flex 让标题与 chip 列表同行：

```css
@media (max-width: 700px) {
  body:not(.force-desktop) .search-history-tags {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 0;
  }
  body:not(.force-desktop) .search-history-tags .search-tag-row-head {
    flex: 0 0 auto;
    flex-direction: row;
    align-items: center;
    justify-content: flex-start;
    gap: 6px;
    margin: 0;
  }
  body:not(.force-desktop) .search-history-tags .search-tag-row-label,
  body:not(.force-desktop) .search-history-tags .search-history-clear { font-size: 11px; }

  /* chip 列表吃掉剩余宽度并横向滑动，不再换行 */
  body:not(.force-desktop) .search-history-tags .search-tag-list {
    flex: 1 1 0;
    min-width: 0;
    flex-wrap: nowrap;
    overflow-x: auto;
    gap: 6px;
    padding-bottom: 0;
    scrollbar-width: none;
    touch-action: pan-x;
  }
  body:not(.force-desktop) .search-history-tags .search-tag-list::-webkit-scrollbar { display: none; }

  body:not(.force-desktop) .search-history-tag-query { height: 30px; font-size: 12px; padding: 0 4px 0 10px; }
  body:not(.force-desktop) .search-history-tag-remove { width: 22px; font-size: 15px; }
}
```

可选进一步截断只显示前 3 条：

```css
body:not(.force-desktop) .search-history-tags .search-tag-list > .search-history-tag:nth-child(n+4) { display: none; }
```

> 收益 **−52px**（可再 −0，截断项只是减少横向滚动量）
> 注意 R5 风险：截断后用户失去「还有更多」的暗示，建议不加，或末尾补一个 `…` 提示。

#### P0-4 常用模板压成单行（111 → 30px）

```css
@media (max-width: 700px) {
  body:not(.force-desktop) .search-templates { align-items: center; gap: 8px; margin-top: 0; }
  body:not(.force-desktop) .search-templates .search-tag-list {
    flex: 1 1 0;
    min-width: 0;
    flex-wrap: nowrap;
    overflow-x: auto;
    gap: 6px;
    padding-bottom: 0;
    scrollbar-width: none;
    touch-action: pan-x;
  }
  body:not(.force-desktop) .search-templates .search-tag-list::-webkit-scrollbar { display: none; }
  body:not(.force-desktop) .search-templates button { height: 30px; padding: 0 10px; font-size: 12px; }
}
```

> 收益 **−81px**

---

### P1 —— 需少量 JS 或 DOM 微调（合计 −163px 首屏 / −279px 滚动后）

#### P1-1 滚动塌缩吸顶（滚动后 −116px）★ 最高价值

**为什么不能直接把 `.search-row` 改成 sticky：**
`position: sticky` 的约束边界是**最近的块级祖先的 content box**。`.search-row` 是 `.search-area` 的子元素，若让 `.search-row` 单独 sticky，它只能在 `.search-area` 自身高度内吸附——一旦 `.search-area` 滚出视口，吸顶立即失效。

**正确做法：** 保留 `.search-area` 整块 sticky（不改 DOM），通过一个 class 在滚动后把它的子块收起来，高度自然从 370px 塌到 46px。

CSS：

```css
@media (max-width: 700px) {
  body:not(.force-desktop) #page-search.search-compact .source-tags,
  body:not(.force-desktop) #page-search.search-compact .search-input-caption,
  body:not(.force-desktop) #page-search.search-compact .search-history-tags,
  body:not(.force-desktop) #page-search.search-compact .search-templates { display: none; }

  body:not(.force-desktop) #page-search.search-compact .search-area { row-gap: 0; }
  body:not(.force-desktop) #page-search.search-compact .search-row {
    margin: 0 -14px;
    padding: 8px 14px;
    border: none;
    border-radius: 0;
    box-shadow: none;
  }
}
```

JS（建议追加到 `public/js/ui-enhance-observer.js` 的 `init()`，或独立小文件）：

```js
(function () {
  var page = document.getElementById('page-search');
  if (!page) return;
  var ticking = false;

  function update() {
    ticking = false;
    if (!document.body.classList.contains('layout-mobile')) {
      page.classList.remove('search-compact');
      return;
    }
    var compact = page.classList.contains('search-stage-active') && window.scrollY > 64;
    page.classList.toggle('search-compact', compact);
  }
  function onScroll() { if (!ticking) { ticking = true; requestAnimationFrame(update); } }

  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('tabchange', update);

  // 生命周期资源按 AGENTS.md 契约注册（落地前确认 StdHub.lifecycle 的实际 API 形态）
  var lifecycle = (window.StdHub && window.StdHub.lifecycle) || [];
  lifecycle.push(function () { window.removeEventListener('scroll', onScroll); });
})();
```

> 收益 **−116px**（滚动后）。首屏不受影响，因为首屏 `scrollY === 0`。

#### P1-2 提示文案并入 placeholder（−33px）

```css
@media (max-width: 700px) {
  body:not(.force-desktop) #page-search .search-input-caption { display: none; }
}
```

信息不丢失的替代做法：手机端用更短的 placeholder，例如
`placeholder="标准号含年份请填 4 位，如 GB/T 3324-2024"`，桌面端保留 caption。
（placeholder 由 `index.html:191` 的 `#searchInput` 承载，需要 JS 按 `isMobile()` 分支设置。）

> 收益 **−33px**（17 + 16 gap）

#### P1-3 结果统计与来源进度合并为一行（−24px）

`public/index.html:208-209` 包一层容器：

```html
<div class="search-status-line">
  <div id="summary" class="summary"></div>
  <div id="sourceProgressStrip" class="source-progress-strip" style="display:none"></div>
</div>
```

```css
.search-status-line { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
@media (max-width: 700px) {
  body:not(.force-desktop) .search-status-line { gap: 6px; }
  body:not(.force-desktop) .search-status-line .src-prog-chip { min-height: 24px; padding: 0 8px; font-size: 11px; }
}
```

若不改 DOM，仅压缩两者高度与间距，约 −20px。

> 收益 **−24px**

#### P1-4 筛选折叠按钮 48 → 34px（−14px）

```css
@media (max-width: 700px) {
  body:not(.force-desktop) .filter-collapse { min-height: 34px; padding: 6px 14px; font-size: 13px; }
}
```

---

### P2 —— 需产品取舍（合计 −66px）

#### P2-1 手机端隐藏 `#toolbar`（−56px）

依据 `public/css/mobile.css:593-605` 已确立的「手机端 = 查阅而非管理」契约——下载、收藏、下载历史都已隐藏，`#toolbar` 里的「已选 0 / 下载选中 / 全选」是同一类管理动作，理应一并收掉。

```css
@media (max-width: 700px) {
  body:not(.force-desktop) #toolbar { display: none !important; }
}
```

> 收益 **−56px**。落地前确认 `app-search-core.js` 中 `#selectedCount` / `#downloadSelected` 的读写没有 `offsetWidth` 依赖（`display:none` 不影响 `textContent` / `disabled`）。

#### P2-2 模式标签行压缩 52 → 42px（−10px）

```css
@media (max-width: 700px) {
  body:not(.force-desktop) .search-mode-tabs { border-bottom: none; margin-bottom: 10px; }
  body:not(.force-desktop) .search-mode-tab { min-height: 32px; padding: 0 12px; font-size: 13px; }
}
```

> 更激进的做法：把「标准检索 / Labr 补给」与「BZ / BW / BY」并成同一行（都是"检索范围"语义），可再省 30px。但 Labr tab 带 `data-admin-only`，游客视角下只有 1 个 tab，合并需要条件布局，复杂度不划算，先不做。

---

## 五、落地顺序建议

| 序 | 阶段 | 内容 | 累计节省（首屏） |
|---|---|---|---:|
| 1 | P0 | 解污染 + 间距 + 历史单行 + 模板单行 | −193px |
| 2 | P1-1 | 滚动塌缩吸顶 | 滚动后 −116px |
| 3 | P1-2 / P1-3 / P1-4 | 提示归零 + 统计合并 + 筛选压缩 | −264px |
| 4 | P2-1 | 隐藏 toolbar | −320px |
| 5 | P2-2 | 模式标签压缩 | −330px |

**建议 P0 单独一波提交、单独验收**，因为它是零风险纯 CSS 且已能解决用户 80% 的抱怨（最近搜索与常用模板各压到一行）。P1-1 必须单独一波（含 JS），P2 视产品决策。

---

## 六、验收标准

1. 390 × 844 视口，搜索 `3324` 后**不滚动**，首屏可见 **≥2 张完整结果卡片**（含底部「预览 / 下载」按钮行）。
2. 「最近搜索」「常用模板」各自只占**一行**；chip 视觉高度 30px；可横向滑动。
3. 向下滚动时，「最近搜索 / 常用模板」**不再出现浮在结果卡片上的残影**。
4. `?desktop=1` 强制桌面布局时，以上所有收敛全部失效，桌面端样式与改动前**逐像素一致**。
5. `npm run build`、`npm run css:check` 通过（`scripts/check-css-entrypoints.mjs` 会校验 CSS 入口清单）。
6. 手动回归：搜索页 idle 态（居中大留白）、资质查询页 `#page-qual`、Labr 模式 `#searchModeLabr`、本地文件库均无样式异常。

---

## 七、风险与对策

| 编号 | 风险 | 对策 |
|---|---|---|
| R1 | 削弱 `.source-tag` 等的 `min-height` 会影响其他页面同名元素 | 只删 4 个选择器，`.filter-chip` / `.topbar-btn` / `.btn` 保留；受影响面仅搜索页与来源筛选 |
| R2 | `scroll` 监听增加主线程开销 | `{ passive: true }` + `requestAnimationFrame` 节流 + 仅 `layout-mobile` 生效 |
| R3 | `search-compact` 与 `search-stage-idle/active` 组合态未覆盖 | 落地时在 `doSearch()` 完成与 `tabchange` 回调各补一次 `update()`；测试「搜索后立刻回滚到顶部」能否正确展开 |
| R4 | 横滑容器与页面纵向滚动抢手势 | 加 `touch-action: pan-x`（可参照 `mobile.css:369-371` 现有做法） |
| R5 | `nth-child(n+4)` 截断历史标签后用户感知不到隐藏项 | 建议不启用截断；若启用，末尾补 `…` 视觉提示 |
| R6 | 手机端隐藏 `#toolbar` 后管理员无法批量下载 | 确认产品定位——按现有契约手机端本就只做查阅；若需保留，改为 P2-1 不执行 |
| R7 | `polish.css` 与 `mobile.css` 存在多处同名规则互相覆盖 | 新增规则优先落在 `polish.css`（最后加载，优先级最高），避免与 `ui-enhance/mobile.css` 再打架 |

---

## 八、附：关键代码位置索引

| 主题 | 位置 |
|---|---|
| 全局 44px 最小尺寸 | `public/css/ui-enhance/mobile.css:32-53` |
| 来源标签 44px + 居中 | `public/css/ui-enhance/polish.css:477-482` |
| search-area grid gap 16px | `public/css/ui-enhance/polish.css:316-320` |
| 提示文案 | `public/css/ui-enhance/polish.css:399-404` |
| 整块吸顶 | `public/css/mobile.css:631-647` |
| idle / active 态 class 切换 | `public/css/mobile.css:607-661` |
| 历史 / 模板间距与 chip 尺寸 | `public/css/mobile.css:266-279` |
| 历史标签 DOM 渲染 | `public/js/app-file-library.js:33-49` |
| 模板按钮与点击 | `public/index.html:196-206`、`public/js/app-search-core.js:582` |
| 来源进度条渲染 | `public/js/app-search-core.js:145-161` |
| 结果统计文案 | `public/js/app-search-core.js:228` |
| 搜索区 HTML 结构 | `public/index.html:184-207` |
| 手机端「查阅非管理」契约 | `public/css/mobile.css:593-605` |
| CSS 加载顺序 | `public/index.html:66-80` |
| 页面 intro 已隐藏 | `public/css/workspace.css:1634-1636` |

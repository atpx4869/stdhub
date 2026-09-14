# StdHub 视觉修复交接文档 —— 资质卡片 / 文件库徽章

> **实施状态（2026-09-14）**：本文档的 P0/P1 已完成。落地时按当前代码修正了三点：标准名用“标准号 + 名称”的共享集合去重，避免跨来源/结果分区重复；国家库异步回填后同步更新废止提权和文件库徽章优先级；主题验收以产品实际支持的 Paper / Legacy 为准。项目完整门禁还额外包含 `npm run test:e2e`。

> **给执行本次改动的 AI**：本文档是完整的实施说明，请逐条执行。所有文件路径、行号、CSS 变量名均已在真实代码中核对过（基于 commit `51ad95c`）。改动前请先 `git status` 确认工作区干净。
>
> **阅读顺序建议**：先读「背景」了解设计意图，再读「改动 1/2/3」逐条实施，最后跑「验收」。

---

## 一、背景与设计原则

StdHub 是单实例 NAS 标准检索应用，手机端定位是**查阅而非管理**。当前有两个页面的视觉层级出了问题，问题不在"不好看"，而在**信息权重与语义错配**。

修复遵循四条原则：

1. **一个标准号最多保留一个权限类徽章**。次要状态降级为纯文本，不再抢视觉。
2. **废止 / 过期状态必须比"参数完备"更醒目**。绿色 `全部参数` 与橙色 `已废止` 并置时，用户会先读到绿色而误判为"可用"。
3. **中性状态不得借用危险色**。红色在本项目已语义占用给"破坏性操作 / 失败"。
4. **同分组内不重复渲染同一信息**。标准名在分组内部重复 N 次是纯噪音。

**必须遵守的项目约定**（来自 `AGENTS.md`）：

- 手机端所有新增 CSS 规则必须包在 `body:not(.force-desktop)` 内，保证 `?desktop=1` 逃生口逐像素不受影响。
- 不新增 inline handler，点击事件用 `data-stdhub-click` 或 `addEventListener`。
- 新增前端代码挂 `window.StdHub`。
- 交付前依次跑 `npm run build`、`npm run css:check`、`npm test`、`npm run git diff --check`。
- CSS 加载顺序：`theme-tokens → components-global → mobile → pages → themes → legacy-theme → workspace → preview-reader → ui-enhance/*`。后面的覆盖前面的，新增规则优先放在 `ui-enhance/polish.css`（最后加载）。

---

## 二、改动 1（P0）：资质卡片头重排

**问题**：`public/js/app-qual-search.js:709` 每张卡无条件渲染 `<span class="qual-std-name">`。查 `1952.1` 时 5 张卡片全渲染"软体家具 沙发"，用户要看的"哪家机构、覆盖多少参数"被淹没。

### 1.1 修改 `public/js/app-qual-search.js`

**位置 A** — 在 `for` 循环开始前（约 L628 `var html = '';` 之后）加一行基准名变量：

```js
  var html = '';
  var prevSource = null;
  var groupIdx = 0;
  var lastRenderedStdName = null;   // 新增：同标准名只在第一个分组渲染一次
```

**位置 B** — 替换 L706-710 这段（`<div class="qual-result-std">` 内部拼接）：

```js
    // 旧代码（删除）
    // + '<span class="qual-std-name">' + escapeHtml(cleanName) + '</span>'
    // + (grp.subCategory ? '<span class="qual-group-lab" title="' + escapeHtml(grp.subCategory) + '">' + escapeHtml(grp.subCategory) + '</span>' : '')
    // + '<span class="qual-result-count">' + grp.items.length + ' 项</span>'
```

**新代码**：

```js
    var showStdName = cleanName && cleanName !== lastRenderedStdName;
    if (showStdName) lastRenderedStdName = cleanName;

    html += '<div class="qual-result-group">'
      + '<div class="qual-result-std"' + headerAttrs + '>'
      + arrowHtml
      + sourceChip
      + '<span class="qual-std-code">' + escapeHtml(grp.stdCode || '') + '</span>'
      + (typeof capLibBadgeHtml === 'function' ? capLibBadgeHtml(grp.stdCode || '') : '')
      + (typeof natCmaBadgeHtml === 'function' ? natCmaBadgeHtml(grp.stdCode || '') : '')
      + scopeChip
      + '<span class="qual-result-count">' + grp.items.length + ' 项</span>'
      + '</div>'
      + (showStdName
          ? '<div class="qual-std-name-row">' + escapeHtml(cleanName)
            + (grp.subCategory ? '<span class="qual-group-lab">' + escapeHtml(grp.subCategory) + '</span>' : '')
            + '</div>'
          : '')
      + limitRowHtml
      + bodyHtml
      + '</div>';
```

**关键点**：
- `lastRenderedStdName` 必须声明在 `for` 循环**外面**（位置 A），在循环内累加判断。因为 `groupOrder` 已按 `source → stdCode → labName` 排序（L619-626），同标准号的多个分组是**连续出现**的，这个简单比较就够用。
- 注意 `cleanName` 是 L642 的 `cleanStdNameForQual(grp.stdCode, grp.stdName)` 结果。
- `<span class="qual-std-name">` 改成 `<div class="qual-std-name-row">`，**原有的 `.qual-std-name` 类名不再使用**，但不要删 CSS（见 1.3 说明）。

### 1.2 删除 DOM 里的内联样式

**位置 C** — L693-694 的 `arrowHtml`，硬编码了 `style="display:inline-block;..."`：

```js
    // 旧代码
    var arrowHtml = collapsible
      ? '<span class="qual-group-arrow" id="' + gid + '_arrow" style="display:inline-block;width:16px;font-size:10px;color:var(--text-3);transition:transform 0.2s">▶</span>'
      : '<span style="display:inline-block;width:16px"></span>';
```

**新代码**（样式全部移到 CSS）：

```js
    var arrowHtml = collapsible
      ? '<span class="qual-group-arrow" id="' + gid + '_arrow">▶</span>'
      : '<span class="qual-group-arrow qual-group-arrow-hidden"></span>';
```

### 1.3 新增 CSS

追加到 **`public/css/ui-enhance/polish.css`** 文件末尾（该文件最后加载，优先级最高，避免与 `mobile.css` 的既有规则打架）：

```css
/* ─────────────────────────────────────────────────────────────────────
   资质结果卡：头部权重重排
   - 标准号升为视觉主标题（14px / 500）
   - 权限徽章缩到 10px 且统一走 accent-tinted，避免多色竞争
   - 标准名从"逐卡重复"改为"同标准名渲染一次"
   ───────────────────────────────────────────────────────────────────── */
.qual-result-std {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}

.qual-result-std .qual-std-code {
  font-size: 14px;
  font-weight: 500;
  letter-spacing: 0;
  color: var(--text);
}

/* 权限徽章统一为单色 accent-tinted pill，靠文字区分 CNAS / CMA。
   目的：把"颜色"这个稀缺资源让给状态徽章（废止 / 过期）。 */
.qual-result-std .qual-source-chip,
.qual-result-std .cap-lib-badge {
  font-size: 10px;
  font-weight: 500;
  padding: 1px 7px;
  border-radius: 3px;
  letter-spacing: 0;
}

/* 状态徽章（废止 / 过期）保持有色彩，且加粗，形成明确层级 */
.qual-result-std .qual-scope-badge {
  font-size: 10px;
  font-weight: 500;
  padding: 1px 6px;
  border-radius: 3px;
}

/* 计数移到最右，弱化 */
.qual-result-std .qual-result-count {
  margin-left: auto;
  font-size: 11px;
  font-weight: 400;
  color: var(--text-3);
}

/* 折叠箭头：从内联 style 抽出来 */
.qual-group-arrow {
  display: inline-block;
  width: 14px;
  font-size: 10px;
  color: var(--text-3);
  transition: transform 0.2s;
}
.qual-group-arrow-hidden { width: 14px; }

/* 标准名行：只在该标准名的第一个分组出现 */
.qual-std-name-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: 2px 0 6px 20px;
  font-size: 13px;
  font-weight: 400;
  line-height: 1.4;
  color: var(--text-2);
}
.qual-std-name-row .qual-group-lab {
  font-size: 11px;
  color: var(--text-3);
}

/* 手机端紧凑化 */
@media (max-width: 700px) {
  body:not(.force-desktop) .qual-result-std { row-gap: 4px; }
  body:not(.force-desktop) .qual-result-std .qual-std-code { font-size: 13px; }
  body:not(.force-desktop) .qual-std-name-row {
    margin: 2px 0 4px 18px;
    font-size: 12px;
  }
}
```

### 1.4 处理既有旧规则（重要，别漏）

以下既有规则现在**已经失效或冲突**，需要处理：

| 文件 | 行号 | 内容 | 处理 |
|---|---|---|---|
| `public/css/mobile.css` | 550-556 | `body:not(.force-desktop) .qual-result-std .qual-std-name { flex: 1 1 100%; padding-left: 22px; ... }` | **保留但改选择器**：`.qual-std-name` → `.qual-std-name-row`，其余属性删掉（已由新 CSS 接管），只留 `flex: 1 1 100%` |
| `public/css/mobile.css` | 557-559 | `.qual-result-std > span[style*="margin-left:auto"] { display: none; }` | **删除整条**。这条靠属性选择器匹配内联样式，1.2 已把内联样式全部移除，规则永久失效 |
| `public/css/components-pages.css` | 1000 | `.qual-result-std { font: 500 13px 'DM Mono'... color: var(--accent); }` | `.qual-std-code` 的字号/颜色已在新 CSS 覆盖。保留原规则不删，让新规则生效即可 |
| `public/css/components-pages.css` | 1001 | `.qual-result-std .qual-std-name { color: var(--text-2); font: 400 13px 'DM Sans'... }` | 同上，已被 `.qual-std-name-row` 取代，可保留（无害） |

### 1.5 验证方法

在浏览器控制台执行：

```js
document.querySelectorAll('.qual-result-group').length
document.querySelectorAll('.qual-std-name-row').length   // 应显著小于上一行
document.querySelectorAll('.qual-std-name').length       // 应为 0
```

---

## 三、改动 2（P0）：废止状态提权 + 层级强化

**问题**：`QB/T 1952.1-2012` 卡片上，绿色 `全部参数`（`oklch(62% 0.18 150)`）与橙色 `已废止` 并置，绿色在视觉上压过废止警示。用户先读到"能力完备"，不会注意 10px 的小字。

### 2.1 调整 `scope-all` 的视觉权重（关键）

**文件**：`public/css/components-pages.css:1048-1051`

原代码：

```css
.qual-scope-badge { display: inline-block; padding: 1px 6px; margin-left: 4px; border-radius: 3px; font: 600 10px 'DM Sans', sans-serif; letter-spacing: 0.02em; border: 1px solid currentColor; }
.qual-scope-badge.scope-all { color: #16a34a; color: oklch(62% 0.18 150); background: rgba(22, 163, 74, 0.12); background: oklch(62% 0.18 150 / 0.12); }
.qual-scope-badge.scope-partial { color: #d97706; color: oklch(68% 0.17 60); background: rgba(217, 119, 6, 0.12); background: oklch(68% 0.17 60 / 0.12); }
.qual-scope-badge.scope-combined { color: #0284c7; color: oklch(62% 0.16 235); background: rgba(2, 132, 199, 0.12); background: oklch(62% 0.16 235 / 0.12); }
```

**设计决策**：`全部参数` 是**高频的默认好状态**，绿色饱和度越高，用户越容易把它读成"这条可以放心用"，从而忽略旁边的废止标记。

把三种 scope 徽章统一为**单色 accent-tinted**（同一颜色、只靠文字区分），把"颜色"这个稀缺资源全部让给废止 / 过期状态：

```css
.qual-scope-badge { display: inline-block; padding: 1px 6px; border-radius: 3px; font: 500 10px 'DM Sans', sans-serif; letter-spacing: 0; border: 1px solid transparent; background: var(--accent-soft); color: var(--accent); }
.qual-scope-badge.scope-all,
.qual-scope-badge.scope-partial,
.qual-scope-badge.scope-combined { background: var(--accent-soft); color: var(--accent); border-color: transparent; }
```

> **注意**：`margin-left: 4px` 从基础规则里删掉了，改由父级 flex `gap` 统一控制（改动 1.3 已设 `gap: 6px`）。

> **如果需要保留色彩区分**（产品上更保守的方案）：只把 `scope-all` 的绿改成 `var(--text-3)` 灰 + 无背景，保留 `scope-partial` / `scope-combined` 的现有色。这样"好状态"退到背景，"需注意状态"保留色彩。

### 2.2 废止 / 过期状态提权

在 `public/css/ui-enhance/polish.css` 末尾追加：

```css
/* 废止 / 过期状态：前置到卡片首行，左侧加警示竖条，权重最高。
   Why: 已废止标准的资质，废止状态比参数覆盖率更重要。绿色"全部参数"
   与橙色"已废止"并置时，用户会先读到绿色而误判为可用。 */
.qual-result-std .cap-lib-badge-abolished,
.qual-result-std .cap-lib-badge-series-only,
.qual-result-std .cap-lib-badge-not-in-lib {
  order: -1;             /* 抢到首行最前 */
  font-weight: 500;
  padding-left: 6px;
  border-left-width: 2px;
  border-left-style: solid;
}

/* 卡片整体：含废止状态时降低"可用"信号的视觉权重 */
.qual-result-group.has-abolished .qual-scope-badge {
  background: transparent;
  color: var(--text-3);
  border-color: var(--border);
}
```

**同时需要 JS 打标**：在改动 1.1 的拼接处，给 `qual-result-group` 加上条件 class。把该行改为：

```js
    // 检测本组是否含废止状态（用于 CSS 降权）
    var abolishedCls = '';
    if (typeof window.__capLibStatusCache === 'object') {
      var st = window.__capLibStatusCache && window.__capLibStatusCache.get(grp.stdCode);
      if (st && (st.status === 'abolished' || st.status === 'series_only')) abolishedCls = ' has-abolished';
    }

    html += '<div class="qual-result-group' + abolishedCls + '">'
```

> `window.__capLibStatusCache` 由 `public/js/app-cap-lib-badge.js:27` 暴露，是 `Map<stdCode, status|null>`。

### 2.3 验证方法

```js
document.querySelectorAll('.cap-lib-badge-abolished').forEach(el => {
  const r = el.getBoundingClientRect();
  const card = el.closest('.qual-result-group').getBoundingClientRect();
  console.log('徽章距卡片顶部:', Math.round(r.top - card.top), 'px  ← 应小于 40px');
});
```

---

## 四、改动 3（P1）：文件库徽章收敛

**问题**：`public/js/app-file-library.js:538` 一行里塞了 3 个徽章：

```js
<span class="local-col-std" title="...">
  <span class="local-std-code">GB/T 45305.3-2026</span>
  ${qualificationBadge}${capLibBadge}${natCmaBadge}
</span>
```

三个徽章依次是：`qualBadgeHtml()`（渲染 CNAS + CMA，见 `app-qual-search.js:777`）、`capLibBadgeHtml()`、`natCmaBadgeHtml()`。最坏情况一个标准号后面挂 **4 个徽章**，标准号本身被挤到视觉次位。

### 3.1 收敛规则

**一个文件行最多保留 1 个徽章**，按以下优先级取第一个可用的：

1. `capLibBadgeHtml()` — 国家库状态（含废止 / 未入库，信息量最大）
2. `qualificationBadge` — CNAS / CMA 资质
3. `natCmaBadge` — 国家 CMA 机构级能力

被丢弃的徽章**不丢失信息**：把它们的文字提取出来，作为灰文本追加到元信息行。

### 3.2 修改 `public/js/app-file-library.js`

替换 L532-538：

```js
    const nameDisplay = f.title || f.fileName;
    const qualificationBadge = isLib && typeof qualBadgeHtml === 'function' ? qualBadgeHtml(f.standardNumber) : '';
    const capLibBadge = isLib && typeof capLibBadgeHtml === 'function' ? capLibBadgeHtml(f.standardNumber) : '';
    const natCmaBadge = isLib && typeof natCmaBadgeHtml === 'function' ? natCmaBadgeHtml(f.standardNumber) : '';
    // 一行只保留 1 个徽章，其余降级为元信息灰文本（避免标准号被 3-4 个徽章淹没）
    const primaryBadge = capLibBadge || qualificationBadge || natCmaBadge;
    const demotedBadges = [capLibBadge === primaryBadge ? '' : capLibBadge,
                           qualificationBadge === primaryBadge ? '' : qualificationBadge,
                           natCmaBadge === primaryBadge ? '' : natCmaBadge].join('');

    return `<div class="local-row${child ? ' local-series-child' : ''}" data-file-id="${isLib ? f.fileId : ''}">
      <div class="local-row-row1">
        <span class="local-col-check">${isLib ? `<label class="workspace-visually-hidden" for="localFile_${f.fileId}">选择 ${escapeHtml(f.standardNumber || f.fileName)}</label><input id="localFile_${f.fileId}" type="checkbox" ${checked} data-local-check data-file-id="${f.fileId}">` : ''}</span>
        <span class="local-col-std" title="${escapeHtml(f.fileName)}"><span class="local-std-code">${escapeHtml(f.standardNumber || f.fileName)}</span>${primaryBadge}<span class="local-badge-demoted" hidden>${demotedBadges}</span></span>
        <span class="local-col-actions">${previewBtn}${actionMenu}</span>
      </div>
      <span class="local-meta-row">
        <span class="local-col-name" title="${escapeHtml(nameDisplay)}">${escapeHtml(nameDisplay)}</span>
        <span class="local-col-size">${escapeHtml(formatSize(f.size))}</span>
        <span class="local-col-time">${escapeHtml(utcToBeijing(f.indexedAt || f.mtime))}</span>
        <span class="local-col-src"><span class="local-source-chip">${escapeHtml(f.source || (isLib ? '本地' : '导出'))}</span></span>
      </span>
    </div>`;
```

> **为什么用 `<span hidden>` 而不是直接不渲染 `demotedBadges`**：
>
> 徽章是**异步填充**的。首次渲染时 `capLibBadgeHtml()` 返回的是空占位 `<span class="cap-lib-badge cap-lib-badge-pending" data-cap-lib="..."></span>`（`app-cap-lib-badge.js:45`），数据回来后由 `fetchCapLibBadges()` 全局查找并替换（`app-cap-lib-badge.js:82`）：
>
> ```js
> document.querySelectorAll('.cap-lib-badge-pending[data-cap-lib]').forEach(el => { ... el.outerHTML = renderBadgeMarkup(data, code); });
> ```
>
> 这个选择器是**全局的**，不依赖父容器，所以把占位元素放进 `<span hidden>` 里**不影响异步填充**。
>
> 但如果改成"直接不渲染降级徽章"，则会产生一个新问题：**主徽章的选择发生在异步填充之前**。首屏渲染时 `capLibBadge` 还是空字符串，`primaryBadge = capLibBadge || qualificationBadge || natCmaBadge` 会退而选中 `qualificationBadge`；等 cap-lib 数据回来、徽章真的渲染出来时，一个行内就会同时出现 2 个徽章，**收敛逻辑失效**。
>
> 所以：**保留 `<span hidden>` 方案**。它既保证异步填充正常，也保证无论数据何时回来，可见徽章始终只有 1 个。

### 3.3 未入库改用中性灰（语义修正）

**文件**：`public/css/pages.css:771-773`

```css
/* 旧：红色，语义借用错误。「未入库」是中性状态，不是故障。
   红色在本项目已语义占用给"破坏性操作 / 失败"。 */
  --cap-lib-not-bg: rgba(220, 38, 38, 0.10);
  --cap-lib-not-fg: #b91c1c;
  --cap-lib-not-border: rgba(185, 28, 28, 0.40);
```

**新**（用灰色描边，与 `--text-3` 体系一致）：

```css
  --cap-lib-not-bg: rgba(138, 147, 162, 0.10);
  --cap-lib-not-fg: #5d6878;
  --cap-lib-not-border: rgba(138, 147, 162, 0.40);
```

> 颜色取自已核对的 `theme-tokens.css` 里的 light 主题值：`--light-text-2: #5d6878`、`--light-text-3: #8a93a2`（L157-160）。

**同时处理深色主题**（`public/css/pages.css:753-755`，`:root` 默认值）：

```css
/* 旧 */
  --cap-lib-not-bg: rgba(220, 38, 38, 0.24);
  --cap-lib-not-fg: #fca5a5;
  --cap-lib-not-border: rgba(248, 113, 113, 0.55);
```

**新**：

```css
  --cap-lib-not-bg: rgba(124, 130, 144, 0.22);
  --cap-lib-not-fg: #aab0bc;
  --cap-lib-not-border: rgba(124, 130, 144, 0.50);
```

> 取值来自 `theme-tokens.css:124-127` 的 `--dark-text-2: #aab0bc`、`--dark-text-3: #7c8290`。

### 3.4 元信息行样式

追加到 `public/css/ui-enhance/polish.css` 末尾：

```css
/* 文件库卡片：降级的次级徽章不再占位（保留 DOM 以便异步填充） */
.local-badge-demoted[hidden] { display: none; }

@media (max-width: 700px) {
  /* 卡片行 1：标准号 + 最多 1 个徽章，超出省略 */
  body:not(.force-desktop) .local-col-std {
    display: flex;
    align-items: center;
    gap: 5px;
    min-width: 0;
    overflow: hidden;
  }
  body:not(.force-desktop) .local-col-std .local-std-code {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  body:not(.force-desktop) .local-col-std .cap-lib-badge,
  body:not(.force-desktop) .local-col-std .qual-badges {
    flex: 0 0 auto;
  }
  /* 元信息行用 flex 铺开，右端贴边、超出省略 */
  body:not(.force-desktop) .local-meta-row {
    display: flex;
    align-items: center;
    gap: 0;
    margin-top: 2px;
    min-width: 0;
  }
}
```

---

## 五、改动清单速查

| # | 文件 | 位置 | 类型 | 说明 |
|---|---|---|---|---|
| 1.1 | `public/js/app-qual-search.js` | L628 附近 + L706-714 | 改 | 加 `lastRenderedStdName`，标准名改条件渲染 |
| 1.2 | `public/js/app-qual-search.js` | L693-694 | 改 | 移除箭头内联 style |
| 1.3 | `public/css/ui-enhance/polish.css` | 文件末尾 | 加 | 资质卡头部重排样式 |
| 1.4 | `public/css/mobile.css` | L550-559 | 改 / 删 | 更新 `.qual-std-name` 选择器；删 `span[style*]` 规则 |
| 2.1 | `public/css/components-pages.css` | L1048-1051 | 改 | scope 徽章统一为单色 |
| 2.2 | `public/css/ui-enhance/polish.css` | 文件末尾 | 加 | 废止状态提权 |
| 2.3 | `public/js/app-qual-search.js` | 改动 1.1 同处 | 加 | `has-abolished` class |
| 3.2 | `public/js/app-file-library.js` | L532-538 | 改 | 徽章收敛为 1 个 |
| 3.3 | `public/css/pages.css` | L753-755, L771-773 | 改 | 未入库改灰 |
| 3.4 | `public/css/ui-enhance/polish.css` | 文件末尾 | 加 | 文件库元信息行样式 |

**改动总量**：3 个 JS 文件（小改）+ 4 个 CSS 文件（其中 1 个只追加）。

---

## 六、验收标准

### 功能验收

1. 查 `1952.1`，**"软体家具 沙发"在整个结果列表中只出现 1 次**，位置在该标准第一个分组下方。
2. `QB/T 1952.1-2012` 卡片上，废止标识出现在**卡片首行**，且左侧有警示竖条，视觉权重高于 `全部参数`。
3. `全部参数` / `部分参数` / `组合覆盖` 三个徽章**颜色一致**（单色 accent-tinted），不再有三色竞争。
4. 本地文件库每个文件行的标准号后**最多 1 个徽章**。
5. `LABR-5250` 的 `未入库` 徽章是**灰色描边**，不是红色。
6. 折叠箭头仍可正常点击展开 / 收起，箭头旋转动画正常（`.qual-group-arrow` 的 transform 逻辑在 `app-qual-search.js` 的 toggle 函数里，未改动）。

### 兼容性验收

7. **桌面端逐像素不变**：`?desktop=1` 打开，对比改动前后截图，除 `.qual-scope-badge` 颜色（这是有意的全局改动）外应无差异。
8. **三个主题正常**：Paper（默认）、Light、Legacy 下都要检查。**Legacy 主题特别重要**——它要求零 OKLCH / 零 `color-mix` / 零 `backdrop-filter`（见 `theme-tokens.css:290`）。新 CSS 只用了 CSS 变量，无 `color-mix`，符合要求。
9. 资质页的 `全部展开 / 全部收起` 按钮（`app-qual-search.js:722-727`）功能正常。

### 构建验收

```bash
npm run build
npm run css:check      # 会校验 CSS 入口清单，见 scripts/check-css-entrypoints.mjs
npm test
git diff --check       # 检查尾随空格
```

---

## 七、风险提示（给执行者）

| 风险 | 说明 | 对策 |
|---|---|---|
| **`.qual-std-name` 残留引用** | 改动 1.1 后该类名不再由资质页渲染，但可能有其他地方引用 | 全仓搜 `qual-std-name` 确认；`public/css/components-pages.css:1001` 和 `public/css/mobile.css:550` 的规则可以保留（无害），不要因为"看起来没用了"就删掉 CSS |
| **异步填充失效** | `cap-lib-badge` 是异步填充的（`app-cap-lib-badge.js:81-88` 全局查找 `.cap-lib-badge-pending`） | 改动 3.2 务必保留 `<span hidden>` 内的降级徽章，不要真的不渲染；改动 1 只是调整了顺序，占位元素仍在 |
| **`has-abolished` 依赖缓存时机** | `window.__capLibStatusCache` 在首屏渲染时可能还是空的，异步返回后 class 不会自动更新 | 这是**渐进增强**：缓存命中时降权，未命中时只是少一层降权，不影响可用性。如果要求严格，需在 `fetchCapLibBadges` 完成后重新打标——**建议先不做，避免范围扩大** |
| **`order: -1` 在 flex 中的副作用** | 若 `.qual-result-std` 不是 flex 容器，`order` 无效 | 改动 1.3 已显式设 `display: flex`，注意新 CSS 与 `components-pages.css:1000` 的旧 `display: flex` 不冲突即可 |
| **手机端 44px 最小尺寸** | `ui-enhance/mobile.css:32-53` 有全局 `min-height: 44px` 会命中 `.qual-result-group button` | 现有代码已用 `body:not(.force-desktop) .qual-visual-query-actions button { min-height: 32px }` 等方式覆盖，本次改动不涉及按钮，无需处理 |

---

## 八、可选的进一步优化（本次不做，供产品决策）

1. **资质卡片把机构名提到首行**。当前 `labName` 只出现在 `grp.subCategory` 里（L710），而用户最关心"哪家机构"。建议把机构名作为首行主信息，标准号降为副标题——**这才是这张卡真正要解决的问题**，但改动范围较大（涉及分组键重构），建议单独立项。

2. **`已废止·可引用` 与 `已废止` 合并展示**。两者当前是两个不同的 badge label（`app-cap-lib-badge.js:110-113`），语义接近，用户不易区分"可引用"的差异。建议合并为"已废止" + tooltip 说明。

3. **文件库卡片标准号与名称的层级**。当前行 1 是标准号（14px/500），行 2 是名称（12px/400）。名称往往更长更有辨识度，可考虑调换或用同一字号不同色阶。

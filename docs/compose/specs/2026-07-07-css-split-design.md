# CSS 拆分设计

> Spec 日期：2026-07-07
> 状态：待实现

---

## [S1] 问题

styles.css（5544行 ~340KB）全量加载，影响维护性和首次加载速度。

## [S2] 方案

按功能和层叠顺序拆分为 6 个 CSS 文件。

### 拆分映射

| 新文件 | 行数 | 内容 |
|--------|------|------|
| theme-tokens.css | ~165 | CSS 变量 + reset |
| components.css | ~1100 | 基础组件样式 |
| mobile.css | ~600 | 响应式/手机端样式 |
| pages.css | ~300 | 页面专属样式 |
| themes.css | ~2100 | 主题覆盖 |
| legacy-theme.css | ~540 | Legacy 主题 |

### 加载顺序

1. theme-tokens.css（变量）
2. components.css（基础）
3. mobile.css（响应式）
4. pages.css（页面）
5. themes.css（主题覆盖）
6. legacy-theme.css（条件加载）

### 约束

- 主题覆盖必须在基础组件之后
- 不改变任何视觉效果
- index.html 中用 `<link>` 替换单个 styles.css

## [S3] 备份

复用 `pre-js-split-2026-07-07` 标签。

## [S4] 验证

- 浏览器视觉对比：拆分前后外观一致
- 暗色/亮色/Paper/Legacy 四套主题均正常
- 手机端响应式正常

# 前端 JS 拆分设计

> Spec 日期：2026-07-07
> 状态：待实现

---

## [S1] 问题

`app-search.js`（1678 行 ~80KB）和 `app-detail-utils.js`（1518 行 ~75KB）过大，影响维护性和加载理解。

## [S2] 方案

按功能内聚性拆分为更小的文件，保持全局变量拼装模式不变。

### 拆分映射

| 原文件 | 新文件 | 行数 | 内容 |
|--------|--------|------|------|
| app-search.js | app-search-core.js | ~584 | 搜索编排、工具栏、键盘导航、右键菜单 |
| app-search.js | app-search-render.js | ~530 | 筛选条、卡片渲染、渐进渲染、本地库匹配 |
| app-search.js | app-preview.js | ~557 | 预览子系统（弹窗/overlay/PDF.js/源选择器） |
| app-detail-utils.js | app-ui-components.js | ~130 | Toast、确认框、输入框 |
| app-detail-utils.js | app-log.js | ~325 | 运行日志子系统 |
| app-detail-utils.js | app-file-library.js | ~500 | 文件库管理 |
| app-detail-utils.js | app-detail-utils.js | ~100 | 保留：详情弹窗+工具函数+键盘快捷键 |

### 加载顺序

```
app-core.js
app-search-core.js
app-search-render.js
app-preview.js
app-download.js
app-ui-components.js
app-log.js
app-file-library.js
app-detail-utils.js（瘦身）
...后续不变
```

### 约束

- 所有函数保持全局作用域（function 声明式）
- 不引入 ES module
- 不改变任何功能行为
- 拆分后 `git diff --stat` 只显示文件重命名 + 移动，无逻辑变更

## [S3] 备份

拆分前打 `pre-js-split-2026-07-07` tag，可随时 `git reset --hard` 回滚。

## [S4] 验证

- 所有 JS 文件语法检查通过
- 浏览器控制台无报错
- 搜索、预览、文件库、日志功能正常

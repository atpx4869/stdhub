# StdHub 任务计划 — V3 UI 重构

> 设计规范：docs/UI_REDESIGN_V3.md
> 当前阶段：实施中

## 批次状态

| 批次 | 内容 | 状态 | commit |
|---|---|---|---|
| R0a | 三层 token 架构 + 四主题色板 + 系统字体栈 | ✅ 完成 | `4d1a851` |
| R0b | 断点迁移 640px → 700px | 🔄 进行中 | - |
| R1 | AppShell 外壳（侧栏三分组 + 折叠 + 顶栏） | 🔄 进行中 | - |
| R2 | 命令面板 Ctrl+K | 🔄 进行中 | - |
| R3 | 核心检索（SearchWorkbench / ResultRow / StatusBadge / EmptyState） | ⏳ 待开始 | - |
| R4 | 资质与 CMA（三模式工作台 / StatusStrip / FilterDrawer） | ⏳ 待开始 | - |
| R5 | 文件与记录（文件库表格 / 历史时间轴 / 工具箱双栏） | ⏳ 待开始 | - |
| R6 | 运维与配置（日志控制台 / 统计 KPI / 设置双栏） | ⏳ 待开始 | - |
| R7 | 全局质量收尾（Dialog / Toast / 无障碍 / 回归） | ⏳ 待开始 | - |

## 每批次门禁

1. `npm run build`
2. `npm run css:check`
3. `npm test`
4. `npm run test:e2e`
5. `git diff --check`
6. 桌面 1440×900 + 移动 390×844 四主题截图检查

## 关键约束

- 不改 DOM ID / 路由 / switchTab / data-stdhub-click
- 不引入 React/Vue/Tailwind/GSAP
- oklch 必须带 sRGB 回退
- Legacy 纯 hex
- PDF 阅读器性能契约不动
- 国家 CMA 保持暂停

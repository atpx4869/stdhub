# StdHub V3 UI 重构 — 进度记录

> 2026-09-11 开始实施

## R0a — Token 基座 ✅
- `theme-tokens.css` 完全重写：三层 token 架构
- 第 1 层：原始色板（历史提交包含四套，当前运行时仅使用 --paper-* / --legacy-*）
- 第 2 层：语义 token (--surface/--border/--text-2/--accent 等)
- 第 3 层：组件 token（待 components-global.css 追加）
- Paper/Legacy 当前色板按 V3 规范使用；Dark/Light 已退出运行时主题选择
- 字体改为系统栈优先，Google Fonts 异步加载
- commit: `4d1a851`

## R0b — 断点迁移 ✅
- 640px → 700px 已完成，CSS 与 `MOBILE_BP` 同源并纳入 `css:check`
- commit: `4796434`

## R1 — AppShell ✅
- 侧栏三分组（检索与验证 / 文件与记录 / 运维）
- 折叠 56px + 组标签隐藏
- 顶栏预留命令面板入口
- commit: `4f2575e`

## R2 — 命令面板 ✅
- 新建 `app-command-palette.js`
- Ctrl+K / Cmd+K 唤起
- 9 tab 跳转 + Paper/Legacy 主题切换 + 直达搜索
- commit: `cf07080`

## R3–R7 — 页面与全局质量 ✅
- 搜索、资质/CMA、文件库、工具、统计、设置、账户与全局弹层已按 V3 工作台重构
- 运行时主题收敛为 Paper/Legacy，独立任务中心按产品决策移除
- 日志页收敛为摘要 chips + 单筛选栏 + 原生延迟渲染事件流
- 下载历史增加关键词/来源/状态筛选、日期分组、状态与定位操作，并移除大面积装饰性空框
- 移动端交互控件统一到至少 44px，文本输入保持至少 16px
- 2026-09-13 最终门禁：build、CSS 边界、240 项单元/集成测试、6 项 Chromium E2E、diff check 全绿
- 相关 commits: `8a7dc6f`、`b3ffa88`、`dfae3cb`、`a8221d1`、`bcf81a2`、`e766b60`～`8c6ceb7`

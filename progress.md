# StdHub V3 UI 重构 — 进度记录

> 2026-09-11 开始实施

## R0a — Token 基座 ✅
- `theme-tokens.css` 完全重写：三层 token 架构
- 第 1 层：原始色板 (--paper-*/--dark-*/--light-*/--legacy-*)
- 第 2 层：语义 token (--surface/--border/--text-2/--accent 等)
- 第 3 层：组件 token（待 components-global.css 追加）
- 四主题色板按 V3 规范更新
- 字体改为系统栈优先，Google Fonts 异步加载
- commit: `4d1a851`

## R0b — 断点迁移 🔄
- 目标：640px → 700px，9 个文件 25 处
- 子代理执行中

## R1 — AppShell 🔄
- 侧栏三分组（检索与验证 / 文件与记录 / 运维）
- 折叠 56px + 组标签隐藏
- 顶栏预留命令面板入口
- 子代理执行中

## R2 — 命令面板 🔄
- 新建 `app-command-palette.js`
- Ctrl+K / Cmd+K 唤起
- 9 tab 跳转 + 主题切换 + 直达搜索
- 子代理执行中

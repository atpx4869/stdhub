# StdHub 文档目录

> 开发、维护或交给其他 AI 修改代码前，请先浏览本目录。代码与文档不一致时以代码为准，但完成修改后应同步更新对应文档。

## 必读文档

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — API 响应壳、命名、路由、错误处理、配置层级、数据源、并发和文件库等架构约定
- [`OPTIMIZATION_ROADMAP.md`](OPTIMIZATION_ROADMAP.md) — 全仓审查结论、已知风险、分阶段优化路线、实施顺序与验收标准
- [`../TODO.md`](../TODO.md) — 功能待办、版本记录和已知问题
- [`../WORKLOG.md`](../WORKLOG.md) — 项目演进、历史决策与事故记录

> 当前优化工作再次启动时，应先阅读 `OPTIMIZATION_ROADMAP.md`。其中记录了测试隔离、应用 shutdown、任务取消、PreviewController、SQLite 查询性能、文件系统边界、Docker 和 CI 等完整方案。

## 功能专题

- [`CHECK-UPDATE-AND-STATS.md`](CHECK-UPDATE-AND-STATS.md) — 标准查新与使用统计
- [`MOBILE_ADAPTATION.md`](MOBILE_ADAPTATION.md) — 移动端布局、导航、PWA 与 PDF 预览适配
- [`THEME_DESIGN.md`](THEME_DESIGN.md) — Dark、Light、Paper、Legacy 主题设计
- [`NATIONAL_CMA_WIKI.md`](NATIONAL_CMA_WIKI.md) — 国家 CMA 数据来源、抓取证据、限制和接入方案
- [`QUAL_SEARCH_AND_PREVIEW_OPTIMIZATION_PLAN.md`](QUAL_SEARCH_AND_PREVIEW_OPTIMIZATION_PLAN.md) — 资质查询提速、预览阶段反馈与手机原生打开兜底方案

## 数据源文档

- [`BZ-API.md`](BZ-API.md) — BZ 源 API 说明
- [`sources/by-source-implementation.md`](sources/by-source-implementation.md) — BY 源实现
- [`sources/gbw-source-implementation.md`](sources/gbw-source-implementation.md) — GBW 源实现
- [`sources/labr-source-plan.md`](sources/labr-source-plan.md) — Labr 源实现与规划

## 设计与实施记录

- [`compose/specs/2026-07-07-mobile-pdf-viewer-design.md`](compose/specs/2026-07-07-mobile-pdf-viewer-design.md) — 移动端 PDF viewer 设计
- [`compose/plans/2026-07-07-mobile-pdf-viewer.md`](compose/plans/2026-07-07-mobile-pdf-viewer.md) — 移动端 PDF viewer 实施计划

## 修改文档的约定

1. 修改 API、数据库、标准号归一化、数据源或并发模型时，同步更新 `ARCHITECTURE.md`。
2. 完成优化路线图中的事项时，在 `OPTIMIZATION_ROADMAP.md` 标记状态并记录验收结果。
3. 功能完成后更新 `TODO.md`；重要过程、决策或事故更新 `WORKLOG.md`。
4. 新增专题文档后，必须在本文件和根目录 `README.md` 的文档导航中添加入口。
5. 不要只在聊天记录中保存关键决策；应落到仓库文档中。

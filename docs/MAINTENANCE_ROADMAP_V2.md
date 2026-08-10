# StdHub 托管优化路线图（v2）

> 建立日期：2026-08-10  
> 基线版本：v1.4.17  
> 执行模式：每个阶段先备份、后修改、再验证、独立提交并立即推送。  
> 国家 CMA 产品决策：**无限期暂停**。历史数据和离线脚本保留，但 Web/NAS 生产服务不得自动抓取、同步或展示可能误导的匹配徽章。

## 一、托管执行规则

1. 不恢复或提交用户已删除的 `cma_节能材料*.json`。
2. 不修改或提交 `data/*.db`、`standards/**`、`dist/**`、会话附件和运行时文件。
3. 每个阶段开始前在 `data/backups/` 生成 SQLite 备份并执行 `PRAGMA integrity_check`。
4. 每个阶段只处理一个主题；不得把后续重构顺手混入当前提交。
5. 每个阶段至少执行 `npm run build` 和 `npm test`；涉及 source 时增加离线 source 测试，涉及 UI 时增加浏览器 smoke/E2E。
6. 每个阶段完成后更新本文件状态，独立 commit 并立即 push。
7. 遇到不可逆数据迁移、真实上游副作用或产品决策时，选择最保守、可回滚路径。
8. 代码与文档冲突时先停止扩展功能，明确产品状态后再实施。

## 二、阶段清单

### D0：国家 CMA 硬暂停

状态：`completed`（2026-08-10）

目标：让“无限期暂停”成为生产代码门禁，而不是 README 文案。

实施：

- 生产装配不再默认构造 `PythonCmaProvider`。
- 国家 CMA 同步接口统一返回 `503 / NAT_CMA_SUSPENDED`。
- 自动同步调度器不再调用国家 CMA。
- 前端隐藏订阅、同步、搜索和徽章入口，保留只读暂停说明。
- 历史数据库和 Python 离线脚本保留，不删除。
- 新增暂停 ADR 和生产装配回归测试。

验收：服务器启动、自动同步和普通页面操作均不会启动国家 CMA Python 子进程。

### D1：前端低风险止血

状态：`pending`

实施：

- 恢复手机端资质“搜索 / 详细搜索”入口。
- 移除手机 `#toolbar { display:flex !important; }` 与 JS 状态冲突。
- 修复文件重命名弹窗在窄屏溢出。
- 建立幂等 `bootstrapApp()`，消除重复初始化。
- 修复恢复下载任务后的 ID 冲突。
- 修复日志自动刷新、登录健康轮询等局部生命周期泄漏。

验收：375px / 430px / 640px 关键入口可达，首屏不重复请求，控制台无错误。

### D2：资质同步数据正确性

状态：`pending`

实施：

- CNAS/CMA 全量同步改为 staging 或单事务原子替换。
- 同一机构同步增加 single-flight。
- 同步失败继续使用上次成功数据。
- 增加第 N 个 chunk 失败、并发手动/自动同步等故障注入测试。

验收：任何同步失败都不会留下空库或半库。

### D3：设置、下载和文件契约统一

状态：`pending`

实施：

- settings 统一为“全部验证 → transaction 写入 → commit → 执行副作用”。
- 建立 `StandardDownloadOrchestrator`，收口普通下载、预览自动下载和 export task。
- 明确任务 owner/subscriber/reused/cancel 语义。
- 文件 rename/delete/move 增加补偿和 reconciliation。
- 区分 download 成功与 library 入库成功。

验收：三条下载链路行为一致；部分失败可恢复且状态不误导。

### D4：前端公共基础

状态：`pending`

实施：

- `StdHub` 命名空间，禁止新增裸顶层业务变量。
- 统一 API client、UiState、ModalManager、LifecycleManager。
- 清理原生 `prompt/confirm`、重复 API helper、重复 escape helper。
- 统一 JS/CSS 缓存版本注入。
- 新增代码不得添加大段内联样式或新的内联事件。

验收：搜索、资质、文件库至少三页迁入公共基础；兼容桥可控。

### D5：产品模式与后端模块收敛

状态：`pending`

默认决策：采用“单用户 NAS 模式”。

实施：

- 删除或隐藏无效的登录、注册、guest、tab 权限设置和用户管理入口。
- 保留 `STDHUB_PROXY_TOKEN` 作为外部访问边界。
- 从 `app.ts` 拆出 downloads/library/diagnostics/lifecycle。
- 定义 `AdapterSourceName` 与 `LibrarySourceName`。
- 清理 Electron、旧 popup、无效兼容壳和死代码。

验收：UI/API 不再宣称支持实际上无效的多用户权限。

### D6：文档、测试、AI 协作与发布门禁

状态：`pending`

实施：

- 新增根目录 `AGENTS.md`。
- 新增 `docs/PRODUCT_STATUS.md`、`TESTING.md`、`RELEASE.md`。
- 新增国家 CMA 无限期暂停 ADR。
- 重写过时的 `ARCHITECTURE.md`，删除 Electron/bzxz 旧内容。
- 建立 Chromium E2E：启动、搜索、空状态、预览、文件库、手机资质 tab、设置页、国家 CMA 暂停。
- 调整发布顺序为：测试/扫描/Docker smoke 通过后再 bump、tag、Release、更新 latest。
- Trivy 高危漏洞必须阻断发布。

验收：AI 或人工接手时只读文档即可判断产品状态和修改边界；失败构建不会留下正式 Release。

## 三、交付定义

最终交付必须满足：

- `npm run build` 通过。
- `npm test` 通过。
- 核心 source 离线测试通过。
- Chromium E2E 关键旅程通过。
- Docker 镜像可在只读根文件系统、非 root 用户下启动并通过 health check。
- 国家 CMA 在生产装配中不可自动恢复。
- CNAS/CMA 同步失败不会损坏上次成功数据。
- 前端首屏只初始化一次，切页后 timer/poll/listener 可释放。
- 文档、TODO、产品状态和代码一致。

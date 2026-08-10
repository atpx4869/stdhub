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

状态：`completed`（2026-08-10）

提交：`fix: stabilize mobile UI and frontend lifecycle`。

#### D1 当前工作树检查点

- `public/css/components-global.css`
  - 为 `.rename-dialog` 保留桌面端 `480px` 宽度，手机端由 `mobile.css` 覆盖。
- `public/css/mobile.css`
  - 已移除手机端 `#toolbar { display:flex !important; }`，恢复 JS 对显示状态的控制。
  - 已保留“搜索 / 详细搜索”资质 tab，仅隐藏 `visual` tab。
  - 已增加 `.rename-dialog` 窄屏宽度和按钮换行规则。
- `public/js/app-file-library.js`
  - 已移除重命名弹窗的内联 `min-width:480px`，增加 `.rename-dialog` 和 `aria-labelledby`。
- `public/js/app-auth-core.js`
  - 已新增幂等 `bootstrapApp()`、`bootPromise`、`authStatusPromise`。
  - `checkAuthStatus()` 已改为只获取状态，不再自行调用 `onAuthReady()`。
  - `onAuthReady()` 的一次性 lifecycle 初始化已有独立守卫，重新取用户状态不会重复注册 router/deep-link 或健康检查。
  - 登录健康轮询已有单实例守卫和 `beforeunload` 清理。
- `public/js/app-download-center.js`
  - 恢复任务后从最大合法可递增 ID 继续分配，避免刷新后任务 ID 冲突。
- `public/js/app-log.js`
  - 日志自动刷新接入 `_tabCleanup`，切页和重复启停均释放 interval。
- `public/index.html`
  - 为本阶段修改的 CSS/JS 更新 query version，避免 NAS/PWA 命中旧缓存。
- `public/js/app-qual.js`
  - 启动入口已由 `checkAuthStatus()` 改为 `bootstrapApp()`。

不得混入 D1 提交：

- 用户主动删除的 `cma_节能材料.json`、`cma_节能材料_全量.json`、`cma_节能材料_测试.json`；
- `.reasonix/desktop-topic-*.json`；
- `.reasonix/attachments/**`；
- `data/**`、`dist/**` 或其他运行时文件。

D1 前置备份已存在：`data/backups/bzxz-d1-before-20260810-183254.db`。

#### D1.1 完成并复核启动幂等化

文件范围：

- `public/js/app-auth-core.js`
- `public/js/app-qual.js`
- 必要时只读检查 `public/js/app-core.js`、`public/index.html`

操作：

- 确认全站只有 `bootstrapApp()` 负责首次调用 `onAuthReady()`。
- 保留 `continueAsGuest()` 的显式重新取状态路径，但避免重复 `initPanels()`、重复 source health 请求和重复 router 初始化。
- 明确失败策略：认证状态请求失败时仍使用默认管理员，`bootPromise` 不产生未处理 rejection。
- 检查脚本加载顺序，保证调用 `bootstrapApp()` 时函数已经定义。

验收：

- 静态搜索不再存在启动阶段的裸 `checkAuthStatus()` 或 `setTimeout(onAuthReady)`。
- 连续调用两次 `bootstrapApp()` 只产生一次 `/api/auth/status` 和一次 `onAuthReady()`。
- 首屏无 `ReferenceError`，默认 tab 只初始化一次。

#### D1.2 修复恢复任务 ID 冲突

文件范围：`public/js/app-download-center.js`。

问题：`downloadTaskSeq` 当前从 `0` 开始，而 `downloadTasks` 会从 `localStorage` 恢复；刷新后新任务可能复用已有 ID，导致更新、取消或完成写到旧任务。

操作：

- 恢复任务后，将 `downloadTaskSeq` 初始化为所有合法数值 ID 的最大值。
- 忽略非法、缺失、负数或非有限 ID；新 ID 必须严格大于任何恢复 ID。
- 不在 D1 改造任务 owner/subscriber/cancel 契约，那属于 D3。

验收：恢复 ID `[2, 7, 11]` 后创建任务得到 `12`；空或损坏存储从 `1` 开始；新任务更新不会命中旧任务。

#### D1.3 收口局部 timer 生命周期

文件范围：

- `public/js/app-log.js`
- `public/js/app-auth-core.js`
- `public/js/app-core.js`（只复用现有 `window._tabCleanup`，不引入 D4 的新 LifecycleManager）

操作：

- 新增幂等 `stopLogAutoRefresh()`，关闭 timer、清空句柄并同步按钮状态。
- 注册 `(window._tabCleanup = window._tabCleanup || {}).logAutoRefresh = stopLogAutoRefresh`，切离日志页即停止轮询。
- `toggleLogAutoRefresh()` 启动前先清理旧 timer，确保永远只有一个 interval。
- 登录健康轮询继续保持单实例；页面隐藏且认证 overlay 不可见时不得发请求。

验收：反复开关自动刷新不叠加 interval；切离日志页后停止请求；页面卸载后无登录健康 timer。

#### D1.4 完成移动端与弹窗 smoke

文件范围：仅检查 D1 已改 CSS/HTML，不顺手做视觉重构。

视口：`375x812`、`430x932`、`640x900`，另检查一个桌面视口。

检查项：

- 资质页“搜索 / 详细搜索”入口可见且可点击，`visual` 在手机端隐藏。
- 搜索结果未选中时 toolbar 可被 JS 隐藏；选中后正常显示，不被 CSS 强制常驻。
- 重命名弹窗不横向溢出，input 与操作按钮可见，Esc/遮罩/取消/确认行为不变。
- 桌面端弹窗宽度和资质 tab 不退化。

#### D1.5 D1 验证、审查、提交与推送

按顺序执行：

1. `git diff --check`
2. `npm run build`
3. 运行最小前端 smoke；若新增测试，只运行对应测试。
4. 因测试隔离已在 Phase A 修复，可在提交前运行 `npm test`；运行前后确认 `data/` 未变化。
5. 审查最终 diff，只允许 D1 业务文件和本路线/TODO 状态更新。
6. 暂存时显式列出文件，禁止 `git add .`。
7. 单独提交，建议信息：`fix: stabilize mobile UI and frontend lifecycle`。
8. `git pull --rebase --autostash` 时必须确认用户 3 个 JSON 删除仍被保留；随后 `git push`。
9. push 后将 D1 标为 `completed`，记录 commit SHA 和验证结果。

D1 完成定义：375px / 430px / 640px 关键入口可达，首屏不重复请求，恢复任务 ID 不冲突，切页后局部 timer 可释放，控制台无错误。

### D2：资质同步数据正确性

状态：`completed`（2026-08-10）

提交：`fix: make qualification sync atomic and single-flight`。

实施结果：

- CNAS/CMA 使用连接级 TEMP staging table，并按 `sync_token` 隔离并发任务。
- 每 200 行使用短 transaction 写入 staging，批次间通过 `setImmediate` 让出事件循环。
- 最终使用短 promotion transaction 原子执行正式快照替换和 lab metadata 更新。
- CMA 证书号变化时，同事务迁移 `qualification_lab_links` 和 `cma_diff_manual_map` 引用。
- 同一机构增加 per-key single-flight；手动 API 与自动 scheduler 共享同一 `QualificationService`，后到的强制请求会在普通 flight 后排队执行。
- 同步期间机构被删除或变更时，promotion 回滚，不产生孤儿资质。
- 每机构设置 `100_000` 条安全上限，异常超量响应不会进入 staging。
- 新增中途写入失败、反向 force、失败重试、不同机构并发、证书号迁移和并发删除测试。

验收结果：任何同步失败都不会留下空库或半库；定向 54 项测试通过，最终完整测试结果见提交记录。

### D3：设置、下载和文件契约统一

状态：`in_progress`（D3a settings 原子更新已完成）

#### D3a：settings 原子更新

状态：`completed`（2026-08-10）

提交：`fix: make settings updates atomic`。

实施结果：

- 新增 `setSettings()`，批量设置在一个 SQLite transaction 内提交。
- admin、auto-sync、qualification 三个设置 PUT 均先完成全部验证，再一次性写入。
- watcher、library scan 和 scheduler reload 仅在 commit 成功后执行。
- 库路径切换会等待旧 scan 完成，再强制执行新路径 full scan。
- Cron 复用 scheduler 完整解析器，拒绝越界、`*/0` 和畸形数字 token。
- 空 auto-sync 更新不再重排或停止 timer。
- 新增三个端点的 DB trigger 故障注入测试，验证零部分写入和零提前副作用。

#### D3b-D3c：待实施

- 建立 `StandardDownloadOrchestrator`，收口普通下载、预览自动下载和 export task。
- 明确任务 owner/subscriber/reused/cancel 语义。
- 文件 rename/delete/move 增加补偿和 reconciliation。
- 区分 download 成功与 library 入库成功。

D3 最终验收：三条下载链路行为一致；部分失败可恢复且状态不误导。

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

## 四、跨对话托管协议

为避免再次因一次性上下文过长中断，后续每个对话只处理一个可提交批次：

1. 开始时只读 `git status --short --branch`、本文件当前阶段和该批次直接涉及的文件；不要再次全仓 `glob + grep + read`。
2. 调查优先使用一次定向 `grep` 和少量分页读取；单轮不要并行展开后续阶段。
3. 每完成一个小项立即记录验证证据，不累计到整阶段末尾再回忆。
4. 修改后先做定向验证；只有准备提交时才做阶段级构建/测试/审查。
5. 对话结束前更新当前检查点：已改文件、未完成项、最后验证命令、是否已 commit/push。
6. 若发现工作树存在用户文件或 Reasonix 元数据变更，保持原状并通过显式 `git add <paths>` 排除。
7. D2-D6 每阶段如超过 6 个紧密相关文件，继续拆成 `a/b/c` 多个独立提交，不追求一次性完成整个阶段。

建议下一对话仅在本轮未能完成 push 时从 **D3a 最终提交与推送** 续接；D3a 推送完成后从 D3b 下载编排开始，不重新调查 D0-D3a。

# StdHub 待办事项

## 版本记录

| 版本 | 日期 | 主要变更 |
|------|------|----------|
| 未发布 | 2026-09-04 | 全站 UI 重构完成：统一工作台、四主题、桌面/手机响应式、全局弹层与键盘焦点；保留分页图片 PDF 阅读器；206 项测试通过 |
| 未发布 | 2026-09-03 | PDF 预览改造：分页 WebP 后台生成、BZ 原图复用、长文档懒加载、失败恢复、原始 PDF Range 查看/下载；移除 PDF.js/pdfh5 |
| v1.4.36 | 2026-08-14 | 资质查询性能优化：FTS5 trigram 全文索引、机构索引路径、纯数字标准号快路径、标准明细直查、增量加载更多、禁用 suspended 国家 CMA 无效请求；154 项测试通过 |
| v1.4.34 | 2026-08-11 | 修复 PDF 预览生命周期与切源：`switchPreviewSource` 复用 viewer 时重置 `_estHeightRef`、滚动越界钳制、LABR/预览任务状态回写修正 |
| v1.4.33 | 2026-08-11 | D3c ①：export task 迁入统一编排器（`ExportTaskService` 改为编排器胶水，channel `export`，与 multi-download/preview 共享 in-flight flight，取消经 `handle.unsubscribe()` abort；编排器补 `totalPages`/phase 透传）；152 项测试通过 |
| v1.4.32 | 2026-08-11 | 修复 PDFViewer 二分越界钳制 + 切换文档时重置页高基准（审查修复） |
| v1.4.31 | 2026-08-11 | 修复 PDFViewer 占位符初始高度缺失致多页 PDF 只能滚到第 6 页 |
| v1.4.30 | 2026-08-11 | 修复预览滚动错位闪烁 + 下载按钮 + 用浏览器打开按钮 |
| v1.4.29 | 2026-08-11 | 下载分流：搜索/批量下载只入库服务器，文件库新增批量下载到本地 |
| v1.4.28 | 2026-08-10 | 文档：新增下次接手快速开始指引（跨对话托管协议） |
| v1.4.27 | 2026-08-10 | 文档：刷新 D3 阶段状态（D3a/D3b 完成、D3c 进行中） |
| v1.4.26 | 2026-08-10 | D3c：预览自动下载迁入统一编排器（与 multi-download 共享 flight、fileId/library_failed 语义） |
| v1.4.25 | 2026-08-10 | 文档：标记 D3b 下载编排完成 |
| v1.4.24 | 2026-08-10 | D3b：新增 `StandardDownloadOrchestrator` 统一下载编排（owner/subscriber/reused/cancel 语义、close 纳入 shutdown、GBW signal 贯穿）；标准补全模板模式 |
| v1.4.23 | 2026-08-10 | D3a：settings 原子更新（批量 transaction、验证后才执行 watcher/scan/scheduler 副作用、Cron 完整校验） |
| v1.4.22 | 2026-08-10 | 资质同步服务共享（手动 API 与自动 scheduler 复用同一 `QualificationService`） |
| v1.4.21 | 2026-08-10 | D2：资质同步原子替换与同机构 single-flight（TEMP staging 分块写入、短事务 promotion、失败保留旧快照） |
| v1.4.20 | 2026-08-10 | D1：前端低风险止血（`bootstrapApp()` 幂等、恢复任务 ID 冲突修复、日志自动刷新释放、重命名弹窗窄屏适配） |
| v1.4.19 | 2026-08-10 | D0：国家 CMA 无限期硬暂停（生产装配不构造 Provider、同步 API 503、调度器不再调用、前端隐藏入口） |
| v1.4.18 | 2026-08-10 | 文档：新增托管优化路线图 v2（D0-D6 阶段化托管计划） |
| v1.4.17 | 2026-08-10 | 文档：版本记录补 v1.4.12-1.4.16；WORKLOG 记录预览优化与设置页 bug 修复 |
| v1.4.16 | 2026-08-10 | 修复设置页历史 bug：`initDragSort` 与 `resetSettings` 自 v1.3.8 起调用但从未定义，renderSettings 抛错导致文件库区块永远"加载中"、区块堆叠显示、外网访问保护不渲染；补上拖拽排序与恢复默认实现 |
| v1.4.15 | 2026-08-10 | 预览优化：`standard_files` 加 etag 列（迁移），file 端点 304 快速路径跳过 fs 校验；多源 picker 数据与 preview/request 并行预取 |
| v1.4.14 | 2026-08-10 | 预览优化：PDFViewer 滚动窗口/当前页改滚动位置估算（O(1)，大 PDF 滚动卡顿）；`_applyFit` 缓存第一页 viewport；预览任务 createTask 原子 check+create（消除并发重复下载）；三份轮询统一为 startTaskPoll |
| v1.4.13 | 2026-08-10 | 移除默认部署的高危提示日志（保留 STDHUB_STRICT_SECURITY 强制拒绝逻辑） |
| v1.4.11 | 2026-08-10 | BY 源登录 302 跟随重写 origin：IIS Location 用站点端口（8080），隧道入口（18080）下直接跟随连到不存在的端口；同主机名强制改用 BY_BASE origin |
| v1.4.10 | 2026-08-10 | CI：docker 构建只响应 workflow_dispatch，消除 push/dispatch 并行构建打 latest 的镜像竞态 |
| v1.4.9 | 2026-08-10 | BY 源 `createFreshAgent` 用 `keepAliveTimeout:1` 替代 0（undici 拒绝 0，抛 UND_ERR_INVALID_ARG） |
| v1.4.8 | 2026-08-10 | BY 源改用独立近无 keep-alive Agent（`pooledFetch` 支持 per-call dispatcher）修复 frp 隧道下 login fetch failed |
| v1.4.7 | 2026-08-10 | CI：auto-release 直接创建 Release 并触发 Docker 构建；补 actions:write 权限 |
| v1.4.6 | 2026-08-10 | CI：每次 push main 自动 bump 版本号 + tag + Release + 构建镜像（auto-release.yml + bump-version.mjs） |
| v1.4.5 | 2026-08-10 | 修复导出前 ensureExportsDir（bz/by/gbw 统一，fs.ts 幂等 mkdir） |
| v1.4.4 | 2026-08-10 | BY 源 `BY_BASE_URL` 环境变量支持（frp/SSH 隧道外网接入）；by-adapter 真实网络测试经 loadDotEnvLocal + it.runIf 生效 |
| v1.4.3 | 2026-08-06 | Phase C 安全 / 部署加固：文件库 realpath 防越界、运行日志脱敏、高成本接口限流、Docker 最小权限与 CI/CD 发布 gate |
| v1.4.2 | 2026-07-18 | Phase B 性能优化：导出文件索引分页、文件库分块扫描、来源健康统计合并、资质批量标准号快路径、版本化迁移入口 |
| v1.4.1 | 2026-07-17 | 资质查询结果去重（同一参数保留最新）；数据库迁移修复；标准预览缩放按钮 |
| v1.4.0 | 2026-07-16 | 国家 CMA 真实数据源接入（PythonCmaProvider）；分页回退 Bug 修复；快速同步（10页）；健康检查面板；结构化进度 |
| v1.3.14 | 2026-07-16 | 国家 CMA 订阅功能（内置湖北省产品质量监督检验研究院，5 个场所）；滑块验证码自动破解；CMA 证书查询脚本 |
| v1.3.7 | 2026-07-13 | 一单一库状态标识改为主题感知的高对比配色；Docker 镜像自动发布 `latest`、`<版本号>` 与 `v<版本号>` 标签 |
| v1.3.6 | 2026-07-13 | 本地文件库改为“标准系列父行 + 可展开版本列表”；分页按系列计算，单版本仍保持普通文件行 |
| v1.3.5 | 2026-07-13 | 本地文件库修复分组排版并加入分页；标准号旁显示 CNAS/CMA 与国家 CMA 能力库匹配标识 |
| v1.3.4 | 2026-07-13 | 搜索右下状态提示改为跟随主题表层，修复 Paper 主题下仍显示深灰色的问题 |
| v1.3.3 | 2026-07-13 | LABR 显示本地已下载标记；PDF 预览优先直接打开标准库副本，避免重复访问上游 |
| v1.3.2 | 2026-07-13 | LABR 补齐 CNAS/CMA 跨年资质提示、国家 CMA 能力库状态徽章；资质详情浮层改用当前主题色 |
| v1.3.1 | 2026-07-13 | 修复 LABR 标准号渲染为对象文本；标准号与名称分列展示 |
| v1.3.0 | 2026-07-13 | LABR 详情与任务中心整合、标准号统一、数据源健康状态与可选 Lucky 访问令牌防护 |
| v1.2.9 | 2026-07-13 | LABR 检索增加 CNAS/CMA 资质匹配标识与 PDF 一键预览（自动入库） |
| v1.2.8 | 2026-07-13 | 深色主题弹窗、菜单与任务浮层统一为黑蓝色；补强前端脚本缓存与文本转义 |
| v1.2.7 | 2026-07-12 | 修复 PWA 缓存导致的新旧前端资源混用，恢复标准检索触发链路 |
| v1.2.6 | 2026-07-12 | 搜索历史标签化；文件库宽屏单行布局，标准号与名称并列展示 |
| v1.2.5 | 2026-07-10 | 本地文件库桌面端卡片行布局 + 入库时间修正 |
| v1.2.3 | 2026-07-10 | 预览页左边缘右滑返回手势 |
| v1.2.2 | 2026-07-10 | 手机端下载改用 Blob 强制下载（避免浏览器内联打开 PDF） |
| v1.2.0 | 2026-07-10 | 手机端 PDF 预览切换到 pdfh5（替换自研 PDFViewer） |
| v1.1.9 | 2026-07-10 | 双指缩放后高度/平移/触摸穿透修复 |
| v1.1.8 | 2026-07-10 | 关于页更新日志显示最近 8 条 release |
| v1.1.7 | 2026-07-10 | 手机端预览移除下载/新标签按钮 + 双指缩放流畅度优化 |
| v1.1.6 | 2026-07-10 | 手机端 PDF 预览默认全页显示 + 文档更新 |
| v1.1.5 | 2026-07-10 | 手机端 PDF 预览修复（devicePixelRatio 双重缩放） |
| v1.1.4 | 2026-07-10 | 移除 PDF 预览 rAF 延迟 |
| v1.1.3 | 2026-07-09 | 手机端 PDF 预览缩放计算改进 |
| v1.1.2 | 2026-07-09 | release 脚本兼容 Windows |
| v1.1.1 | 2026-07-08 | CSS 拆分与懒加载、Paper 主题灰色修复、手机端复选框/Toast 修复 |
| v1.1.0 | 2026-07-06 | GBW 新上游适配、手机端交互优化、统计/日志内容增强、Docker 部署、版本号显示 |
| v1.0.0 | 2026-07-05 | 初始版本（从 bzxz 迁移） |

## 已完成

- [x] 全站 UI 重构：统一应用外壳、搜索/资质/CMA、文件与工具、日志/统计/设置/账户、任务中心和全局弹层；完成四主题、桌面/手机、键盘焦点、减少动态效果与 206 项测试回归
- [x] PDF 预览统一为分页图片阅读器，支持后台生成、部分可用、首开补偿、去重、重启恢复、缓存失效/清理和原始 PDF 新标签页查看/下载
- [x] 项目初始化（从 bzxz 复制）
- [x] Electron 残留清理
- [x] 认证简化（默认管理员）
- [x] UI 重构（tabbar/搜索卡片/设置页）
- [x] CMA 能力项目库搜索
- [x] GBW 超时保护 + 全局错误处理
- [x] pdf-merge-worker 兼容修复
- [x] 下载自动切源重试
- [x] BW 源下载日志增强（showGb/gc/verifyCode/viewGb 全链路）
- [x] OCR worker Python 路径修复（优先 py -3.11）
- [x] GBW showGb/viewGb 重定向跟随修复
- [x] GBW 域名迁移（c.gb688.cn → openstd.samr.gov.cn，/bzgk/gb/ → /bzgk/std/）
- [x] GBW 新下载流程适配（newGbInfo 建立会话 → showGb 浏览器头 → 解析 isValid → 直接下载或验证码）
- [x] 手机端"我"页功能扩展（工具箱/CMA/日志/统计/设置入口）
- [x] 资质搜索结果手机端紧凑布局（category + testItem 合并一行）
- [x] 文件库手机端卡片布局（表格转卡片，仅显示预览+下载）
- [x] 文件库桌面端标准号+名称合并显示
- [x] 库配置移至系统设置新子 tab
- [x] BZ 适配器优化：并发下载容错（retry + skip）、搜索缓存 5min TTL、哨兵指纹替代 SHA-256
- [x] searchByStandard N+1 查询批量化（500次 → 2次）
- [x] queryBatched 串行改并发（2x 提速）
- [x] GBW 验证码流程调研 — isValid='true' 的标准不需要验证码，直接下载正常
- [x] 手机端下拉刷新（搜索结果 + 文件库）
- [x] CMA 一单一库机构详情手机端卡片化
- [x] 设置页诊断面板手机端全屏
- [x] 使用统计增强（来源成功率、热门标准 Top10、源健康看板、成功率指标）
- [x] 运行日志增强（今日概览条、错误聚合、快捷筛选、自动刷新、搜索高亮、后端来源标签）
- [x] 侧边栏重新排序（标准检索→资质→CMA→文件库→下载历史→日志→统计→设置）
- [x] Express trust proxy 支持反代部署
- [x] Docker 部署（Dockerfile + docker-compose + GitHub Actions 自动构建）
- [x] Docker OCR worker 冷启动超时修复（默认 20 秒；可通过 BZXZ_OCR_STARTUP_TIMEOUT_MS 按 NAS 性能调整；NAS 更新镜像后已验证恢复正常）
- [x] 版本号显示（"我"页底部 + /api/health）
- [x] index.html UTF-8 编码损坏修复（PowerShell 事故）
- [x] CSS 拆分（components.css → global + pages，16KB + 138KB）
- [x] CSS 按页面懒加载（首屏仅加载全局样式，切页时动态加载）
- [x] Paper 主题灰色修复（--text-3 暖化、log/stats/detail/settings 组件覆盖）
- [x] Paper 主题 Toast 背景修复（深色 → 暖白色）
- [x] 手机端复选框隐藏（result-card .check-col display:none）
- [x] 手机端 PDF 预览 devicePixelRatio 双重缩放修复（v1.1.4-v1.1.5）
- [x] 手机端 PDF 预览默认全页显示（fit mode page）
- [x] 手机端预览界面移除下载和新标签按钮
- [x] 双指缩放流畅度优化（CSS transform 替代实时重渲染）

## 托管治理计划（v1.4.17 后）

> 完整执行方案见 [`docs/MAINTENANCE_ROADMAP_V2.md`](docs/MAINTENANCE_ROADMAP_V2.md)。每项按“备份 → 修改 → 定向验证 → 独立提交 → 推送”执行。为避免上下文再次溢出，每个对话只处理一个可提交小批次；续接时从路线图记录的当前检查点开始，不重复全仓调查。

## 下次接手快速开始（换对话 / 换协作者时从这里开始）

> 适用：任何新对话、新 AI 会话或人工接手。不重新调查已完成阶段，只读确认现场后直接开工。

1. **确认现场**：`git status --short --branch` —— 工作树应只含 `.reasonix/**`、`reasonix.toml`、3 个 `cma_节能材料*.json` 的删除状态；若出现其他业务改动，先弄清归属再动。
2. **读检查点**：本文档上方 D0–D6 勾选状态 + `docs/MAINTENANCE_ROADMAP_V2.md` 当前阶段。**当前检查点：D3c 剩余**（① export task 迁入统一编排器；② 文件 rename/delete/move 补偿与 reconciliation），完成后进入 D4（前端公共基础）。
3. **备份**：在 `data/backups/` 生成 `bzxz-<阶段>-before-<yyyyMMdd-HHmmss>.db`（用 `better-sqlite3` 的 `db.backup()` 从只读连接拷贝）并执行 `PRAGMA integrity_check` = ok。已有 `bzxz-d3c-before-20260810-232123.db` 可作参照。
4. **每对话只做一个小批次**：改代码 → `npm run build` → `npm test`（全量，当前 10 文件 145 项，测试已隔离、可安全反复跑）→ 如需定向测试，按 `npm run build; ...; npm test; ...` 链式执行（单独的 vitest 命令会被工作流门禁拦截）→ `git diff --check`。
5. **提交**：禁止 `git add .`，必须显式列出暂存文件；`.reasonix/**`、`reasonix.toml`、`data/**`、`dist/**` 永不提交；3 个 CMA JSON 删除状态必须保留、绝不混入提交。commit 后 `git push`；被远程自动 version bump 拒绝时执行 `git pull --rebase --autostash`（autostash 保住未提交的删除）再 push。
6. **完成即更新**：每小批完成后立即更新本文档勾选 + 路线图对应阶段状态，独立 `docs:` 提交并推送。

**关键背景（勿擅自改动）**：国家 CMA 无限期暂停，普通 CNAS/CMA 资质与 CMA 一单一库不受影响；默认单用户 NAS 产品模式（`requireAuth`/`requireAdmin`/`requireTab` 当前全放行属既有设计）；自定义 `standardsLibraryDir` 是既有功能，保留 realpath/边界校验。

- [x] D0 国家 CMA 无限期硬暂停：禁生产 Provider、同步 API、自动调度与徽章入口，保留历史数据只读（2026-08-10）
- [x] D1 前端低风险止血（2026-08-10）：
  - [x] 手机端恢复资质“搜索 / 详细搜索”入口，仅隐藏 `visual`
  - [x] 移除手机 toolbar 的 `display:flex !important`
  - [x] 重命名弹窗去除窄屏固定最小宽度
  - [x] 幂等 `bootstrapApp()`，首屏认证和面板只初始化一次
  - [x] 根据恢复任务最大 ID 初始化 `downloadTaskSeq`
  - [x] 日志自动刷新接入 `_tabCleanup`，登录健康轮询保持单实例并可释放
  - [x] 375/430/640px 与桌面 Chromium smoke、build、101 项测试通过
  - 详细验证和文件边界见 `docs/MAINTENANCE_ROADMAP_V2.md` D1
- [x] D2 CNAS/CMA 同步原子替换与同机构 single-flight（2026-08-10）：TEMP staging 分块写入、短事务 promotion、手动/自动共享 service、失败保留旧快照、force 排队升级、证书号引用迁移和并发删除回滚；54 项定向测试通过
- [ ] D3 settings、下载和文件契约统一（进行中）：
  - [x] D3a settings 全部验证、transaction 提交后再执行 watcher/scan/scheduler 副作用；Cron 完整校验和端点故障注入通过
  - [x] D3b 统一下载编排及 owner/subscriber/reused/cancel 语义：`StandardDownloadOrchestrator` 按 source+id+userId 复用 in-flight、断连退订、close 原子关闭并纳入 shutdown；semaphore signal 取消；GBW autoDownload signal 贯穿全部 HTTP 阶段，abort 不降级不 fallback；144 项全量测试通过
  - [x] D3c 预览自动下载迁入统一编排器：与 multi-download 共享 flight、fileId/library_failed 语义、编排器补「下载产物缺失」显式失败；145 项测试通过
  - [x] D3c 剩余①：export task 迁入统一编排器（`ExportTaskService` 改为编排器胶水，channel `export`，复用 in-flight、保留 Store/SSE 进度、取消经 handle.unsubscribe abort；编排器补 totalPages/phase 透传）；152 项测试通过
  - [ ] D3c 剩余②：rename/delete/move 补偿与 reconciliation
- [ ] D4 前端公共基础：StdHub namespace、API/UiState/Modal/Lifecycle、统一缓存版本
- [ ] D5 单用户 NAS 产品模式、app.ts 拆分、source 类型和死代码清理
- [ ] D6 AGENTS/PRODUCT_STATUS/TESTING/RELEASE/ADR、Chromium E2E 与发布门禁

## 待办

#### 游客只读与单管理员解锁（已确认方案，尚未开始）

详细方案：[`docs/ACCESS_CONTROL_PLAN.md`](docs/ACCESS_CONTROL_PLAN.md)。

- [x] Phase A：恢复 guest/admin 会话，右上角管理员密码登录/退出，Cookie 过期、失败限速、CSRF。
- [x] Phase B：后端权限矩阵：游客只读；Labr、文件库、资质订阅/同步、CMA 机构维度对比/领域订阅、查新、补全、导出、运维全部管理员专属。
- [x] Phase C：前端按身份显示导航和操作；游客隐藏 Labr、机构维度对比、领域订阅与同步及所有修改按钮。
- [ ] Phase D：补齐直接 API、任务越权、缓存泄露、会话过期、移动端和发布验证。
- [ ] 明确不做用户管理、多用户、注册、邀请、角色编辑和用户级数据隔离。

#### 国家 CMA 功能（无限期暂停）
- [x] 生产 Provider、写入/同步/徽章 API、自动调度和前端入口已硬暂停；历史数据只读
- [x] 暂停决策和恢复条件已固化到 `docs/ADR/0001-national-cma-indefinite-suspension.md`
- [ ] 仅在新的 ADR、合规数据入口、place_id 级建模和完整门禁通过后评估恢复

#### 资质查询性能优化（2026-08-14）
- [x] 普通关键词和详细搜索接入 SQLite FTS5 trigram，避免 CNAS/CMA 两表多字段全扫描
- [x] 实验室名称/编号先定位机构主键，再按资质外键索引查询
- [x] 纯数字标准号进入归一化快路径；标准明细按 `std_code_norm` 直接查询
- [x] 搜索加载更多增量追加、慢查询日志、国家 CMA suspended 无效请求清理

#### 全面审查剩余项（2026-09-01）
> 已完成批次见 `findings.md` / `progress.md`：Multer 升级、cron 闰年窗口、全量测试、CI Node 对齐、trust proxy 收紧、未捕获异常受控退出、移除 `xlsx`、删除历史 CSS 双写、CSS 入口门禁。以下为尚未实施项。

##### 高优先级
- [x] 明确开放管理员模式：保持单用户免登录；非 loopback 默认强制 `STDHUB_PROXY_TOKEN`，仅 `STDHUB_ALLOW_OPEN_ADMIN=1` 可作为危险逃生开关。Docker Compose 因容器必须听 `0.0.0.0` 而带该开关，且端口默认只映射到宿主机 loopback
- [x] 处理剩余生产依赖漏洞：overrides 固定 `qs@^6.16.0`、`body-parser@^2.3.0`、`uuid@^11.1.1`（已验证 ExcelJS CJS `require('uuid').v4` 可用）；`npm audit --omit=dev` 清零

##### 中优先级
- [ ] 前端公共基础：统一 API client、事件委托替代 inline `onclick`、安全模板/DOMPurify 收口 `innerHTML`、新模块改 ES module，最终加 CSP。现状约 31 个全局脚本、112 个 inline handler、215 次 innerHTML、106 个 fetch
- [ ] 拆分超大职责文件：优先 `qualification-service.ts`、`standards-routes.ts`、`db.ts`；后续 `cap-lib-service.ts`、`gbw-adapter.ts`、`preview-routes.ts`
- [ ] 数据库迁移集中化：把 `db.ts` 与 `nat-cma-service.ts` 内的 schema 变更迁到 `src/database/migrations/`，每条带版本号、事务和测试
- [ ] 统一环境配置 schema：新增 `src/config.ts`，用 Zod 校验端口、限流、队列、timeout、bind host，禁止模块直接读未校验的 `process.env`
- [ ] 自动发布改为显式 release：当前每次 push main 都 bump/tag/Release/镜像，导致并发 rebase 和版本噪声；改为 `workflow_dispatch`、Changesets 或 release 标签驱动

##### 低优先级
- [ ] 理清 `data/cma_national.db`：已被 Git 跟踪，同时被 `.gitignore` 忽略。改为可审计 seed/JSON/SQL，或从 Git 移除并改为发布资产
- [ ] 首页重型依赖按需加载：Chart.js、PDFH5 和低频业务脚本改为进入对应 tab 时动态 import
- [ ] 历史文档标注 CSS 入口已变更：`docs/THEME_DESIGN.md`、`docs/MOBILE_ADAPTATION.md`、`docs/sources/labr-source-plan.md` 仍写 `public/styles.css` / `components.css`，避免后续按旧契约恢复双写

#### 中优先级
- [x] 手机端文件库：复选框与标准名称之间空隙过大，重构为 flex 卡片布局
- [x] 文件库 UI：移动端去除重复标题、合并重新扫描入口，选中后显示底部批量操作栏
- [x] 全站 UI：统一下载、同步、导出的任务反馈组件
  - 已同步 README 与 WORKLOG：下载、资质同步、CMA 能力库同步、标准查新导出、标准补全均接入任务中心
- [x] 资质与 CMA 页面：常用筛选前置，高级条件收进抽屉
  - 资质页面保留 CNAS/CMA 来源快捷筛选；高级抽屉调整结果数量
  - CMA 能力项目库保留领域筛选；高级抽屉按资料状态筛选并显示已选数量
- [x] 移动端 UI：统一页面头部与状态色体系
- [x] Web / 手机端：标准结果一键分享（手机调用系统分享；桌面复制可自动检索的链接）
  - 功能页统一为紧凑标题与可横向滑动的操作区
  - 任务、补全、状态徽标与提示采用一致的进行中 / 成功 / 警告 / 失败语义色

#### 下一轮体验优化
- [x] 搜索历史标签化：搜索框下固定展示最近 10 次关键词；支持单条删除、清空与一键重新搜索，取消遮挡结果的悬浮历史菜单；常用标准号模板独立成第二行
- [x] 下载全链路进度显示：单条、批量和任务中心统一展示来源阶段；BZ 按真实页数显示百分比，BY 等无总量来源仅显示真实阶段；批量支持逐项阶段、失败重试与停止后不再启动队列
- [x] 手机端任务反馈：任务进行中或失败时，在底部导航上方显示状态条并可展开查看（最近 30 条任务在刷新后保留；进行中任务会标记为需重新发起）
- [x] 收藏 / 关注跨设备同步：复用服务端查新关注清单；首次自动合并浏览器旧收藏，跨设备同步收藏标准号与关注状态；本地继续保留分组、备注和下载记录
- [x] 记住搜索习惯：按设备保留检索来源、结果筛选、排序和显示密度；筛选栏提供一键恢复默认
- [x] 文件库效率优化：增加最近 30 天、重复标准、多来源、年份快捷筛选；保留原有搜索、分页与批量删除 / 统一命名
- [x] 文件库宽屏单行布局：标准号与标准名称并列展示，大小、入库时间、来源和操作按表头对齐；窄屏继续保留两行紧凑卡片
- [x] 深色主题浮层统一：确认框、任务中心、用户菜单、筛选抽屉、预览与 Toast 改为黑蓝色；Legacy 兼容主题保留灰色风格
- [x] LABR 检索增强：标准号旁显示 CNAS/CMA 资质匹配标识；PDF 支持一键预览，首次会自动入库，登录类资源明确提示可能消耗当日配额
- [x] LABR 深度优化：后端统一标准号识别；结果可展开资源详情；下载、批量下载与预览接入任务中心；设置页展示 LABR 凭据 / 最近登录健康状态
- [x] LABR 资质与能力库补齐：严格资质显示 CNAS/CMA；仅有不同年版时以“跨年匹配”明确提示真实版本；同时显示国家 CMA 能力库状态，不改变主标准检索的严格同年语义
- [x] LABR 本地文件复用：查询结果批量标记已下载文件；PDF 预览优先秒开本地标准库副本，避免重复下载和消耗上游配额；单条 / 批量下载完成后即时刷新标记
- [x] 资质徽章详情浮层主题化：不再固定使用灰色 `#23262B`，随深色、Paper 与 Legacy 主题的表层颜色切换
- [x] 搜索完成状态提示主题化：右下角“搜索完成（N条）”不再写死深灰背景，跟随当前主题表层、边框与文字颜色
- [x] 外网访问防护：支持 `STDHUB_PROXY_TOKEN`，由 Lucky 注入私密 Header 后保护站点和 API；设置页与 README 提供启用说明
#### 下一轮可靠性与效率优化
- **Phase A 状态（2026-08-06 更新）**：已完成。可靠性收尾项已落地，重点覆盖文件库预览生命周期统一、动态列表事件委托、真实取消链路、收藏元数据服务端同步、PWA 缓存边界、任务中心历史与文件库版本管理。
- **Phase B 状态（2026-08-06 更新）**：已完成。性能优化项已落地，重点覆盖导出文件索引分页、文件库分块扫描、来源健康统计合并、资质批量快路径和版本化迁移入口。
- **Phase C 状态（2026-08-06 更新）**：已完成。安全 / 部署加固项按 C1-C6 落地，覆盖文件库真实路径边界、日志脱敏、高成本接口限流、反代部署边界、Docker 最小权限和 CI/CD 发布 gate。
- [x] Phase A 可靠性收尾：文件库预览复用统一预览生命周期；文件库动态列表移除业务数据拼接的 `onclick/onchange`，改为事件委托
- [x] Phase B 性能优化：`/api/downloads` 改为 exports 索引分页；`scanLibrary()` 改为扫描互斥、变更集和分块事务；`source-health` 合并为单 SQL；资质批量可视化对完整标准号走批量快路径；建立 `schema_migrations` 版本化迁移入口
- [x] Phase C 安全 / 部署加固：文件库拒绝 symlink 并使用 realpath 校验边界；日志入库前统一脱敏；预览下载、Labr、OCR/验证码、资质同步、批量操作等高成本接口接入限流；默认监听本机并为 NAS/Lucky 提供显式外部监听开关；Docker 非 root + 最小权限；CI/CD 改为测试通过后才发布镜像
- [x] 下载任务真正可取消：任务中心可请求服务端取消，SSE 显示已取消；取消后阻止后续校验、入库与完成回写，并释放同标准排队锁
- [x] 收藏元数据跨设备同步：分组、备注、已下载状态与文件名迁入服务端；收藏存在状态继续以查新关注清单为唯一依据
- [x] 手机 PWA 体验：支持 HTTPS 安装到主屏；Service Worker 缓存页面壳和静态资源，明确绕开 API、PDF 与认证响应
- [x] 任务中心历史：复用服务端 usage_events 加载下载/导出记录；任务中心支持类型、状态筛选并展示失败详情
- [x] 文件库版本管理：按标准号聚合多来源/多年份文件；多版本/多来源使用可展开父行，单版本保持普通文件行，分页按标准系列计算
- [x] 本地文件库体验修复：同一标准系列在当前页内连续展示，分组标题与版本/来源数量一致；改为每页 30 项的明确分页，标准号旁显示 CNAS/CMA 与国家 CMA 能力库状态
- [x] 标准更新提醒：“我”页显示收藏标准真实变更、近 7 天入库数与最近来源异常摘要

#### 资质查询与预览体验优化
- [x] 预览任务阶段化反馈：`checking_library`、`searching_source`、`downloading`、`moving_to_library`、`ready`、`failed` 等阶段显示来源、耗时、重试和可执行动作
- [x] 资质查询标准号快路径：标准号类输入优先走 `std_code_norm/std_code_base` 索引；命中后直接返回精确标准组，未命中才回退全文匹配
- [x] 资质结果分区展示：精确匹配、同系列/跨年提示、全文匹配分区展示，避免不同年份资质误读为严格命中
- [x] 按标准查延迟加载：先返回标准组摘要，用户展开后再加载机构明细，避免大产品标准一次性拉取大量行
- [x] 资质查询分页 / 加载更多：明细查询支持 offset 分页；前端提供加载更多，减少一次性渲染压力
- [x] 预览资源加载优化：空闲预加载 PDF.js/pdfh5；大文件或页数多时提示优先用浏览器原生打开
- [x] 预览原生打开兜底（最后实施）：预览弹层、手机失败页和长时间等待状态增加“用浏览器原生打开”；华为手机等内嵌 PDF 不兼容时可直接跳系统浏览器或下载后打开
- 详细方案见 `docs/QUAL_SEARCH_AND_PREVIEW_OPTIMIZATION_PLAN.md`

## 暂不实施（不计入当前待办）

- SSO 登录服务：当前保持免登录管理员模式；后续如部署 Authentik、Keycloak、企业微信、钉钉或飞书等身份服务，再接入通用 OIDC 登录。

## 已知问题

- **GBW 源已适配新上游**：域名 `c.gb688.cn` → `openstd.samr.gov.cn`，路径 `/bzgk/gb/` → `/bzgk/std/`。isValid='true' 的标准可直接下载，无需验证码。
- pdf-merge-worker 警告：tsx 模式下 Node.js 产生 MODULE_TYPELESS_PACKAGE_JSON 警告（功能正常）
- onnxruntime 1.27.0 在 Python 3.14 上 DLL 加载失败，已降级到 1.19.0 + Python 3.11 解决

## 部署信息

- **GitHub**: https://github.com/atpx4869/stdhub
- **Docker Hub**: `jzrm/stdhub:latest`，同时提供 `<版本号>` 与 `v<版本号>` 固定标签
- **GitHub Actions**: push to main 自动构建 Docker 镜像，并从 `package.json` 自动生成版本标签
- **NAS 部署**: Docker Compose 默认拉取 `jzrm/stdhub:latest`，端口 3000；需要锁定版本时可改用固定标签

## 事故记录

### 2026-07-06 index.html 编码损坏事件
- **原因**：PowerShell `Set-Content -Raw` 和 `-replace` 破坏 UTF-8 编码
- **修复**：手动重写整个 index.html
- **教训**：永远不用 PowerShell 修改含中文的 UTF-8 文件，用 Node.js fs.writeFileSync 或 VS Code

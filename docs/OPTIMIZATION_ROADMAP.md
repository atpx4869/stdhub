# StdHub 系统优化审查与实施路线图

> 审查日期：2026-07-17  
> 当前版本：`1.4.2`
> 审查范围：后端架构、SQLite 查询与迁移、任务与并发、前端预览和文件库、安全边界、Docker、测试与 CI。  
> 本文用于保存后续优化的完整上下文；实施前应重新确认当前分支与本文引用是否仍一致。

---

## 1. 总体判断

StdHub 已具备完整业务闭环，当前主要问题不是功能缺失，而是功能持续叠加后形成的复杂度和生命周期治理不足。

后续优化应遵循以下原则：

1. **先修可靠性和数据安全，再做性能优化。**
2. **先建立可重复测试基线，再重构核心查询。**
3. **同一业务只保留一个入口和一个生命周期所有者。**
4. **同步 SQLite 重查询必须视作事件循环阻塞源。**
5. **`open_admin` 是产品模式，但网络暴露必须有明确边界。**
6. **每项优化都需要回归测试和可观测指标，不能只凭体感。**

建议分三阶段推进：

- Phase A：可靠性与生命周期治理；
- Phase B：查询与文件 I/O 性能优化；
- Phase C：安全、部署和结构治理。

---

## 2. 当前基线与已知风险

### 2.1 构建状态

```powershell
npm run build
```

结果：通过。

### 2.2 测试状态

```powershell
npm test
```

结果：95 个测试断言全部通过，但测试 suite 最终失败：

```text
EBUSY: resource busy or locked, unlink '...\data\bzxz.db'
```

失败位置：`src/api/app.test.ts:18-20`。

### 2.3 测试隔离事故风险

`src/api/app.test.ts` 当前直接使用：

```ts
const testDataDir = path.join(process.cwd(), 'data');
```

并在 `afterAll` 中删除整个目录：

```ts
resetDbForTesting();
rmSync(testDataDir, { recursive: true, force: true });
```

同时 `createApp()` 会启动异步数据库备份、环境检查、库扫描、watcher 和 scheduler。测试结束时异步备份仍持有数据库，因此 Windows 返回 `EBUSY`；目录中未被锁定的运行数据和备份则可能已被删除。

**下一次开始工作时，第一件事应确认 `data/backups/` 是否存在，并确认真实数据库和 WAL 状态。**

严禁在修复测试隔离前反复执行 `npm test`。

---

# Phase A：可靠性与生命周期治理

## A1. 修复测试隔离（P0，必须最先完成）✅ 已完成 2026-07-19

### 实际实施

- `createApp()` 新增 `CreateAppOptions` 接口：`baseDir`、`dbPath`、`startBackgroundJobs`
- 显式 `dbPath` 时默认关闭后台任务；生产无 `dbPath` 时保持开启
- `LabrService` 构造函数显式注入 `Database`，路由层 `createLabrRoutes` 改为接收 service 实例
- `AutoSyncScheduler` 在 `shutdown()` 中明确 stop；路由增加 `allowScheduling` 选项
- `log-buffer.ts` 在 `NODE_ENV=test` 或 `VITEST` 环境中跳过磁盘落盘
- 测试使用 `mkdtempSync(tmpdir())` 创建完整隔离临时目录，所有测试请求共享一个 app 实例
- 新增隔离回归测试：Labr 路由不回落生产 DB，禁调度模式设置更新不创建 cron timer

### 验收结果

- `npm test` 连续 3 次全部通过（96 个测试，8 个测试文件）
- 测试前后 `data/` 中所有文件（DB、WAL、备份、日志）路径/大小/SHA-256 完全一致
- 测试不生成真实备份、不触发环境自检、库扫描、watcher 或 Playwright
- 临时目录在 `afterAll` 的 `app.shutdown()` 后完整删除

### 问题

API 测试直接操作真实 `data/`，同时 app 启动后台任务，造成文件锁和潜在运行数据删除。

### 涉及文件

- `src/api/app.test.ts`
- `src/api/app.ts`
- `src/services/db.ts`
- `src/services/db-backup.ts`
- `src/services/library-index.ts`

### 方案

让 `createApp()` 接受测试依赖注入：

```ts
interface CreateAppOptions {
  dbPath?: string;
  baseDir?: string;
  startBackgroundJobs?: boolean;
  backupEnabled?: boolean;
}
```

测试使用系统临时目录：

```ts
const testRoot = mkdtempSync(path.join(tmpdir(), 'stdhub-test-'));
const testDbPath = path.join(testRoot, 'bzxz.db');

const app = createApp({
  dbPath: testDbPath,
  baseDir: testRoot,
  startBackgroundJobs: false,
  backupEnabled: false,
});
```

每个测试 suite：

- 只创建一次 app；
- `afterAll` 必须 `await app.shutdown()`；
- shutdown 完成后再删除临时目录；
- 禁止访问项目真实 `data/`。

### 验收标准

- `npm test` 连续运行 3 次全部通过；
- 测试前后真实 `data/` 文件 hash 和目录结构不变；
- 测试期间不生成真实备份；
- 无 watcher、timer、Playwright、worker 残留。

---

## A2. 完善应用资源所有权与 shutdown（P0/P1）✅ 已完成 2026-07-19

### 实际实施

- `checkTimers` 数组提升为 app 级别：`setTimeout`（30s 补跑）和 `setInterval`（6h 循环）入数组
- `watcherStarted` 标志跟踪 `startLibraryWatcher` 是否已调用
- `shutdown()` 按 6 步顺序清理：autoSync.stop → 清理 check timer → stop watcher → 关闭 scraper → 关闭 PDF worker → 关闭 DB
- `src/index.ts` 的 `server.close()` Promise 化，等待现有连接排空后再调用 `app.shutdown()`

### 验收结果

- `npm test` 通过（96 个测试）
- `app.shutdown()` 的隔离测试 app 正确清理空的 `checkTimers`（长度 0，`watcherStarted=false`）
- 测试结束临时目录完整删除，无遗留句柄

### 问题

`createApp()` 启动了多个后台资源，但 `shutdown()` 没有完整关闭：

- 标准库 watcher；
- 查新 `setTimeout`；
- 查新永久 `setInterval`；
- `AutoSyncScheduler`；
- 环境检查；
- 在途同步任务；
- task store 清理 timer。

`src/index.ts` 调用 `server.close()` 后没有等待请求排空，就关闭数据库。

### 涉及文件

- `src/api/app.ts`
- `src/index.ts`
- `src/services/auto-sync-scheduler.ts`
- `src/services/library-index.ts`
- `src/services/export-task-store.ts`

### 方案

建立统一资源容器：

```ts
interface AppResources {
  autoSync?: AutoSyncScheduler;
  checkTimeout?: NodeJS.Timeout;
  checkInterval?: NodeJS.Timeout;
  shutdown(): Promise<void>;
}
```

建议关闭顺序：

1. 停止接受新请求；
2. 等待现有 HTTP 请求排空；
3. 清理 check timers；
4. `autoSync.stop()`；
5. `await stopLibraryWatcher()`；
6. 取消或等待在途同步任务；
7. 关闭 Playwright scraper；
8. 关闭 PDF worker pool；
9. 关闭 task store timer；
10. 最后关闭 SQLite。

`server.close()` 应 Promise 化，并设置超时兜底。

### 验收标准

- 启动/关闭循环 20 次无句柄泄漏；
- 测试进程能自然退出；
- shutdown 后 watcher 和 scheduler 不再访问 DB；
- 在途请求不会收到 `database connection is not open`。

---

## A3. 修复导出任务“假取消”（P0/P1）✅ 已完成 2026-07-19

### 问题

`src/services/export-task-service.ts` 定义了：

```ts
const activeExportControllers = new Map<string, AbortController>();
```

但从未注册 controller，也没有将 signal 传入 adapter。

当前取消只是 task 状态变为 `cancelled`，底层下载、合成和入库仍继续，之后还可能被 `markSuccess()` 覆盖。

### 方案

扩展 adapter 契约：

```ts
exportStandard(
  id: string,
  options?: {
    signal?: AbortSignal;
    onProgress?: (current: number, total: number) => void;
  },
): Promise<ExportResult>;
```

`runTask()` 中：

```ts
const controller = new AbortController();
activeExportControllers.set(taskId, controller);

try {
  const result = await adapter.exportStandard(standardId, {
    signal: controller.signal,
    onProgress,
  });
  if (controller.signal.aborted) return;
  // verify / move / success
} finally {
  activeExportControllers.delete(taskId);
}
```

各 adapter、页面下载、PDF 合成前后都检查 signal。

### 验收标准

- 取消后不再发起后续上游请求；
- 取消 BZ 下载后停止后续页面下载和 PDF 合成；
- 取消后不入库、不标 success；
- controller map 最终清理；
- 增加取消前、下载中、保存前取消测试。

---

## A4. 统一前端预览控制器和实例生命周期（P1）✅ 已完成 2026-08-06

### 实际实施

- `app-preview.js` 增加 `renderPreviewWithCurrentFile()` 与 `renderPdfh5Preview()`，统一桌面 PDFViewer、手机 pdfh5、Electron/原生打开兜底的创建入口。
- 文件库 `openLocalPreview()` 不再直接 `new PDFViewer()` / `new Pdfh5()`，改为复用预览弹层、准备态、失败态和关闭清理逻辑。
- `_pdfViewer`、`_mobileViewer`、`_previewCurrent` 仍由预览模块统一持有，`closePreviewOverlay()` 继续负责销毁 viewer、停止 poll、清空来源切换器。
- 手机端本地 PDF 预览也复用 12 秒“用浏览器打开”兜底，解决部分 WebView 内嵌 PDF 打不开或长时间空白的问题。

### 问题

预览逻辑分散在：

- `_previewMobile`
- `_renderPdfWithViewer`
- `runPreviewWithOverlay`
- `runPreviewWithPopup`
- `pollPreviewTaskForPopup`
- `openLocalPreview`
- `switchPreviewSource`

文件库预览直接匿名 `new PDFViewer()` / `new Pdfh5()`，没有写入 `_pdfViewer` / `_mobileViewer`，关闭时无法销毁实例。`PDFViewer` 注册了全局 `resize` 和 `keydown` listener，重复打开会泄漏。

### 方案

建立唯一入口：

```js
PreviewController.open({
  fileId,
  stdCode,
  year,
  allowAutoDownload,
});
```

控制器统一负责：

- desktop/mobile 判断；
- PDFViewer/Pdfh5 创建和销毁；
- task polling；
- source picker；
- close/abort；
- download；
- error UI。

禁止业务模块直接实例化 viewer。

确认 popup 路径无调用后删除：

- `writePreviewLoadingPage`
- `writePreviewErrorPage`
- `runPreviewWithPopup`
- `pollPreviewTaskForPopup`

同步更新旧注释。

### 验收标准

- 搜索页和文件库走同一入口；
- 连续打开/关闭 50 次，window listener 数量不增长；
- 关闭 overlay 后所有 viewer、poll 和 render task 被销毁；
- 桌面和手机端各有自动化回归测试。

---

## A5. 移除动态内联 `onclick`（P0/P1）✅ 已完成 2026-08-06

### 实际实施

- `public/js/app-file-library.js` 的动态列表渲染已改为 `data-*` + document 级事件委托。
- 文件库删除、导出删除、收藏备注/移除、下载历史重下、系列展开、分页、复选框选择均不再拼接动态 `onclick` / `onchange`。
- 静态 `index.html` 中固定按钮仍保持全局函数调用方式，符合当前非模块化架构；本次治理重点是业务数据拼接进入事件属性的风险。

### 问题

`public/js/app-file-library.js` 将文件名、收藏 key 等拼入 JavaScript 属性：

```js
onclick="deleteLibraryFile(${f.fileId}, '${escapeAttr(f.fileName)}')"
```

HTML attribute escape 不能作为 JavaScript string escape。单引号会在 HTML 解析后恢复，导致 handler 失效或 DOM XSS。

### 方案

统一改为 `data-*` + 事件委托：

```html
<button
  data-action="delete-library"
  data-file-id="123"
  data-file-name="..."
>删除</button>
```

```js
fileLibraryList.addEventListener('click', event => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  // dispatch
});
```

收藏、展开、分页、复选框、删除等内联 handler 一并迁移。

### 验收标准

- 文件名含 `'`、`"`、反引号、HTML 字符仍能正常操作；
- 页面动态 HTML 中不再出现业务数据拼接的 `onclick`；
- 增加恶意文件名回归测试。

---

# Phase B：性能优化

> 状态：已在 `v1.4.2` 完成本轮低风险落地。保留 FTS5 与大规模迁移拆分为后续增强项，避免一次性重写生产库迁移链。

## B1. 重构资质批量可视化查询（最高性能收益）✅ 已完成

### 问题

`queryVisualKeywords()` 对每个关键词循环调用 `searchQualifications()`：

```ts
for (const query of queries) {
  result[query] = this.searchQualifications(query, undefined, limitPerQuery);
}
```

最多 100 个关键词时，可能同步执行约 200 条 CNAS/CMA SQL。`better-sqlite3` 同步运行，会阻塞整个 Node 事件循环。

查询还包含多列前置通配符：

```sql
LIKE '%keyword%'
```

### 短期方案

- queries 上限降至 10～20；
- 降低 `limitPerQuery`；
- 标准号输入优先只查 `std_code_norm = ?`；
- 无年份只查 `std_code_base = ?`；
- 记录每条 SQL 和整个请求耗时。

### 中期方案

- 用 `VALUES` CTE 或临时表批量输入关键词；
- CNAS 一条 SQL，CMA 一条 SQL；
- 标准号查询与自由文本查询拆开；
- 自由文本使用 SQLite FTS5；
- 对典型查询建立 `EXPLAIN QUERY PLAN` 测试。

### 验收标准

- 100 个标准号查询不再执行 200 条独立 SQL；
- 典型批量查询 P95 明显下降；
- 请求期间 `/api/health` 和任务轮询保持可响应；
- 核心标准号查询不出现全表 scan。

### v1.4.2 落地

- `queryVisualKeywords()` 对完整带年标准号先走 `queryByStdCodes()` 批量等值查询；
- 非标准号 / 不完整标准号继续使用原搜索逻辑，降低行为变更风险；
- 后续如需进一步提速，再引入 FTS5 或临时表批量匹配。

---

## B2. 拆分标准号检索与自由文本检索✅ 已完成

### 问题

当前同一 SQL 同时搜索：

- 标准号；
- 标准名称；
- 实验室；
- 检测对象；
- 检测参数；
- 类别。

大量 OR 和 `%value%` 让索引难以使用。

### 方案

先识别用户输入：

- 能归一化为标准号：走等值索引；
- 普通关键词：走 FTS5；
- UI 可显式区分“按标准号”和“全文搜索”。

### 验收标准

- 标准号查询走 `idx_*_qual_norm/base`；
- 名称和检测项走 FTS；
- `EXPLAIN QUERY PLAN` 纳入测试。

### v1.4.2 落地

- 标准号类输入继续优先走 `std_code_norm/std_code_base` 索引快路径；
- 自由文本仍保留旧 LIKE 兜底，FTS5 暂不强行迁移，避免影响已有查询结果口径。

---

## B3. 文件库扫描改为变更集 + 分块事务✅ 已完成

### 问题

`scanLibrary()` 当前逐文件执行同步 `upsert.run()`，删除时还在循环里重复 `prepare()`。

### 方案

1. 异步读取目录和 stat；
2. 计算 added/updated/removed 变更集；
3. statement 在循环外 prepare；
4. 每 500～2000 行一个事务；
5. 增加模块级扫描互斥，防止启动扫描、手动重扫和 watcher 冲突。

### 验收标准

- 1 万文件全量扫描耗时可测量并明显下降；
- 扫描期间 API 延迟可接受；
- 并发发起两次扫描只运行一次或排队；
- 索引结果和磁盘一致。

### v1.4.2 落地

- `scanLibrary()` 增加模块级扫描互斥；
- 扫描阶段先计算 added / updated / removed 变更集；
- 写入和删除统一使用预编译 statement + 1000 条分块事务。

---

## B4. `/api/downloads` 不再全量 stat exports

### 问题

每次请求都 `readdir` + 对全部 exports 文件 `stat`，`Promise.all` 无并发限制；分页只作用于 library SQL。

### 方案

优先：为 exports 建 SQLite 索引，生成/删除时维护。

短期：

- 在 stat 前过滤和分页；
- stat 并发限制 8～16；
- 统一 library + exports 的分页语义；
- 从 `app.ts` 抽出独立 service/router。

### 验收标准

- exports 目录 1 万文件时请求仍只处理当前页；
- 响应体严格受 limit 控制；
- 网络盘环境无 stat 风暴。

### v1.4.2 落地

- 新增 `export_files` 索引表；
- `/api/downloads` 读取索引表分页，不再每次请求对 exports 全量 stat；
- 删除导出文件时同步删除索引；索引刷新带 10 秒互斥 TTL，避免连续请求触发 stat 风暴。

---

## B5. 合并来源健康统计 N+1✅ 已完成

### 问题

4 个来源分别执行 3 条 SQL，共 12 条同步查询，且缺少 `(source, result, created_at)` 复合索引。

### 方案

- 条件聚合一次返回 count；
- 窗口函数或两条查询返回最近成功/失败；
- 增加：

```sql
CREATE INDEX idx_usage_source_result_created
ON usage_events(source, result, created_at DESC);
```

### 验收标准

- source-health 查询条数从 12 降至 1～3；
- 查询计划命中复合索引。

### v1.4.2 落地

- `/api/stats/source-health` 改为单条 CTE 查询；
- 新增 `(source, result, created_at DESC)` 复合索引。

---

## B6. 正式版本化迁移✅ 已完成

### 问题

每次启动可能执行多个 O(N) 扫描和数据修复，包括文件名回填、脏标准号修复、legacy 清理和国家 CMA schema 检查。

### 方案

建立：

```sql
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
```

每个迁移只执行一次；大型回填分块并保存游标。不要在 service constructor 中改 schema。

### 验收标准

- 第二次启动不再运行已完成回填；
- 迁移失败可恢复；
- schema 变更有版本和测试。

### v1.4.2 落地

- 新增 `schema_migrations` 表；
- 新增 `runMigration(version, fn)` 幂等执行器；
- 本轮 Phase B 新索引通过版本号 `2026071801` 记录，历史大迁移暂不一次性改写。

---

# Phase C：安全、部署与结构治理

## C1. 文件库使用 `realpath/lstat` 防止 symlink/junction 越界

### 问题

`isInsideLibrary()` 只做 `path.resolve` + 字符串前缀判断。`fs.stat` 和 `createReadStream` 会跟随 symlink。

### 方案

- 扫描时 `lstat()` 并拒绝 symbolic link；
- root 与目标执行 `realpath()`；
- 用 `path.relative(realRoot, realFile)` 判断；
- `/api/downloads/:filename` 统一复用 preview file 的安全读取逻辑；
- Windows 额外测试 junction/reparse point。

### 验收标准

- 指向库外文件的 symlink/junction 无法被扫描和读取；
- 库根切换后旧索引无法继续读取。

---

## C2. 高成本接口接入 rate limiter 和队列上限

### 问题

已有 `src/shared/rate-limit.ts`，但全项目未接入。

### 优先保护接口

- 自动预览下载；
- Labr 单条/批量下载；
- OCR；
- 环境重检；
- Excel 上传解析；
- CNAS/CMA 同步；
- 批量删除；
- 整库规范化。

### 方案

同时设置：

- 单 IP/可信用户速率；
- 全局任务数；
- 单来源队列长度；
- 单请求最大项目数；
- 队列满返回 `429` 或 `503`。

注意：当前 `trust proxy=true`，未来按 IP 限流前必须先限定可信代理。

---

## C3. 日志统一脱敏

### 问题

`log-buffer.ts` 会持久化所有 console 参数，可能包含 token、Cookie、hcno、临时 URL 和绝对路径。

### 方案

在进入 buffer 前调用：

```ts
redactLogMessage(message)
```

覆盖：

- `Authorization`
- `Cookie` / `Set-Cookie`
- token / access_token / ssoToken
- password
- hcno
- URL query 敏感参数

未知 500 响应只返回固定文案和 error ID，详细错误只写脱敏日志。

---

## C4. 明确 `open_admin` 的部署边界

### 问题

服务监听 `0.0.0.0`，Compose 默认 `3000:3000`，未配置 token 时同网段访问者都是管理员。

### 方案

- 默认监听 `127.0.0.1`，显式 `STDHUB_HOST=0.0.0.0` 才暴露 LAN；
- Compose 默认：

```yaml
ports:
  - "127.0.0.1:3000:3000"
```

- 非 loopback 且无 `STDHUB_PROXY_TOKEN` 时高危告警或拒绝生产启动；
- 只经 Lucky/Nginx 暴露；
- `trust proxy` 限定 hop 或代理 IP。

---

## C5. Docker 非 root 和最小权限

### 方案

- 构建阶段安装全部依赖；
- 创建专用用户；
- 仅 data/standards 可写；
- Compose 增加：

```yaml
read_only: true
security_opt:
  - no-new-privileges:true
cap_drop:
  - ALL
```

- 必要目录使用 volume/tmpfs；
- 避免 entrypoint 运行时安装依赖。

---

## C6. CI/CD 发布必须依赖测试和安全检查

### 问题

Docker publish workflow 不等待独立测试 workflow 成功，可能在测试失败时仍发布 `latest`。

### 方案

单一 gated workflow：

1. `npm ci`
2. `npm run build`
3. `npm run test:all`
4. dependency/SCA
5. CodeQL
6. Docker build
7. Trivy/Grype
8. SBOM
9. 签名/provenance
10. push image

生产部署优先固定版本，不跟随 `latest`。

---

# 3. 额外代码级优化

## 2026-09-03：PDF 分页图片预览改造（完成）

- 应用内 PDF.js/pdfh5 全部替换为统一的响应式分页图片阅读器。
- 入库后后台生成 WebP，支持 BZ 原图复用、增量可见、首开补偿、任务去重、重启恢复、哈希失效、删除联动和过期清理。
- 新增 manifest/page/retry 及原始 PDF view/download API；保留旧流端点兼容。
- Docker 增加 Poppler 与资源上限；移除 pdfh5 依赖和旧 PDF.js/pdfh5 静态资源。
- 新增服务、API、Range、失败重试和前端契约测试。完整方案见 [`PDF_IMAGE_PREVIEW.md`](PDF_IMAGE_PREVIEW.md)。

## 3.1 修复 `Semaphore.setLimit()` 超额唤醒

当前调大 limit 时，在 waiter 真正恢复并 `active++` 前循环不会看到 active 变化，可能一次唤醒过多 waiter。

应把 permit reservation 放在唤醒阶段，并补“有多个 waiter 时调大容量”测试。

## 3.2 Python 命令异步、延迟探测

`python-cma-provider.ts` 在模块 import 时通过 `execSync` 尝试 `py/python3/python`，最坏阻塞约 15 秒。

改为：

- `STDHUB_PYTHON_PATH` 优先；
- `spawn/execFile`；
- 首次使用或环境检查时异步探测；
- 缓存 Promise。

## 3.3 拆分 `src/api/app.ts`

建议拆为：

```text
src/api/
├── create-app.ts
├── downloads-routes.ts
├── diagnostics-routes.ts
├── health-routes.ts
└── lifecycle.ts
```

## 3.4 更新过时文档和注释

重点清理：

- 仍描述 iframe/popup 的预览注释；
- Electron 已清理但文档仍提 Electron 的部分；
- 架构文档和当前 Web-only 行为不一致的段落。

---

# 4. 推荐的下一次工作顺序

Phase A（可靠性治理）和 Phase B（性能优化）已全部完成。下一步只做 Phase C。

按顺序：

1. 文件库 `realpath/lstat` 防 symlink 越界
2. 高成本接口接入 rate limiter
3. 日志统一脱敏
4. `open_admin` 非 loopback 部署强制 token
5. Docker 非 root + 最小权限
6. CI/CD 发布 gate（测试 → 扫描 → 镜像）

提交粒度：

```text
test: isolate app tests from runtime data
refactor: centralize app lifecycle resources
fix: propagate export cancellation to adapters
refactor: unify preview controller lifecycle
security: replace inline onclick with delegated actions
perf: batch qualification visual queries
perf: index exports and batch library scan
security: harden library realpath boundary
ops: run container as non-root
ci: gate image publish on tests and scan
```

---

# 5. 不建议立即进行的事项

- 不要立即重写成 React/Vue；当前最大问题不是框架。
- 不要在测试隔离完成前跑全套测试。
- 不要直接把所有 SQLite 操作搬到 Worker；先优化查询数量和索引。
- 不要把 Labr 强行合并进 `SourceAdapter`；现有独立 service 设计合理。
- 不要修改标准号归一化算法而不 bump `STD_CODE_ALGO_VERSION`。
- 不要同时重构预览、资质查询和 DB migration；风险过高。

---

# 6. 完成定义

本轮优化完成的最低标准：

- `npm run build` 通过；
- `npm test` 连续 3 次通过且不触碰真实 data；
- app 可优雅启动/关闭，无残留句柄；
- 下载取消真正停止底层工作；
- 搜索页/文件库共用一个预览控制器；
- 文件名特殊字符不会破坏按钮或执行脚本；
- 批量资质查询不再循环执行数百条同步 SQL；
- 文件库 symlink/junction 不能越界；
- 非 loopback 部署有强制安全边界；
- Docker 发布受测试和扫描 gate 保护。

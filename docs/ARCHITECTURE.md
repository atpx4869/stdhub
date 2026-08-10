# bzxz 架构约定

> 本文档记录代码层的约定，新加功能时按这些规则放——避免再一次"多 AI 多次拼凑"的混乱。
> 与代码不一致时，**以代码为准**，但应该有人来更新这份文档。

---

## 一、API 响应壳 (Result Envelope)

所有 JSON API 端点统一返回 `{ data, error }` 壳，定义在 `src/shared/response.ts`：

```ts
type ApiResult<T> =
  | { data: T;    error: null }
  | { data: null; error: { code: string; message: string; details?: unknown } }
```

**写后端时**：永远走 `respond(res, payload)` / `respondError(res, status, code, message, details?)`，**禁止直接** `res.json(...)` 或 `res.status(N).json(...)`。

**写前端时**：从 fetch 拿到响应后用 `readApiResponse(res)` 解包，它会自动取 `data` 或把 `error` 字段透出。

**SSE/流响应**：每条 `data:` 行也用同样的壳（`{ data: T, error: null }` 或 `{ data: null, error: {...} }`），客户端用同一解包路径。

**例外**：文件下载（`/api/downloads/:filename`）、静态资源、`GET /` 不走 Result 壳——它们不是 JSON。

---

## 二、命名风格

| 边界 | 风格 | 原因 |
|------|------|------|
| 数据库（SQLite 列） | `snake_case` | SQL 惯例，`lab_no`、`created_at` |
| Service 层方法/属性 | `camelCase` | TypeScript 惯例 |
| API 请求体字段 | `camelCase` | 客户端契约 |
| API 响应体字段 | `camelCase` | 客户端契约 |
| 前端 JS 标识符 | `camelCase` | JS 惯例 |
| localStorage 键名 | `snake_case` 前缀 `bzxz_` | 与 DOM/Web 习惯一致 |

**转换边界**：
- DB → API：路由层用 `toCamelCase(...)` 包装（`src/shared/case.ts`）
- API → DB：路由层用 `toSnakeCase(...)` 把请求体喂给 service（zod schema 也用 camelCase）
- service 层本身不关心 snake/camel——它接受什么形态由路由决定

---

## 三、路由前缀

按"资源族 → 子资源"分层。**功能上同族的，URL 也要同族**：

```
/api/auth/*               用户认证（登录、注册、会话、改密）
/api/admin/*              管理员（用户管理、全局设置）
/api/stats/*              使用统计

/api/standards/*          标准检索、详情、预览、下载
/api/standards/:id/...
/api/download-sessions/*  下载会话（验证码流程）
/api/tasks/*              异步任务进度

/api/qualifications/*     资质能力（CNAS / CMA 统一族）
  /search                 资质搜索（行级平铺）
  /search-by-standard     按标准号聚合（产品标准可展开 / 方法直显，searchByStandard）
  /batch-query            批量按标准号查
  /visual                 可视化批量查
  /settings               同步设置
  /stats                  统计
  /labs/cnas              CNAS 实验室订阅 (GET/POST)
  /labs/cnas/:labNo       (DELETE/PUT)
  /labs/cnas/sync         (POST)
  /labs/cnas/sync-logs    (GET)
  /labs/cma               CMA 同上
  /labs/cma/search        CMA 候选机构搜索
  /links                  CNAS↔CMA 关联
  /links/:source/:id      (DELETE)

/api/downloads*           导出文件列表/下载/删除
/api/health               健康检查
```

**Legacy aliases**：旧路径（`/api/cnas/labs`、`/api/cma/sync`、`/api/qualification-links/*`）在 `src/api/app.ts:legacyRouteAlias` 中央 rewrite 表里透明转发到新路径，下个大版本删除。**新代码不要写旧路径。**

---

## 四、错误处理

后端 3 条路径合一：

1. **请求验证**：抛 zod 错误，`normalizeError` 转 `BadRequestError`，被全局错误中间件捕获 → `{ error: { code: 'BAD_REQUEST', ... } }`
2. **业务约束/找不到**：直接 `throw new BadRequestError(msg)` / `throw new NotFoundError(msg)` / `throw new UpstreamError(msg)`（定义在 `src/shared/errors.ts`）
3. **意料外异常**：被全局错误中间件捕获 → `{ error: { code: 'INTERNAL_SERVER_ERROR' } }`

**禁止反模式**：把业务"失败"塞进 HTTP 200（如 `res.json({ status: 'failed', ... })`）。失败就走 4xx/5xx + Result error。

前端：`readApiResponse(res)` 返回 `{ code, message, details? }` 时即表示失败，调用方做 `if (data.code) { ... }` 或读 `data.message` 直接显示。

---

## 五、三层配置存储

三层并存，各自的职责**严格不重叠**。新加配置项前看这张表：

| 层 | 存什么 | 范围 | 文件/位置 |
|----|--------|------|----------|
| **DB `settings` 表** | 全局策略、跨设备共享、需要权限管控 | 服务端全局 | `bzxz.db` |
| **localStorage** | UI 偏好、单机使用习惯、可丢失 | 单浏览器/单用户 | 浏览器本地 |
| **Electron `settings.json`** | 桌面集成（下载路径、开机启动、LAN 访问开关） | 单台设备的桌面客户端 | 用户数据目录 |

**怎么选**：

- 重启/换电脑/换浏览器后**必须保留** → DB
- 只影响当前看到的 UI（顺序、密度、面板位置） → localStorage
- 涉及 OS / Electron API（路径、注册表、托盘） → Electron settings.json
- 安全/管控相关（登录是否必填、注册是否开放） → DB（不能让前端 localStorage 篡改）

**禁止**：同一个语义存在两层。例如下载并发数：只放 localStorage（每用户独立），不要再在 DB 也存一份"默认值"。

**键名规范**：
- DB settings 表：`snake_case`（`qual_sync_cron`、`registration_enabled`）
- localStorage：`bzxz_` 前缀 + `snake_case`（`bzxz_priority`、`bzxz_concurrency`）
- Electron settings.json：`camelCase`（`downloadPath`、`webServiceEnabled`）—— JSON 是 JS 边界

---

## 六、源 (Source) 抽象

`SourceAdapter` 接口（`src/domain/standard.ts`）：
- 必选：`searchStandards`、`getStandardDetail`、`detectPreview`、`exportStandard`
- 可选：`createDownloadSession`、`submitDownloadCaptcha`、`getDownloadSession`、`autoDownload`

**各源能力不一致是业务本质，不是设计问题**：
- `gbw`：搜索 + 自动验证码 + 直接下载 PDF (`autoDownload`)
- `bz`：搜索 + 逐页 JPEG → pdf-lib 合并 (`exportStandard`)
- `by`：搜索 + 内网直链 PDF (`exportStandard`)
- `labr`：**不实现 SourceAdapter**（详见 §六-A），走独立 service

路由层调用时根据 `adapter.autoDownload`、`adapter.exportStandard` 是否存在选择路径——前端的 `/api/standards/multi-download` 已经做了这层路由。**不要为了"统一"强抽基类**——之前评估过，会产出空壳接口。

批量下载的跨源回退依赖 `/api/standards/resolve` 带回的 `sourceIds/sources`。解析阶段启用 `StandardResolver.resolve(..., { collectSourceIds: true })` 时会继续查完用户启用的来源，保留同一标准在各源的 source-specific id；`/api/standards/multi-download` 只按这些真实 id 逐源尝试，不能用首个命中 id 伪装其它来源。标准补全默认不启用 `collectSourceIds`，避免为了报表补全额外打所有来源。

`StandardResolver` 接受两类输入：① 带前缀标准号（`GB/T 3324-2024` / `YY/T 0287`）；② 裸数字号（`3324-2024` / `3325` / `18584`）。裸号不自动补 `GB/T`，而是按数字原文查询各源，再用同基础号过滤；带年份必须精确年版，不带年份优先现行最新版本。这样批量下载/标准补全可直接粘用户手头的简写清单，同时避免把非国标强行误补前缀。

标准补全分两步：`POST /api/standards/complete/preview` 只解析 Excel/CSV 首个 sheet，返回列校验、表头跳过、唯一/重复统计和前 8 条预览；`POST /api/standards/complete` 复用同一套解析 helper 后再调用 resolver 并写回 workbook。新增列规则或表头识别规则时，两条端点必须同步走共享 helper，避免预览通过但正式补全失败。

### 六-A. labr：第 4 源，**独立 service，不挂 SourceRegistry**

`labr.cc` 是第 4 标准源，但**有意不实现 `SourceAdapter`**。原因：

- **搜索语义不同**：gbw/bz/by 是"输入 stdCode → 唯一命中"的精确检索；labr 是关键词模糊匹配，一次返回多条候选
- **下载链路差异大**：kind=0 匿名直拉 / kind=1 需登录走 preview2 + 5/天硬限速，强行套 `exportStandard`/`autoDownload` 会扭曲三源共同契约
- **用户路径独立**：sidebar 单开 tab「Labr库检索」→ 搜索 → 多选 → 批量下载入库，**不参与**主搜索的多源并行（避免污染精确命中唯一性）

**模块布局**：

```
src/sources/labr/
├── labr-client.ts    协议层：login / bridgeSso / searchInline / recList /
│                     getDetail / preview2 / downloadDirect。无 token 持久化、
│                     无编排，纯 HTTP 协议薄壳。错误模型 LabrRateLimitError /
│                     LabrAuthError
└── labr-service.ts   单例编排：session 持久化（settings: labr.token /
                      labr.token_expires_at）+ env LABR_USERNAME/LABR_PASSWORD
                      取凭据 + download(did) 按 info.kind 0/1 分支 + auth 失败
                      自动重登重试一次 + batchDownload 撞 RateLimit 后短路 kind=1
```

**集成点**：`library-index.addFileToLibrary` —— labr 下载产物与 BW/BZ/BY 一起落到 `standards_library_dir`，文件名带 `LB` 标签，主搜索预览路由自动看见、被 `/api/preview/files` 列入候选。

**关键资源**：
- 源级 `Semaphore('labr', 2)` —— labr 上游对单 IP 频控敏感，钉死真实并发
- `labr_temp_urls (did PK, url, fetched_at)` 表 —— 缓存 kind=1 的 `temp/<md5>.pdf` 短时下载链跨 token 持久化；preview2 拿到的 hash 实测可跨账号 token 拉，避开 5/天额度
- 三层 std-code 归一化（`cleanStdCode` + `std_code_norm` + `std_code_base`） —— labr 入库的文件能沾资质徽章

**禁止**：
- 把 labr 加进 `library_source_priority` 默认值 —— 它是补给源、用户主动选取，不应被精确搜索 fallback 链当默认候选
- 在 labr-service 外再加 mutex —— 已经有 source-semaphore + activeByStandard 索引（如果未来用），别让请求排队等自己

---

## 七、前端模块布局

`public/js/app-*.js` 8 个文件按固定顺序加载，**共享全局变量**（如 `currentUser`、`results`、`savedStandards`）。
**这不是 ES module，是依赖 `<script>` 顺序的全局拼装。** 不要尝试改 ES module 化——HTML 里 30+ 个 `onclick="fn()"` 内联调用全部依赖函数在全局作用域。

`window._tabCleanup` 是模块间唯一的协作约定：模块如果起了轮询/定时器，注册一个停止函数到 `window._tabCleanup.<name> = stopFn`，`switchTab()` 在切换前会统一调用。

`apiGet/apiPostJson/apiPutJson/apiDelete` 是新代码首选，自动解 Result 壳并抛 `Error`（带 `.code` / `.details`）。旧代码用 `fetch + readApiResponse` 兼容。

---

## 八、添加新功能的检查清单

写一个新 API 端点时：

- [ ] 路由路径符合「资源族 → 子资源」分层（见 § 三）
- [ ] 用 `respond()` / `respondError()` 输出（见 § 一）
- [ ] 请求体 zod schema 用 camelCase（见 § 二）
- [ ] 如果 service 返回 DB row（snake_case），路由出口用 `toCamelCase()`
- [ ] 错误抛 `AppError` 子类，不要 `res.status(...).json(...)`（见 § 四）
- [ ] 配置项放对层（见 § 五）

写前端调用时：

- [ ] 用 `apiGet/apiPostJson/...` 或 `fetch + readApiResponse`
- [ ] 起了 timer/poller？注册到 `window._tabCleanup`
- [ ] 字段名用 camelCase


---

## 九、并发架构（多用户场景）

> 服务推广到内网后会出现 N 个用户同时检索 / 下载 / 同步资质的情况。
> 这一节记录关键资源池的设计，新加耗时操作前先看这里——别再回退成全局 mutex。

### 1. CnasScraper 页面池（`src/services/cnas-scraper.ts`）

**问题**：CNAS 实验室同步走 Playwright，原先用 Promise 链 mutex 串行化，N 个用户排队等。

**方案**：共享 Browser + 每任务独立 Context/Page + 信号量。

- `openPage()` 复用同一个 browser，每个调用方拿到独立的 `Context` + `Page`
- 信号量 `maxConcurrent = 3`（CNAS 站点限速 + 内存占用平衡）
- `navigateToLab(page, labInfo)` 改为接收外部 page，由 caller 负责生命周期

**禁止**：在 scraper 外再加 mutex / Promise 链——会把并发吃光。

### 2. PDF 合成 Worker 池（`src/shared/pdf-merge.ts` + `pdf-merge-worker.ts`）

**问题**：`pdf-lib` 合成 1 个标准 ≈ 0.5–3s 纯 CPU，多人同时下载时主线程被钉死，API 响应停滞。

**方案**：`worker_threads` 池，JPEG 通过 `transferList` 零拷贝传给 worker。

- `POOL_SIZE = 2`（两个常驻 worker 保持热启动）
- `mergeJpegsToPdf({ jpegBuffers, outputPath, onProgress })`——`jpegBuffers` 的 ArrayBuffer 会被 detach
- 队列 + WeakMap 跟踪每个 slot 的 pending job
- Worker 启动开销 ≈ 50-100ms（pdf-lib 懒加载首次）

**Electron 打包注意**：worker_threads 不能从 `app.asar` 加载 `.js`。`package.json` 的 `build.asarUnpack` 拉出 `dist/src/shared/pdf-merge-worker.js`，`getWorkerEntry()` 把路径里的 `app.asar` 改写成 `app.asar.unpacked`。**同时必须把 `pdf-lib` 及其依赖（`@pdf-lib/*` / `pako` / `tslib`）也加进 asarUnpack** —— 否则 worker 从 `app.asar.unpacked/dist/src/shared/` 走 `node_modules` 向上解析时落不回 asar 内部，运行时报 `Cannot find package 'pdf-lib'`。改 pdf-merge 相关文件位置或升级 pdf-lib 依赖树时同步这三处。

**Shutdown**：`src/api/app.ts:shutdown()` 调用 `closePdfMergePool()` 让 worker 优雅退出。

### 3. Tesseract Worker 池（`src/sources/shared/captcha-ocr.ts`）

**问题**：tesseract.js 的 worker 不能并发 `recognize`，原先用 mutex 全局串行。

**方案**：`POOL_SIZE = 2` 池 + free 栈 + waiters FIFO 队列。

- `acquireTesseract()` / `releaseTesseract()`——经典的信号量模式
- 只在 ddddocr Python 子进程不可用时回退到 tesseract，所以 2 个 worker 够用

### 4. undici HTTP 连接池（`src/shared/http.ts`）

**配置**：`connections: 32, pipelining: 4`（per-origin）。

- 32 是经验值：源站点（如 bz / gbw / by）单 host 不容易触发限速，但又不会暴起耗本机端口
- pipelining=4 在 keep-alive 长连接上做请求复用——绝大多数源站 HTTP/1.1，pipelining 比建新连接便宜

**per-call dispatcher 覆盖**：`pooledFetch(url, { dispatcher })` 可传自定义 undici Agent 覆盖全局
`httpAgent`（`FetchWithTimeoutOptions.dispatcher`）。用于隧道类源（见 by 源）：

- `createFreshAgent()` 生成**近无 keep-alive** Agent（`keepAliveTimeout: 1`）——frp/SSH 隧道会
  静默关闭空闲连接，undici 默认 keep-alive 复用到已断连接会抛 `fetch failed`；极短保活让连接
  用完即关，隧道下稳定。**undici 不接受 `keepAliveTimeout: 0`**（抛 `UND_ERR_INVALID_ARG`）。

### 5. ddddocr 子进程多路复用（`src/sources/shared/captcha-ocr.ts`）

ddddocr 是单 Python 进程，请求/响应通过 **UUID-keyed pending map** 多路复用：调用方塞一个 reqId 进 stdin，监听 stdout 收到同一 reqId 时 resolve。无锁，天然并发安全。

### 6. 源级并发信号量（`src/shared/source-semaphore.ts` + `src/shared/semaphore.ts`）

**问题**：前端 `downloadConcurrency` 默认 5 是 per-user 的，10 个用户同时批量下载 = 50 并发打源站；竞速模式下 ×3 源 = 150。国标网这类政府站点 IP 频控敏感，必须钉死真实出口并发。

**方案**：FIFO 计数信号量按源全局共享。

- `bz=2`（pdf-merge worker pool 也只 2，叠在一起不会让 worker queue 堆死）
- `gbw=4`（直 PDF + OCR；4 个并发足以打满 ddddocr 又不堆死队列）
- `by=4`（内网直 PDF，跟 GBW 同量级）
- `labr=2`（labr.cc 对单 IP 频控敏感，kind=1 走 preview2 还有 5/天硬限速；2 并发足够 batch 场景，不暴露 IP）
- `BzAdapter.exportStandard` / `ByAdapter.exportStandard` / `GbwAdapter.autoDownload` 入口全部包 `getSourceSemaphore(src).run(...)`；labr 在 `labr-client` 协议层调用前包
- `Semaphore.setLimit()` 运行时可调（未来想暴露给 admin 设置时直接接上）
- 诊断：`GET /api/diagnostics/sources` 返回 `{ active, limit, waiting }`

**禁止**：在 adapter 内部再加 mutex/queue —— semaphore 已经把出口压住了，内部串行只会让自己的请求排队等自己。

### 7. 跨用户下载任务去重（`src/services/export-task-store.ts`）

**问题**：两个用户同时点 `GB/T 18584-2024` 下载 → 两次完整 BZ JPEG 拼接、两份重复的国标网请求、写到同一个 `exports/GB-18584-2024.pdf` 互相覆盖。

**方案**：`ExportTaskStore.activeByStandard: Map<standardId, taskId>` 索引活跃任务，第二个 createTask 时把 userId 追加到现有 task 的 `subscribers: number[]` 拿现成进度流。

- 活跃定义：`status ∈ {queued, running}`；终态 (`success`/`failed`) 摘除映射，下次同标准能起新任务
- owner 校验从 `task.userId === req.user.id` 改为 `store.isSubscriber(taskId, userId)`，多个 subscriber 都能读同 task / 开同 SSE 流
- 复用 task 时 `ExportTaskService.createTask` 不会重复调 `runTask`（用 `subscribers.length === 1` 区分新建 vs 复用）
- 预览侧 `preview-task-store.ts::findActiveTaskByKey` 用同模式去重已运行数月

**禁止**：终态不摘活跃索引——会让旧成功 task 被未来同标准请求误复用，但文件可能已过 TTL 清理。

### 总览

| 资源 | 池大小 | 模式 | 触发场景 |
|------|--------|------|----------|
| CnasScraper Page | 3 | 共享 browser + 每任务 context | CNAS 资质同步 |
| PDF Merge Worker | 2 | worker_threads | bz 源逐页 JPEG → PDF 合成 |
| Tesseract Worker | 2 | tesseract.js 池 | 验证码 OCR（ddddocr 不可用时回退）|
| undici HTTP | 32/origin | keep-alive + pipelining | 所有外网 HTTP 请求 |
| ddddocr 子进程 | 1（多路复用）| UUID pending map | 验证码 OCR 首选 |
| Source Semaphore (bz/gbw/by/labr) | 2/4/4/2 | FIFO 计数信号量 | 多用户下载共享出口 IP，钉死真实并发；labr 还叠 5/天 preview2 配额 |
| ExportTaskStore subscribers | 不限人数 | activeByStandard 索引 + 共享 SSE | 同标准跨用户下载去重 |

**加新的耗时操作前**：判断它是 CPU 密集还是 IO 密集，CPU → worker_threads 池；IO → 看是否已有 client 池可复用；都不是 → 先想想是不是真的需要锁。

## 十、标准库 / 预览模块（Phase 1）

> "下载 + 预览"两个看似独立的功能在底层其实共用一个本地 PDF 库。Phase 1 只接入预览（读路径），Phase 2 才会把下载流接进来（写路径），同一索引、同一目录、同一文件名规则。

### 数据模型

```
standard_files
├── std_code_norm  (extractBaseCode 归一后的标准号)
├── year           (从文件名末尾抽出，可空)
├── source         ('gbw' | 'bz' | 'by')
├── abs_path       (含 SOURCE 后缀的绝对路径)
├── file_name      (path.basename(abs_path)，下载兜底和本地库搜索走索引)
├── size / mtime   (扫描时的 stat 快照，增量比对用)
└── UNIQUE (std_code_norm, year, source)
```

唯一约束的形状决定了"多源同号"的存储方式：**永远带源后缀**（`GB_T 3324-2024 - BW.pdf`），不靠 rename 策略，让两源能并存在同一目录而不互相覆盖。
`file_name` 是派生索引列，旧库启动迁移会从 `abs_path` 回填；所有 scan / addFileToLibrary / watcher / rename 写入点都必须同步维护，避免下载兜底退回全表后缀匹配。

### 路径解析（src/shared/library-paths.ts）

两级回退：

1. `settings.standards_library_dir`（用户配置）或默认 `<BZXZ_EXE_DIR>/standards/`
2. 探针失败 → `<BZXZ_USER_DATA_DIR>/standards/`（Windows Program Files 兼容）
3. 都不通 → 硬塞默认路径 + 把 `fallbackReason` 写进 LibraryStatus，管理员设置页打 banner

之所以**默认不放 C 盘 userData**：标准 PDF 体积大、长期累积，放 C 盘会鼓胀用户 OS 盘；放 exe 同级让用户自己挑装机盘（D / E）。

### 安全 (`isInsideLibrary`)

扫描和预览端点各做一次"绝对路径必须落在库根之内"校验，防 symlink 跟随把库外文件纳入索引。库根改了之后，旧索引行残留指向库外 → 直接 410 GONE + 删行，下次扫描重建。

### 扫描策略 (`scanLibrary`)

- 启动时增量扫描一次（fire-and-forget）
- 管理员手动 POST `/admin/library/rescan` 全量重扫
- 增量靠 `(mtime, size)` 双比对；都没变即跳过 parse
- **不递归子目录**：保持库结构扁平，便于用户在文件管理器里直接浏览
- **chokidar 监听**（Phase 2，默认开）：`startLibraryWatcher` 在启动时根据 `library_watcher_enabled='1'` 起，监听 `depth: 0` 顶层 PDF；`awaitWriteFinish: { stabilityThreshold: 1500ms, pollInterval: 200ms }` 防大文件写一半就入库。OneDrive / SMB 抖动场景下 admin 可在设置里关

### 查询优先级 (`lookupFile`)

请求级 `sources` > settings `library_source_priority` > 默认 `['gbw','bz','by']`。多源同号时按数组顺序选第一个本地有的；fs.access 失败的行即时清掉，避免返回 404 fileId。

### Phase 2 实现（已完成）

**下载即入库**：adapter 把 PDF 写到临时 `data/exports/`，`services/download-to-library.ts` 立即 `fs.rename` 到 `standards/`，按 `library_filename_pattern` 模板（`{stdCode} {source} {year} {title}`）命名 UPSERT `standard_files`。跨卷 `EXDEV/EPERM/EACCES` 时退化为 copy+unlink。**已无 14 天清理**，标准永久保留。`data/exports/` 只剩补全功能的 xlsx 报表。

**预览自动下载流**：`POST /api/preview/request` 未命中 → `services/preview-task-store.ts` 先 `findActiveTaskByKey(stdCode, year)` 查同标准的 pending/downloading 任务，命中直接复用 taskId（返回 `reused:true`），否则 `createTask(stdCode, year)` 建新 task → 后台按 source 优先级遍历 `searchStandards` → `autoDownload`/`exportStandard` → `moveDownloadToLibrary` → task.ready(fileId)。前端 `GET /api/preview/task/:taskId` 轮询 1.5s/次直到 ready 切 iframe / failed 弹「重试」+「关闭」/ 用户主动关闭 abort（**无前端超时**，靠 store 的 10 分钟无更新 TTL GC 兜底；GC 命中后轮询接口返 404，前端当 failed 处理）。任务存在内存 Map（重启即丢）。key 用 normalized `stdCode + year` 保证连点 / 下载预览交叉调用都聚合到同一任务。

**模板引擎**：`services/library-naming.ts` `renderLibraryFilename`。空值占位符 + 相邻分隔符（空格/`-`/`_`/`·`/`—`）被吞掉，避免"GB 3324-2024 -.pdf"悬空尾。非法路径字符 `\/:*?"<>|` 清成空格；总长截到 200 字符防 Windows 260 字符路径上限。admin zod schema 强制模板含 `{stdCode}`。

### Phase 3：本地文件库管理（独立 tab `data-tab="local"`，#66）

**目的**：用户积累的标准 PDF 数量增长后，需要集中查看 / 重命名 / 删除 / 在文件管理器中定位的能力。原先这是「下载历史」tab 里的一个 section，被拆出为独立顶级 tab。

**端点拓扑**（均收口在 `src/api/preview-routes.ts`，复用同一组 `getFileById` + `isInsideLibrary` 安全防线）：

- `DELETE /api/preview/file/:id`：物理 `fs.unlink` + 删 `standard_files` 行。`ENOENT` 静默吞掉（DB 行已脏，仍然清行）。库根外的 `abs_path` → 拒绝物理删但清行 + 410 GONE，避免索引脏行长期残留。
- `POST /api/preview/files/batch-delete`：body `{ ids: number[] }`，单循环复用 DELETE 路径，返回 `{ deleted, failed: [{id, message}] }` 让前端展示部分成功。
- `POST /api/preview/file/:id/reveal`：用 `process.env.BZXZ_ELECTRON` 区分桌面端 / Web；桌面端 `process.emit('bzxz:reveal-in-folder', absPath)` 把 absPath 喂给 Electron 主进程的 listener，后者调 `shell.showItemInFolder`。Web 浏览器侧返 501，前端 fallback 到「复制路径」按钮。
- `PATCH /api/preview/file/:id`：rename，body `{ fileName }`。校验 `/[\/\\:*?"<>|\x00-\x1F]/` 非法字符 + 200 字符长度上限；用户没带扩展名时自动接旧扩展；新路径走 `isInsideLibrary` 防越界；目标文件已存在 → 409 拒绝覆盖。**关键**：只改 `abs_path` + 派生 `file_name`，不动 `std_code_norm` / `year` / `source` —— 这三个是搜索/绿点的索引键，改了会破坏库匹配。

**Electron IPC 桥**（`electron/main.ts`）：

启动 startServer 阶段一次性注册 `process.on('bzxz:reveal-in-folder')`，把 Node 主进程事件总线当后端 → 桌面端的轻量 IPC（避免给每个新需求都加 ipcMain handle 引线）。注意只 emit absPath 字符串，后端已校验路径在库根内，主进程只需信任并打开。

**前端表格**（`public/js/app-detail-utils.js` `renderFileLibrary`）：

`refreshFileLibrary` 调 `/api/downloads?q=&limit=&offset=`，搜索框 250ms 防抖走服务端筛选，默认只取 200 条并显示「已加载/总数」；库内结果超过当前页时渲染「加载更多」，继续按 library offset 取下一页。`fileLibrarySelectedIds: Set<number>` 跨当前页保留选中状态，但 `renderFileLibrary` 每次执行时按 `visibleIds` 清理掉已不在当前结果集合内的 id（防"看不见的勾选"溜到批量删除里）。每行 5 个动作按 `kind === 'library'` 区分：库内文件全功能，`exports/` xlsx 只有「下载 / 删除」（走原 `/api/downloads/:filename` 路径）。删除 / 批量删除 / rename 全部走 `showConfirm` 二次确认。

## 十二、CMA 一单一库比对（cma-diff）

### 数据源 & 表

- 远端：`https://cma.caqit.org.cn/cma-admin/system/standardData/list`，无鉴权 / 按 11 个顶层 `domain` 名筛选 / **分页拉取**（`pageSize=2000` 逐页，远端按行数线性变慢，一次拉 41k 行会超时）
- 本地 `cma_capability_lib`：`source_id PK` + 11 列业务字段 + `row_hash / last_seen_at / fetched_at`；4 个索引（norm / base / domain / status）
- 元数据 `cma_capability_lib_meta`：每领域 `subscribed / last_synced_at / remote_total / local_total / last_sync_stats(JSON)`，11 行硬初始化（与 `src/shared/cap-lib-domains.ts` 常量一致）
- 黑名单 `cma_diff_blacklist`（`std_code / std_code_norm / reason`）：屏蔽非标准号脏内容，按 norm 命中不显示不匹配
- 手动映射 `cma_diff_manual_map`（`cert_number / src_norm / lib_norm`，UNIQUE(cert,src)）：人工把机构标准号指向库内标准号覆盖自动判定，cert 空=全局

### 模块结构

```
src/
├── shared/
│   ├── cap-lib-domains.ts    # 11 个顶层领域常量
│   └── cap-lib-status.ts     # parseLibStatus(remark) + LibStatus / DiffStatus 枚举
├── services/
│   └── cap-lib-service.ts    # syncDomain / diffByLab / batchStatus / labsCounts / cleanupStaleRows / exportDiff / 黑名单 / 手动映射 / rematch / diagnose
└── api/
    └── cap-lib-routes.ts     # 20 个端点挂 /api/cma-diff/*（含批量订阅 / sync-selected / export / blacklist / manual-map / rematch / diagnose）

public/js/
├── app-cap-lib-badge.js      # 共用徽章（搜索 + 资质查询 + 比对页 三处复用）
└── app-cma-diff.js           # 比对页主交互（领域订阅 / 同步进度 / 机构表 / diff 详情）
```

### 同步算法（hash diff + soft delete）

每行：算 `sha1(domain|method|stdCode|remark|libStatus|rawStatus)`：
- 与现存 `row_hash` 相同 → 只 `UPDATE last_seen_at`，跳过主字段写入
- 不同 / 不存在 → `INSERT ... ON CONFLICT(source_id) DO UPDATE` 全字段 upsert + 写新 hash

同步完成后：
- 本次远端没出现的本地行 `last_seen_at` 保留旧时间（**不 DELETE**）
- `removedSoft` 统计写入 meta.last_sync_stats
- admin 在 `cma-diff` 页点「清理 30 天未见」走 `POST /api/cma-diff/cleanup` 真删 + 重算 local_total

**并发与事件循环（防假死）**：`runSync` 拆成「远端拉取」和「SQLite 入库」两段。远端 fetch 是 IO 等待，
可限流并发；better-sqlite3 事务同步阻塞主线程，所以只有入库阶段串到模块级 `dbWriteChain`
（**写并发 1**）。入库按 **2000 行分块事务**，批次间 `await setImmediate` 让出事件循环。
Why：旧版「全部更新」一次性启动全部领域时，如果多个大领域写事务并发回到主线程，会连环锁死事件循环 →
进度轮询/所有请求排队 → 页面假死；但把整条 `runSync` 全局串行，又会让产品质量检验的 21 页远端请求逐页慢等。
现在的边界是：远端请求并发，DB 写入串行。

**远端分页拉取（防超时/卡 0%）**：`runSync` 仍按 `pageSize=2000` 分页。第一页先拿 `total`，
后续页同领域最多 `REMOTE_DOMAIN_PAGE_CONCURRENCY=4` 个 worker 并发；所有领域共享
`REMOTE_FETCH_CONCURRENCY=4` 的 `Semaphore`，防「全部更新」把 11 个领域页请求同时轰上游。
每页完成后实时 `setProgress(fetching, current=已拉行数, total)`；拉完但前面还有领域在入库时，
phase 进入 `queued`（等待串行入库）。前端 `progressText` 把 fetching 显示成「并发拉取 X/total (pct%)」。
Why：远端「产品质量检验」已从 41s 劣化到一次拉 41k 行需 5-7 分钟（超 180s 旧超时），逐页串行仍会累积到
很长等待；限流并发能明显缩短大领域拉取时间，同时保留上游保护。

### 比对算法（5 档，按标准号去重）

`diffByLab(certNumber)`：先取机构资质行按 `std_code_norm` **去重**（同号多检测项目聚合到
`testItems[]` 一行），过滤黑名单，再对去重集合用 `std_code_norm IN` + `std_code_base IN`
两句**批量查库**（复用 `batchStatus` 的 `exactMap`/`seriesMap`/`priority` 写法）。
取代旧「每条资质行 6 个相关子查询」的 O(N×6) 放大；`labsCounts`/详情/导出全部受益。

5 档判定顺序：
1. 保年 `exact='active'`    → in_lib
2. 保年 `exact='cite_only'` → cite_only
3. 保年 `exact='abolished'` → abolished
4. 剥年命中 active 且不同 norm → series_only（提示"建议改用 X 年版"）
5. 默认                        → not_in_lib（政策：资质到期不再延续）

**人工兜底**：黑名单（`cma_diff_blacklist`，norm 命中 / norm 空回退原始 std_code）在去重后剔除，
不显示不计数不匹配；手动映射（`cma_diff_manual_map`，机构级优先全局）在判定前把 `src_norm`
换成 `lib_norm` 查库覆盖自动结果；`rematchOne` 复用 `diffByLab` 全量算后挑出单标准号行
（单项重试，前端就地替换免整页重渲）。`diagnose(stdCode)` 本地查询误判自查：输出归一化值 +
保年/剥年命中明细 + 黑名单/映射状态 + 各领域同步状态 + 判定结论（不打远端，秒回）。

### 权限闸门

- 大多数读端点：`requireTab('cma-diff')` per-route guard（router 挂在根上无 mount path）
- `batch-status`（徽章注入用）：`requireTab('cma-diff','qual','search')` OR 语义 —— 徽章注入三处页面，权限路径要一致
- 写操作（同步 / 批量同步 / 订阅切换 / 批量订阅 / 清理 / 黑名单增删 / 手动映射增删）：叠加 `requireAdmin`；
  导出 / rematch / 列表读取仅 `requireTab('cma-diff')`
- 导出 `POST /export`：`requireTab('cma-diff')`（仅比对页触发，不同于 batch-status 的三 tab OR）

### 页面 UI（app-cma-diff.js）

- **领域订阅卡整卡折叠**：默认收起、标题栏摘要「已订阅 N 个 · 最近同步 时间」，折叠态记 `localStorage('capLib.domCollapsed')`（默认值不为 `'0'` 即收起）。展开后两列 grid（窄屏 ≤900px 单列），长领域名 ellipsis、进度条弹性宽
- **批量同步**（admin）：`capLibSyncChecked` 一次 `POST /api/cma-diff/sync-selected` 启动所有勾选领域；
  「全部更新」复用 `capLibSyncAll`。两个入口都只负责启动 job + 追加进度监听，远端并发/DB 串行由后端控制，完成后统一 `capLibInvalidateCache()` + 重渲，避免每个领域 done 都刷新页面
- **订阅批量保存**：复选框变更先进 `pendingDomainSubs`，350ms 防抖后一次 `PUT /api/cma-diff/domains/subscriptions`；
  点击同步前会 `flushPendingDomainSubs()`，保证 UI 勾选和后端订阅状态一致
- **机构内 5 档分类折叠 + 分页**：`capLibToggleLab` 拉行后按 `diffStatus` 分 5 组缓存到 `body._capLibGroups`，`renderStatusGroups` 按单一 `GROUP_ORDER`（worst→best）渲染折叠卡，默认展开首个非空最严重档；`renderPagedTable` 每页大小可选 50/100/200/300/500/1000（默认 100，`getPageSize`/`setPageSize` 记 localStorage `capLib.pageSize`，黑名单条上有选择器）+ `renderPager`/`compressPages`（≤7 页全列，否则 `1 … cur±1 … last`）。懒渲染：非默认展开档点开才生成表；收起机构清 `_capLibGroups` 引用
- **机构内搜索**：机构展开后顶部搜索框 `capLibSearchLab`（防抖 200ms），按标准号/标准名/检测项目过滤缓存行，命中档全展开（`renderStatusGroups` 的 `expandAll`）；过滤后的分组挂到 `.cap-lib-lab-groups` 容器的 `_capLibViewGroups`，翻页/展开懒渲染经 `viewGroupsFor` 优先取它（保证搜索态翻页只翻命中行），清空恢复全量默认视图
- 配色/文案/排序复用 `DIFF_STATUS_META`（单一真相源）；新 CSS 全 token 化（`--surface-h/--border/--accent`）保证 light/paper 主题不"白上加白"

### 导出（三级）

`exportDiff(filter: { certNumbers, statuses?, keyword? })`：certNumbers 空 → 取全部订阅机构，逐机构 `diffByLab` + 状态/关键词过滤 + 摊平为 `ExportRow`（带 certNumber/labName），按 `EXPORT_STATUS_ORDER`（最差在前）+ labName + stdCode 排序。

`POST /api/cma-diff/export` 生成 Excel（`xlsx@0.18.5`，与 check-routes 同库）：状态列 emoji 前缀（零依赖不走 cellStyles）+ 首行 `!autofilter` + `!cols` 列宽自适应（中文 2 宽估算）。**流式 `res.send(buffer)` 不落临时文件**（不抄 check-routes 写 data/exports 再回 downloadUrl 那套），文件名 `Content-Disposition: filename*=UTF-8''…`，机构名 sanitize 非法字符。

三级入口（前端 `capLibExportDiff`，按钮 `onclick` 均 `event.stopPropagation()` 避免触发折叠）：
- 状态档头「导出」→ `{certNumbers:[本机构], statuses:[该档]}`
- 机构头「导出此机构」→ `{certNumbers:[本机构]}`
- 顶部「导出全部机构」→ `{certNumbers:[]}`（空=全部订阅机构合并表）

# 项目审查发现

> 本文件记录审查证据与候选优化点；最终结论将在完成交叉验证后汇总。

## 初步结构发现
- 项目为 Express + TypeScript + better-sqlite3 后端，前端是无打包器的原生 HTML/CSS/JS，多来源抓取适配器并存。
- 存在明显的生成物/迁移期重复：`public/styles.css` 344KB、`public/css/components.css` 154KB、`components-pages.css` 138KB、`pages.css` 61KB；同一选择器在多份文件重复，且实际加载链路依赖运行时懒加载，已发生过样式漏同步。
- 多个超大职责文件：`qualification-service.ts` 1653 行、`cap-lib-service.ts` 1070 行、`standards-routes.ts` 942 行、`gbw-adapter.ts` 988 行；前端也有多个 800-950 行全局脚本，属于高认知负担区域。
- 默认 `npm test` 仅覆盖 `src/api src/shared src/services`，不覆盖 `src/sources`；来源适配器测试需另跑 `test:live`/`test:all`，CI 若只运行默认测试可能漏掉关键回归。
- `@types/cheerio` 被放在 runtime dependencies，可能可迁移到 devDependencies；同时直接依赖 `playwright` 和 `playwright-core`，需要确认是否确有双重直接依赖必要。

## 后端初步发现
- **高风险安全边界**：`src/api/app.ts` 明确禁用认证，并为每个请求注入管理员身份；`src/index.ts` 在非 loopback 且无代理 token 时，只有 `STDHUB_STRICT_SECURITY=1` 才拒绝启动，默认甚至不打印告警。若 Docker/宿主端口对局域网或公网可达，所有管理员 API 均可直接调用。
- `app.set('trust proxy', true)` 无条件信任任意代理头；若服务可被直接访问，客户端可伪造 `X-Forwarded-For`，使基于 IP 的限流/审计失真。应按部署拓扑配置 hop/subnet，而非全信任。
- `process.on('uncaughtException')` 记录后继续运行。Node 发生未捕获异常后进程状态可能不一致，建议进入受控 shutdown 并由容器/进程管理器拉起；`unhandledRejection` 也应根据错误策略决定退出，而不是永久吞掉。
- 环境变量读取分散在多个模块，且部分在 import 时固化（例如 cookie/security/source base URL），缺少统一 schema 校验；非法数字配置可能生成 `NaN` 并传入限流/并发器。
- 数据库 schema 与大量迁移集中在 `src/services/db.ts`（773 行），同时 `nat-cma-service.ts` 还有局部迁移，schema ownership 分散，后续多 AI 修改容易出现迁移顺序和重复定义漂移。
- `qualification-service.ts` 内大量 SQL 返回值使用 `any[]`，削弱 strict TypeScript 在最复杂数据聚合路径上的保护。
- 安全守卫是“双重空实现”：`app.ts` 注入 admin，`auth-middleware.ts` 的 `requireAuth/requireAdmin/requireTab` 也全部直接 `next()`。路由表面上看有权限控制，实际上没有，容易误导后续维护者。
- `clientIp()` 优先使用 `req.socket.remoteAddress`，即便 `trust proxy` 开启也不会使用 `req.ip`；反代部署下所有请求很可能共享代理 IP，限流会误伤所有用户。与此同时全信任 proxy 又允许其他依赖 `req.ip` 的代码被伪造，配置语义互相矛盾。
- CI Node 版本不一致：Docker/engines 使用 Node 20，PR Check 用 Node 22，主 CI 用 Node 24。原生依赖（better-sqlite3/sharp/playwright）在不同 ABI/行为下可能出现“CI 绿、生产红”；建议矩阵至少包含生产 Node 20，并统一 `.node-version`。
- 自动发布对每次 main push 自动 bump/tag/release，导致小修复也立即发布，并与开发者并发 push 产生 rebase/reject；更适合改为显式 release、Changesets 或合并标签驱动。

## 前端初步发现
- CSS 有实质性多源漂移：`components.css` 与 `components-pages.css` 约 1232 条非空规则行完全相同；下载中心规则同时出现在 `styles.css/components.css/components-pages.css/pages.css` 四份。此前进度条漏同步就是该结构的直接后果。应确定一个源文件，通过构建脚本生成拆分产物，并在 CI 检查生成物是否最新。
- 首屏一次性加载约 31 个全局 `<script>`，无 `defer`/ES modules；所有模块共享 window 命名空间和加载顺序隐式依赖。当前已存在重复全局函数 `cssEscape`。建议逐步迁移 ES modules，至少生成 manifest 并自动排序/校验依赖。
- `index.html` 约 850+ 行，含 112 个 inline `onclick`、36 个 inline style；JS 内约 215 次 `innerHTML` 写入、106 个 fetch。虽多数路径调用 escape helper，但这种字符串模板模式使 XSS 审查高度依赖人工，建议统一 DOM/render helper、事件委托和 API client。
- 资源版本参数手工维护且不一致，部分脚本无版本参数，懒加载 `components-pages.css` 则使用 `Date.now()` 永久绕开 HTTP 缓存。应改为内容哈希 manifest 或统一应用版本号。
- Chart.js 与 PDFH5 在首页同步加载，即使用户不访问统计/PDF 页面也支付解析成本；可按 tab/功能动态加载。Google Fonts 外链在内网环境可能延迟或泄露访问元数据，适合自托管/系统字体优先。
- Service Worker 只缓存 shell，且缓存名手工版本化；配合 HTML 内手写 SW 查询版本和大量资源版本参数，发布缓存策略有多个真相源。建议由构建版本统一生成。

## 供应链、测试与运行时发现
- 使用官方 registry 执行 `npm audit --omit=dev` 得到 7 项生产依赖漏洞（3 high / 3 moderate / 1 low）。最需优先处理：直接依赖 `multer@2.1.1` 的上传 DoS（可升级 2.2+），以及 `xlsx@0.18.5` 的原型污染/ReDoS（npm 无可用修复；项目确实用它解析用户上传的 xlsx，应迁移到维护中的库或隔离解析）。`undici` 漏洞由 `cheerio@1.2.0` 间接引入，可通过依赖升级/override 评估修复。
- 默认 npm registry 是 npmmirror 时 `npm audit` 直接 404，意味着本地/CI 若不显式使用官方审计端点，可能长期看不到漏洞；当前 CI 使用 Trivy 是补偿，但应增加可见的 npm audit/OSV 检查或 Dependabot/Renovate。
- 全量 `npm run test:all` 通过：16 文件、184 测试；默认 `npm test` 仅 12 文件、158 测试，因此 CI 当前少跑 26 个来源适配器测试。建议 CI 改 `test:all`，把需真实凭据的 live 测试用显式环境条件跳过。
- 没有 ESLint、Prettier、前端 JS 类型检查、覆盖率阈值或重复代码检查。TypeScript 构建能覆盖后端，但约 40K 行前端 JS/CSS 主要依赖人工回归。
- 关键路由/服务缺少直接测试，包括 `standards-routes.ts` 的 xlsx 上传解析、`preview-routes.ts` 文件操作、`cnas-scraper.ts` 崩溃恢复、`cap-lib-service.ts` 大同步、权限/代理边界等；当前 `app.test.ts` 只有少量装配级验证。
- `AutoSyncScheduler.computeNextFireMs()` 只向前扫描 10080 分钟（7 天），但配置接受完整 5 段 cron。月度/低频 cron 的下一次触发可能超过 7 天并返回 null，导致静默不调度。应采用成熟 cron parser 或扩大并测试搜索范围。
- 仓库跟踪了 `data/cma_national.db`，而 `.gitignore` 同时声明忽略该文件。这种“已跟踪但被忽略”的状态会让数据更新语义不清；建议迁移为可审计的 seed/versioned 数据格式或 release asset，并明确更新流程。


# StdHub 开发交接文档

> 生成日期：2026-09-21 · 适用：换电脑/新环境接手开发
> 当前远程 main：`aa2c8f3` · 工作区已全部推送，`git status` 干净

---

## 1. 项目一句话定位

**StdHub**：多源标准检索与批量下载 + CNAS/CMA 实验室资质能力验证的 Web 应用。前身是 bzxz（标准盒子），现已去掉 Electron 桌面端，Web 优先（NAS/服务器部署），单管理员 + 游客只读模式。

- 唯一业务机构：湖北省产品质量监督检验研究院（CMA `221700110366`、CNAS `L0290`），已收敛为单机构，不再做多机构订阅。
- 核心功能：标准检索下载、资质查询（CNAS/CMA）、CMA 一单一库比对（能力项目库）、工具箱（查新/批量/补全）。

---

## 2. 换电脑后的环境搭建（按顺序）

### 2.1 克隆代码

```bash
git clone https://github.com/atpx4869/stdhub.git
cd stdhub
git checkout main
```

### 2.2 Node 环境

- **Node ≥ 20**（项目根目录 `.node-version` 写了 `22`，建议用 Node 22）。
- 推荐用 fnm / nvm 管理版本；若装多个版本，确保 `node -v` 是 20+。

### 2.3 安装依赖

```bash
npm install
```

> 注意：`better-sqlite3`、`sharp`、`playwright` 是原生/大依赖。若 `npm install` 卡住或报错，先确认 Node 版本正确，再考虑 `npm config set registry https://registry.npmmirror.com`。

### 2.4 本地环境变量（关键，容易漏）

```bash
cp .env.example .env.local
```

然后编辑 `.env.local`，填入真实值。**最小可跑**只需填：

| 变量 | 说明 |
|---|---|
| `BY_USERNAME` / `BY_PASSWORD` / `BY_DEPT_ID` | BY 源（std.samr.gov.cn），启用 BY 检索下载必需 |
| `LABR_USERNAME` / `LABR_PASSWORD` | LABR 源（labr.cc），启用 labr 必需 |
| `BY_BASE_URL` | 可选，默认 `http://172.16.100.72:8080`（内网）；经隧道时改 `http://127.0.0.1:18080` |

> ⚠️ `.env.local` 已在 `.gitignore`，不会提交，换电脑必须自己重建。**不要**把本机 `.env.local` 当成线上事实——本机和 NAS 上是两份不同的文件（见文末「已知坑」）。

### 2.5 首次启动

```bash
npm run dev        # tsx 热重载启动，开发用
# 或
npm run build && npm start   # 构建后运行（生产模式）
```

默认访问 `http://127.0.0.1:3000`（容器内端口 3000，本地 dev 也默认 3000）。

默认管理员：`admin / adminadmin`（首次登录后请改密）。

---

## 3. 常用命令速查

| 命令 | 作用 |
|---|---|
| `npm run dev` | 开发启动（tsx，热重载） |
| `npm run build` | TypeScript 构建（`tsc -p tsconfig.json`） |
| `npm test` | 跑全部 vitest 单测（`vitest run`） |
| `npm run test:e2e` | 跑两套 E2E（默认 4173 真实后端 + 4174 mock UI） |
| `npm run css:check` | CSS 入口检查 + oklch fallback 校验 |
| `npm run oklch:check` | 只跑 oklch fallback 校验 |

**门禁顺序（CI 与本地一致）**：`npm run build` → `npm run css:check` → `npm test` → `npm run test:e2e`。

### 单测 / E2E 的精准运行

```bash
# 只跑某个测试文件
npx vitest run src/services/cap-lib-service.test.ts

# 只跑 mock E2E 的某个 spec（单 worker，稳定）
npx playwright test --config playwright.mock.config.ts cma-diff-card.spec.ts --workers=1
```

---

## 4. 项目结构速览

```
stdhub/
├── src/                     # 后端源码（TypeScript）
│   ├── index.ts             # 入口
│   ├── api/                 # 路由（cap-lib-routes.ts、cnas-routes.ts 等）
│   ├── services/            # 服务层（cap-lib-service、qualification-service、db.ts 等）
│   ├── shared/              # 共享工具（std-code、cap-lib-status、errors 等）
│   ├── sources/             # 各标准源适配器（gbw/bz/by/labr）
│   └── database/migrations/ # 数据库迁移
├── public/                  # 前端静态资源（无框架，原生 JS + CSS）
│   ├── index.html           # 单页入口（所有页面）
│   ├── js/                  # 前端 JS（app-*.js，按功能拆分）
│   └── css/                 # 前端 CSS（pages.css、theme-tokens.css 等）
├── e2e/                     # Playwright E2E
│   ├── smoke.spec.ts        # 默认 config（4173 真实后端）跑
│   ├── library-history-layout.spec.ts  # mock config（4174）跑
│   ├── cma-diff-card.spec.ts           # mock config（4174）跑
│   ├── ui-mock-server.cjs   # mock UI 后端
│   └── server.ts            # 真实后端 E2E server
├── docker-compose.yml       # 部署编排
├── Dockerfile
├── .github/workflows/       # CI：pr-check / auto-release / docker-publish
└── WORKLOG.md               # 项目工作日志（值得先读一遍了解历史）
```

**关键约定**：
- 前端是**无框架**的原生 JS + CSS，公共能力挂在 `window.StdHub.*` 命名空间（`app-foundation.js` 提供 `api.fetch/request/readResponse`，`app-core.js` 提供工具函数）。改前端时别引入框架。
- 后端路由用 Express 5，per-route guard（不用 `router.use(requireXxx)`），统一 `respond(res, toCamelCase(...))` 返回 `{data, error}` 信封。
- 数据库用 better-sqlite3，`db.ts` 里 `migrate()` 用 `CREATE TABLE IF NOT EXISTS` 建表，**不写破坏性 ALTER/DROP**。

---

## 5. 最近几天做了什么（接手时要知道）

最近一次大改动是 **CMA 机构维度比对卡片重设计 + 近 90 天变动追踪**，涉及 4 个 commit：

| commit | 内容 |
|---|---|
| `15f94f6` | feat：卡片四段式重设计（五档状态卡 + 变动区）+ `cma_diff_change_events` 事件表 + `changesForLab`/`/labs/:cert/changes` 端点 |
| `72c4cb4` | fix：修 `certNumber is not defined`（renderLabs 误用变量名） |
| `2bd05c5` | fix：修状态卡跳转的展开状态机 + DOM id 前缀 |
| `aa2c8f3` | test：补 cma-diff 卡片渲染冒烟 E2E |

**核心设计**（改动时要知道）：
- 五档比对状态：`in_lib / cite_only / abolished / series_only / not_in_lib`（定义在 `src/shared/cap-lib-status.ts`，前端 `app-cma-diff-domains.js` 里有 `DIFF_STATUS_META` + `STATUS_ORDER`）。
- **近 90 天变动**：不是快照表，是**纯事件表** `cma_diff_change_events`。写入只在 `qualification-service.ts` 的 `promoteCma` 事务前后各取一次 `diffByLab` 快照 diff（`recordDiffEvents`），产出 `added/removed/status_changed` 三类事件。**能力库同步（cap-lib sync）不单独写事件**——因为库侧 `lib_status` 只有三档（active/cite_only/abolished），映射不到 series_only/not_in_lib 两档比对推导态；改为靠"下一次资质同步时 diffByLab 实时 JOIN"自然捕获。
- `labsCounts()` 返回附带 `changes` 块（90 天窗口、50 条封顶）；`changesForLab(cert, days, limit)` 是聚合入口（limit=0 不封顶）。

**前端卡片结构**（`public/js/app-cma-diff-labs.js` 的 `renderLabs()`）：
`cap-lib-lab-head`（机构名+证书号+按钮）→ `cap-lib-lab-stats`（五档状态卡）→ `cap-lib-lab-changes`（变动区）→ `cap-lib-lab-foot`（总数+待关注+明细入口）→ `cap-lib-lab-body`（明细表，折叠）。

**⚠️ cma-diff 页有子 tab**：能力项目库搜索 / 机构维度比对 / 领域订阅与同步。机构卡片在「机构维度比对」子 tab（`.cap-lib-tab[data-cap-lib-tab="labs"]`），默认激活的是「能力项目库搜索」。写 E2E 或手动验证时记得先切子 tab。

---

## 6. 已知坑（务必先看，都是踩过的）

1. **本机与 NAS 是两份 `.env.local`**：排查"配置引起的问题"前先确认读的是哪份文件。本机 `E:\github项目\stdhub\.env.local` 含 `CNAS_BROWSER_CHANNEL=chrome`，NAS 那份没有。别用本机文件推断线上行为。
2. **资质查询是纯本地、同步才走网络**：`GET /api/qualifications/search` 只查 `cnas_qualifications`/`cma_qualifications` 两张表，零网络。只有 `/api/qualifications/labs/{cnas,cma}/sync` 走 Playwright 抓取。「查不到结果」永远先查本地表有没有数据 + 前端是否把"0 条"当"加载中"。
3. **`autosync_enabled` 默认关闭**（`'0'`）：定时同步要手动到「系统设置→自动同步」打开总开关。`qual_sync_enabled`/`qual_sync_cron` 是**死配置**，别被误导。
4. **`host.docker.internal` 在 Linux NAS 不解析**：compose 里必须 `extra_hosts: ["host.docker.internal:host-gateway"]`，否则 BY 源连不上。
5. **`node --check` 只查语法、不查变量作用域**：`renderLabs` 这类动态拼 HTML 的函数，`certNumber is not defined` 这类 bug 要浏览器运行时才暴露。改前端渲染逻辑时，用 E2E（cma-diff-card.spec.ts 有 pageerror 捕获）或本地 dev + 无头浏览器验证。
6. **本机没有 Docker CLI**（只有 `wsl.exe`）：镜像/容器验证依赖 GitHub Actions（CI 会跑 Docker smoke + Trivy 扫描 + 推镜像）。
7. **测试别 mock `require()` 载入的第三方模块**：vitest 的 `vi.mock` 拦不住 `require('dotenv')`，会退化读宿主机真实文件。在自有的 ESM 导入边界（`node:fs`、`node:path`）上模拟。
8. **本地 `outputs/` 和 `test-results/` 是测试产物，永不提交**（已在 .gitignore）。

---

## 7. 提交与发布约定

- 用 `/commit` 命令提交（走 git 安全协议 + hook）。
- push `main` 触发 CI：`pr-check.yml`（build/css/test/e2e 门禁）+ `docker-publish.yml`（Docker 构建 + smoke + Trivy 扫描 + 推镜像 `jzrm/stdhub:latest`）。
- **Trivy 镜像扫描不过会导致镜像不推送**（不是代码问题，是运行镜像的 Debian 安全包版本落后）。若遇到，参考 `Dockerfile` 里"刷新运行时安全包"的写法：失效缓存层 + `dist-upgrade` + 显式装修复版包。
- 镜像：`jzrm/stdhub`（Docker Hub），NAS 部署映射端口 `33004 → 3000`。

---

## 8. 明天上手建议

1. `git clone` → `npm install` → `cp .env.example .env.local`（填凭据）→ `npm run dev`。
2. 先读一遍 `WORKLOG.md`（了解历史脉络），再看本文档第 5、6 节（最近改动 + 坑）。
3. 跑一遍 `npm test` 确认环境正常（当前全量 347 单测 + 9 mock E2E 应全绿）。
4. 若继续做 CMA 卡片相关，重点文件：`public/js/app-cma-diff-labs.js`（前端）、`src/services/cap-lib-service.ts` + `src/services/qualification-service.ts`（后端）、`src/api/cap-lib-routes.ts`（路由）、`e2e/cma-diff-card.spec.ts`（测试）。

---

*本文档与 `WORKLOG.md`、`.workbuddy/memory/`（仅本机）互补。若换了新机器，`.workbuddy/memory/` 下的本地记忆不会随 Git 走，重要约定已沉淀到本文档。*

# labr 源接入计划 V2

> 第 4 个标准来源 `labr` (labr.cc)。**未实施**，本文是动业务代码前的最终方案。
>
> V2 推翻 V1：基于 `probe-labr-result.md`（2026-05-27 Playwright 登录态实测）和"sidebar Labr库检索 tab"产品方向，所有契约与改动点已重新对齐。

---

## 零、Onboarding —— 给下一个会话 / 换台电脑接手的你

### 阅读顺序（按这个看完就有完整上下文）

1. **本文件** —— labr 接入的所有决策、契约、改动点清单、实施顺序都在这里
2. **`probe-labr-result.md`**（项目根目录）—— labr.cc 站点的实测 API 契约。本文很多结论是引用它的，遇到"为什么这样做"先回这里查
3. **`CLAUDE.md`**（项目根目录）—— 工程约定：README 必须随码同改、OKLCh fallback、构建走 GitHub Actions 而非本地、std_code 三层归一化
4. **`docs/ARCHITECTURE.md`** —— 模块边界。labr 不挂 SourceRegistry，看这张图就懂为什么独立 service
5. **真要开工前再读以下源文件**（不要预读，按需 Read）：
   - `src/services/library-index.ts` —— parseLibraryFilename / addFileToLibrary / scanLibrary
   - `src/services/library-naming.ts` —— renderLibraryFilename
   - `src/shared/source-semaphore.ts` —— source-level 并发限制
   - `src/shared/id.ts` + `src/domain/standard.ts` —— SourceName 类型
   - `src/sources/by/by-adapter.ts` —— 看 token 持久化 / cookie / ensureLogin 的现成模式（labr-client 沿用）
   - `web/index.html` 第 36-81 行 —— sidebar 现有 tab 结构

### 当前进度

- ✅ probe 已完成（probe-labr-result.md 663 行）
- ✅ V2 plan 已敲定（本文）
- ✅ **#50–#59 全部上线**（后端 domain / semaphore / db / client / service / API + 前端 sidebar / labr-panel / preview picker / 样式徽章）
- ⏳ #60 文档同步执行中
- 任务编号 #50 起（任务系统不跨会话保留，本文末"实施顺序"=权威清单）

### 凭据位置（不要写进任何 commit / 内存 / 文档）

labr 账号密码与 token 在以下两个文件里（已 gitignore 或本地文件）：
- `probe-labr-result.md` 第 4 节"登录端点"
- `plan.txt`（前一轮 CLI 残留，**仅本地**）

实施时凭据应通过环境变量 `LABR_USERNAME` / `LABR_PASSWORD` 注入；首次启动前提示用户写入 `.env.local`（项目已有 `.env` 模式，照 BY_USERNAME / BY_PASSWORD 的现成做法即可）。**永不要**把凭据 hard-code 到任何 .ts/.md，也不要塞进 auto-memory。

### 实施依赖链（任务列表系统不跨会话，落到这里）

```
#50 parseLibraryFilename 兼容新旧文件名   ← 第一刀，纯本地逻辑 + 单测
   ↓
#51 域类型 + library-index labr↔LB 映射
   ↓
#52 db.ts labr_temp_urls 表 + filename_pattern 默认值改
   ↓
#53 labr-client（登录 + List + Detail + 统一 download）  ← 含 nock/record-replay 单测
   ↓
#54 labr-service（编排 + batch 退避）
   ↓
#55 labr-routes + /api/preview/files     ↓ ↓
                                        ↓  ↓
#56 sidebar Labr库检索 tab 骨架（可与后端并行）
   ↓
#57 labr-panel.ts 业务逻辑              #58 multi-source preview picker
                                        ↓
#59 labr.css + file-type-badge.css
   ↓
#60 文档同步 + CI 验证
```

### 实施进度登记表（**每完成一节点就 commit 这张表**）

> **使用方法**：完成一个节点 → 把 `[ ]` 改成 `[x]` + 填 commit SHA / 日期 + 简短备注 → `git add labr-source-plan.md && git commit` 推到 GitHub。换电脑拉下来一眼看到下一步该做什么。
>
> commit SHA 用短 hash（前 7 位）。备注里写"踩了什么坑 / 偏离 plan 的地方"，**不要**复述"做完了"。

| # | 节点 | 状态 | commit | 完成日期 | 关键文件 / 备注 |
|---|---|:-:|---|---|---|
| 50 | parseLibraryFilename 兼容新旧文件名 + 单测 | [x] | _待填_ | 2026-05-27 | `src/services/library-index.ts` 新增 `STD_CODE_HEAD_RE` + 输出 `title` 字段；`library-index.test.ts` 21 用例覆盖老格式回归 / 含 title / stdCode 形状 (DB44T/JBT 4730.5/2010A/ISO/无年份) / 拒绝。watcher 仅消费 stdCodeNorm/year/source，title 纯增字段无下游回归 |
| 51 | 域类型 labr + library-index 映射 + semaphore | [x] | _待填_ | 2026-05-27 | SourceName 加 `'labr'`；VALID_SOURCES、source-semaphore DEFAULTS (labr=2)、library-index 的 SUPPORTED_SOURCES/SOURCE_LABEL_TO_CANONICAL (LB+LABR)/CANONICAL_TO_LABEL (labr→LB)、library-naming SOURCE_LABELS 全部加 labr 项。`source-registry` 的 FACTORIES 改 `Partial<Record<...>>`（labr 不实现 SourceAdapter，故意空缺）。admin-routes/preview-routes 的 sourceEnum 与 db.ts 的 library_source_priority 默认值 **不动**——labr 与主搜索 preview fallback 隔离 |
| 52 | db.ts 表迁移 + filename_pattern 默认值 | [x] | _待填_ | 2026-05-27 | `db.ts` 加 `labr_temp_urls (did PK, url, fetched_at)` 表；seed 默认 `library_filename_pattern` 改 `'{stdCode} {title} - {source}'`；一次性 UPDATE 把旧默认值升级到新默认（仅当用户没改过 setting），用户自定义保留。renderLibraryFilename 已对空 title 容错（BW/BZ/BY 旧形态不破） |
| 53 | labr-client（登录 / List / Detail / Download） | [x] | _待填_ | 2026-05-27 | `labr-client.ts` 协议层（无 token 持久化、无编排）：`login` / `bridgeSso` / `searchInline` / `recList` / `getDetail` / `preview2`（识别 LabrRateLimitError + LabrAuthError）/ `downloadDirect`（kind=0 直拉 + temp/<md5>.pdf 同方法）。pure-func 测 21 用例已含；nock 录放推到 #54 跟 live integration 一起，避免空转 mock |
| 54 | labr-service（编排 + batch 退避） | [x] | _待填_ | 2026-05-27 | `src/sources/labr/labr-service.ts` 单例编排：session 持久化到 settings(`labr.token` / `labr.token_expires_at`)、env `LABR_USERNAME`/`LABR_PASSWORD` 取凭据、`download(did)` 按 `info.kind` 分支（0 直拉 / 1 走 `labr_temp_urls` 缓存 → preview2 → 入表 → 拉）、auth 失败自动重登重试一次、`batchDownload()` 撞 LabrRateLimitError 后置 batchState 让后续 kind=1 短路（kind=0 不受影响）。配套扩展 `library-naming.renderLibraryFilenameWithExt(...,ext)` 与 `addFileToLibrary({ext, mime})` 让非 PDF（docx/xlsx/pptx）也能进库；MIME 按扩展名表查（pdf/doc/docx/xls/xlsx/ppt/pptx/txt/zip）。单测推到 #55 路由层做 end-to-end，避免在 sqlite + http mock 上做空转 |
| 55 | labr API routes + /api/preview/files | [x] | _待填_ | 2026-05-27 | `src/api/labr-routes.ts` 新建：`GET /api/labr/search`（page=1 → searchInline 首屏 ≤4，page≥2 → recList，pageSize 上限 500）/ `GET /api/labr/detail/:did` / `POST /api/labr/download` / `POST /api/labr/batch-download`（items 上限 100）。`src/api/preview-routes.ts` 加 `GET /api/preview/files?stdCode=&year=` 返回多源候选（按 library_source_priority + 兜底全集排序，labr 不在默认 priority 但会被列出）；sourceEnum 扩展到 'gbw'\|'bz'\|'by'\|'labr'。`src/api/app.ts` 挂载 `createLabrRoutes(requireAuth)` |
| 56 | sidebar Labr库检索 tab 骨架 | [x] | | | `web/index.html` 加侧栏按钮（📚 + desc）+ `#page-labr` 骨架（搜索框 / `#labrResults` / `#labrPager` / 批量按钮）。`public/js/app-core.js` `KNOWN_TABS` 加 `labr`；`public/js/app-auth-admin.js` `TAB_LABELS` 加 `labr:'Labr库检索'`、`TAB_ITEMS` 追加同 key 条目 —— 权限闸口/admin 默认权限 UI 自动覆盖。事件函数（`doLabrSearch` / `doLabrBatchDownload`）由 #57 接入 |
| 57 | labr-panel.ts 业务逻辑 | [x] | | | 选 legacy JS 路线（与 app-qual.js 一致），新增 `public/js/app-labr.js`：`doLabrSearch(page)` / `doLabrDownload(did)` / `doLabrBatchDownload()` / 全选 + 单选 / 翻页（page≥2 走 rec-list、page=1 走 inline）。响应走 `readApiResponse` 解 `{data,error}` envelope。错误 code `LABR_RATE_LIMIT` / `LABR_AUTH` 给中文友好提示。批量下载结果逐行就地渲染 ok / 失败原因，限速被跳过的条目单独提示数量。hl_title 白名单 `<font color>` / `<mark>` / `<b>` 后写入，其余 escape。`web/index.html` 注册 `<script src="/legacy/app-labr.js">`。TS 化推迟到 #57 整体（labr-panel.ts 与 web/src/labr/* 文件结构）作为后续单独迁移任务，与 qual 同步迁移即可 |
| 58 | multi-source preview picker | [x] | | | 沿 legacy JS 路线：`public/index.html` 在 `.preview-head` 下加 `#previewSourcePicker`（默认 hidden）。`public/js/app-search.js` 新增 `loadPreviewSourcePicker(stdCode, year, activeFileId)` —— ready 后调一次 `/api/preview/files?stdCode=&year=`，≥2 候选时显示 picker，单一候选静默隐藏。每个按钮渲染 `source 名 + year + ext`（非 PDF 才显 ext 徽章），active 高亮当前 fileId。`switchPreviewSource(fileId, stdCode)` 直接换 iframe src 到 `/api/preview/file/:fileId`（跳过整轮 `/preview/request` RTT，因为候选已确定在库），并把 active class 转过去。`closePreviewOverlay` 清空 picker。仅 overlay 路径实装；popup 路径暂不支持 picker（popup 是浏览器子窗口，注入 UI 复杂度高、价值低）。CSS 样式留给 #59 |
| 59 | pages/labr.css + file-type-badge.css | [x] | claude | 2026-05-27 | 新增 `web/src/styles/pages/labr.css`（labr-row 家族 + std-code 蓝徽章 + kind-0 绿/kind-1 橙 + ext 按 office 套件主色 pdf 红/doc 蓝/xls 绿/ppt 橙/txt 灰 + paid 橙 + 640px mobile 紧凑）；`components/preview.css` 追加 `.preview-source-picker` 多源切换条（active 蓝、mobile 横滚）；`index.css` 加 `@import './pages/labr.css'`。所有 oklch() 都有 rgba() fallback 兄弟（CLAUDE.md 契约）。仅写入 `web/src/styles/*`，未镜像 `public/styles.css`（legacy 入口将丢 labr 样式，记录为 #60 跟进项）。**发现**：`public/styles.css` 第 1593 行 `.library-row-label` 处被截断（预先存在的文件损坏），#60 向用户告警 |
| 60 | 文档同步 + CI 绿 | [x] | claude | 2026-05-27 | `README.md` 顶部"近期重点"补 labr 上线条 + 来源表加 labr 行；`web/README.md` 加 `pages/labr.css` 与 `components/preview.css` picker 段落；`docs/ARCHITECTURE.md` 模块图加 labr-service / labr-client / labr_temp_urls 节点；`CHANGELOG.md` Unreleased 加"labr 4th source + multi-source preview picker"条；本文顶部 V2 状态 → ✅ 已上线。**已知遗留**：`public/styles.css` 第 1593 行 `.library-row-label` 处被截断（预先存在的文件损坏，与 labr 无关），legacy `public/index.html` 入口缺 labr 样式 —— 用户决定是修补 styles.css 还是直接砍掉 legacy 入口 |
| 61 | 修 public/styles.css 截断 + 镜像 labr/picker CSS 段 | [x] | d8acfd2 / 17c6181 | 2026-05-28 | `public/styles.css` 修第 1593 行 `.library-row-label` 截断；末尾追加镜像 banner：多源 preview picker (~50 行) + Labr库检索 page #page-labr (~140 行)；oklch 都跟 rgba fallback；`DEVELOPMENT.md` 加 PS 5.1 UTF-8 配置节（chcp 65001 + 编码三件套 + git i18n + here-string + WriteAllText 兜底） |
| 62 | 镜像 labr sidebar 入口 + #page-labr 容器 + app-labr.js 引用到 public/index.html | [x] | claude | 2026-05-28 | **用户报告装包后主界面 sidebar 没 Labr 入口** —— 根因：Electron 加载 `http://localhost:port` → Express 把 `public/` 当静态根（`src/api/app.ts:68/76`）→ 跑的是 legacy `public/index.html`；但 #56 sidebar `<button>` + `<div id="page-labr">` 只加到 `web/index.html`。#61 只镜像了 CSS，没镜像 HTML。本次：`public/index.html` 加 sidebar `<button data-tab="labr">📚 Labr库检索</button>`（qual 之后、stats 之前）+ `<div class="page" id="page-labr">` 容器（搬运 web/index.html 第 299-311 行）+ `<script src="/js/app-labr.js">`。两步切换契约：未来砍 legacy 入口时整段删 |
| 63 | ARCHITECTURE.md + README API 表补 labr | [x] | 901f01c | 2026-05-28 | plan #60 登记表声称已加，实际 grep 0 命中（之前漏写）。本次：`docs/ARCHITECTURE.md` § 6-A 加 labr 独立 service 节 + § 9 信号量表加 labr=2；`README.md` 加 `/api/labr/*` + `/api/preview/files` + `/api/preview/library-check` API 段 |
| 64 | 修 hl_title 高亮泄漏 + library-check 跨源（含 labr） | [x] | claude | 2026-05-28 | 用户实测两个 bug：①Labr 搜索结果 title 字面出现 `<font color="red">` —— 根因：`sanitizeLabrTitle` 把所有 `< >` escape 后写的白名单正则用 `[&quot;']` 匹配 attribute 引号，但 escape 链没转 `"` → 永远匹配不上 → 标签被 escape 后字面泄漏。改成把 `<font [color=...]>` 整体转 `<mark>` 再 escape + 白名单解回 `<mark>/<b>`（attribute 数=0，更稳）。②labr 入库的标准在主搜索预览没绿点 —— 根因：`/api/preview/library-check` 默认 `effectiveSources` 用 `getConfiguredSourcePriority`，默认值 `['gbw','bz','by']` 不含 labr → bulkLookup 把 labr 行过滤掉。修：新增 `ALL_LIBRARY_SOURCES` 常量（4 源全集），library-check 默认走全集（"绿点 = 库里有没有"是 OR 语义，不是 priority 语义）；`/api/preview/files`、`runAutoDownload` 仍走 priority（自动选源是 priority 语义）。两个 endpoint 之前共用 `getConfiguredSourcePriority` 把两种语义混了 |

### 跨节点 / 跨会话发现的事（追加日志）

> 实施过程中遇到的"plan 没说但需要记的事"写这里。比 commit message 长寿（commit 信息常被忽略），又比新开 task 轻量。

| 日期 | commit | 事项 |
|---|---|---|
| 2026-05-28 | #62 | **legacy `public/index.html` 是装包后的实际入口**（不是 `web/index.html`）：Electron `loadURL(http://localhost:port)` → Express `staticDir/public/index.html`。任何新 sidebar tab / page 都要镜像到 `public/index.html`，CSS 镜像到 `public/styles.css`，legacy JS 放 `public/js/`。直到 legacy 入口被砍掉前，**HTML/CSS/JS 三件套都要同步镜像** |
| 2026-05-28 | #64 | **`/api/preview/library-check` 与 `/api/preview/files` 用不同源集合是有意的**：前者是"绿点 = 库里有没有"OR 语义、用 4 源全集 `ALL_LIBRARY_SOURCES`；后者是"自动选哪一个"priority 语义、用 `getConfiguredSourcePriority`（默认不含 labr）。改 library-check 默认源时不要顺手把 files 也改了 |
| 2026-05-28 | #64 | **labr hl_title 是原始 HTML**（带 `<font color="red">`），不是预转义文本。sanitize 不能简单 escape-then-whitelist，因为转义后正则要在转义形态里匹配（`<` → `&lt;`、`>` → `&gt;`），但 attribute 引号 `"` 默认 escape 链不动它，会让 `[&quot;']` 类正则永远失配。要么先把 `"` 也 escape（多一条规则），要么改成"先标准化标签 → 再统一 escape → 再解白名单"，#64 选了后者 |
| 2026-05-28 | #65 | **不在 UI 中暴露 labr.cc 域名**：sidebar 副标题 `labr.cc 标准库补给` → `标准库补给`，README "支持的标准源"表 `labr.cc` → `标准库补给源`（用户向描述）。API 表里的 `source=labr` **保留**（开发者参考，文案不属于面向用户的 UI 范畴）。镜像位置：`public/index.html` + `web/index.html` + `public/js/app-auth-admin.js` (`TAB_LABELS` / `TAB_ITEMS`) + `README.md` 顶部表 + 功能清单 |
| 2026-05-28 | #66 | **本地文件库独立成顶级 tab**：从「下载历史」中拆出 `data-tab="local"`，加 5 项管理（预览/下载/打开路径/编辑/删除 + 复选 + 批量删）。后端新增 `DELETE /api/preview/file/:id` / `POST /api/preview/files/batch-delete` / `POST /api/preview/file/:id/reveal` (Electron-only) / `PATCH /api/preview/file/:id`（rename）。Electron 主进程靠 `process.on('bzxz:reveal-in-folder')` 事件总线接收后端 emit、调 `shell.showItemInFolder`，避免给每个新需求都加 ipcMain handle 引线。**`std_code_norm` 索引键不允许被 rename 改动**（搜索 / 绿点都依赖它） |

### 本地测试约定（**强制**）

**不在本地跑测试**。Claude 不要给"先跑 npm run web:test"的预检步骤，commit 命令块直接 `git add` + commit + push，让 GitHub Actions 跑 typecheck/test/build。本机不跑构建/测试是用户工程约定（GH Actions 已是单一真相源），同样适用于单测。

跨节点判断：plan 里凡是写"先本地跑 ... 验绿"的步骤都按本约定剔除，commit 命令块只列必要的 git 动作。

### 工作流约定（CLAUDE.md 强制，再点一下）

- 改任何代码同步修对应 README（项目根 + web/ + docs/）
- 不在本地跑 `npm run build`，靠 GitHub Actions CI（用户用 Actions 自动打包）
- 静态核查能跑就跑（Glob/Read 验 import 路径、类型引用）
- commit message 中文，第一行扼要，空行后 why + how
- Linux 沙箱常态化挂掉，git 命令以"代码块给用户复制"的形式交付

---

## 一、定位（V2 关键变更）

labr **不是第 4 个 SourceAdapter**，而是一个**独立的标准库补给器**：

| 维度 | 现有 3 源（gbw/bz/by） | labr |
|---|---|---|
| 搜索语义 | 精确（用户输入 stdCode → 唯一命中） | **模糊**（输入关键词 → 列表） |
| 命中数 | 1 / 0 | 多条 |
| 用户路径 | 输入 → 自动下载 → 入库 → 预览 | **sidebar "Labr库检索" tab** → 搜索 → 列表多选 → 手动批量下载 → 入库（与三源共用 standards_library_dir）|
| 是否参与主搜索的多源并行 | ✅ 是 | ❌ **不参与**（避免污染精确搜索的命中唯一性） |
| 入库后被主预览复用 | ✅ | ✅ **同等参与**预览路由 |
| 走 `SourceAdapter` 接口 | ✅ | ❌ **不走**（独立 Service + Routes） |
| 进 `librarySourcePriority` admin 配置 | ✅ | ❌ |

**集成层是 `library-index`**：labr 下载完成后，文件名按统一规则写入 `standards_library_dir`，主搜索预览自动看见。

---

## 二、源标识

| 项 | 值 | 备注 |
|---|---|---|
| canonical SourceName | `labr` | TS 字面量、入 `VALID_SOURCES` |
| 文件名标签 | `LB` | 沿用 BW/BZ/BY 的两字母约定 |
| UI 入口 | **左侧 sidebar "Labr库检索"** (`data-tab="labr"`, icon 🧪) | 与"资质查询"同组，独立 tab 不开新窗口 |
| 下载落地 | **`standards_library_dir`**（统一标准库目录） | 与 BW/BZ/BY 一致，走 `addFileToLibrary` |
| 站点 | `https://www.labr.cc`（主站）/ `https://uc.labr.cc`（账号中心） | |
| 是否需要登录 | **看资源** —— `kind=0` 不要、`kind=1` 必需 | |

---

## 三、下载策略（按 `info.kind` 二分，**这是 V1 没看见的核心事实**）

```
搜索 list / detail → 拿到 info.kind
   ├─ kind=0  匿名 GET https://www.labr.cc/{detail.filepath}        ← 真路径
   │           （免费 / 付费 全部走这条；ACL 完全不挡）
   │           filepath 前缀有两种：filesystem/frontend/document/... 与 filesystem/backend/document/...
   │           前者=用户前台上传，后者=站点后台批量入库（如 pptx），下载链路无区别
   │
   └─ kind=1  必须登录（ssoToken Cookie）
              ① 先查 temp-url 缓存（见下）；命中 → 直接 GET 该 URL
              ② miss → GET /document/preview2.html?did=N&pageNo=1&category=0
                       → data.url = https://www.labr.cc/temp/<md5>.pdf
                       → 持久化 (did → md5) 入缓存
              ③ 匿名 GET temp/<md5>.pdf（temp 路径完全裸放）
```

**判别字段**：list 接口 (`rec-list`) 和 detail 接口 (`state.info`) 都暴露 `kind`。搜索阶段就能识别"假路径资源"。

**⚠ 易混淆**：站点"有无预览按钮"是 `filetype === 'pdf'` 决定的，**不是** `kind`。kind=0 的 pptx/docx（如 did=849、5792）也没预览按钮，但匿名可直拉。**绝不能用"无预览按钮"代理 kind=1 判别**。

**统一下载入口**（probe 推荐的最终签名，比 V2 草稿里两个独立函数干净）：

```ts
async function downloadLabr(info, detail, session): Promise<Buffer> {
  if (info.kind === 0) {
    // #1/#2/#3：匿名直拉
    return await fetch(`https://www.labr.cc/${detail.filepath}`).then(r => r.buffer());
  }
  // #5：kind=1
  let url = await tempUrlCache.get(info.did);          // ← V2.1 新增：避开 5/日 额度
  if (!url) {
    await session.ensureLoggedIn();
    const r = await fetch(
      `https://www.labr.cc/document/preview2.html?did=${info.did}&pageNo=1&category=0`,
      { headers: { Cookie: `ssoToken=${session.token}` } },
    );
    const body = await r.json();
    if (body.code !== 200) {
      // 撞额度时 body.message === "每日限定免费下载 5 次，已达上限，请明日再操作！"
      throw new LabrRateLimitError(body.message);
    }
    url = body.data.url;
    await tempUrlCache.set(info.did, url);
  }
  return await fetch(url).then(r => r.buffer());
}
```

**绝对不要**用 down-file 接口：kind=0 返回的 filepath 跟 detail 一样，kind=1 返回的还是假路径，毫无收益、还白费一次后端调用。

**5 次/日 额度兜底**：
- 实测 `Authorization: Bearer` header 会触发 preview2 的"每日 5 次"限免下载额度
- **必须用 Cookie**（ssoToken）发请求，Cookie 路径目前未观察到限制（**但假设存在**）
- **batch 场景退避**：批量下载里若某条返回 `LabrRateLimitError`，后续 kind=1 任务全部 abort + 标 `quotaExhausted`，UI 提示"今日免费额度耗尽，请明日再试或登录其他账号"
- **temp-url 缓存**（V2.1 新增）：probe 实测"旧 hash 跨 token 仍可拉"，把 `(did → temp_md5_url)` 持久化到 SQLite `labr_temp_urls(did INTEGER PK, url TEXT, fetched_at TEXT)`。下次同 did 再下时跳过 preview2、直接拉 url。可显著降低额度消耗（同一 did 重复下载场景常见 —— 用户预览后觉得不对、换其他 stdCode、回头又选回来）。失效兜底：拉 url 返回 404 时再走 preview2 重新生成 hash 并 upsert。

---

## 四、登录流程

```
POST https://uc.labr.cc/v1/site/login?ut_module=v1
  Content-Type: application/json
  body: {"username":"<phone>","password":"<pwd>","verificationCode":"","openid":"","webflg":1}
  → resp.data.access_token  (40 字符不透明字符串，expires_in=365 天)

GET https://www.labr.cc/site/auto-login.html?token=<token>
  → Set-Cookie: ssoToken=<token>; Domain=.labr.cc; HttpOnly; Secure; SameSite=Lax
```

后续所有 www.labr.cc 请求都带 `Cookie: ssoToken=<token>`。

**实现要点**：
- 凭证从环境变量读：`LABR_USERNAME` / `LABR_PASSWORD`
- token 缓存到 `data/labr-token.json`（同 bz/by 的 token 持久化做法），expires_in 默认 1 年
- 启动时不立即登录，**懒登录**：首次遇到 kind=1 资源下载或用户主动点"登录"按钮才触发
- Cookie 维持用 Node 端 `tough-cookie` 或在 `pooledFetch` 上加一个简单的 cookie jar
- **错误处理**：labr 后端是 PHP，错误码塞在 body.code 不是 HTTP status —— 必须 `if (json.code !== 200) throw` 而不是只看 fetch 的 ok

---

## 五、搜索 / 分页

```
GET https://www.labr.cc/document/rec-list.html?pageNo=2&category=0&keyword=<kw>&tagids=&pageSize=100
  → { code:200, data:{ total, pageSize, pageCount, list:[...] } }
```

- 首屏 `document/list.html?keyword=...` HTML 内联 ≤4 条到 `state.dataList`（SSR），其余分页走 rec-list
- pageNo **从 2 开始**（pageNo=1 通常空，前端就是这样设计的）
- pageSize 默认 20，**实测可改到 500 无上限**；我们固定 `pageSize=100`
- 没有 `hasMore`，靠 `pageNo === pageCount` 判结束
- 标准号没有独立字段，从 `title` 用正则抽（labr 自己是全文模糊匹配）

**list 字段映射**（合并 dataList 和 rec-list 两种来源后的并集）：

| 我们的字段 | labr 字段 | 备注 |
|---|---|---|
| `did` | `did` (string or number) | 用 `String(did)` 归一化 |
| `title` | `title` | 含 stdCode 全文 |
| `stdCode` | regex from `title` | 用 `extractFullCode(title)` 抽，抽不到则 null |
| `credits` | `price` | 0 = 免费 |
| `isFree` | `is_free` | 0/1 |
| `ext` | `ext` | 注意 labr 有拼写错："doc"→docx, "xsxl"→xlsx |
| `pubdt` | `pubdt` | `"YYYY-MM-DD HH:MM:SS"` |
| `kind` | `kind` | **0=真路径, 1=假路径需登录** |
| `views` | `views` | |

---

## 六、UI 过滤规则（用户已敲定）

搜索结果只显示满足以下条件的资源：

```
visible = is_free === 1
       && price === 0
       && detail.filetype === 'pdf'    （第一期 PDF only，docx/xlsx/pptx 不展示）
```

**注意**：
- "付费 ≠ 不可拿"已被探测证实（kind=0 的 30 积分付费资源也能匿名拉），但**用户明确要求过滤 credits>0**，按需求执行
- 非 PDF 在 list 层 `ext` 字段就能判，不需要进 detail
- list 层没有 `filetype`，过滤靠 `ext === 'pdf'`（"doc"/"pptx"/"xsxl" 全部排除）
- **"无预览按钮" ≠ kind=1**：probe 实测预览按钮渲染条件是 `filetype === 'pdf'`，跟 `kind` 字段无关。kind=0 的 pptx/docx 也没预览按钮。所以 PDF only 是**产品决策**（第一期不接入非 PDF mime），不是技术约束。kind 字段才是路径判别字段

---

## 七、文件名规则（V2 改动）

**默认 pattern 改成 `{stdCode} {title} - {source}`**（V1 是 `{stdCode} - {source}`）。

理由：labr 是模糊搜索，同一标准号可能有多条命中（不同上传者、不同版本），title 进文件名利于人工识别；BW/BZ/BY 沿用同 pattern 不冲突（它们 title 与 stdCode 强对应）。

示例：
```
GB_T 3324-2024 木家具通用技术条件 - LB.pdf
GB_T 3324-2024 木家具通用技术条件 - BW.pdf
```

**⚠️ 隐患（必须同步修 parseLibraryFilename）**：

现有正则 `/^(.+?)\s*[-—]\s*([A-Za-z]+)\s*$/` + `extractBaseCode` 能抽出 `GB/T 3324`，但**年份提取的 `-\s*(\d{4})\s*$` 锚定字符串结尾**，新格式下结尾是 title 不是 year，**year 列会变空**。

需要改成：先 strip 末尾 ` - LABEL`，从开头匹配 `^[A-Z/]+\s+\d+(-\d{4})?` 抽 stdCode + year，剩下的视作 title（可丢可保存到新增的 `title` 列）。改动落在 `src/services/library-index.ts:72` `parseLibraryFilename`。

---

## 八、同标准多源 → 预览选源弹窗

需求：库里若同一 stdCode 有 `BW/BY/LB` 多个版本，预览时弹小窗让用户选。

### 新 API

```
GET /api/preview/files?stdCode=GB/T+3324-2024
  → 200 { files: [
      { source: 'gbw', label: 'BW', size: 1535414, mtime: ... },
      { source: 'by',  label: 'BY', size: 1267800, mtime: ... },
      { source: 'labr',label: 'LB', size: 1672000, mtime: ... }
    ]}
```

复用 `library-index.lookupFile()` 的全量结果（现在只返回 priority 第一个，新接口返回数组）。

### 现有 `/api/preview/file` 兼容

保留，行为不变（按 `library_source_priority` 取一个）。前端旧路径继续可用，新弹窗用 `/files`。

### 前端

`web/src/preview/` 新增 picker 组件；展示候选列表 `{label}版（{size}）`，点击后调 `/api/preview/file?source=labr` 拉对应版本。

---

## 九、覆盖式入库（用户决策）

**同源同 stdCode 直接覆盖旧文件**，不保留版本历史。

实现：`addFileToLibrary(stdCode, source, srcPath)` 内部 unlink 已有 `${stdCode} * - ${LABEL}.pdf` 再 rename。watcher 会触发增量更新。

跨源不冲突（文件名里源标签不同），所以"覆盖"只在 source 相同 + stdCode 相同时生效。

---

## 十、改动点清单（按文件归类）

### A. 域 / 共享

1. **`src/domain/standard.ts`** `SourceName` union 增 `'labr'`
2. **`src/shared/id.ts`** `VALID_SOURCES` Set 加 `'labr'`
3. **`src/shared/source-semaphore.ts`** `DEFAULTS` 加 `labr: 4`（TypeScript Record<SourceName,number> 强约束，必须加；不加 build 失败）

### B. 库索引 / 文件命名

4. **`src/services/library-index.ts`**
   - `SUPPORTED_SOURCES` 加 `'labr'`
   - `SOURCE_LABEL_TO_CANONICAL` 加 `LB: 'labr'`
   - `CANONICAL_TO_LABEL` 加 `labr: 'LB'`
   - **`parseLibraryFilename` 重写**：支持 `{stdCode} {title} - {label}` 与旧格式 `{stdCode} - {label}` 同时存在（向后兼容）。年份从 stdCode 头部抽，title 从中段抽
   - `buildLibraryFilename` 接受可选 title 参数（V2 默认带 title）
   - `lookupFile()` 增加 `getAllFiles(stdCodeNorm)` 同胞方法供 `/api/preview/files`
5. **`src/services/library-naming.ts`**
   - `SOURCE_LABELS` 加 `labr: 'LB'`
   - `renderLibraryFilename` 不需要改（已支持 `{title}`），只是 db 默认 pattern 字符串变了

### C. 配置默认值

6. **`src/services/db.ts:294`** `library_filename_pattern` 默认值改 `{stdCode} {title} - {source}`（保留对用户已有自定义 pattern 的尊重，只改默认）
7. **不修改** `library_source_priority` 默认（仍 `["gbw","bz","by"]`）。labr 不参与主搜索预览优先级竞争 —— 用户主动入库的 labr 文件，预览时通过新的"多源弹窗"显式选择
8. **`src/services/db.ts` 新增表 `labr_temp_urls`**：
   ```sql
   CREATE TABLE IF NOT EXISTS labr_temp_urls (
     did INTEGER PRIMARY KEY,
     url TEXT NOT NULL,
     fetched_at TEXT NOT NULL
   );
   ```
   用于缓存 kind=1 preview2 拿到的 `temp/<md5>.pdf` 真实地址，避开 5/日 额度。可选定期清理（90 天未访问）—— 但因为旧 hash 跨 token 仍可拉，不清理也没问题

### D. labr 独立服务（**新增**）

8. **`src/sources/labr/labr-client.ts`** —— HTTP 客户端
   - `login()` / `ensureLoggedIn()` / `loadCachedToken()` / `persistToken()`
   - `searchList(keyword, pageNo, pageSize)` → 调 rec-list
   - `fetchFirstPage(keyword)` → 解析 list.html inline dataList
   - `getDetail(did)` → 解析 detail.html inline state.info / state.detail
   - **`download(info, detail)`** —— 统一入口，内部按 `info.kind` 分支：
     - `kind=0`：匿名 GET `https://www.labr.cc/{detail.filepath}`（兼容 `filesystem/frontend/...` 与 `filesystem/backend/...` 两种前缀）
     - `kind=1`：查 `labr_temp_urls` 缓存 → 命中直拉 / miss 调 preview2 → 写缓存
     - 错误模型：`LabrRateLimitError`（5/日 额度撞墙）、`LabrLoginRequiredError`、`LabrNotFoundError`
   - 全部用 `pooledFetch` + `getSourceSemaphore('labr').run(...)` 包
   - **temp-url 缓存**：通过 `db.ts` 提供 `getLabrTempUrl(did)` / `setLabrTempUrl(did, url)`，命中后先 HEAD 验证 200 再用，404 时回落 preview2 并 upsert
9. **`src/sources/labr/labr-service.ts`** —— 业务编排
   - `search({ keyword, page })` —— 翻页 + 字段过滤 + stdCode regex 抽取
   - `getDownloadable(did)` —— 决策 kind 0/1 路径，返回临时 PDF buffer 或路径
   - `downloadAndAddToLibrary(did)` —— 下载 + 调 `library-index.addFileToLibrary`
   - `batchDownload(dids[])` —— 串行（受 source-semaphore 限）；遇 `LabrRateLimitError` 后续 kind=1 任务全部 short-circuit + 在结果里标 `skipped: 'quotaExhausted'`，kind=0 任务不受影响继续
10. **`src/sources/labr/labr-types.ts`** —— ListItem / DetailInfo 等

### E. Routes（新增）

11. **`src/api/labr-routes.ts`**
    - `GET  /api/labr/search?q=&page=` 返回过滤后的列表
    - `GET  /api/labr/detail/:did` 返回 detail 字段
    - `POST /api/labr/download` body `{ dids: number[] }` 批量入库，返回每条结果 `{did, success, libraryPath?, error?}`
    - `GET  /api/labr/login-status`
    - `POST /api/labr/login` body `{username, password}`（可选，覆盖 env）
12. **`src/api/preview-routes.ts`** 新增 `GET /api/preview/files`（见第九节）
13. **`src/api/index.ts`** 挂载 `labr-routes`

### F. 前端（新增 sidebar tab，**不开独立窗口**）

14. **`web/index.html` sidebar** —— 在"资质查询"和分隔线之间插入：
    ```html
    <button class="sidebar-item" data-tab="labr" onclick="switchTab('labr')">
      <span class="sidebar-icon">🧪</span>
      <span class="sidebar-text">Labr库检索<span class="sidebar-desc">实验室资源搜索 / 入库</span></span>
    </button>
    ```
    位置：放在 `qual`（资质查询）之后、`sidebar-sep` 分隔线之前 —— 与"标准库/检索"类业务归一组。

15. **`web/index.html` 主内容区** —— 在最后一个 `<div class="page" id="page-...">` 之后新增：
    ```html
    <div class="page" id="page-labr">
      <div class="search-area">
        <div class="search-row">
          <input type="text" id="labrSearchInput" placeholder="输入关键词、标准号或资料标题…">
          <button class="btn btn-primary" id="labrSearchBtn">搜索</button>
        </div>
      </div>
      <div class="toolbar" id="labrToolbar" style="display:none">
        <div class="toolbar-left">
          <span class="badge-count" id="labrSelectedCount">已选 0</span>
          <button class="btn btn-sm btn-primary" id="labrDownloadSelected" disabled>下载入库</button>
          <button class="btn btn-sm btn-ghost" id="labrSelectAll">全选</button>
        </div>
        <div class="toolbar-right">
          <span class="badge-count" id="labrLoginStatus">未登录</span>
          <button class="btn btn-sm btn-ghost" id="labrLoginBtn">登录</button>
        </div>
      </div>
      <div id="labrResults"></div>
      <div id="labrPager"></div>
    </div>
    ```
    `switchTab` 已有的 case 自动从 `data-tab` 推导对应 `#page-{tab}`，**不需要改 switchTab 本体**。

16. **`web/src/labr/` 新目录**
    - `labr-panel.ts` —— 绑定搜索框、列表渲染、分页、批量勾选、下载入库 调用 `/api/labr/*`
    - `labr-login.ts` —— 登录小弹窗（账号 / 密码 / "记住一年"）
    - `labr-card.ts` —— 单条结果卡片（stdCode 徽章 + title + 文件类型彩色徽章 + 大小 + 上传时间 + 勾选）
    - `index.ts` 在主入口 lazy-load：tab 切到 labr 时再初始化（首屏不拖累）

17. **样式** —— `web/src/styles/pages/labr.css`：复用 `theme/glass.css` 暗色玻璃主题（与 search/batch 一致），不要走 announcement/admin 的亮色调色板。卡片可直接复用 `components/result-card.css`；文件类型徽章新增几色（pdf=红、docx=蓝、pptx=橙、xlsx=绿），落 `components/file-type-badge.css`。

18. **多源预览弹窗（独立于 labr tab）** —— `web/src/preview/multi-source-picker.ts`，挂在已有 preview 流程上。任何 tab（search / batch / complete）点预览时，若 `/api/preview/files` 返回多条，先弹候选窗。一处实现、全 tab 受益。

19. **下载路径说明**（用户特别强调"走统一下载路径"）—— labr 下载落地路径**与 BW/BZ/BY 完全一致**：
    - 通过 `library-index.addFileToLibrary` 写入 `standards_library_dir`（admin "系统设置" → 标准库目录）
    - 文件名遵循 `library_filename_pattern`（默认 `{stdCode} {title} - LB.pdf`）
    - 入库后立即被 watcher 索引、`/api/preview/file` 自动可服务
    - **不**新增 labr 专属下载目录、**不**走 `data/exports/` 临时目录最终态（exports 仅作中转）

### G. 不变 / 显式不动

- ❌ **`src/services/source-registry.ts`** 不动（labr 不走 SourceAdapter）
- ❌ **`src/api/admin-routes.ts`** 不动（`sourceEnum.max(3)` 不冲突，因为 labr 不进 priority；如未来要让 labr 进 priority，把 `.max(3)` 改 `.max(4)` 同时把 `sourceEnum` 加 `'labr'`）
- ❌ **`src/api/standards-routes.ts`** 不动（它已经从 `VALID_SOURCES` 派生 SOURCES）
- ❌ **`src/services/environment-check.ts`** 不动（labr 非主源、不做连通性硬检；可在 labr panel 内置一次性 ping）
- ❌ **`public/js/app-core.js`** 不动（labr 不进主搜索 source 选择器）

### H. 文档同步（CLAUDE.md 强制）

17. `README.md` 总览：功能列表新增"labr 独立搜索窗口（标准库补给）"
18. `README.md` API 表：新增 `/api/labr/*` 与 `/api/preview/files`
19. `docs/ARCHITECTURE.md` 模块边界图加 labr-service（不挂在 SourceRegistry 下）
20. `web/README.md` 加 `web/src/labr/` 目录说明
21. `CHANGELOG.md` 加用户可见特性
22. 本文 `docs/sources/labr-source-plan.md` 实施完成后转 status → ✅ 已上线

---

## 十一、测试矩阵

| 维度 | 用例 | 期望 |
|---|---|---|
| 列表过滤 | keyword=3324 dataList=4，全是 kind=0 + free + pdf → 列表 4 条 | UI 4 条 |
| 列表过滤 | 切到 keyword=GB rec-list pageSize=100，过滤付费/非 pdf | 仅免费 PDF 显示 |
| 分页 | keyword=GB pageNo=2/3/4 | 各返回 100 条 |
| kind=0 frontend 下载 | did=3100 (0 积分免费) `filesystem/frontend/...` | 直拉 1.46 MB |
| kind=0 backend 下载 | did=849 (pptx) `filesystem/backend/...` | 直拉成功（验证 backend 前缀也接受）|
| kind=0 付费 | did=55654 (30 积分) | 不展示在 UI（被过滤），但 CLI/单测直拉成功 |
| kind=1 下载 | did=14718 → 触发登录 → preview2 → temp 拉成功 | 入库 PDF 完整 |
| kind=1 缓存命中 | 同 did=14718 第二次下载 | 跳过 preview2，直接拉缓存 url，不消耗 5/日 |
| kind=1 缓存失效 | 篡改 labr_temp_urls.url 为 404 | 自动回落 preview2 重新生成 + upsert |
| kind=1 未登录 | preview2 返回 `code:400 请先注册！` | service 抛 LabrLoginRequiredError，UI 弹登录窗 |
| Cookie vs Bearer | 用 Bearer 调 6 次 preview2 | 第 6 次"每日 5 次"被拒；切 Cookie 应正常 |
| 5/日 额度兜底 | 模拟 6 条 kind=1 batch | 第 6 条起标 `skipped: quotaExhausted`，混在中间的 kind=0 任务不受影响 |
| Token 持久化 | 重启进程 | 不需要重新登录 |
| 多源预览 | 库里同 stdCode 有 BW + LB | `/api/preview/files` 返回 2 条 |
| 文件名兼容 | 旧库 `GB_T 3324-2024 - BW.pdf` + 新库 `GB_T 3324-2024 木家具 - LB.pdf` | 都被 parseLibraryFilename 正确抽 |
| 文件名年份 | 新格式仍能抽出 year=2024 | library_files.year 列填对 |
| 批量下载 | 选 5 条混合 kind | 全部成功；并发受 labr semaphore 限到 4 |
| PHP 错误 | 模拟 401 body code=400 | service 抛业务错误，不被 fetch ok 蒙混 |

---

## 十二、实施顺序

1. **库索引兼容性**（先于一切）：改 `parseLibraryFilename` 支持新旧两种文件名，单测覆盖
2. **域类型**：`SourceName` / `VALID_SOURCES` / source-semaphore DEFAULTS
3. **db.ts**：新增 `labr_temp_urls` 表 + `library_filename_pattern` 默认值改
4. **labr-client**：登录、cookie jar、List/Detail/统一 download(info,detail)，写单测（用 nock 或 record/replay）
5. **labr-service**：编排 + library-index 写入 + batch 退避
6. **API routes**：`/api/labr/*` + `/api/preview/files`
7. **前端 sidebar 入口**：`web/index.html` 加 tab 按钮 + page 容器（最小可见，按钮先空挂）
8. **前端 labr 面板逻辑**：`web/src/labr/labr-panel.ts` 接通 `/api/labr/*`，搜索 + 列表 + 批量下载 + 登录弹窗
9. **前端 preview 多源弹窗**：`web/src/preview/multi-source-picker.ts`，挂上所有 tab 的预览入口
10. **样式**：`pages/labr.css` + `components/file-type-badge.css`，写入 `index.css` 导入顺序
11. **文档同步**（CLAUDE.md 强制）：README / web/README / ARCHITECTURE / CHANGELOG
12. push → GitHub Actions 跑 CI，看绿后告知用户

---

## 附录 A：探测得到的服务端怪癖（实施时必避坑）

- **PHP 报错原文外漏**：`Trying to access array offset on null957` 这种会出现在 body.message 里。不要把 message 直接展示给用户
- **ext 字段拼写错**：`xsxl` 是 `xlsx`、list 层 `doc` 实际可能是 `docx`，第一期 PDF only 不踩
- **did 类型不统一**：dataList 是 string，rec-list 是 number。`String(did)` 归一化
- **filepath 全角斜杠**：filename 里可能含 U+2215 `∕`（如 did=3100），不能简单按 `/` split 路径
- **filepath 形态**：偶见 `filesystem/std/...`（占位假路径，404）—— 必须严格按 `info.kind` 路由，不要从 filepath 字符串猜
- **kind=0 有两种 filesystem 前缀**：`filesystem/frontend/document/...`（用户前台上传）与 `filesystem/backend/document/...`（站点后台批量入库，如 pptx 资源），下载链路无区别，但白名单匹配时两者都要接受
- **预览按钮 ≠ kind 标记**：预览渲染条件是 `filetype === 'pdf'`，kind=0 的 docx/pptx 也无预览按钮。判别下载链路只能看 `info.kind`，看按钮会错
- **token 365 天有效**：但前端不暴露续期接口，refresh_token 探测未覆盖，先按"过期重登"策略兜底
- **rec-list 的 pageNo=0 行为不严谨**：等同 pageNo=2，必须固定从 2 开始

---

## 附录 B：来自用户的产品决策记录

- ✅ 文件名沿用 source 后缀，新增 title 中段
- ✅ 同源同 stdCode 直接覆盖
- ✅ 多源预览弹窗候选
- ✅ 列表显示：stdCode / title / 文件大小 / 文件格式（带颜色徽章）/ 上传时间
- ✅ 过滤掉积分 > 0 资源（即便能拉）
- ✅ 第一期支持非 PDF？→ 否（PDF only）
- ✅ 需要"免费下载但要登录"路径（kind=1）→ 支持，懒登录
- ✅ 批量下载

凭据来源：环境变量 `LABR_USERNAME` / `LABR_PASSWORD`，或前端登录表单覆盖。

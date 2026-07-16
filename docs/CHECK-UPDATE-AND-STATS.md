# 标准查新 + 使用统计重构 —— 方案

> 两个功能的设计方案（暂不写代码）。可点击预览：`docs/check-update-stats-prototype.html`
> （顶部切三主题 + 两屏切换：标准查新 / 使用统计）。

---

## 功能一：标准查新

### 1. 需求

用户导入一批标准号（像批量下载那样，可粘贴多行 / 导入 Excel），系统逐个查新：
**有变动**的标准 → 高亮提醒 + 展开变动详情；**无变动**的 → 折叠收起。变动维度（已确认）：

1. **状态变化**：现行 → 作废 / 被代替（最核心）。
2. **有新版本**：同基础号出现更新年版（如 GB/T 1.1-2009 → 2020）。
3. **实施日期 / 被代替关系变化**：实施日期变了、代替了哪些旧标准、被哪个新标准代替。

### 2. 数据来源（已确认改为 BZ 单源，2026-05-31）

**只查 BZ 源**（原方案三源已废弃）。理由：BZ 的状态元数据最全（状态码 1-9：现行有效/部分有效/
即将实施/即将废止/已经废止/调整转号/其它，+ 发布/实施/废止日期 + replacedStd 被代替），GBW/BY
状态字段不全、跨源文案不一致反而添乱。三源 → 单源省 2/3 请求、逻辑更聚焦。

- **登记**：查 BZ search 拿到内部 id，再 `getStandardDetail` 拿完整字段，存为基线快照。
  search 和 detail 共用同一 `BzSearchRow` 类型（字段集一致），detail 不会多出新字段，但 detail
  接口字段填充更完整，故统一走 detail 一次拿全（detail 有 10min 缓存）。
  > **注意**：BZ detail 必须先 search 拿内部记录 id（detail?id=内部id，非标准号），所以是
  > search + detail 两步，绕不开 search。
- **查新**：同样 search→detail，与基线逐字段 diff。
- BZ 查不到 → 标 `not_found`「无法核验」，**不算无变动**（避免漏报）。
- **状态比对改精确文案**（不再"是否废止"布尔归一）：现行有效→即将废止 等每一步状态推进都预警。

> **字段方向歧义（待真机确认）**：用户要"被替代标准"和"代替标准序号"两个方向。代码里目前只确认
> BZ 有 `replacedStd` 一个字段（大概率"被谁代替"方向）。"代替了谁"那个方向的字段名待真机抓一次
> detail JSON 后补。当前先存展示 `replacedStd`，TODO 标在 check-service。

### 2.5 字段来源核查（实现前已确认，2026-05-31）

所有源都返回统一的 `StandardSummary`（`src/domain/standard.ts`），查新四维度的数据来源：

| 维度 | 字段 | BZ | GBW | 说明 |
|---|---|---|---|---|
| 状态 | `status` | ✅ `BZ_STATUS_MAP`（现行有效/部分有效/即将实施/即将废止/已经废止/调整转号） | ✅ `STATE`（含"废止"等） | 各源文案不同，diff 时按"是否含废止/作废"归一判断更稳，别死比字符串 |
| 实施日期 | `implementDate` | ✅ `actDate` | ✅ `ACT_DATE` | |
| 废止日期 | `abolishedDate` | ✅ `endData` | ⚠ 恒 null | GBW 不给废止日期 |
| 被代替 | `meta.replacedStd` | ✅ | ❌ | **仅 BZ 有**，被代替关系优先信 BZ |
| 新版本 | （派生） | 两源都靠 `standardNumber` 同基础号比年版 | 同左 | 用 `extractBaseCode` 剥年份比对 |

**结论**：状态 + 实施日期 + 新版本三源都能做；被代替关系仅 BZ 可靠。diff 时按源能力降级，
缺字段的维度标"该源未提供"而非误判无变动。

### 3. 数据模型（新增表）

```sql
-- 查新清单（用户导入的一批标准 = 一个 watchlist；支持多份）
CREATE TABLE check_watchlists (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  name        TEXT NOT NULL,                 -- 清单名（导入时取文件名 / 用户命名）
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_checked_at TEXT
);

-- 清单内的标准 + 基线快照 + 最近一次查新结果
CREATE TABLE check_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  watchlist_id  INTEGER NOT NULL REFERENCES check_watchlists(id),
  std_code      TEXT NOT NULL,               -- 导入的标准号（清洗后，复用 cleanStdCode）
  std_code_norm TEXT,                        -- 归一化（复用 extractFullCode）
  -- 基线快照（导入时拉到的状态）
  base_status   TEXT,                        -- 现行/作废/被代替/即将实施
  base_title    TEXT,
  base_impl_date TEXT,                       -- 实施日期
  base_replaced_by TEXT,                     -- 被哪个新标准代替
  base_snapshot_at TEXT,
  -- 最近查新结果
  last_status   TEXT,
  last_title    TEXT,
  last_impl_date TEXT,
  last_replaced_by TEXT,
  last_checked_at TEXT,
  change_flags  TEXT,                        -- JSON：本次检出的变动类型数组 ['status','newVersion',...]
  source_used   TEXT                         -- 命中的源 / 'not_found'
);
CREATE INDEX idx_check_items_wl ON check_items(watchlist_id);
```

**为什么存快照**：查新的本质是"和上次相比变没变"。存导入时的基线，之后每次查新和基线（或上次结果）
diff，才能判定"变动"。否则只能显示"当前状态"，给不出"变了"的信号。

### 4. 比对逻辑（`diffStandard(base, fresh)`）

逐字段比，产出 `change_flags`：

- `status`：`base_status !== fresh.status`（现行→作废等）。
- `newVersion`：fresh 里同基础号（`extractBaseCode`，**剥年份**）出现更高年版 → 标"有新版本：XXXX"。
  复用现有 std-code 三层归一里的 `extractBaseCode`，与资质跨年匹配同源。
- `implDate`：实施日期变化。
- `replacedBy`：被代替关系变化。

无任何 flag → 归"无变动"（折叠）。三源都未命中 → `source_used='not_found'`，单列"无法核验"。

### 5. 信息架构（复用 `.set-*`）

**已确认：独立菜单「标准查新」**，侧栏与标准检索同级（不是子 tab）。`switchTab('check')` +
`#page-check` + `TAB_LABELS.check`，两个 index.html 同步；移动端进「我」页入口或底部 Tab（随移动端期）。

| 区域 | 组件 | 内容 |
|---|---|---|
| 页头 | `.set-page-head` | h1「标准查新」+ 副说明 + 右侧「导入 / 全部查新」 |
| 导入区 | `.set-card` + `.batch-textarea` | 粘贴多行标准号 / 上传 Excel（复用批量下载的解析）；显示"清单 N 项" |
| 概览 | `.set-stats` | 总计 / 有变动 / 无变动 / 无法核验 |
| 结果区 | 分组列表 | **有变动**默认展开（顶部、`is-bad`/`is-warn` 语义色 + 变动徽章）；**无变动**整组折叠成一行"N 项无变动 ▸"，点开才列出 |
| 变动详情 | 行内展开 | 旧值 → 新值对照（状态/年版/实施日期/被代替），复用日志页 `.log-full` 风格的对照块 |

变动徽章语义：状态变化=红（danger）、有新版本=橙（warning）、实施日期/被代替=蓝（accent）。

### 6. API（新增）

- `POST /api/check/watchlists`（建清单 + 导入标准号，存基线快照——首次查一遍三源）
- `GET /api/check/watchlists` / `GET /api/check/watchlists/:id`（列清单 / 看明细）
- `POST /api/check/watchlists/:id/recheck`（重新查新，逐项三源拉取 + diff，写 change_flags）
- `DELETE /api/check/watchlists/:id`（删清单——不可逆，二次确认）

查新走现有源 semaphore 限流（别打爆上游），大清单后台分批、前端轮询进度（复用批量下载的进度模式）。

### 7. 分期

- **Phase 1 ✅ 已落地**：
  - 表 `check_watchlists` / `check_items`（`db.ts`）。
  - `check-service.ts`：导入存基线快照 + `recheck` diff（复用 `StandardResolver` 三源 + 限流；
    `ResolvedItem` 补 `abolishedDate`/`replacedStd`）；diff 四维度（状态按"是否废止"归一、实施日期、
    被代替、年版用 `extractBaseCode` 剥年比对）。
  - `check-routes.ts`：`POST/GET /api/check/watchlists`、`GET /:id`、`POST /:id/recheck`、
    `DELETE /:id`（归属校验，非本人 404）。挂进 `app.ts`。
  - 前端：侧栏「标准查新」独立菜单 + `#page-check` + `app-check.js`（导入并查新 / 重新查新 /
    有变动展开 + 无变动整组折叠 + 无法核验单列 + 变动详情旧→新对照）+ `pages/check.css`（双文件镜像）。
    `TAB_LABELS.check`。两个 index.html 同步。
  - **本期范围说明**：导入即建清单并首查（基线==最新→首查通常无变动，之后「重新查新」才出变动）。
    单清单内存态展示，未做清单持久化列表 UI（Phase 2）。
- **Phase 2**：Excel 导入（复用批量下载解析）、清单管理（多份/重命名/删）、查新进度条。
- **Phase 3 / 自动查新 ✅ 已落地**：每清单 `auto_enabled` + `auto_interval_days`（默认/硬下限 15 天）+
  `next_run_at`。`runDueAutoChecks()` 由 app.ts 启动后 30s 补跑一次 + 每 6h 扫一次到期清单（串行、跳过
  手动防抖、跑完重排下次）。有变动 → `console.warn` 进运行日志页。`PUT /:id/auto` 设置开关。
  前端清单工具条「自动查新」开关 + "每 N 天"输入。
  > 限制：定时器进程存活时才跑，应用关闭期间错过的靠下次启动补跑兜底（Electron 桌面应用固有）。
  > 桌面通知暂未做（变动先写运行日志）。

### 限流总览（Step 1 + Step 2）

| 项 | 值 |
|---|---|
| 单清单 / 单次查新最多标准 | 200（超出截断） |
| 分批 | 50/批，批间 sleep 2s |
| 出站并发 | BZ source-semaphore = 2 收口 |
| 全局 | 同一时刻只 1 个清单在查（串行锁） |
| 手动防抖 | 同清单 20 分钟 |
| 自动查新周期 | 默认 / 硬下限 15 天，可往长调（≤365） |
| 自动调度粒度 | 启动 +30s 补跑 + 每 6h 扫一次 |

### 8. 风险

- **批量查新慢 + 受源限流**：100 个标准 × 三源 = 300 次请求。必须走 semaphore + 后台分批 +
  进度反馈，不能卡 UI。导入时的"首次基线快照"同理。
- **"无变动"误判**：源临时查不到 ≠ 无变动。三源都未命中要单列"无法核验"，不能混进"无变动"。
- **年版判定**：依赖源返回的同基础号最新年版，复用 `extractBaseCode`；源数据不全时年版提醒可能漏，
  文案要诚实（"据 X 源"）。

---

## 功能二：使用统计重构

### 1. 现状（已有，不是从零）

`usage_events` 表 + `trackEvent()` + `stats-routes.ts`（summary / timeseries / by-source /
by-user / recent）已存在，已记 `search` / `download` / `batch_resolve` / `complete`，字段
`{user_id, event_type, source, standard_id, metadata, created_at}`。**所以这是增强，不是重写。**

### 2. 需求差距 → 要补的字段

需求要记：时间、**主机名、IP、客户端类型**、操作类型（打开/查询/预览/下载…）、
**操作结果（成功/失败）+ 失败时的日志/原因**、同用户短时间折叠。
现状缺：hostname / ip / client / result / error。补五列：

```sql
ALTER TABLE usage_events ADD COLUMN ip        TEXT;   -- req.ip / X-Forwarded-For
ALTER TABLE usage_events ADD COLUMN hostname  TEXT;   -- 见下"主机名约束"
ALTER TABLE usage_events ADD COLUMN client    TEXT;   -- 'web' | 'desktop' | 'mobile'
ALTER TABLE usage_events ADD COLUMN result    TEXT;   -- 'success' | 'fail'（NULL=旧数据/未标）
ALTER TABLE usage_events ADD COLUMN error     TEXT;   -- 失败原因 / 日志摘要（result='fail' 时）
```

`trackEvent` 签名加可选 `ctx { ip, hostname, client }` + `result`/`error`，从请求注入
（middleware 统一塞 ctx；result/error 由各业务调用点按成功/异常分支传）。旧调用不传也能跑（列可空）。

**记录结果的口径**：
- **成功**：操作正常完成（搜索有结果返回、下载落地、预览生成、补全产出）→ `result='success'`。
- **失败**：业务异常分支（搜索源全部超时、下载四源未命中 / HTTP 错误、预览失败、补全报错）→
  `result='fail'`，`error` 写**简明原因 + 关键日志摘要**（如 `BW/BY/BZ 全部超时(15s)`、
  `DB44/T 1234 四源均未匹配`、`by 源 downloadPdf HTTP 500`）。错误文本与运行日志同源，避免两套说法。
- 各 `trackEvent` 调用点本就分布在 try/catch 里（见 `standards-routes.ts` 的 search/download/
  complete），把 catch 分支也补一条 `result='fail'` 的事件即可——**失败操作以前根本没进统计，这次一并补齐**。

**已确认记录维度**：IP + 主机名都记 + 操作结果（成功/失败）+ 失败日志。

> **主机名约束（重要、要在 UI 说明）**：浏览器（web / 手机端）受隐私限制**拿不到客户机主机名**，
> 只有 **Electron 桌面端**能 `os.hostname()` 拿到并随请求带上（如 `X-Client-Host` 头，主进程注入）。
> 所以 hostname 是"桌面端有值、web/手机端为空"。client 类型可由 UA + 自定义头判定：
> Electron 桌面 → `desktop`、移动 UA → `mobile`、其余 → `web`。IP 后端 `req.ip` 都能拿到。

### 3. 操作类型（event_type 扩充）

现有 `search` / `download` / `batch_resolve` / `complete`，按需求补：
- `open`（打开某页 / 启动客户端）
- `preview`（预览，preview-routes 已有触发点可加）
- `qual_search`（资质查询）、`check`（标准查新）
统一在 `EVENT_TYPES` 常量里登记，前端筛选/展示用同一份中文映射。

### 4. 同用户短时间折叠（已确认：同用户 + 同类型 + 5 分钟内）

- **数据层不丢**：`usage_events` 仍每条单记（审计完整性，永久删除/篡改都不可取）。
- **展示层折叠**：统计页"操作明细"渲染时，把 `同 user + 同 event_type + 相邻且间隔 ≤5min` 的连续
  记录合并成一条："张三 5 分钟内下载了 12 个标准 ▸"，点开列出明细。后端可加一个
  `GET /api/stats/activity?collapse=5m` 直接返回折叠后的分组，减轻前端。

### 5. 信息架构（统计页重构）

页头 `.set-page-head` + 日期区间（现有）+ 新增"操作明细"主体：

| 区域 | 组件 | 内容 |
|---|---|---|
| 概览 | `.set-stats` | 总操作 / 活跃用户 / 下载数 / **失败数**（现有 summary 增强；失败数用 danger 色突出） |
| 图表 | `.set-card` + Chart.js | 趋势 / 操作类型分布（现有 timeseries / by-source 复用） |
| **操作明细** | `.set-table` | 列：时间 / 用户 / 主机名 / IP / 客户端 / 操作类型 / **结果** / 对象（标准号）。结果用成功/失败徽章；**失败行左侧 danger 色条**，行可展开看 `error`（失败原因/日志摘要）。同用户5分钟同类折叠成一行，展开看明细 |
| 筛选 | `.set-toolbar` + `.set-chip` | 按用户 / 操作类型 / 客户端 / **结果（全部/成功/失败）** / 时间筛（管理员可跨用户，普通用户只看自己） |

客户端类型用小徽章（`.set-badge`）：web=蓝、桌面=绿、手机=橙；结果徽章：成功=绿、失败=红。
**折叠组里只要含失败项就标红 + 显示 "N 成功 / M 失败"**，展开能定位到具体失败那条 + 其 error。
权限沿用现有：非管理员只看自己。

### 6. API（增强现有 stats-routes）

- 现有 `/summary` `/timeseries` `/by-source` `/by-user` `/recent` 不动接口、SELECT 补回新列；
  `/summary` 增 `failCount`（`result='fail'` 计数）。
- 新增 `GET /api/stats/activity`：操作明细，支持 `collapse=5m`（同用户同类型5分钟折叠，
  折叠组带 `successCount`/`failCount`）+ 按 user/eventType/client/**result**/时间筛 + 分页。
  返回每条的 `result` / `error`。
- `trackEvent` 注入 `ip/hostname/client`：在 auth middleware 后加一个轻量 middleware 解析这三项
  挂到 `req`，各 trackEvent 调用点透传（或 trackEvent 直接读 `req`——但 usage-tracker 现在不接 req，
  改成接一个 ctx 对象更干净）。

### 7. 分期

- **Phase 1 ✅ 后端采集层已落地**：
  - `usage_events` 加五列（ip/hostname/client/result/error），走 `addColumnIfMissing` 幂等迁移。
  - `usage-tracker.ts`：`trackEvent` 加第 7 参 `ctx`（ip/hostname/client/result/error）；新增
    `extractUsageCtx(req)`（hostname 取 `X-Client-Host` 头、client 取 `X-Client-Type` 头或 UA 粗判、
    ip 取 `req.ip` 并剥 `::ffff:`）。
  - 各调用点透传 ctx + result：search / batch_resolve / download(×4) / complete / qual_search 的
    **成功路径标 `result:'success'`，catch 分支补记 `result:'fail'`+error**（以前失败操作完全没进统计）。
    multi-download 全源失败时记一条 fail，error 汇总各源原因。新增 `qual_search` 事件类型。
  - ✅ **桌面端头注入已落地**：`electron/main.ts` 用 `session.defaultSession.webRequest.onBeforeSendHeaders`
    对 `localhost`/`127.0.0.1` 后端请求注入 `X-Client-Host`(os.hostname()) + `X-Client-Type: desktop`
    （只对本地后端、不污染外部源站请求）。桌面端 hostname 自此有真值、client 准确判为 desktop。
  - **待办**：`open` 事件（启动 / 切页埋点，前端做，归 Phase 2 一起）。
- **Phase 2 ✅ 已落地**：
  - 后端 `GET /api/stats/activity`：返回明细（含 ip/hostname/client/result/error），`collapse=5m`
    服务端把"同 user + 同 event_type + 间隔≤5min"折叠成组（带 successCount/failCount/children）；
    querySchema 加 `result`/`client` 过滤；`/summary` 加 `failCount`。
  - 前端统计页加"操作明细"区：工具条（操作类型 / 结果筛选 chip）+ 明细表。折叠组显示 `×N` +
    成功/失败计数，可展开看子项；含失败的行 / 组标红左条，失败子项展开显示 error。客户端徽章
    （web 蓝 / 桌面 绿 / 手机 橙）；主机名/IP 列，桌面端有值、其它端显示 "—"。`loadStats` 末尾调
    `loadStatsActivity()`，summary 多一张失败卡。CSS 双文件镜像（`pages/stats.css` + `public`）。
  - 待办：`open` 事件埋点（启动/切页）暂未做，可后续补。
- **Phase 3**：导出明细 csv（含结果/error 列）；失败率趋势图；异常访问提示（如非常规 IP）。

### 8. 风险

- **隐私 / 权限**：IP + 主机名属敏感信息，**仅管理员可见跨用户明细**，普通用户只看自己；不写入
  auto-memory / 日志导出默认脱敏（或仅管理员导出）。
- **主机名拿不到**：web/手机端 hostname 必为空，UI 要显示"—"而非误导成空白，并在列头 tooltip 说明
  "仅桌面端可获取"。
- **X-Forwarded-For 可伪造**：局域网内可信；若将来公网部署，IP 取值要走可信代理链，不能裸信
  XFF 头。
- **表增列迁移**：`ALTER TABLE ADD COLUMN` 对既有行新列为 NULL，安全；但要在 db.ts 启动迁移里加
  幂等判断（列已存在不重复加），与现有 std_code 列回填同样的"检测列缺失再加"模式。
- **折叠不能丢数据**：只在展示/接口层折叠，DB 永远每条单记（审计需要）。

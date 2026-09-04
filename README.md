# StdHub

多源标准检索与批量下载 · CNAS/CMA 实验室资质能力验证

Web 优先的标准检索与文档导出系统。Express API + SQLite + 原生前端；支持 NAS/服务器部署。

> 基于 bzxz（标准盒子）项目创建，去掉 Electron 桌面端，保留核心功能。

## 功能

### 标准检索
- 多源并行搜索（BZ/GBW/BY/Labr）
- Labr 搜索结果显示 CNAS/CMA 资质匹配标识与国家 CMA 能力库状态；不同年版资质会明确标为“跨年”，PDF 可一键预览并自动入库
- Labr 可展开查看资源详情；已下载文件会标记并在 PDF 预览时优先直接打开本地副本；下载、批量下载、预览统一进入任务中心
- 设置页集中显示 BZ / GBW / BY / LABR 健康状态，并显示可选的外网访问保护状态
- 标准 PDF 预览与下载；自动入库时显示查库、搜源、下载、保存入库等阶段反馈，并在页面空闲时预热 PDF 渲染资源；内嵌预览失败或加载过慢时提供浏览器原生打开兜底
- 批量下载（自动切源回退、真实阶段与页数进度）
- 收藏标准跨设备同步并自动加入查新关注清单
- 本地文件库管理（按标准系列分页；多版本或多来源默认折叠、展开后逐文件预览与清理；CNAS/CMA/国家能力库高对比状态标识及快捷筛选）

### 资质能力验证
- CNAS/CMA 实验室资质查询（来源快捷筛选与结果数量高级筛选）
- 标准号类查询优先走归一化索引快路径，并按精确匹配、同系列 / 跨年提示、全文匹配分区展示；普通资质搜索自动获取并展示全部结果，按标准查展开后再加载机构明细
- 资质可视化（批量关键词查询）
- 订阅管理与自动同步

### 国家 CMA 资质订阅
- 国家 CMA 已**无限期暂停**：线上订阅、同步、搜索入口和匹配徽章已硬停用
- 历史数据保留为只读，不代表当前有效资质，不会由 Web/NAS 自动更新
- 离线脚本仅保留为研究工具；恢复条件见 [`docs/ADR/0001-national-cma-indefinite-suspension.md`](docs/ADR/0001-national-cma-indefinite-suspension.md)
- 历史数据证据与场所级正确建模要求见 [`docs/NATIONAL_CMA_WIKI.md`](docs/NATIONAL_CMA_WIKI.md)

### CMA 一单一库比对
- 11 个领域订阅与同步
- 5 档比对状态（在库/仅限引用/已废止/年版过期/不在库）
- 搜索页保留关键词与领域快捷筛选，资料状态收纳在高级筛选抽屉
- 标准号归一化匹配（三层防御）
- Excel 导出

### 标准查新
- 创建查新清单
- 监控标准变更

### 统一任务中心
- 集中查看下载、资质同步、CMA 能力库同步与导出任务
- 单条与批量下载显示真实阶段、BZ 页数百分比、失败重试与完成结果

### 移动端适配
- 响应式布局（≤640px 自动切换手机版）
- 底部 tabbar 导航（搜索/资质/文件/我）
- 功能页统一的紧凑标题、可滑动操作区与语义状态色
- 分页图片 PDF 阅读器（支持按需加载、缩放、适合宽度、全屏和原始 PDF 打开/下载）
- 下拉刷新（搜索结果 + 文件库）
- 搜索首页提供最近搜索与常用标准号快捷入口
- 按设备记住检索来源、筛选、排序与显示密度
- 卡片化搜索结果显示
- 毛玻璃搜索栏吸顶

## 文档导航

> 开发、维护或让其他 AI 修改代码前，请先阅读 [`docs/README.md`](docs/README.md) 和相关专题文档，避免重复踩坑或破坏既有架构约定。

- [`docs/README.md`](docs/README.md) — 完整文档目录
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — API、命名、数据源、并发与文件库架构约定
- [`docs/MAINTENANCE_ROADMAP_V2.md`](docs/MAINTENANCE_ROADMAP_V2.md) — v1.4.17 后托管治理路线与逐阶段交付门禁
- [`docs/OPTIMIZATION_ROADMAP.md`](docs/OPTIMIZATION_ROADMAP.md) — 第一轮全仓审查与 Phase A/B/C 历史记录
- [`docs/NATIONAL_CMA_WIKI.md`](docs/NATIONAL_CMA_WIKI.md) — 国家 CMA 数据链路、限制与接入方案
- [`docs/QUAL_SEARCH_AND_PREVIEW_OPTIMIZATION_PLAN.md`](docs/QUAL_SEARCH_AND_PREVIEW_OPTIMIZATION_PLAN.md) — 资质查询提速、预览阶段反馈与手机原生打开兜底方案
- [`docs/WHOLE_APP_UI_REDESIGN.md`](docs/WHOLE_APP_UI_REDESIGN.md) — 全站 UI 设计系统、页面蓝图、迁移批次和验收规则
- [`docs/AI_DEVELOPMENT_SETUP.md`](docs/AI_DEVELOPMENT_SETUP.md) — 跨设备 AI 开发环境、skills 安装和任务恢复流程
- [`task_plan.md`](task_plan.md) — 当前阶段、完成状态和下一步
- [`progress.md`](progress.md) — 最近实施内容与测试结果
- [`findings.md`](findings.md) — 架构限制、设计决策和已知问题
- [`TODO.md`](TODO.md) — 功能待办与版本记录
- [`WORKLOG.md`](WORKLOG.md) — 项目演进与历史工作记录

## 快速开始

### 环境
- Node.js >= 20
- Python >= 3.8 + ddddocr（仅 BW 源验证码需要）

### 安装

```bash
npm install
pip install ddddocr
npm run build
npm run dev
```

打开 `http://localhost:3000`。

### 凭据配置

部分源需要账号密码。复制 `.env.example` 为 `.env.local`：

```bash
cp .env.example .env.local
# 编辑 .env.local 填入 LABR_USERNAME / LABR_PASSWORD 等
```

## 部署

### Docker

```bash
docker compose up -d
```

每次 push 到 `main`，GitHub Actions 自动：递增 patch 版本号（`bump-version.mjs` 同步
`package.json`/`package-lock.json`）→ 打 tag → 创建 GitHub Release → 构建并发布
`latest`、`<版本号>`（例如 `1.4.11`）和 `v<版本号>` 镜像标签。NAS 日常可继续使用
`jzrm/stdhub:latest`；需要固定版本时改为 `jzrm/stdhub:1.4.11`（构建竞态已通过
「docker 构建仅响应 workflow_dispatch」消除，`latest` 由版本 bump 后的唯一构建写入）。

默认 `docker-compose.yml` 只把容器端口映射到宿主机 `127.0.0.1:3000`。容器内部必须监听 `0.0.0.0`，因此 Compose 用 `STDHUB_ALLOW_OPEN_ADMIN=1` 作为本机映射逃生开关。如确需局域网直连，可改成 `3000:3000`，并务必配置 `STDHUB_PROXY_TOKEN` 后删除该逃生开关。

### 免 Docker

```bash
bash deploy.sh
```

### Lucky 外网访问保护（建议）

1. 在 `.env.local` 设置一个随机的 `STDHUB_PROXY_TOKEN`。
2. 在 Lucky 对应的反向代理规则中，为请求添加 `X-StdHub-Proxy-Token: 同一个令牌`。
3. 仅向 Lucky 暴露站点；不要把 Docker 的 `3000` 端口直接映射到公网。

未配置该令牌且监听非本机时，应用默认拒绝启动。仅本机 loopback，或显式设置 `STDHUB_ALLOW_OPEN_ADMIN=1` 时，才允许无 token 的免登录管理员模式。

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | 3000 | 监听端口 |
| `STDHUB_BIND_HOST` | `127.0.0.1`（Compose 中为 `0.0.0.0`） | 服务监听地址；Docker 通过宿主机 `127.0.0.1:3000` 控制外部暴露面 |
| `STDHUB_PROXY_TOKEN` | 空（未启用） | 非本机监听时必须设置；Lucky 注入 `X-StdHub-Proxy-Token` 后才能访问 |
| `STDHUB_ALLOW_OPEN_ADMIN` | 空（拒绝） | 设为 `1` 时允许无 token 的非本机监听。这是危险逃生开关，仅用于确认过的局域网直连 |
| `STDHUB_TRUST_PROXY` | `1` | Express 信任的反代层数/地址；默认只信任紧邻的一层代理，多层代理可显式覆盖，切勿在端口可直连时设为 `true` |
| `CNAS_BROWSER_CHANNEL` | 空（Playwright Chromium） | CNAS 同步使用的浏览器 channel；通常不要设置，仅在自行安装兼容浏览器时覆盖 |
| `BY_BASE_URL` | `http://172.16.100.72:8080` | BY 源（标院内网系统）入口覆盖；经 frp/SSH 隧道部署时指向隧道入口（如 `http://host.docker.internal:18080`），详见 `docs/sources/by-source-implementation.md` |

## 项目结构

```
stdhub/
├── src/              # 后端 TypeScript（已清理 Electron）
│   ├── api/          # Express 路由
│   ├── services/     # 业务逻辑（数据库/资质/文件库）
│   ├── shared/       # 工具函数（标准号归一化/信号量）
│   └── sources/      # 数据源适配器（BZ/GBW/BY/Labr）
├── public/           # 前端（原生 JS + CSS）
├── data/             # SQLite 数据库
├── standards/        # 本地标准 PDF 库
├── scripts/          # 工具脚本
├── docs/             # 文档（开发前先读 docs/README.md；优化路线见 OPTIMIZATION_ROADMAP.md）
├── WORKLOG.md        # 工作日志
└── TODO.md           # 待办事项
```

## 数据源

| 源 | 搜索 | 下载 | 说明 |
|---|---|---|---|
| BZ | JSON API | 逐页 JPEG → PDF | 标准在线 |
| GBW | JSON API | 验证码 OCR → PDF | 国标网（当前上游不稳定，502） |
| BY | JSON API | 直接 PDF | 内网 |
| Labr | JSON API | 独立 service | 标准库补给源 |

## 开发

开始开发或交给其他 AI 修改前，请先阅读 [`docs/README.md`](docs/README.md)。涉及架构调整、性能治理、测试隔离或安全强化时，还必须阅读 [`docs/OPTIMIZATION_ROADMAP.md`](docs/OPTIMIZATION_ROADMAP.md)。

```bash
npm run dev          # 启动后端（端口 3000）
npm run build        # 编译 TypeScript
npm test             # 运行测试
```

### 跨设备继续开发

换电脑或更换 Codex 环境时，请先阅读 [`docs/AI_DEVELOPMENT_SETUP.md`](docs/AI_DEVELOPMENT_SETUP.md)，再依次阅读 `task_plan.md`、`progress.md` 和 `findings.md`。当前全站 UI 重构的长期规范位于 [`docs/WHOLE_APP_UI_REDESIGN.md`](docs/WHOLE_APP_UI_REDESIGN.md)。

截至 2026-09-04，全站 UI 重构阶段已完成：搜索、资质、CMA、文件库、历史、工具箱、日志、统计、设置、账户、任务中心与全局弹层已统一到同一工作台设计系统。Paper 为主要现代主题，legacy/classic 为 Chrome 109 兼容基线，dark/light 保持等价支持；最终验证为 22 个测试文件、206 项测试全部通过。当前改动尚未提交或发布。

## License

ISC

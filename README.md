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
- 标准 PDF 预览与下载
- 批量下载（自动切源回退、真实阶段与页数进度）
- 收藏标准跨设备同步并自动加入查新关注清单
- 本地文件库管理（按标准系列分页；多版本或多来源默认折叠、展开后逐文件预览与清理；CNAS/CMA/国家能力库高对比状态标识及快捷筛选）

### 资质能力验证
- CNAS/CMA 实验室资质查询（来源快捷筛选与结果数量高级筛选）
- 资质可视化（批量关键词查询）
- 订阅管理与自动同步

### 国家 CMA 资质订阅
- 内置国家 CMA 机构与场所订阅管理
- 当前公共查询源提供的是**机构级能力数据**：场所仅用于订阅管理，页面会明确标注数据范围，避免将机构能力误判为场所独立能力
- 同一证书全程只运行一个同步任务，SQLite 事务原子替换缓存；服务重启会把中断任务标记为失败
- 本地 SQLite 缓存能力数据；相同标准/产品的不同上游能力记录不会互相覆盖
- 纳入现有资质自动同步计划；任务中心会正确显示成功或失败
- 可按标准号、检测方法、产品或领域检索本地已同步能力；标准检索、LABR 和本地文件库会显示严格同年版的“国家 CMA”机构级徽章
- 场所级数据仅在获得官方稳定接口、授权 API 或人工验证会话后接入；不在服务器中运行验证码绕过逻辑

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
- PDF.js canvas 渲染（支持双指缩放/双击切换适配）
- 下拉刷新（搜索结果 + 文件库）
- 搜索首页提供最近搜索与常用标准号快捷入口
- 按设备记住检索来源、筛选、排序与显示密度
- 卡片化搜索结果显示
- 毛玻璃搜索栏吸顶

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

GitHub Actions 会同时发布 `latest`、`<版本号>`（例如 `1.3.7`）和 `v<版本号>` 镜像标签。NAS 日常可继续使用 `jzrm/stdhub:latest`；需要固定版本时改为 `jzrm/stdhub:1.3.7`。

### 免 Docker

```bash
bash deploy.sh
```

### Lucky 外网访问保护（建议）

1. 在 `.env.local` 设置一个随机的 `STDHUB_PROXY_TOKEN`。
2. 在 Lucky 对应的反向代理规则中，为请求添加 `X-StdHub-Proxy-Token: 同一个令牌`。
3. 仅向 Lucky 暴露站点；不要把 Docker 的 `3000` 端口直接映射到公网。

未配置该令牌时，应用保持原有的免登录管理员模式。

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | 3000 | 监听端口 |
| `STDHUB_PROXY_TOKEN` | 空（未启用） | 设置后要求 Lucky 注入 `X-StdHub-Proxy-Token` 请求头，阻止绕过反向代理的访问 |

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
├── docs/             # 文档
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

```bash
npm run dev          # 启动后端（端口 3000）
npm run build        # 编译 TypeScript
npm test             # 运行测试
```

## License

ISC

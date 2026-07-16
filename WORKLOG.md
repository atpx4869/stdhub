# StdHub 项目工作日志

## 项目概述

基于 bzxz（标准盒子）项目创建的新项目 **StdHub**，目标：
- Web 优先部署（NAS/服务器）
- 未来 iOS 端支持
- 去掉 Electron 桌面端
- 保留核心功能：标准检索、资质查询、CMA 一单一库

## 已完成的工作

### 1. 项目初始化
- 从 bzxz 复制到 `C:\Users\jzrm\Desktop\github项目\stdhub`
- 删除 Electron 相关文件（electron/、build/installer.nsh、tsconfig.electron.json）
- 更新 package.json（name: stdhub，移除 electron scripts）
- 初始化 git 仓库

### 2. 后端 Electron 残留清理
修改了 11 个文件，移除所有 BZXZ_ELECTRON/BZXZ_BASE_DIR/BZXZ_STATIC_DIR 等环境变量引用：
- `src/index.ts` - 移除代理绕过、PORT_FILE
- `src/shared/env-loader.ts` - 移除 Electron execPath 路径
- `src/shared/fs.ts` - 简化 getRootDir/getStaticDir
- `src/shared/log-buffer.ts` - 日志固定写 data/logs/
- `src/shared/library-paths.ts` - 简化路径回退链
- `src/shared/pdf-merge.ts` - 移除 asarUnpack 适配
- `src/services/db-backup.ts` - 备份目录固定 data/backups
- `src/services/usage-tracker.ts` - 移除 desktop client 检测
- `src/api/app.ts` - 统一 baseDir/staticDir
- `src/api/preview-routes.ts` - 删除 reveal 端点
- `src/sources/shared/captcha-ocr.ts` - 注释清理

### 3. 前端改造
- **恢复原版前端**：从 bzxz 完整复制 public/ 目录（15 个 JS 文件 + styles.css）
- **删除 React 前端**：web/ 目录（之前尝试过但放弃）
- **认证简化**：auth-routes.ts 直接返回 admin 用户，前端移除登录层
- **默认管理员身份**：app-auth-admin.js 简化，不再需要登录

### 4. UI 重构
- **底部 tabbar 扩展**：从 3 个（标准/资质/我）扩展到 4 个（搜索/资质/文件/我）
- **搜索结果卡片压缩**：手机端从 5 行压缩到 4 行（日期合并到状态行）
- **设置页重构**：
  - app-settings.js 从 1344 行精简到 ~460 行
  - 删除 Electron 专属区块（端口/开机自启/更新/代理）
  - 导航从左侧栏改为顶部横向 tab
  - 标准库设置合并到本地文件库页面
- **用户管理移除**：默认管理员身份，删除用户管理页面
- **资质查询子 tab**：重命名为"搜索/详细搜索/批量搜索"
- **CMA 一单一库子 tab**：拆分为"能力项目库搜索/机构维度比对/领域订阅与同步"
- **工具箱子 tab**：合并"标准查新/批量下载/标准补全"为三个可切换 tab
- **Labr 合并**：从独立 sidebar 合并到搜索页，作为可切换模式

### 5. CMA 能力项目库搜索
- 新增后端搜索 API：`GET /api/cma-diff/search`
- 新增前端搜索界面：关键词 + 领域筛选 + 结果表格 + 分页
- 搜索结果只显示标准号/检测方法/领域/备注（不显示状态，避免误导）

### 6. GBW 源优化
- **全局错误处理**：src/index.ts 添加 unhandledRejection/uncaughtException
- **超时保护**：给 GBW 适配器所有 pooledFetch 调用添加 timeoutMs（15-30 秒）
- **跳过验证码直接下载**：新增 autoDownloadDirect 方法，先尝试直接下载 PDF，失败再回退验证码流程
- **pdf-merge-worker 兼容**：getWorkerEntry 函数检查 .js 和 .ts 文件

### 7. 文档
- 更新 README.md（StdHub 版本）
- 更新 .env.example（移除 Electron 引用）
- 更新 GitHub Actions（移除 Electron 构建）
- 更新 docs/README.md
- 创建 WORKLOG.md（本文档）

## 已知问题

### GBW 源 502 错误
- 国标网（c.gb688.cn）上游服务器返回 502
- bzxz 和 stdhub 返回相同错误，确认是上游问题而非代码问题
- 已添加自动切源重试机制
- 已添加跳过验证码直接下载的测试方法

### pdf-merge-worker 警告
- tsx 模式下加载 .ts 文件时 Node.js 产生 MODULE_TYPELESS_PACKAGE_JSON 警告
- 功能正常，仅性能警告
- 消除方法：先 `npm run build` 再 `node dist/src/index.js`

## 启动方式

```bash
# 开发模式
npm run dev

# 生产模式
npm run build && node dist/src/index.js
```

服务启动后访问 http://localhost:3000

## 项目结构

```
stdhub/
├── src/              # 后端 TypeScript（已清理 Electron）
├── public/           # 原版前端（完整功能）
├── data/             # SQLite 数据库
├── standards/        # 本地标准 PDF 库
├── scripts/          # OCR 脚本 + oklch 工具
├── docs/             # 文档
├── Dockerfile        # Docker 部署
├── deploy.sh         # 部署脚本
└── WORKLOG.md        # 本文档
```

### 7. 手机端 PDF 预览修复（v1.1.5 ~ v1.1.6）
- **修复 devicePixelRatio 双重缩放 bug**：`_renderPage()` 中 `getViewport({ scale: this.scale * dpr })` 与 `ctx.scale(dpr)` 叠加，导致 canvas 实际渲染区域 = viewport × dpr²，超出 canvas 被裁剪，视觉上始终处于放大状态
- 改为标准 PDF.js HiDPI 渲染模式：viewport 仅用逻辑 scale，canvas 物理像素 = viewport × dpr，CSS 尺寸 = viewport，`ctx.scale(dpr)` 填满高 DPI canvas
- **默认全页显示**：fit 模式从 `width`（适宽）改为 `page`（适页），打开 PDF 时整页完整可见

### 8. 手机端预览优化（v1.1.7）
- **移除预览头部"下载"和"新标签"按钮**（手机端）：这两个功能在手机端本就无效，且手机端定位为"查阅"非"管理"
- **双指缩放手势流畅度优化**：捏合过程中改为 CSS `transform: scale()` 实时变换，松手后才触发一次 canvas 重渲染，避免 60fps 的重渲染开销造成卡顿

### 9. 关于页更新日志（v1.1.8）
- 更新日志从仅显示最新单条 release 改为**显示最近 8 条**，直接从 GitHub API 获取 `?per_page=8`，每条显示版本号、日期、内容（markdown 转 HTML）

### 10. 双指缩放后续修复（v1.1.9）
- **缩放后 placeholder 高度同步**：捏合时同步缩放 `placeholder.style.height`，避免 canvas 溢出/留白
- **放大后允许水平平移**：动态检测 canvas 宽度是否超过容器，超过则 `overflow-x: hidden` → `auto`，并加 `touch-action: pan-x pan-y`
- **触摸事件隔离**：`touchstart`/`touchmove` 统一 `e.preventDefault()`，防止事件穿透到底层页面触发下拉刷新/tab 切换
- **修复 passive listener 冲突**：`touchend` 移除无效的 `preventDefault()`（passive 监听器禁止）

### 11. 手机端 PDF 预览切换到 pdfh5（v1.2.0）
- **替换自研 PDFViewer**：手机端预览改用成熟的 pdfh5 库（v3.0.0，基于 PDF.js v5.4.296）
- 静态资源：`public/vendor/pdfh5/`（js/pdfh5.js + pdf.min.js + pdf.worker.min.js + cmaps/ + standard_fonts/ + iccs/ + wasm/，共 204 个文件，约 5MB）
- pdfh5 自带完善的手势缩放（双指 + 双击）、翻页、内存管理，解决了自研版本多轮迭代仍未完全稳定的问题
- 添加暗色主题适配样式：loadingBar / pageNum / backTop / pdfViewer 背景覆盖
- 保留自研 PDFViewer 代码（`app-pdf-viewer.js`），桌面端未受影响

### 12. pdfh5 黑屏修复（v1.2.1）
- **缺少 `pdf.sandbox.min.js`**：拷贝资源时遗漏，导致 `initPdfJs()` 抛异常，pdfh5 初始化完全失败
- **资源路径全部错位**：pdfh5 auto-detect 的相对路径（`./js/pdf.worker.min.js`、`../cmaps/` 等）基于页面 URL 解析而非 pdfh5.js 位置，全部指向错误目录。改为 `_previewMobile` 和 `openLocalPreview` 中显式传入绝对路径 `/vendor/pdfh5/js/...`
- **`viewerContainer` 高度为零**：缺少 `flex: 1; min-height: 0`，PDF 画布区域不占空间

### 13. 手机端下载改为 Blob 强制下载（v1.2.2）
- **问题**：移动浏览器（iOS Safari / 微信内置浏览器等）常忽略 `Content-Disposition: attachment`，将 PDF 内联打开
- **修复**：`triggerDownload()` 和 `downloadLocalFile()` 在 `window.isMobile()` 时改用 `fetch → Blob → URL.createObjectURL() → <a download>` 路径，绕过浏览器内联打开行为
- 新增通用函数 `forceDownloadBlob(url, fileName)` 在 `app-detail-utils.js` 中
- **`viewerContainer` 高度为零**：缺少 `flex: 1; min-height: 0`，PDF 画布区域不占空间

### 14. 统一任务中心（2026-07-11）
- 顶栏入口从“下载中心”升级为“任务中心”，继续复用原有下载任务与重试能力
- CMA 能力库同步轮询会写入实时阶段与完成统计；资质同步、标准查新导出、标准补全也会记录成功或失败状态
- 页面样式统一由 `pages.css` 提供，移动端沿用现有底部抽屉定位

### 15. 资质与 CMA 筛选优化（2026-07-11）
- 资质查询和详细搜索将 CNAS/CMA 来源保留在搜索框下方，高级抽屉用于调整单次返回数量
- CMA 能力项目库将领域筛选保留在搜索框旁，资料状态（现行有效/废止可引用/已废止）收进高级抽屉
- 抽屉在桌面居中显示、手机底部弹出；选中条件会在入口以数量徽标反馈，结果表同步展示资料状态

### 16. 移动端页头与状态色统一（2026-07-12）
- 资质、设置与“我”页改用统一页头结构；其他功能页复用同一套手机端标题与操作区排版
- 小屏下的页头操作支持横向滑动，避免 CMA、日志等多操作页面挤压标题
- 补全状态、任务中心、状态徽标和提示统一使用信息 / 成功 / 警告 / 失败语义色，并增加边框或底色辅助辨识

### 17. Web / 手机端体验优化（2026-07-12）
- **手机搜索快捷入口**：搜索空态显示最近 4 条搜索和 GB/T、GB、YY/T、JJG 模板；历史项可一键重新搜索。
- **下载全链路进度**：BZ 使用 SSE 的真实页数展示百分比；BY 等无总量来源只展示连接、下载、校验、入库等真实阶段。批量下载复用同一阶段流，任务中心保留失败重试。
- **搜索习惯**：按设备保存检索来源、结果筛选、排序和卡片密度；筛选栏可一键恢复默认。
- **跨设备收藏**：浏览器旧收藏首次自动合并到服务端“我的收藏”查新清单，其他设备会回填收藏状态；分组、备注、下载记录继续本地保留。
- **文件库效率**：新增最近 30 天、重复标准、来源、年份快捷筛选，不影响原有搜索、分页和批量管理。

### 18. 文件库版本管理、CMA 状态色与镜像标签（2026-07-13）
- **本地文件库版本管理**：多版本或多来源标准改为“标准系列父行 + 可展开版本列表”；后端分页按标准系列计算，避免同一标准被拆到不同页面；单版本仍保持普通文件行。
- **一单一库状态色**：国家 CMA 能力库徽章和比对页状态文字统一使用高对比状态谱：在库青绿、可引用靛紫、已废止琥珀、年版过期玫红、未入库红色；浅色、Paper、深色与经典主题均有对应前景色。
- **Docker 发布修复**：GitHub Actions 读取 `package.json` 版本，镜像同时发布 `latest`、`<版本号>` 与 `v<版本号>` 标签；已验证 `latest`、`1.3.7`、`v1.3.7` 指向同一镜像摘要。

## 下次继续的方向

1. **GBW 502 问题**：等上游恢复，或继续优化自动切源逻辑
2. **手机端进一步优化**：底部 tabbar 功能完善、触控交互优化
4. **功能完善**：根据用户反馈继续迭代

### 2026-07-16：国家 CMA 订阅可靠性重构（后续发现数据源接线错误，已停用）
- 抽出 `NatCmaService`，将内置机构、订阅、进度与缓存迁出路由；同一证书的多个场所共用一个同步锁，避免并发重复抓取与互相覆盖。
- 能力数据改为按机构证书原子替换，使用上游唯一源标识保存记录；场所订阅不再复制同一批能力数据。
- 接入自动同步调度与任务中心失败反馈；页面总数改按机构去重，并明确展示为“机构级能力条目”。
- 保留 Python 场所抓取脚本仅供离线研究；线上不运行滑块验证码绕过逻辑。
- 新增 `NatCmaService` 回归测试：多场所去重抓取、并发锁、最后取消订阅后清除缓存。

### 2026-07-16：国家 CMA 检索与标准匹配（后续发现数据源接线错误，已暂停）
- 增加本地机构级能力检索接口：支持标准号、方法、产品、领域关键词与分页。
- 能力表新增标准号归一化索引；国家 CMA 徽章采用严格同号同年匹配。
- 标准检索、LABR、本地文件库、资质查询结果接入“国家 CMA”徽章，悬浮提示明确数据为机构级，避免误读为场所独立资质。

### 2026-07-16：国家 CMA 来源核对与纠正
- 已确认先前“真实抓取验证”误用了 CMA 实验室公共查询源 `223.75.53.51:81`，该结果不能代表国家 CMA（`cma.cnca.cn`）。
- 项目中的 `scripts/cma_search.py` / `scripts/cma_fetch_place.py` 才指向 `https://cma.cnca.cn/cma`；它们尚未作为线上服务提供者接入。
- 已隔离错误接线：默认国家 CMA 服务不再调用 CMA 实验室来源，缓存不再参与国家 CMA 搜索、徽章或计数，设置页显示“真实数据源待接入”。
- 后续先实现真实国家 CMA 的合规只读提供者与验证，再恢复同步、检索和匹配功能。

### 2026-07-16：国家 CMA 公开入口只读验证
- 对 `https://cma.cnca.cn/cma/solr/tBzAbilitySearch/list` 做只读请求，返回 HTTP 200、`Content-Type: text/html;charset=UTF-8`，并下发 `JSESSIONID`，确认国家 CMA 公共检索入口与会话建立正常。
- 未请求滑块验证码端点、未使用或接入验证码绕过逻辑、未抓取场所/能力数据、未写入数据库。
- 代码审查确认：场所与能力请求必须带经滑块验证获得的 `finalX`；因此当前仅完成可达性验证，真实字段与分页验证等待授权 API 或人工验证会话方案。

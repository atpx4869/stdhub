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

## 下次继续的方向

1. **GBW 502 问题**：等上游恢复，或继续优化自动切源逻辑
2. **手机端进一步优化**：底部 tabbar 功能完善、触控交互优化
3. **iOS 端**：考虑用 Capacitor 包装 Web 前端
4. **功能完善**：根据用户反馈继续迭代

# StdHub 待办事项

## 版本记录

| 版本 | 日期 | 主要变更 |
|------|------|----------|
| v1.1.0 | 2026-07-06 | GBW 新上游适配、手机端交互优化、统计/日志内容增强、Docker 部署、版本号显示 |
| v1.0.0 | 2026-07-05 | 初始版本（从 bzxz 迁移） |

## 已完成

- [x] 项目初始化（从 bzxz 复制）
- [x] Electron 残留清理
- [x] 认证简化（默认管理员）
- [x] UI 重构（tabbar/搜索卡片/设置页）
- [x] CMA 能力项目库搜索
- [x] GBW 超时保护 + 全局错误处理
- [x] pdf-merge-worker 兼容修复
- [x] 下载自动切源重试
- [x] BW 源下载日志增强（showGb/gc/verifyCode/viewGb 全链路）
- [x] OCR worker Python 路径修复（优先 py -3.11）
- [x] GBW showGb/viewGb 重定向跟随修复
- [x] GBW 域名迁移（c.gb688.cn → openstd.samr.gov.cn，/bzgk/gb/ → /bzgk/std/）
- [x] GBW 新下载流程适配（newGbInfo 建立会话 → showGb 浏览器头 → 解析 isValid → 直接下载或验证码）
- [x] 手机端"我"页功能扩展（工具箱/CMA/日志/统计/设置入口）
- [x] 资质搜索结果手机端紧凑布局（category + testItem 合并一行）
- [x] 文件库手机端卡片布局（表格转卡片，仅显示预览+下载）
- [x] 文件库桌面端标准号+名称合并显示
- [x] 库配置移至系统设置新子 tab
- [x] BZ 适配器优化：并发下载容错（retry + skip）、搜索缓存 5min TTL、哨兵指纹替代 SHA-256
- [x] searchByStandard N+1 查询批量化（500次 → 2次）
- [x] queryBatched 串行改并发（2x 提速）
- [x] GBW 验证码流程调研 — isValid='true' 的标准不需要验证码，直接下载正常
- [x] 手机端下拉刷新（搜索结果 + 文件库）
- [x] CMA 一单一库机构详情手机端卡片化
- [x] 设置页诊断面板手机端全屏
- [x] 使用统计增强（来源成功率、热门标准 Top10、源健康看板、成功率指标）
- [x] 运行日志增强（今日概览条、错误聚合、快捷筛选、自动刷新、搜索高亮、后端来源标签）
- [x] 侧边栏重新排序（标准检索→资质→CMA→文件库→下载历史→日志→统计→设置）
- [x] Express trust proxy 支持反代部署
- [x] Docker 部署（Dockerfile + docker-compose + GitHub Actions 自动构建）
- [x] 版本号显示（"我"页底部 + /api/health）
- [x] index.html UTF-8 编码损坏修复（PowerShell 事故）

## 待办

### 中优先级
- [ ] 前端 JS 拆分（app-search.js 76KB、app-detail-utils.js 69KB）

#### 低优先级
- [ ] iOS 端 Capacitor 包装
- [ ] CSS 按页面懒加载（当前 340KB 全量加载）
- [ ] SSO 集成方案（登录页 Mockup 设计待确定：双栏布局/单栏简洁版/暂不实现）

## 已知问题

- **GBW 源已适配新上游**：域名 `c.gb688.cn` → `openstd.samr.gov.cn`，路径 `/bzgk/gb/` → `/bzgk/std/`。isValid='true' 的标准可直接下载，无需验证码。
- pdf-merge-worker 警告：tsx 模式下 Node.js 产生 MODULE_TYPELESS_PACKAGE_JSON 警告（功能正常）
- onnxruntime 1.27.0 在 Python 3.14 上 DLL 加载失败，已降级到 1.19.0 + Python 3.11 解决

## 部署信息

- **GitHub**: https://github.com/atpx4869/stdhub
- **Docker Hub**: `jzrm/stdhub:latest`
- **GitHub Actions**: push to main 自动构建 Docker 镜像
- **NAS 部署**: Docker Compose 拉取 jzrm/stdhub:latest，端口 3000

## 事故记录

### 2026-07-06 index.html 编码损坏事件
- **原因**：PowerShell `Set-Content -Raw` 和 `-replace` 破坏 UTF-8 编码
- **修复**：手动重写整个 index.html
- **教训**：永远不用 PowerShell 修改含中文的 UTF-8 文件，用 Node.js fs.writeFileSync 或 VS Code

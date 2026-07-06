# StdHub 待办事项

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

## 待办

### 高优先级
- [x] GBW 验证码流程调研 — isValid='true' 的标准不需要验证码，直接下载流程正常；verifyCode 的 "error" 对这些标准无影响

### 中优先级
- [x] 手机端触控交互优化（下拉刷新：搜索结果 + 文件库）
- [x] CMA 一单一库机构详情手机端表格改卡片
- [x] 设置页诊断面板手机端全屏
- [ ] 前端 JS 拆分（app-search.js 76KB、app-detail-utils.js 69KB）

### 低优先级
- [ ] iOS 端 Capacitor 包装
- [ ] Docker 部署测试
- [ ] CSS 按页面懒加载（当前 334KB 全量加载）

## 已知问题

- **GBW 源已适配新上游**：域名 `c.gb688.cn` → `openstd.samr.gov.cn`，路径 `/bzgk/gb/` → `/bzgk/std/`。新流程需先访问 newGbInfo 建立会话，再用浏览器头获取 showGb 页面。部分标准 isValid='true' 可直接下载，部分需验证码。BZ/BY/Labr 源不受影响。
- **GBW verifyCode 返回 "error"**：OCR 正确识别验证码（100% 置信度），但 GBW 服务器拒绝验证。可能与 session 状态或请求头有关，待进一步排查。
- pdf-merge-worker 警告：tsx 模式下 Node.js 产生 MODULE_TYPELESS_PACKAGE_JSON 警告（功能正常）
- onnxruntime 1.27.0 在 Python 3.14 上 DLL 加载失败（WinError 1114），已降级到 1.19.0 + Python 3.11 解决

## 事故记录

### 2026-07-06 index.html 编码损坏事件
- **原因**：使用 PowerShell `Set-Content -Raw` 和 `-replace` 操作修改 index.html，PowerShell 默认用 ASCII/UTF-16 编码写入，破坏了文件的 UTF-8 编码，导致所有中文字符变成 `?`（替换字符）。同时 `-replace` 操作破坏了 script 标签的闭合语法。
- **影响**：界面显示乱码、所有功能失效
- **修复**：手动重写整个 index.html（825行），从头重建所有中文文本
- **教训**：**永远不要用 PowerShell 的 Set-Content / -replace 修改包含中文的 UTF-8 文件**。应使用 Node.js 的 fs.writeFileSync（指定 utf8 编码）或 VS Code 编辑器进行修改。涉及 HTML/CSS/JS 文件的批量修改必须用 Node.js 脚本处理。

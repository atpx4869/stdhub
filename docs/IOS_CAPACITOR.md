# iOS Capacitor 包装指南

## 目标与边界

标准盒子 iOS App 采用“**内置前端 + 在线服务端**”模式：Capacitor 只封装 `public/` 前端，搜索、资质、CMA、PDF、文件库、SQLite 与下载任务仍由现有 Express 服务端处理。

不要尝试在 iPhone 中运行 Node.js、Express、SQLite 或爬取程序。

## 已完成的 Windows 预备工作

- 前端支持运行时 API 地址：网页默认同源；iOS 同步时使用 `STDHUB_IOS_API_BASE` 注入 HTTPS 服务端地址。
- 相对 `/api/` 请求、文件库预览/下载 URL 和下载任务 SSE 已适配远程 API。
- API 跨域默认关闭；服务端只接受 `BZXZ_CORS_ORIGINS` 中明确列出的来源。
- 已加入 Capacitor 依赖、`capacitor.config.ts` 和 npm 脚本；尚未创建 `ios/` 目录。

## 服务器前置条件

在服务器的 `.env.local` 中配置（不要提交）：

```env
BZXZ_CORS_ORIGINS=capacitor://localhost
```

iPhone 必须能访问 `STDHUB_IOS_API_BASE` 指向的 **HTTPS** 服务地址。当前认证处于默认管理员直通模式；若未来重新启用登录认证，还需：

```env
BZXZ_COOKIE_CROSS_SITE=1
BZXZ_COOKIE_SECURE=1
```

重启服务器后配置生效。

## 在 MacBook Pro 2019 上操作

### 1. 准备环境

- 更新 macOS，安装兼容的 Xcode，并至少打开一次接受许可。
- 安装 Node.js 20 或更高版本，并确认 `node -v`、`npm -v` 可用。
- 登录 Apple ID；连接 iPhone 后，在设备上选择“信任此电脑”。
- 如 `cap sync ios` 提示 CocoaPods 缺失，再安装 CocoaPods。

### 2. 获取项目

```bash
git clone <你的 GitHub 仓库地址>
cd stdhub
npm ci
npm run build
```

如在 Mac 上启动本地服务端测试，再复制 `.env.example` 为 `.env.local` 并填写所需上游账号；仅做 iOS 壳工程时不需要复制 NAS 的数据库或标准 PDF。

### 3. 创建 iOS 原生工程（只执行一次）

```bash
npm run cap:doctor
npm run cap:ios:add
```

这一步会生成 `ios/` 目录；该目录应提交到 Git，便于后续在不同 Mac 上继续开发。

### 4. 同步前端并打开 Xcode

将下方示例域名替换为你的真实 HTTPS 服务端地址：

```bash
STDHUB_IOS_API_BASE=https://standards.example.com npm run cap:ios:check
STDHUB_IOS_API_BASE=https://standards.example.com npm run cap:ios:sync
npm run cap:ios:open
```

`cap:ios:sync` 会临时写入 iOS 打包用 API 地址、执行同步，然后自动恢复仓库中的默认 `public/js/runtime-config.js`，避免把服务器地址误提交到 Git。

### 5. 在 Xcode 中运行

1. 在左上角选择已连接的 iPhone（不要选 Generic Device）。
2. 在 Signing & Capabilities 选择你的 Team；如 Bundle Identifier 冲突，修改 `capacitor.config.ts` 的 `appId` 后重新同步。
3. 点击运行按钮，首次在 iPhone 的“设置 → 通用 → VPN 与设备管理”中信任开发者证书。
4. 按下面清单逐项测试。

## 首轮真机测试清单

- [ ] App 能打开且可以访问服务端。
- [ ] 标准搜索、资质查询、CMA 能力库查询可用。
- [ ] PDF 预览可用。
- [ ] 文件上传与标准补全可用。
- [ ] 下载、导出、下载任务进度可用。
- [ ] 切换 Wi-Fi / 蜂窝网络后有合理反馈。
- [ ] 横竖屏、安全区、深色 / 浅色主题正常。

## 已知后续事项

- 系统浏览器打开的远程下载链接未必继承 App 登录态；真机验证后，必要时接入 Capacitor Filesystem / Share。
- 当前阶段不包含离线搜索、离线 SQLite、推送通知或 App Store 发布。
- 每完成一个阶段，同步更新根目录 `TODO.md` 的 iOS 流程表和本文件。

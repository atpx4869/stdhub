# StdHub 协作约定

## 开工前

1. 阅读 `README.md`、`TODO.md`、`docs/PRODUCT_STATUS.md` 和直接相关的 ADR。
2. 先看 `git status --short`；保留所有不属于当前任务的修改。
3. 涉及数据库、迁移或文件库批量操作前，用 SQLite backup API 备份 `data/bzxz.db`，并确认 `PRAGMA integrity_check` 为 `ok`。

## 产品边界

- 产品是单实例 NAS Web 应用：游客可检索、查看公开资质并预览已入库标准；管理员负责下载入库、同步、导出、文件管理和设置。
- 初始管理员是 `admin / adminadmin`；首次登录后必须修改密码。已存在管理员时启动不得覆盖密码。
- 国家 CMA 数据源无限期暂停。没有新 ADR、合规数据入口、place_id 建模和完整测试门禁，不得恢复 Provider、同步、调度或徽章。
- `AdapterSourceName` 仅为 `bz | gbw | by`；`labr` 是独立远程补给源；`bd` 仅表示本地导入。

## 实现约定

- JSON API 使用 `{ data, error }` 响应壳；文件流和静态资源除外。
- 环境变量统一经 `src/config.ts` 读取与校验。
- 前端新增代码挂在 `window.StdHub`，请求使用 `StdHub.api`，生命周期资源注册到 `StdHub.lifecycle`；不得新增 inline handler。
- 文件系统与数据库同时变化时必须提供补偿或 reconciliation，不能留下“磁盘成功、索引失败”的半状态。
- 运行时数据库、标准文件、导出、备份、预览缓存和凭据不得提交。

## 交付检查

依次运行 `npm run build`、`npm run css:check`、`npm test`、`npm run test:e2e` 和 `git diff --check`。发布只能手动触发 Release 工作流；候选版本通过测试、容器冒烟和 HIGH/CRITICAL 漏洞扫描后才能打标签。

# 测试指南

## 本地检查

```bash
npm ci
npm run build
npm run css:check
npm test
npx playwright install chromium
npm run test:e2e
git diff --check
```

Vitest 使用临时 SQLite 数据库和临时目录，不应修改 `data/`。Chromium E2E 由 `e2e/server.ts` 启动隔离数据库，覆盖游客首页、管理员边界和默认管理员登录。需要调试浏览器时运行 `npx playwright test --headed`。

## 重点回归

- 认证：新库可用 `admin / adminadmin` 登录，已有管理员密码不被覆盖，游客不能调用管理 API。
- 游客标准访问：可搜索、查看详情和预览，并可从搜索列表或详情下载公开标准 PDF；下载资格只看“有文本”，废止状态只作提示、不禁用下载。游客不能使用 Labr、工具箱批量下载、同步、文件库增删改、重试或重命名等管理能力。
- 文件库：新增、移动、重命名、删除的文件和索引一致；故障注入后能补偿恢复。
- 下载：直接下载、预览自动入库和导出任务共享统一编排，取消与复用语义一致。
- 国家 CMA：健康状态为 `suspended/readOnly`，生产不得装配可写 Provider。

## CI 门禁

PR 和主分支运行 TypeScript 构建、CSS 入口检查、Vitest、Chromium E2E、CodeQL 和 Trivy。发布工作流还会构建真实 Docker 镜像、启动容器并请求 `/api/health`；Trivy 的 HIGH/CRITICAL 结果会阻断发布。

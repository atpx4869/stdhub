# StdHub 架构

> 更新于 2026-09-08。本文描述当前 NAS Web 产品，不包含已移除的 Electron/PDFH5 架构。

## 运行结构

```
浏览器/PWA
  └─ Express API 与静态资源
      ├─ 标准适配器：BZ / GBW / BY
      ├─ 独立来源：Labr
      ├─ 业务服务：资质、CMA 一单一库、查新、预览、文件库
      ├─ SQLite：data/bzxz.db
      └─ 标准库与派生预览：standards/ + data/preview-cache/
```

`src/api/app.ts` 只负责装配。下载文件路由在 `download-routes.ts`，健康与诊断在 `diagnostics-routes.ts`，timer/watcher/自动同步的启动停止在 `app-background-runtime.ts`。所有长期资源最终由 `app.shutdown()` 关闭。

## API 与权限

JSON API 统一返回 `{ data, error }`；PDF、图片和静态文件是流响应例外。请求先经过反向代理令牌边界、身份附加和同源/CSRF 检查。

- 游客：标准检索、详情、公共资质/CMA 查询、标准预览，以及从搜索列表或详情下载公开标准 PDF。
- 管理员：除游客能力外，还可使用 Labr、工具箱批量下载、同步、导出、文件管理、日志和设置。
- 游客单条下载可调用公共来源下载链路；任务状态、SSE 进度和取消仅对该任务订阅者开放。

## 来源模型

- `AdapterSourceName = bz | gbw | by`：实现统一 `SourceAdapter`，可进入检索解析和下载编排。
- `RemoteSourceName` 额外包含 `labr`：Labr 契约与额度模型不同，使用独立 service。
- `LibrarySourceName` 再包含 `bd`：表示本地导入，只参与文件库索引。

国家 CMA Provider 在生产装配中固定为 unavailable；恢复必须遵守 ADR 0001。

## 数据与一致性

SQLite 是元数据事实来源，标准 PDF 位于配置的库目录。跨数据库/文件系统操作采用补偿：数据库失败时恢复已移动或已重命名文件；删除先改名为墓碑、提交索引删除后再清理，启动扫描只清理超过安全时间的合法墓碑。

数据库 schema 初始化和版本迁移必须幂等并记录 `schema_migrations`。涉及真实数据库前先使用 SQLite backup API 备份并执行完整性检查。运行时数据库、WAL、标准文件、导出、预览缓存与备份不进入 Git。

## 前端

页面目前为渐进式模块化的经典脚本。共享能力集中在 `window.StdHub`：

- `api`：同源凭据、统一响应壳与错误。
- `dom/ui/modal`：安全文本、状态和弹窗。
- `lifecycle`：切页和卸载清理。
- `assets`：版本化按需脚本加载。

服务端向 HTML 注入唯一资源版本，Service Worker 使用同一版本隔离缓存。Chart.js 仅进入统计页时加载；PDF 预览使用服务端生成的 WebP 分页图，不再在浏览器内加载 PDF.js/PDFH5。

## 配置与部署

环境变量全部通过 `src/config.ts` 的 Zod schema 校验。业务策略和跨设备设置存 SQLite；浏览器显示偏好存 localStorage；秘密只通过环境或 `.env.local` 注入。

生产镜像以非 root 用户运行。正式发布由手动工作流发起，只有构建、单元/集成测试、Chromium E2E、Docker 启动冒烟和 HIGH/CRITICAL 漏洞扫描通过后才创建版本与 Release。

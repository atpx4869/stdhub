# by 源实现文档

## 概述

by 源通过内网包装 API 检索和下载标准，不再登录或解析 ASP.NET 页面。

- 默认入口：`https://by.917520.xyz`（隧道地址可变，用 `BY_API_URL` 覆盖）
- 鉴权：请求头 `X-Token`，不要把 token 放进查询参数或日志
- 程序内只保留来源简写 BY，不暴露上游系统名称或内网地址

## 关键配置

凭据一律从 `.env.local`（或真实环境变量）注入，**禁止写死进仓库/文档**：

| 环境变量 | 必填 | 说明 |
|----------|------|------|
| `BY_API_TOKEN` | ✅ | 包装 API 的访问令牌 |
| `BY_API_URL` | 可选 | API 根地址，默认 `https://by.917520.xyz`，不要带尾斜杠 |
| `BY_API_MAX_PAGES` | 可选 | 交互检索最多翻页数，默认 `5`，范围 1–50。不要对交互搜索使用 `pages=all` |

已废弃且不再读取：`BY_USERNAME` / `BY_PASSWORD` / `BY_DEPT_ID` / `BY_BASE_URL`。

## 接口约定

- `GET /api/health`：无需 token，用于源可用性
- `GET /api/search`：`code` 或 `name` 二选一，加上 `pages`（数字）。无结果返回 HTTP 200 且 `count=0`
- `GET /api/pdf?sid=`：必须先对同一会话搜索过该标准，否则 `400 NO_PDF`
- `POST /api/batch` 与 ZIP 下载接口本程序不使用

查询分类：标准号形态（如 `18584-2024`、`GB/T 10004`）走 `code`，其余走 `name`。

## 下载

1. 用缓存中的标准号再搜一次，给包装层建立 PDF 会话
2. `GET /api/pdf?sid=` 取字节
3. `assertDownloadedPdf` 校验 `%PDF-` 头后再写入导出目录
4. 若返回 `NO_PDF`，再搜索一次后重试一回

详情页不再指向内网 ASP.NET `StandDetail`；`detailUrl` 为空，预览走程序内 PDF 下载。

## 错误处理

- 网络失败、HTTP 5xx、401 均抛 `UpstreamError`，不再吞成空数组
- 401 / `UNAUTHORIZED` 提示检查 `BY_API_TOKEN`
- 详情或下载时缓存没有该 `sid`：要求用户重新搜索，不再用第一条结果顶替

## 部署

Compose 继续通过宿主机 `env_file` 注入 `.env.local`。不要把 `.env.local` bind mount 到 `/app/.env.local`。
排障只看 `docker compose config` 是否识别变量名、以及 `docker logs` 的配置提示；输出不得包含 token。

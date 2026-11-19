# SBY API

SBY 是独立检索源，只接 std 的 `/stage-api`。不要把它当成 BY，也不要复用 BZ 的 gxzl。

## 配置

- `SBY_BASE_URL` 默认 `https://std.hbsqi.com`
- `SBY_MAX_PAGES` 默认 `5`

界面标签固定为 SBY，不要显示上游站点名。

## 协议

- 列表：`POST /stage-api/title/std/indexList`，JSON `{ pageNum, pageSize, keyword }`。`keyword` 这个键必须在，空检索也要带空字符串。
- 行数组优先读 `rows`，不要用 `records`。
- 详情：`GET /stage-api/title/std/info/:id`。缓存未命中且详情失败时，不要回退到搜索第一条。
- 下载：`POST /stage-api/title/std/stdDownload`，JSON `{ id }`。
- 全文只看 `b000`。`a305` 页数或 `structuration` 都不能单独当作有文本。
- HTTP 200 但 body 是 JSON，视为无电子件，不要当 PDF。
- 网络错误要抛出，不要吞成空结果。

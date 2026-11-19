# SBY API

SBY 是独立检索源，只接 std 的 `/stage-api`。不要把它当成 BY，也不要复用 BZ 的 gxzl。

## 配置

- `SBY_BASE_URL` 默认 `https://std.hbsqi.com`
- `SBY_MAX_PAGES` 默认 `5`

界面标签固定为 SBY，不要显示上游站点名。

## 协议

- 列表：`POST /stage-api/title/std/indexList`，JSON `{ pageNum, pageSize, keyword }`。`keyword` 这个键必须在，空检索也要带空字符串。
- 行数组优先读 `rows`，不要用 `records`。
- 详情：`GET /stage-api/title/std/info/:id`。列表里的 `b000` 经常是 `null`，详情和导出必须再打 info，不要用搜索缓存直接当无电子件。详情失败时不要回退到搜索第一条。
- 下载：`POST /stage-api/title/std/stdDownload`，JSON `{ id }`。
- 全文只看 `b000`。`a305` 页数或 `structuration` 都不能单独当作有文本。
- HTTP 200 但 body 是 JSON，视为无电子件，不要当 PDF。
- 网络错误要抛出，不要吞成空结果。

## 交互检索时间预算

- 搜索直接查询列表，不先串行执行空关键词健康检查；独立健康检查仍保留。
- 整次搜索最多 10 秒，调用方指定更短预算时遵守；单次请求不做自动重试，预算同时覆盖响应体读取。
- 已拿到前页结果后，后续页等待有更短上限；慢页或总预算耗尽返回已收到的结果。当前数组返回契约不提供完整性标志，检索结果不能作为全量统计使用。首轮失败仍报错，显式取消不返回部分成功。
- 浏览器对 SBY 使用 12 秒截止时间，留出网络传输余量，其它源原 6 秒不变。这是有界等待，不保证上游始终能在预算内响应。

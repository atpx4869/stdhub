# Doc88 文库

标准检索下的第三个管理员子 Tab：**标准检索 | Labr 补给 | Doc88 文库**。

## 使用流程

1. 输入标准号或关键词搜索 PDF；页数和上传日期来自各条原始搜索结果，不推测标准发布日期。
2. 点「生成 PDF」，确认/修改标准号与标准名称。无法可靠识别标准号时必须手填。
3. 后台全局单并发渲染，文档间隔至少 2 秒。进度阶段：打开阅读器→逐页渲染→合成→入库。
4. 完成后可直接下载、本地预览、重命名。入库使用现有命名模板，来源后缀为 `D88`。
5. 排队或渲染任务可取消；进入原子入库阶段后不可取消。服务重启的未完成任务标记中断，不悄悄补跑。

Doc88 产物为**逐页渲染的位图 PDF**，不是原始矢量/文本文件，没有文本层。仅用于有权访问的文档备份，不自动定时抓取，不做 OCR，不加入 BZ/GBW/BY 下载回退。

## 配置

仅由运行环境提供 Cookie：

```env
DOC88_COOKIE_FILE=/app/data/secrets/doc88-cookie.txt
DOC88_PAGE_TIMEOUT_MS=30000
DOC88_QUEUE_LIMIT=8
DOC88_SCALE=2
```

也可通过 `DOC88_COOKIE` 提供 Cookie，优先于文件。程序**没有默认 cookie.txt 回退**。文件建议以只读 secret 挂载，并限制读取权限。不得放入 Git、镜像、日志或 API 返回值。修改容器环境须重新创建容器，单纯 `docker restart` 不会更换镜像或环境配置。

依赖复用 StdHub Playwright Chromium，Docker 安装 Noto CJK/emoji 字体与 Poppler。生成完成后通过 PDF magic、大小及 `pdfinfo` 实际页数校验，缺页文档不入库。

## 技术契约

- Chrome 71 UA；`cdb_IMGR=1` / `cdb_H5R=1`。
- `Viewer` 可为全局词法绑定，不能仅查 `window.Viewer`。
- 逐页滚进视口，单次 evaluate 返回简单值/字符串。PNG≥35000 bytes 为原包的已渲染判据，不随意替换为 RGB/alpha 判断。
- 保留原包阅读器设置和建页方法；服务器完全限制的文档无法完整生成。
- `.pg` 固定宽高和 `overflow:hidden` + `preferCSSPageSize:true`，本地相对图片路径。
- 搜索实际每页通常 10 条；`hasMore` 解析上游分页链接，不按期望条数猜测。
- 同 pcode 的活跃任务幂等；已有相同标准号/年份的 Doc88 库文件复用，不覆盖其它来源。
- Cookie 原文及浏览器错误原文不写入持久任务错误。

## 接口

管理员限定；响应沿用 `{data,error}`。

- `GET /api/doc88/search?keyword=...&page=1&pageSize=20`
- `GET /api/doc88/health`（仅配置状态，非凭据有效性保证）
- `POST /api/doc88/tasks`：`{pcode,title,standardNumber,cleanTitle}`，202
- `GET /api/doc88/tasks`（本人最近 50 项，刷新恢复）
- `GET /api/doc88/tasks/:taskId`
- `GET /api/doc88/tasks/:taskId/stream`（SSE）
- `POST /api/doc88/tasks/:taskId/cancel`

SQLite `doc88_tasks` 记录进度/终态/文件 ID；本地文件仍由统一 `standard_files` 管理。重命名后的文件名从文件库实时读取。

## 已验证与边界

自动测试不使用上传包的真实 cookie.txt。受凭据上游下载需要部署环境配置有效 Cookie，并对有权获取的文档实测。接口逆向依赖站点实现，站点改版可能导致渲染失败；失败任务会明确终止，不输出缺页成品。

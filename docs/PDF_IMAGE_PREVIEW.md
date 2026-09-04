# PDF 分页图片预览

## 当前方案

StdHub 不再在应用内使用 PDF.js、Canvas 或 pdfh5 解析 PDF。搜索结果、本地文件库和多来源切换统一打开分页图片阅读器；原始 PDF 仅通过明确的“查看原始 PDF”和“下载 PDF”链接交给浏览器处理，两个链接都在新标签页打开。

1. PDF 入库后，文件库事件将 `fileId` 放入低并发队列；老文件在启动时补排队，首次打开也会兜底触发。
2. BZ 来源直接复用下载阶段的逐页 JPEG；其他来源用 Poppler 的 `pdfinfo` 获取页数，再由 `pdftoppm` 单页栅格化。
3. `sharp` 将页面限制在 1800×2600 内并编码为质量 88 的 WebP。每完成一页就更新 manifest，前端可立即展示。
4. 阅读器用 `IntersectionObserver` 只加载视口前后约两页，并卸载距离当前页超过六页的图片。

## 缓存与恢复

缓存位于 `data/preview-cache/<fileId>/`：`manifest.json` 保存 SHA-256、源指纹、状态、页数、尺寸、错误和生成器版本；页面命名为 `0001.webp`、`0002.webp`。临时文件先写入同目录再重命名，避免读取半页。

源 PDF 内容哈希改变、文件被替换或生成器版本改变时缓存自动失效。删除文件库记录时同步删除缓存。启动时删除孤儿目录、超过 24 小时的临时文件及超过 7 天的失败缓存，并重新排队未完成文件。任务按 `fileId` 去重，默认只运行一个转换；关闭应用时中止并等待活动任务。

## API

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/files/:id/preview/manifest` | 查询进度、页面元数据和原始文件链接；首次访问触发生成 |
| GET | `/api/files/:id/preview/pages/:page` | 获取单页 WebP；未完成返回 425，越界返回 416 |
| POST | `/api/files/:id/preview/generate` | 确保任务已排队 |
| POST | `/api/files/:id/preview/retry` | 清理失败缓存并重新生成 |
| GET | `/api/files/:id/pdf/view` | 内联打开原始 PDF，支持 ETag 和单段 Range |
| GET | `/api/files/:id/pdf/download` | 下载原始 PDF，支持 UTF-8 文件名、ETag 和单段 Range |

旧 `/api/preview/file/:id` 暂时保留为兼容端点，新代码不得继续引用。

## 部署与资源限制

运行时依赖 `poppler-utils` 和 `sharp`。Dockerfile 使用 Debian 多架构 Poppler 包，可用于 amd64/arm64；`data` 卷必须可写并持久化。

| 变量 | 默认值 | 说明 |
|---|---:|---|
| `STDHUB_PREVIEW_CONCURRENCY` | `1` | 同时转换数，代码限制 1–4 |
| `STDHUB_PREVIEW_WIDTH` | `1800` | 输出宽度上限 |
| `STDHUB_PREVIEW_MAX_HEIGHT` | `2600` | 输出高度及栅格上限 |
| `STDHUB_PREVIEW_QUALITY` | `88` | WebP 质量 |
| `STDHUB_PREVIEW_TIMEOUT_MS` | `120000` | 单个外部命令超时 |
| `STDHUB_PREVIEW_MIN_FREE_MB` | `256` | 每页前要求的最小可用空间 |

Compose 默认限制为 1.5 CPU、1536 MB 内存和 512 MB `/tmp`；持久输出不写 `/tmp`。

## 失败、回滚与限制

加密/损坏 PDF、缺少 Poppler、超时、异常大页面、磁盘不足和源文件消失都会写入可读失败状态，不会使服务退出。用户可重试，也始终可查看或下载仍存在的原始 PDF。

紧急回滚时，保留 `standard_files` 与原始 PDF，回退应用镜像/代码版本，并删除 `data/preview-cache` 即可。该目录只有派生文件；不要删除 `data/bzxz.db` 或标准库。旧 PDF.js/pdfh5 资源已移除，回滚到旧前端必须同时使用包含它们的旧镜像。

当前仅支持 PDF；原始流只支持单段 Range；密码保护 PDF 不尝试破解。非 Docker 部署需自行安装 Poppler，并保证 `pdfinfo`、`pdftoppm` 在 `PATH` 中。

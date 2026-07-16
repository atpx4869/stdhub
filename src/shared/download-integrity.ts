// 下载完整性校验 —— 防 0KB / 错误页 / 截断响应 写入磁盘。
//
// 背景：gbw 偶发上游返回 200 + content-type=pdf 但 body 几乎为空（验证码通过后 viewGb 的
// race / CDN 304 转 200 等场景），不校验就把 0KB pdf 入库；其他源同链路同问题、概率低。
//
// 三层防御：
//   Layer 1 —— 各 adapter writeFile 之前调本模块（最早 / 最便宜，在 buffer 上判定）
//   Layer 2 —— addFileToLibrary 入库前 fs.stat 兜底（漏改 adapter 也拦得住）
//   Layer 3 —— moveDownloadToLibrary 入口检查 result.fileSize（省一次 IO）
//
// 抛错走 UpstreamError 是为了 gbw autoDownloadInner 的 OCR 重试循环天然能 catch + 重试，
// 不需要改重试代码。其他源会冒到 API 响应给前端弹错。

import { UpstreamError } from './errors';

/**
 * 最小合法 PDF 阈值。1024B 留余量：
 * - 拦 0KB / 错误页 HTML 残骸（几十~几百字节）
 * - 不误伤极小标准（gbw/by 单页起步 5KB+，标准 PDF 一般几十 KB 起）
 *
 * 万一被反馈误伤，下调到 512 一行 const 改完。
 */
export const MIN_PDF_BYTES = 1024;

const PDF_MAGIC = Buffer.from('%PDF-');

/**
 * 严校验 —— 适用 PDF 单一格式的 source（gbw / by / bz）。
 * 同时检查 size 阈值 + magic header（%PDF-）。
 */
export function assertDownloadedPdf(bytes: Buffer, label: string): void {
  if (bytes.length < MIN_PDF_BYTES) {
    throw new UpstreamError(
      `[download-integrity] ${label}: ${bytes.length}B < ${MIN_PDF_BYTES}B 阈值，疑似空响应/错误页`,
    );
  }
  if (!bytes.subarray(0, 5).equals(PDF_MAGIC)) {
    const head = bytes.subarray(0, 5).toString('hex');
    throw new UpstreamError(
      `[download-integrity] ${label}: 非 PDF magic header (前 5 字节 0x${head})`,
    );
  }
}

/**
 * 宽校验 —— 适用 labr 这种 ext 可能是 pdf/doc/docx 的 source，不查 magic 只查 size。
 */
export function assertNonEmptyDownload(bytes: Buffer, label: string): void {
  if (bytes.length < MIN_PDF_BYTES) {
    throw new UpstreamError(
      `[download-integrity] ${label}: ${bytes.length}B < ${MIN_PDF_BYTES}B 阈值，疑似空响应/错误页`,
    );
  }
}

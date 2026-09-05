/**
 * Source-level concurrency limits — 每个数据源出口的全局信号量。
 *
 * 为什么不放在 adapter 里：BZ 单文件 / GBW autoDownload / BY 单文件 三个 adapter
 * 各自要 acquire 同一个 source 的 semaphore，集中放一处可以让 admin 设置页和诊断
 * 接口都能读到当前 stats。
 *
 * 默认值的依据：
 * - BZ = 2：单次导出涉及 12 路并发 JPEG 下载 + pdf-lib worker 拼装（worker pool 也只 2）。
 *   超过 2 会让 worker queue 堆积，反而拖慢所有用户的导出。
 * - GBW = 4：直 PDF 单 HTTP 请求，国标网 IIS 处理快，可适度并发。但 GBW 每个请求
 *   先要过 ddddocr 识别验证码（CPU 50-200ms），4 个并发足以打满 CPU 又不至于把
 *   ocr-worker 队列堆死。
 * - BY = 4：内网直 PDF，跟 GBW 同量级。
 * - LABR = 2：kind=0 直拉是单 HTTP 请求（同 GBW 量级可以 4），但 kind=1 走 preview2
 *   每天有 5 次硬上限（Bearer token 维度），并发开高了瞬间打穿配额、后面整批退避也救不回。
 *   保守起步 2，让用户主动批量下载时给 kind=0 留余量、kind=1 串行触发 LabrRateLimitError
 *   后能让 labr-service 优雅 short-circuit。后续若 kind=0 占比高可以调到 4。
 *
 * 不暴露给前端配置（暂时）。未来如发现 admin 需要在线调，加个 settings 项 +
 * SemaphoreRegistry.setLimit() 即可（Semaphore 本身已支持运行时改容量）。
 */

import { Semaphore } from './semaphore';
import type { SourceName } from '../domain/standard';

const DEFAULTS: Record<SourceName, number> = {
  bz: 2,
  gbw: 4,
  by: 4,
  labr: 2,
  bd: 1,
};

const registry = new Map<SourceName, Semaphore>();
for (const [src, limit] of Object.entries(DEFAULTS) as Array<[SourceName, number]>) {
  registry.set(src, new Semaphore(limit));
}

/** 取指定源的全局信号量；adapter 在 exportStandard / autoDownload 入口包 acquire/release。 */
export function getSourceSemaphore(source: SourceName): Semaphore {
  const sem = registry.get(source);
  if (!sem) throw new Error(`No semaphore registered for source: ${source}`);
  return sem;
}

/** 诊断 / admin 用：dump 各源当前持有数 + 等待队列 */
export function getSourceSemaphoreStats(): Record<SourceName, { active: number; limit: number; waiting: number }> {
  const out: Partial<Record<SourceName, { active: number; limit: number; waiting: number }>> = {};
  for (const [src, sem] of registry) {
    out[src] = sem.stats();
  }
  return out as Record<SourceName, { active: number; limit: number; waiting: number }>;
}

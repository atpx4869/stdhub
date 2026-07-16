import path from 'node:path';
import { stat } from 'node:fs/promises';

import type {
  ExportResult,
  PreviewInfo,
  SearchStandardsInput,
  SourceAdapter,
  StandardDetail,
  StandardSummary,
} from '../../domain/standard';
import { BadRequestError, NotFoundError, UpstreamError } from '../../shared/errors';
import { MIN_PDF_BYTES } from '../../shared/download-integrity';
import { buildFileName, getExportsDir } from '../../shared/fs';
import { parseStandardId } from '../../shared/id';
import { pooledFetch } from '../../shared/http';
import { getSourceSemaphore } from '../../shared/source-semaphore';
import { mergeJpegsToPdf } from '../../shared/pdf-merge';
import { getCachedPageCount, setCachedPageCount } from '../../shared/page-cache';
import { searchCache } from '../../shared/cache';
import { BZ_NEW_BASE, mapBzSearchRow, mapBzDetail, type BzSearchRow } from '../shared/bz-utils';

interface BzNewSearchResponse {
  code: number;
  data?: {
    records?: BzSearchRow[];
    total: number;
  };
}

interface BzNewDetailResponse {
  code: number;
  data?: BzSearchRow;
}

interface BzReadPagesResponse {
  code: number;
  success?: boolean;
  data?: number;
  msg?: string;
}

const SEARCH_API = `${BZ_NEW_BASE}/api/gxist-standard/standardstd/list`;
const READ_PAGES_API = `${BZ_NEW_BASE}/api/gxist-standard/standardstd/read-pages`;
const MAX_PREVIEW_PAGES = 512;
const PAGE_DISCOVERY_BATCH_SIZE = 8;
const PAGE_DOWNLOAD_CONCURRENCY = 12;
const PREVIEW_PAGE_CACHE_TTL = 5 * 60 * 1000;

interface PreviewPage {
  index: number;
  bytes: Uint8Array;
  /** Lightweight fingerprint: size + first 16 bytes (much faster than SHA-256) */
  fingerprint: string;
}

export class BzZhengguiAdapter implements SourceAdapter {
  readonly source = 'bz' as const;
  private readonly previewPageCache = new Map<string, { expiresAt: number; pages: PreviewPage[] }>();

  async searchStandards(input: SearchStandardsInput): Promise<StandardSummary[]> {
    const cacheKey = `bz:search:${input.query}`;
    const cached = searchCache.get<StandardSummary[]>(cacheKey);
    if (cached) return cached;

    const url = new URL(SEARCH_API);
    url.searchParams.set('language', 'zh');
    url.searchParams.set('current', '1');
    url.searchParams.set('size', '20');
    url.searchParams.set('keywords', input.query);

    const response = await pooledFetch(url.toString(), {
      signal: input.signal,
      timeoutMs: input.timeoutMs,
      retries: input.signal ? 1 : undefined,
    });
    if (!response.ok) {
      throw new UpstreamError('bz search API failed', { status: response.status });
    }

    const payload = (await response.json()) as BzNewSearchResponse;
    const rows = payload.data?.records ?? [];
    const result = rows.map((row) => this.mapSearchRow(row));
    searchCache.set(cacheKey, result, 5 * 60 * 1000); // 5 min TTL
    return result;
  }

  async getStandardDetail(id: string): Promise<StandardDetail> {
    const cacheKey = `bz:detail:${id}`;
    const cached = searchCache.get<StandardDetail>(cacheKey);
    if (cached) return cached;

    const { sourceId } = parseStandardId(id);
    const detailUrl = `${BZ_NEW_BASE}/api/gxist-standard/standardstd/detail?id=${encodeURIComponent(sourceId)}`;
    const response = await pooledFetch(detailUrl);
    if (!response.ok) {
      throw new UpstreamError('bz detail API failed', { status: response.status });
    }

    const payload = (await response.json()) as BzNewDetailResponse;
    const row = payload.data;
    if (!row) {
      throw new NotFoundError(`bz detail not found for ${id}`);
    }

    const result = this.mapDetail(row);
    searchCache.set(cacheKey, result, 10 * 60 * 1000); // 10 min cache
    return result;
  }

  async detectPreview(id: string): Promise<PreviewInfo> {
    const detail = await this.getStandardDetail(id);
    const hasPdf = detail.moreInfo?.hasPdf === true || detail.moreInfo?.isPdf === '1';
    const standardNo = detail.standardNumber;

    if (!hasPdf || !standardNo) {
      return {
        standardId: id,
        pageUrls: [],
        previewUrl: undefined,
        downloadUrl: undefined,
        captchaRequired: false,
        fileType: undefined,
        meta: { hasPdf: false, note: 'No preview available for this standard' },
      };
    }

    const totalPages = await this.detectPageCount(standardNo);

    const pageUrls = Array.from({ length: totalPages }, (_, index) => this.getPreviewPageUrl(standardNo, index));

    return {
      standardId: id,
      totalPages,
      pageUrls,
      fileType: 'jpeg',
      previewUrl: `${BZ_NEW_BASE}/standard/details/?id=${detail.sourceId}`,
      downloadUrl: undefined,
      captchaRequired: false,
      meta: {
        hasPdf,
        standardNo,
        sourceId: detail.sourceId,
        readImageBase: `${BZ_NEW_BASE}/api/gxist-standard/standardstd/read-image`,
      },
    };
  }

  async exportStandard(id: string, onProgress?: (current: number, total: number) => void): Promise<ExportResult> {
    // 源级并发限流：BZ 单次导出涉及 12 路 JPEG + pdf-lib worker 拼装，多用户并发时
    // 排队让出口稳定（详见 src/shared/source-semaphore.ts）
    return getSourceSemaphore('bz').run(() => this.exportStandardInner(id, onProgress));
  }

  private async exportStandardInner(id: string, onProgress?: (current: number, total: number) => void): Promise<ExportResult> {
    const detail = await this.getStandardDetail(id);
    const hasPdf = detail.moreInfo?.hasPdf === true || detail.moreInfo?.isPdf === '1';
    if (!hasPdf || !detail.standardNumber) {
      throw new BadRequestError(`bz export: no preview pages available for ${detail.standardNumber}`);
    }

    const previewPages = await this.downloadPreviewPages(detail.standardNumber);
    if (previewPages.length === 0) {
      throw new BadRequestError(`bz export: no preview pages available for ${detail.standardNumber}`);
    }

    const totalPages = previewPages.length;
    const fileName = buildFileName(detail.standardNumber, detail.title);
    const filePath = path.join(getExportsDir(), fileName);

    // pdf-lib synthesis (embedJpg + addPage + drawImage + save) is ~0.5-3s of
    // pure CPU and would block the main event loop / other API calls. Offload
    // to a worker_threads pool. jpegBuffers are transferred (zero-copy).
    await mergeJpegsToPdf({
      jpegBuffers: previewPages.map((p) => p.bytes),
      outputPath: filePath,
      onProgress,
    });

    // 合成后 size 兜底：pdf-lib worker 极罕见情况下 save 出 0/截断文件，再走入库
    // 就把空 pdf 永久塞库。magic 必然正确（pdf-lib 控制），只查 size 即可。
    const fileStat = await stat(filePath);
    if (fileStat.size < MIN_PDF_BYTES) {
      throw new UpstreamError(
        `[download-integrity] bz mergeJpegsToPdf 输出 ${fileStat.size}B < ${MIN_PDF_BYTES}B 阈值，疑似合成失败 (${filePath})`,
      );
    }

    return {
      standardId: id,
      filePath,
      fileName,
      totalPages,
    };
  }

  private async detectPageCount(standardNo: string): Promise<number> {
    // Cache hit
    const cached = getCachedPageCount(standardNo);
    // Old versions wrote invalid "1 page" entries because BZ no longer returns
    // content-length for HEAD requests. Re-check one-page cache entries.
    if (cached !== null && cached > 1) return cached;

    // Fast path: the SPA's own page-count API.
    const fromApi = await this.fetchPageCountFromApi(standardNo);
    if (fromApi !== null && fromApi > 0) {
      setCachedPageCount(standardNo, fromApi);
      return fromApi;
    }

    // Fallback: sentinel-based discovery via downloading.
    return (await this.downloadPreviewPages(standardNo)).length;
  }

  private async fetchPageCountFromApi(standardNo: string): Promise<number | null> {
    try {
      const url = `${READ_PAGES_API}?page=0&no=${encodeURIComponent(standardNo)}`;
      const response = await pooledFetch(url, { timeoutMs: 10_000, retries: 1 });
      if (!response.ok) return null;
      const payload = (await response.json()) as BzReadPagesResponse;
      if (payload.code !== 200) return null;
      const total = typeof payload.data === 'number' ? payload.data : null;
      if (total === null || !Number.isFinite(total) || total <= 0) return null;
      return Math.min(total, MAX_PREVIEW_PAGES);
    } catch {
      return null;
    }
  }

  private async downloadPreviewPages(standardNo: string): Promise<PreviewPage[]> {
    const cached = this.previewPageCache.get(standardNo);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.pages;
    }

    // Fast path: ask the API for the exact total, then fetch all pages in parallel.
    const total = await this.fetchPageCountFromApi(standardNo);
    if (total !== null && total > 0) {
      const pages = await this.fetchPagesParallel(standardNo, total);
      pages.sort((a, b) => a.index - b.index);
      this.previewPageCache.set(standardNo, { expiresAt: Date.now() + PREVIEW_PAGE_CACHE_TTL, pages });
      setCachedPageCount(standardNo, pages.length);
      return pages;
    }

    // Fallback: sentinel-hash boundary detection.
    const first = await this.fetchPreviewPage(standardNo, 0);
    const pages: PreviewPage[] = [first];
    const firstFingerprint = first.fingerprint;
    let nextPage = 1;
    let reachedEnd = false;

    while (!reachedEnd && pages.length < MAX_PREVIEW_PAGES) {
      const indexes = Array.from(
        { length: Math.min(PAGE_DISCOVERY_BATCH_SIZE, MAX_PREVIEW_PAGES - nextPage) },
        (_unused, idx) => nextPage + idx,
      );
      const batch = await Promise.all(indexes.map(index => this.fetchPreviewPage(standardNo, index)));
      for (const page of batch) {
        if (page.fingerprint === firstFingerprint) {
          reachedEnd = true;
          break;
        }
        pages.push(page);
      }
      nextPage += indexes.length;
    }

    if (!reachedEnd && pages.length >= MAX_PREVIEW_PAGES) {
      throw new UpstreamError(`bz preview page boundary not found for ${standardNo}`, { maxPages: MAX_PREVIEW_PAGES });
    }

    pages.sort((a, b) => a.index - b.index);
    this.previewPageCache.set(standardNo, { expiresAt: Date.now() + PREVIEW_PAGE_CACHE_TTL, pages });
    setCachedPageCount(standardNo, pages.length);
    return pages;
  }

  private async fetchPagesParallel(standardNo: string, total: number): Promise<PreviewPage[]> {
    const results: (PreviewPage | null)[] = new Array(total).fill(null);
    let cursor = 0;

    const fetchWithRetry = async (pageNum: number): Promise<PreviewPage | null> => {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          return await this.fetchPreviewPage(standardNo, pageNum);
        } catch (e) {
          if (attempt === 0) {
            console.warn(`[bz] page ${pageNum} download failed (attempt 1), retrying: ${e instanceof Error ? e.message : e}`);
          } else {
            console.warn(`[bz] page ${pageNum} download failed (attempt 2), skipping: ${e instanceof Error ? e.message : e}`);
          }
        }
      }
      return null;
    };

    const workers = Array.from({ length: Math.min(PAGE_DOWNLOAD_CONCURRENCY, total) }, async () => {
      while (true) {
        const index = cursor++;
        if (index >= total) return;
        results[index] = await fetchWithRetry(index);
      }
    });
    await Promise.all(workers);

    const pages = results.filter((p): p is PreviewPage => p !== null);
    if (pages.length < total) {
      console.warn(`[bz] ${standardNo}: ${total - pages.length}/${total} pages failed to download`);
    }
    return pages;
  }

  private async fetchPreviewPage(standardNo: string, pageNum: number): Promise<PreviewPage> {
    const pageUrl = this.getPreviewPageUrl(standardNo, pageNum);
    const response = await pooledFetch(pageUrl, { timeoutMs: 20_000, retries: 2 });
    if (!response.ok) {
      throw new UpstreamError(`Failed to download preview page: ${pageUrl}`, { status: response.status });
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length < 5000 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
      throw new UpstreamError(`Invalid bz preview page response: ${pageUrl}`, { status: response.status, bytes: bytes.length });
    }
    // Lightweight fingerprint: size + first 16 bytes (avoids expensive SHA-256)
    const head = Array.from(bytes.slice(0, 16), b => b.toString(16).padStart(2, '0')).join('');
    return {
      index: pageNum,
      bytes,
      fingerprint: `${bytes.length}:${head}`,
    };
  }

  private getPreviewPageUrl(standardNo: string, pageNum: number): string {
    return `${BZ_NEW_BASE}/api/gxist-standard/standardstd/read-image?no=${encodeURIComponent(standardNo)}&page=${pageNum}`;
  }

  private mapSearchRow(row: BzSearchRow): StandardSummary {
    return mapBzSearchRow(row, 'bz');
  }

  private mapDetail(row: BzSearchRow): StandardDetail {
    return mapBzDetail(row, 'bz');
  }
}

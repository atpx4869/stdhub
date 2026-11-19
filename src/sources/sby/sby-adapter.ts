import path from 'node:path';

import { readConfig } from '../../config';
import type {
  ExportResult,
  PreviewInfo,
  SearchStandardsInput,
  SourceAdapter,
  StandardDetail,
  StandardSummary,
} from '../../domain/standard';
import { assertDownloadedPdf } from '../../shared/download-integrity';
import { BadRequestError, NotFoundError, UpstreamError } from '../../shared/errors';
import { buildFileName, safeWriteExportFile } from '../../shared/fs';
import { pooledFetch } from '../../shared/http';
import { createStandardId, parseStandardId } from '../../shared/id';

const DEFAULT_SBY_BASE = 'https://std.hbsqi.com';
const SEARCH_TIMEOUT_MS = 20_000;
const PDF_TIMEOUT_MS = 60_000;
const HEALTH_TIMEOUT_MS = 8_000;
const AVAILABILITY_TTL_MS = 30_000;
const PAGE_SIZE = 20;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const STATUS_TEXT: Record<string, string> = {
  '1': '现行',
  '2': '废止',
  '3': '即将实施',
};

interface SbyItem {
  stdId: string;
  standardNumber: string;
  title: string;
  titleEn: string;
  status: string;
  publishDate: string;
  implementDate: string;
  abolishedDate: string;
  dept: string;
  standardType: string;
  classCn: string;
  classIcs: string;
  replaced: string;
  instead: string;
  pages: string;
  dataSource: string;
  textPath: string;
  hasText: boolean;
}

function sbySettings() {
  const { baseUrl, maxPages } = readConfig().sby;
  return {
    baseUrl: (baseUrl || DEFAULT_SBY_BASE).replace(/\/+$/, ''),
    maxPages,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function asString(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function isPresent(row: Record<string, unknown>, field: string): boolean {
  return asString(row[field]) !== '';
}

function afterDash(value: string): string {
  const index = value.indexOf('-');
  return index === -1 ? value : value.slice(index + 1).trim();
}

function statusText(row: Record<string, unknown>): string {
  const named = asString(row.stdStatusName);
  if (named === '现行有效' || named === '有效') return '现行';
  if (named) return named;
  const ext = asString(row.a200Ext);
  if (ext) return afterDash(ext);
  return STATUS_TEXT[asString(row.stdStatus)] || '';
}

function parseItem(raw: unknown): SbyItem | null {
  const row = asRecord(raw);
  if (!row) return null;
  const stdId = asString(row.stdId);
  const standardNumber = asString(row.a100);
  if (!stdId || !standardNumber) return null;
  return {
    stdId,
    standardNumber,
    title: asString(row.a298),
    titleEn: asString(row.a301),
    status: statusText(row),
    publishDate: asString(row.a101),
    implementDate: asString(row.a205),
    abolishedDate: asString(row.a210),
    dept: asString(row.a102),
    standardType: afterDash(asString(row.stdTypeName)),
    classCn: asString(row.a825),
    classIcs: asString(row.a404),
    replaced: asString(row.a461),
    instead: asString(row.a462),
    pages: asString(row.a305),
    dataSource: asString(row.dataSource),
    textPath: asString(row.b000),
    hasText: isPresent(row, 'b000'),
  };
}

function requestHeaders(accept: string, json = false): Record<string, string> {
  const { baseUrl } = sbySettings();
  return {
    Accept: accept,
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'User-Agent': USER_AGENT,
    Referer: baseUrl + '/',
    Origin: baseUrl,
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  };
}

function apiUrl(pathname: string): string {
  return new URL(pathname, sbySettings().baseUrl + '/').toString();
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  try {
    const parsed = JSON.parse(text) as unknown;
    return asRecord(parsed) || {};
  } catch {
    throw new UpstreamError('SBY API 返回了无法解析的响应 (HTTP ' + response.status + ')');
  }
}

function extractRows(body: Record<string, unknown>): { rows: unknown[]; total: number } {
  const topHasRows = Array.isArray(body.rows) || Array.isArray(body.records);
  const data = topHasRows ? body : (asRecord(body.data) || {});
  const rows = Array.isArray(data.rows) ? data.rows : (Array.isArray(data.records) ? data.records : []);
  const totalRaw = data.total;
  const total = typeof totalRaw === 'number' && Number.isFinite(totalRaw) ? totalRaw : Number(totalRaw) || 0;
  return { rows, total };
}

export class SbyAdapter implements SourceAdapter {
  readonly source = 'sby' as const;

  private availability:
    | { value: boolean; expireAt: number }
    | null = null;

  private readonly items = new Map<string, SbyItem>();

  async searchStandards(params: SearchStandardsInput): Promise<StandardSummary[]> {
    const query = params.query.trim();
    if (!query) throw new BadRequestError('搜索关键字不能为空');
    if (params.signal?.aborted) throw new UpstreamError('SBY 搜索已取消');
    if (!(await this.isAvailable())) {
      throw new UpstreamError('SBY 源当前不可用');
    }
    const items = await this.searchApi(query, params.signal);
    return items.map(item => this.toSummary(item));
  }

  async getStandardDetail(id: string): Promise<StandardDetail> {
    const { sourceId } = parseStandardId(id);
    const cached = this.items.get(sourceId);
    const item = this.mergeItem(cached, await this.fetchDetail(sourceId));
    this.items.set(item.stdId, item);
    return this.toDetail(item);
  }

  async detectPreview(id: string): Promise<PreviewInfo> {
    const detail = await this.getStandardDetail(id);
    return {
      standardId: id,
      pageUrls: [],
      fileType: detail.previewAvailable ? 'pdf' : undefined,
      captchaRequired: false,
      meta: {
        capability: 'direct_pdf_download',
        hasPdf: Boolean(detail.previewAvailable),
        stdId: detail.sourceId,
      },
    };
  }

  async exportStandard(id: string, opts?: { onProgress?: (current: number, total: number) => void; signal?: AbortSignal }): Promise<ExportResult> {
    if (opts?.signal?.aborted) throw new UpstreamError('SBY 下载已取消');
    const detail = await this.getStandardDetail(id);
    if (!detail.previewAvailable) {
      throw new UpstreamError('SBY 无电子件');
    }
    opts?.onProgress?.(1, 1);
    return this.downloadPdf(id, detail.sourceId, detail.standardNumber, detail.title);
  }

  async isAvailable(): Promise<boolean> {
    const now = Date.now();
    if (this.availability && this.availability.expireAt > now) {
      return this.availability.value;
    }
    try {
      const response = await this.postList({ pageNum: 1, pageSize: 1, keyword: '' }, HEALTH_TIMEOUT_MS);
      const available = response.ok;
      this.availability = { value: available, expireAt: now + AVAILABILITY_TTL_MS };
      return available;
    } catch (error) {
      console.warn('[sby] health check failed:', error instanceof Error ? error.message : String(error));
      this.availability = { value: false, expireAt: now + AVAILABILITY_TTL_MS };
      return false;
    }
  }

  private remember(items: SbyItem[]): void {
    for (const item of items) this.items.set(item.stdId, this.mergeItem(this.items.get(item.stdId), item));
  }

  private mergeItem(base: SbyItem | undefined, incoming: SbyItem): SbyItem {
    if (!base) return incoming;
    return {
      ...base,
      ...incoming,
      title: incoming.title || base.title,
      titleEn: incoming.titleEn || base.titleEn,
      textPath: incoming.textPath || base.textPath,
      hasText: incoming.hasText || base.hasText,
    };
  }

  private async searchApi(keyword: string, signal?: AbortSignal): Promise<SbyItem[]> {
    const maxPages = sbySettings().maxPages;
    const collected: SbyItem[] = [];
    let total = Number.POSITIVE_INFINITY;
    for (let page = 1; page <= maxPages; page += 1) {
      if (signal?.aborted) throw new UpstreamError('SBY 搜索已取消');
      const response = await this.postList({ pageNum: page, pageSize: PAGE_SIZE, keyword }, SEARCH_TIMEOUT_MS, signal);
      const body = await readJson(response);
      if (!response.ok) {
        throw new UpstreamError('SBY API HTTP ' + response.status + '：' + (asString(body.msg) || asString(body.error) || '搜索失败'));
      }
      const extracted = extractRows(body);
      const items = extracted.rows.map(parseItem).filter((item): item is SbyItem => Boolean(item));
      this.remember(items);
      collected.push(...items);
      total = extracted.total || total;
      if (items.length === 0 || page * PAGE_SIZE >= total) break;
    }
    return collected;
  }

  private async fetchDetail(stdId: string): Promise<SbyItem> {
    let response: Response;
    try {
      response = await pooledFetch(apiUrl('/stage-api/title/std/info/' + encodeURIComponent(stdId)), {
        method: 'GET',
        headers: requestHeaders('application/json'),
        timeoutMs: SEARCH_TIMEOUT_MS,
        retries: 2,
      });
    } catch (error) {
      throw new UpstreamError('SBY 详情请求失败：' + (error instanceof Error ? error.message : String(error)));
    }
    const body = await readJson(response);
    if (!response.ok) {
      throw new UpstreamError('SBY API HTTP ' + response.status + '：' + (asString(body.msg) || '详情失败'));
    }
    const data = asRecord(body.data) || body;
    const item = parseItem(data);
    if (!item) throw new NotFoundError('SBY 未找到该标准详情');
    return item;
  }

  private async downloadPdf(standardId: string, stdId: string, standardNumber: string, title: string): Promise<ExportResult> {
    let response: Response;
    try {
      response = await pooledFetch(apiUrl('/stage-api/title/std/stdDownload'), {
        method: 'POST',
        headers: requestHeaders('application/pdf, application/json;q=0.9', true),
        body: JSON.stringify({ id: stdId }),
        timeoutMs: PDF_TIMEOUT_MS,
        retries: 1,
      });
    } catch (error) {
      throw new UpstreamError('SBY PDF 请求失败：' + (error instanceof Error ? error.message : String(error)));
    }

    const contentType = response.headers.get('content-type') || '';
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!response.ok || contentType.includes('application/json') || contentType.includes('text/html') || bytes.subarray(0, 4).toString() !== '%PDF') {
      throw new UpstreamError('SBY 无电子件');
    }
    assertDownloadedPdf(bytes, 'sby:' + stdId);
    const fileName = buildFileName(standardNumber, title);
    const filePath = await safeWriteExportFile(fileName, bytes);
    return {
      standardId,
      filePath,
      fileName: path.basename(filePath),
      fileSize: bytes.length,
    };
  }

  private async postList(
    body: { pageNum: number; pageSize: number; keyword: string },
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Response> {
    try {
      return await pooledFetch(apiUrl('/stage-api/title/std/indexList'), {
        method: 'POST',
        headers: requestHeaders('application/json', true),
        body: JSON.stringify(body),
        timeoutMs,
        retries: 2,
        signal,
      });
    } catch (error) {
      throw new UpstreamError('SBY 搜索请求失败：' + (error instanceof Error ? error.message : String(error)));
    }
  }

  private toSummary(item: SbyItem): StandardSummary {
    return {
      id: createStandardId('sby', item.stdId),
      source: 'sby',
      sourceId: item.stdId,
      standardNumber: item.standardNumber,
      title: item.title || item.titleEn,
      standardType: item.standardType || undefined,
      status: item.status || undefined,
      publishDate: item.publishDate || undefined,
      implementDate: item.implementDate || undefined,
      abolishedDate: item.abolishedDate || undefined,
      detailUrl: '',
      previewAvailable: item.hasText,
      meta: {
        nameEn: item.titleEn || undefined,
        dept: item.dept || undefined,
        classCn: item.classCn || undefined,
        classIcs: item.classIcs || undefined,
        replaced: item.replaced || undefined,
        instead: item.instead || undefined,
        pages: item.pages || undefined,
        dataSource: item.dataSource || undefined,
        textPath: item.textPath || undefined,
      },
    };
  }

  private toDetail(item: SbyItem): StandardDetail {
    const summary = this.toSummary(item);
    return {
      ...summary,
      moreInfo: summary.meta,
    };
  }
}

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
import { BadRequestError, NotFoundError, UpstreamError } from '../../shared/errors';
import { buildFileName, safeWriteExportFile } from '../../shared/fs';
import { assertDownloadedPdf } from '../../shared/download-integrity';
import { pooledFetch } from '../../shared/http';
import { createStandardId, parseStandardId } from '../../shared/id';

const DEFAULT_BY_API_URL = 'https://by.917520.xyz';
const SEARCH_TIMEOUT_MS = 20_000;
const PDF_TIMEOUT_MS = 60_000;
const HEALTH_TIMEOUT_MS = 8_000;
const AVAILABILITY_TTL_MS = 30_000;

const CODE_LIKE = /^(?:[A-Z]{1,12}(?:\s*\/\s*[A-Z])?\s*)?\d{1,6}(?:[.\-:\s]\d{1,4})*$/i;

export function classifyByQuery(query: string): { code?: string; name?: string } {
  const q = query.trim().replace(/\s+/g, ' ');
  if (!q) return {};
  if (CODE_LIKE.test(q)) return { code: q };
  return { name: q };
}

interface ByApiItem {
  code: string;
  name_cn: string;
  name_en: string;
  status: string;
  publish: string;
  implement: string;
  kind: string;
  nature: string;
  amend: string;
  sid: string;
  pdf: string;
  page: number;
}

interface ByApiEnvelope {
  ok?: boolean;
  version?: string;
  code?: string;
  error?: string;
  data?: {
    items?: unknown;
    count?: number;
    status?: string;
  };
}

function bySettings() {
  const { apiUrl, token, maxPages } = readConfig().by;
  return {
    apiUrl: apiUrl || DEFAULT_BY_API_URL,
    token,
    maxPages,
  };
}

function requireToken(): string {
  const token = bySettings().token;
  if (!token) {
    throw new UpstreamError('BY 源未配置：请在 .env.local 设置 BY_API_TOKEN');
  }
  return token;
}

function apiUrl(pathname: string, params?: Record<string, string>): string {
  const url = new URL(pathname, `${bySettings().apiUrl}/`);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

function authHeaders(token: string, accept: string): Record<string, string> {
  return {
    Accept: accept,
    'X-Token': token,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function parseItem(raw: unknown): ByApiItem | null {
  const row = asRecord(raw);
  if (!row) return null;
  const sid = asString(row.sid);
  const code = asString(row.code);
  if (!sid || !code) return null;
  const page = typeof row.page === 'number' && Number.isFinite(row.page) ? row.page : 0;
  return {
    code,
    name_cn: asString(row.name_cn),
    name_en: asString(row.name_en),
    status: asString(row.status),
    publish: asString(row.publish),
    implement: asString(row.implement),
    kind: asString(row.kind),
    nature: asString(row.nature),
    amend: asString(row.amend),
    sid,
    pdf: asString(row.pdf),
    page,
  };
}

async function readEnvelope(response: Response): Promise<ByApiEnvelope> {
  const text = await response.text();
  try {
    return JSON.parse(text) as ByApiEnvelope;
  } catch {
    throw new UpstreamError(`BY API 返回了无法解析的响应 (HTTP ${response.status})`);
  }
}

function throwApiError(response: Response, body: ByApiEnvelope, fallback: string): never {
  const code = body.code || '';
  const message = body.error || fallback;
  if (response.status === 401 || code === 'UNAUTHORIZED') {
    throw new UpstreamError('BY API 鉴权失败：请检查 BY_API_TOKEN');
  }
  if (response.status === 400 && code === 'NO_PDF') {
    throw new UpstreamError(message || '请先搜索，再下载该标准的 PDF');
  }
  throw new UpstreamError(`BY API ${code || `HTTP ${response.status}`}：${message}`);
}

export class ByAdapter implements SourceAdapter {
  readonly source = 'by' as const;

  private availability:
    | { value: boolean; expireAt: number }
    | null = null;

  private readonly items = new Map<string, ByApiItem>();

  async searchStandards(params: SearchStandardsInput): Promise<StandardSummary[]> {
    const query = params.query.trim();
    if (!query) throw new BadRequestError('搜索关键字不能为空');
    if (params.signal?.aborted) throw new UpstreamError('BY 搜索已取消');
    if (!(await this.isAvailable())) {
      throw new UpstreamError('BY 源当前不可用');
    }
    const classified = classifyByQuery(query);
    if (!classified.code && !classified.name) {
      throw new BadRequestError('搜索关键字不能为空');
    }
    const items = await this.searchApi(classified);
    return items.map(item => this.toSummary(item));
  }

  async getStandardDetail(id: string): Promise<StandardDetail> {
    const { sourceId } = parseStandardId(id);
    const item = this.items.get(sourceId);
    if (!item) {
      throw new NotFoundError('BY 标准详情不在本次检索缓存中，请重新搜索');
    }
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
        sid: detail.sourceId,
      },
    };
  }

  async exportStandard(id: string, opts?: { onProgress?: (current: number, total: number) => void; signal?: AbortSignal }): Promise<ExportResult> {
    if (opts?.signal?.aborted) throw new UpstreamError('BY 下载已取消');
    const { sourceId } = parseStandardId(id);
    const cached = this.items.get(sourceId);
    if (!cached) {
      throw new NotFoundError('请先搜索该标准，再下载 PDF');
    }
    await this.searchApi({ code: cached.code });
    if (opts?.signal?.aborted) throw new UpstreamError('BY 下载已取消');
    try {
      return await this.downloadPdf(id, sourceId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/请先搜索|NO_PDF/.test(message)) throw error;
      await this.searchApi({ code: cached.code });
      return this.downloadPdf(id, sourceId);
    }
  }

  async isAvailable(): Promise<boolean> {
    const now = Date.now();
    if (this.availability && this.availability.expireAt > now) {
      return this.availability.value;
    }
    try {
      const response = await pooledFetch(apiUrl('/api/health'), {
        method: 'GET',
        timeoutMs: HEALTH_TIMEOUT_MS,
        retries: 1,
      });
      const available = response.ok;
      this.availability = { value: available, expireAt: now + AVAILABILITY_TTL_MS };
      return available;
    } catch (error) {
      console.warn('[by] health check failed:', error instanceof Error ? error.message : String(error));
      this.availability = { value: false, expireAt: now + AVAILABILITY_TTL_MS };
      return false;
    }
  }

  private remember(items: ByApiItem[]): void {
    for (const item of items) this.items.set(item.sid, item);
  }

  private async searchApi(query: { code?: string; name?: string }): Promise<ByApiItem[]> {
    const token = requireToken();
    const params: Record<string, string> = {
      pages: String(bySettings().maxPages),
    };
    if (query.code) params.code = query.code;
    else if (query.name) params.name = query.name;
    else throw new BadRequestError('搜索关键字不能为空');

    let response: Response;
    try {
      response = await pooledFetch(apiUrl('/api/search', params), {
        headers: authHeaders(token, 'application/json'),
        timeoutMs: SEARCH_TIMEOUT_MS,
        retries: 2,
      });
    } catch (error) {
      throw new UpstreamError(`BY 搜索请求失败：${error instanceof Error ? error.message : String(error)}`);
    }

    const body = await readEnvelope(response);
    if (!response.ok || body.ok === false) {
      throwApiError(response, body, '搜索失败');
    }
    const rawItems = Array.isArray(body.data?.items) ? body.data.items : [];
    const items = rawItems.map(parseItem).filter((item): item is ByApiItem => Boolean(item));
    this.remember(items);
    return items;
  }

  private async downloadPdf(standardId: string, sid: string): Promise<ExportResult> {
    const token = requireToken();
    const item = this.items.get(sid);
    if (!item) throw new NotFoundError('请先搜索该标准，再下载 PDF');

    let response: Response;
    try {
      response = await pooledFetch(apiUrl('/api/pdf', { sid }), {
        headers: authHeaders(token, 'application/pdf'),
        timeoutMs: PDF_TIMEOUT_MS,
        retries: 1,
      });
    } catch (error) {
      throw new UpstreamError(`BY PDF 请求失败：${error instanceof Error ? error.message : String(error)}`);
    }

    const contentType = response.headers.get('content-type') || '';
    if (!response.ok || contentType.includes('application/json')) {
      const body = await readEnvelope(response);
      throwApiError(response, body, 'PDF 下载失败');
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    assertDownloadedPdf(bytes, `by:${sid}`);
    const fileName = buildFileName(item.code, item.name_cn || item.name_en);
    const filePath = await safeWriteExportFile(fileName, bytes);
    return {
      standardId,
      filePath,
      fileName: path.basename(filePath),
      fileSize: bytes.length,
    };
  }

  private toSummary(item: ByApiItem): StandardSummary {
    return {
      id: createStandardId('by', item.sid),
      source: 'by',
      sourceId: item.sid,
      standardNumber: item.code,
      title: item.name_cn || item.name_en,
      status: item.status || undefined,
      publishDate: item.publish || undefined,
      implementDate: item.implement || undefined,
      detailUrl: '',
      previewAvailable: Boolean(item.pdf),
      meta: {
        nameEn: item.name_en || undefined,
        kind: item.kind || undefined,
        nature: item.nature || undefined,
        amend: item.amend || undefined,
        page: item.page || undefined,
        pdf: item.pdf || undefined,
      },
    };
  }

  private toDetail(item: ByApiItem): StandardDetail {
    const summary = this.toSummary(item);
    return {
      ...summary,
      moreInfo: summary.meta,
    };
  }
}

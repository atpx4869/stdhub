import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import type {
  DownloadSessionInfo,
  ExportResult,
  PreviewInfo,
  SearchStandardsInput,
  SourceAdapter,
  StandardDetail,
  StandardSummary,
} from '../../domain/standard';
import { BadRequestError, NotFoundError, UpstreamError } from '../../shared/errors';
import { assertDownloadedPdf } from '../../shared/download-integrity';
import { buildFileName, ensureExportsDir, getExportsDir } from '../../shared/fs';
import { createStandardId, parseStandardId } from '../../shared/id';
import { pooledFetch } from '../../shared/http';
import { searchCache } from '../../shared/cache';
import { getSourceSemaphore } from '../../shared/source-semaphore';
import {
  getCachedHcno,
  getCachedTextAvailability,
  setCachedHcno,
  setCachedTextAvailability,
} from '../../shared/text-availability-cache';
import { GbwDownloadSessionStore } from './gbw-download-session-store';
import { ocrCaptcha } from '../shared/captcha-ocr';

interface GbwSearchResponse {
  total?: number;
  pageNumber?: number;
  rows?: GbwSearchRow[];
}

interface GbwSearchRow {
  id?: string;
  C_STD_CODE?: string;
  C_C_NAME?: string;
  STD_NATURE?: string;
  ACT_DATE?: string;
  STATE?: string;
  ISSUE_DATE?: string;
}

interface OcrAttemptLog {
  round: number;
  sessionId: string;
  ocrText: string;
  ocrConfidence: number;
  submittedCode: string;
  verifyResponse?: string;
  resultStatus?: string;
  error?: string;
}

const GBW_STD_BASE = 'https://std.samr.gov.cn';
const GBW_OPENSTD_BASE = 'https://openstd.samr.gov.cn';
const GBW_DOWNLOAD_BASE = 'https://openstd.samr.gov.cn';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Download cancelled');
}

export class GbwAdapter implements SourceAdapter {
  readonly source = 'gbw' as const;
  /** Cache of text availability: sourceId → boolean */
  private textCache = new Map<string, boolean>();

  constructor(private readonly downloadSessionStore = new GbwDownloadSessionStore()) {}

  /** Get cached text availability for multiple IDs */
  getTextAvailability(ids: string[]): Record<string, boolean> {
    const result: Record<string, boolean> = {};
    for (const id of ids) {
      if (this.textCache.has(id)) result[id] = this.textCache.get(id)!;
    }
    return result;
  }

  async searchStandards(input: SearchStandardsInput): Promise<StandardSummary[]> {
    const cacheKey = `gbw:search:${input.query}`;
    const cached = searchCache.get<StandardSummary[]>(cacheKey);

    if (cached) {
      // Even for cached results, re-check uncached text availability items
      const statusMap = new Map<string, string>();
      for (const r of cached) {
        if (r.status) statusMap.set(r.sourceId, r.status);
      }
      const uncachedIds = cached
        .map(r => r.sourceId)
        .filter(id => !this.textCache.has(id));
      if (uncachedIds.length) {
        this.batchCheckTextAvailability(uncachedIds, statusMap).catch(() => {});
      }
      return cached;
    }

    const searchUrl = new URL('/gb/search/gbQueryPage', GBW_STD_BASE);
    searchUrl.searchParams.set('searchText', input.query);
    searchUrl.searchParams.set('page', '1');
    searchUrl.searchParams.set('pageSize', '20');

    const response = await pooledFetch(searchUrl.toString(), {
      signal: input.signal,
      timeoutMs: input.timeoutMs || 15000,
      retries: input.signal ? 1 : undefined,
    });

    if (!response.ok) {
      throw new UpstreamError('Failed to query gbw search endpoint', { status: response.status });
    }

    const payload = (await response.json()) as GbwSearchResponse;
    const rows = payload.rows ?? [];
    const result = rows.map((row) => this.mapSearchRow(row));
    searchCache.set(cacheKey, result);

    // Fire off background text availability checks (don't await)
    // Skip 废止 standards — they generally have no text available
    const statusMap = new Map<string, string>();
    for (const r of result) {
      if (r.status) statusMap.set(r.sourceId, r.status);
    }
    const uncachedIds = result
      .map(r => r.sourceId)
      .filter(id => !this.textCache.has(id));
    if (uncachedIds.length) {
      this.batchCheckTextAvailability(uncachedIds, statusMap).catch(() => {});
    }

    return result;
  }

  /** Background batch check: fetch detail pages to extract hcno, then check openstd */
  private async batchCheckTextAvailability(sourceIds: string[], statusMap?: Map<string, string>): Promise<void> {
    // Pre-filter pass 1: 废止 standards generally have no text, skip them
    // Pre-filter pass 2: persistent cache hit — hydrate in-memory map, skip HTTP
    const toCheck: string[] = [];
    for (const id of sourceIds) {
      const status = statusMap?.get(id);
      if (status && status.includes('废止')) {
        this.textCache.set(id, false);
        continue;
      }
      const cached = getCachedTextAvailability(id);
      if (cached) {
        this.textCache.set(id, cached.hasText);
        continue;
      }
      toCheck.push(id);
    }

    if (toCheck.length === 0) return;

    // Two endpoints, two different hosts (std.samr / openstd.samr) — connection
    // pools don't compete, so we can crank concurrency higher than the old 3.
    const concurrency = 8;
    let i = 0;
    const worker = async () => {
      while (i < toCheck.length) {
        const idx = i++;
        const sourceId = toCheck[idx];
        try {
          // Resolve hcno: prefer the permanent on-disk cache (hcno never changes
          // for a given sourceId — only hasText is TTL'd). On TTL-expired entries
          // this lets us skip the gbDetailed HTTP call entirely.
          let hcno: string | null | undefined = getCachedHcno(sourceId);
          if (hcno === undefined) {
            // No prior hcno on record — fetch detail page.
            // pooledFetch has built-in retries; disable for batch to fail fast.
            const detailUrl = `${GBW_STD_BASE}/gb/search/gbDetailed?id=${sourceId}`;
            const resp = await pooledFetch(detailUrl, { headers: { 'User-Agent': USER_AGENT }, timeoutMs: 12000, retries: 1 });
            if (!resp.ok) { continue; }  // Don't cache — leave for retry on next search
            const html = await resp.text();
            hcno = extractHcno(html) ?? null;
            // Persist the hcno immediately, before the (potentially failing)
            // openstd check, so we never need to re-resolve it.
            setCachedHcno(sourceId, hcno);
          }

          if (!hcno) {
            this.textCache.set(sourceId, false);
            setCachedTextAvailability(sourceId, null, false);
            continue;
          }
          const hasText = await this.checkOpenstdHasText(hcno);
          this.textCache.set(sourceId, hasText);
          setCachedTextAvailability(sourceId, hcno, hasText);
        } catch {
          // Don't cache failures — leave uncached so they can be retried on next search
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, toCheck.length) }, () => worker()));
  }

  async getStandardDetail(id: string): Promise<StandardDetail> {
    const { source, sourceId } = parseStandardId(id);
    if (source !== 'gbw') {
      throw new BadRequestError(`gbw adapter cannot resolve id from source ${source}`);
    }

    // Cache hit: avoid two upstream HTTP requests (detail page + openstd hasText check)
    // on every autoDownload retry. The `meta.html` blob is omitted from the cache to
    // keep memory footprint small.
    const cacheKey = `gbw:detail:${id}`;
    const cached = searchCache.get<StandardDetail>(cacheKey);
    if (cached) return cached;

    const detailUrl = new URL('/gb/search/gbDetailed', GBW_STD_BASE);
    detailUrl.searchParams.set('id', sourceId);

    const response = await pooledFetch(detailUrl.toString(), {
      headers: {
        'User-Agent': USER_AGENT,
      },
      timeoutMs: 15000,
      retries: 2,
    });

    if (!response.ok) {
      console.warn(`[gbw] getStandardDetail FAILED: id=${id} status=${response.status}`);
      throw new UpstreamError('Failed to fetch gbw detail page', { status: response.status });
    }

    const html = await response.text();
    const { load } = await import('cheerio');
    const $ = load(html);

    const standardNumber = cleanText(extractBasicInfoField($, '标准号') ?? '');
    const title = cleanText($('.page-header h4').first().text());
    const englishTitle = cleanText($('.page-header h5').first().text());
    const status = cleanText($('.page-header .label-primary').first().text());

    const fieldMap = extractFieldMap($);
    const hcno = extractHcno(html);

    if (!standardNumber || !title) {
      throw new NotFoundError(`gbw detail not found for ${id}`);
    }

    // Persist the hcno immediately so a later openstd failure doesn't make us
    // re-parse this detail page just to recover hcno on the next search round.
    if (hcno !== undefined) {
      setCachedHcno(sourceId, hcno ?? null);
    }

    // Use the cached availability flag if a prior batchCheckTextAvailability filled it;
    // fall back to the persistent on-disk cache, and only hit openstd as last resort.
    let hasText = this.textCache.get(sourceId);
    if (hasText === undefined) {
      const persisted = getCachedTextAvailability(sourceId);
      if (persisted) {
        hasText = persisted.hasText;
        this.textCache.set(sourceId, hasText);
      }
    }
    if (hasText === undefined && hcno) {
      hasText = await this.checkOpenstdHasText(hcno);
      this.textCache.set(sourceId, hasText);
      setCachedTextAvailability(sourceId, hcno, hasText);
    }

    const result: StandardDetail = {
      id,
      source: 'gbw',
      sourceId,
      standardNumber,
      title,
      standardType: cleanText($('.page-header .label-success').first().text()) || fieldMap['标准类别'] || undefined,
      status,
      publishDate: extractBasicInfoField($, '发布日期') ?? null,
      implementDate: extractBasicInfoField($, '实施日期') ?? null,
      abolishedDate: null,
      previewAvailable: Boolean(hasText),
      detailUrl: detailUrl.toString(),
      contentText: englishTitle || '',
      moreInfo: {
        enName: englishTitle || undefined,
        fields: fieldMap,
        hcno,
        openstdDetailUrl: hcno ? `${GBW_OPENSTD_BASE}/bzgk/std/newGbInfo?hcno=${hcno}` : null,
      },
      meta: {},
    };
    searchCache.set(cacheKey, result, 10 * 60 * 1000); // 10 min cache
    return result;
  }

  async detectPreview(id: string): Promise<PreviewInfo> {
    const detail = await this.getStandardDetail(id);
    const hcno = asString(detail.moreInfo?.hcno);

    if (!hcno || !detail.previewAvailable) {
      return {
        standardId: id,
        pageUrls: [],
        previewUrl: undefined,
        downloadUrl: undefined,
        captchaRequired: false,
        meta: {
          hcno: hcno ?? null,
          openstdDetailUrl: hcno ? `${GBW_OPENSTD_BASE}/bzgk/std/newGbInfo?hcno=${hcno}` : null,
          capability: 'metadata_only',
        },
      };
    }

    return {
      standardId: id,
      pageUrls: [],
      previewUrl: `${GBW_DOWNLOAD_BASE}/bzgk/std/showGb?type=online&hcno=${hcno}`,
      downloadUrl: `${GBW_DOWNLOAD_BASE}/bzgk/std/showGb?type=download&hcno=${hcno}`,
      captchaRequired: true,
      meta: {
        hcno,
        openstdDetailUrl: `${GBW_OPENSTD_BASE}/bzgk/std/newGbInfo?hcno=${hcno}`,
        capability: 'gated_preview_download',
      },
    };
  }

  async exportStandard(id: string, _opts?: { onProgress?: (current: number, total: number) => void; signal?: AbortSignal }): Promise<ExportResult> {
    throw new BadRequestError('gbw export requires a captcha-assisted download session first');
  }

  async createDownloadSession(id: string, userId: number, opts: { signal?: AbortSignal } = {}): Promise<DownloadSessionInfo> {
    throwIfAborted(opts.signal);
    const detail = await this.getStandardDetail(id);
    const hcno = asString(detail.moreInfo?.hcno);
    console.log(`[gbw] createDownloadSession: id=${id} userId=${userId} hcno=${hcno ?? 'null'} stdNum=${detail.standardNumber}`);

    if (!hcno) {
      throw new BadRequestError('No hcno found for this gbw standard; download is not available');
    }

    // Step 1: 访问 newGbInfo 建立 session cookie
    const infoUrl = `${GBW_DOWNLOAD_BASE}/bzgk/std/newGbInfo?hcno=${hcno}&refer=outter`;
    console.log(`[gbw] createDownloadSession: GET newGbInfo...`);
    const infoResponse = await pooledFetch(infoUrl, {
      headers: { 'User-Agent': USER_AGENT },
      redirect: 'follow',
      signal: opts.signal,
      timeoutMs: 15000,
      retries: 1,
    });
    const infoCookies = infoResponse.headers.getSetCookie?.() ?? [];

    // Step 2: 获取 showGb 下载页面
    const showUrl = `${GBW_DOWNLOAD_BASE}/bzgk/std/showGb?type=download&hcno=${hcno}&request_locale=zh`;
    console.log(`[gbw] createDownloadSession: GET showGb (browser headers)...`);
    const showResponse = await pooledFetch(showUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        'Referer': infoUrl,
        'Cookie': extractCookieHeader(infoCookies),
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'same-origin',
      },
      redirect: 'follow',
      signal: opts.signal,
      timeoutMs: 15000,
      retries: 1,
    });

    const showCookies = showResponse.headers.getSetCookie?.() ?? [];
    const allCookies = [...infoCookies, ...showCookies];
    const cookieHeader = extractCookieHeader(allCookies);
    console.log(`[gbw] createDownloadSession: showGb status=${showResponse.status} totalCookies=${allCookies.length}`);

    // 解析页面判断是否需要验证码
    const showHtml = await showResponse.text();
    const isValidMatch = showHtml.match(/var isValid\s*=\s*['"]([^'"]+)['"]/);
    const isValid = isValidMatch?.[1] ?? 'unknown';
    const hcnoMatch = showHtml.match(/var hcno\s*=\s*['"]([^'"]+)['"]/);
    const pageHcno = hcnoMatch?.[1] ?? hcno;
    console.log(`[gbw] createDownloadSession: isValid="${isValid}" pageHcno="${pageHcno}"`);

    if (!cookieHeader) {
      console.warn(`[gbw] createDownloadSession FAILED: no cookies. status=${showResponse.status}`);
      throw new UpstreamError('Failed to establish gbw download session cookies');
    }

    // Step 3: 获取验证码图片
    const captchaUrl = `${GBW_DOWNLOAD_BASE}/bzgk/std/gc?_${Date.now()}`;
    console.log(`[gbw] createDownloadSession: GET gc captcha...`);
    const captchaResponse = await pooledFetch(captchaUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        Referer: showUrl,
        Cookie: cookieHeader,
        Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      },
      signal: opts.signal,
      timeoutMs: 15000,
      retries: 1,
    });

    if (!captchaResponse.ok) {
      console.warn(`[gbw] gc captcha FAILED: status=${captchaResponse.status}`);
      throw new UpstreamError('Failed to fetch gbw captcha image', { status: captchaResponse.status });
    }

    const captchaBytes = Buffer.from(await captchaResponse.arrayBuffer());
    console.log(`[gbw] createDownloadSession: gc captcha OK: size=${captchaBytes.length}B`);
    const created = this.downloadSessionStore.create({
      userId,
      standardId: id,
      source: 'gbw',
      status: 'captcha_required',
      captchaImageBase64: captchaBytes.toString('base64'),
      captchaContentType: captchaResponse.headers.get('content-type') ?? 'image/jpeg',
      cookies: [cookieHeader],
      showUrl,
      hcno: pageHcno,
      meta: {
        hcno: pageHcno,
        isValid,
        detailUrl: detail.detailUrl,
      },
    });

    return stripDownloadSessionSecrets(created);
  }

  async submitDownloadCaptcha(sessionId: string, code: string, userId: number, opts: { signal?: AbortSignal } = {}): Promise<DownloadSessionInfo> {
    throwIfAborted(opts.signal);
    const session = this.downloadSessionStore.get(sessionId);
    if (!session || session.userId !== userId) {
      throw new NotFoundError(`gbw download session not found: ${sessionId}`);
    }

    const normalizedCode = code.trim();
    if (normalizedCode.length !== 4) {
      throw new BadRequestError('Captcha code must be 4 characters');
    }

    const cookieHeader = session.cookies.join('; ');
    const verifyUrl = `${GBW_DOWNLOAD_BASE}/bzgk/std/verifyCode`;
    // verifyCode is single-use; never retry on 5xx — would burn a fresh captcha.
    console.log(`[gbw] verifyCode: POST ${verifyUrl} code=${normalizedCode} sessionId=${sessionId}`);
    const response = await pooledFetch(verifyUrl, {
      method: 'POST',
      headers: {
        'User-Agent': USER_AGENT,
        Referer: session.showUrl,
        Origin: GBW_DOWNLOAD_BASE,
        'X-Requested-With': 'XMLHttpRequest',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        Cookie: cookieHeader,
      },
      body: new URLSearchParams({ verifyCode: normalizedCode }),
      signal: opts.signal,
      timeoutMs: 15000,
      retries: 1,
    });

    if (!response.ok) {
      console.warn(`[gbw] verifyCode FAILED: status=${response.status}`);
      throw new UpstreamError('Failed to submit gbw captcha', { status: response.status });
    }

    const resultText = (await response.text()).trim();
    const verificationPassed = isVerificationSuccess(resultText);
    const viewUrl = `${GBW_DOWNLOAD_BASE}/bzgk/std/viewGb?hcno=${session.hcno}`;
    console.log(`[gbw] verifyCode: response="${resultText}" passed=${verificationPassed} viewUrl=${viewUrl}`);

    let nextStatus: DownloadSessionInfo['status'] = verificationPassed ? 'verified' : 'failed';
    let nextMeta: Record<string, unknown> = {
      ...session.meta,
      verifyResponse: resultText,
      viewUrl,
    };

    if (verificationPassed) {
      try {
        console.log(`[gbw] verifyCode passed, downloading final file from viewGb...`);
        const fileProbe = await this.tryDownloadFinalFile(session, viewUrl, opts.signal);
        if (fileProbe.kind === 'file') {
          console.log(`[gbw] viewGb OK: kind=file size=${fileProbe.fileSize}B name=${fileProbe.fileName}`);
          nextStatus = 'downloaded';
          nextMeta = {
            ...nextMeta,
            filePath: fileProbe.filePath,
            fileName: fileProbe.fileName,
            contentType: fileProbe.contentType,
            fileSize: fileProbe.fileSize,
          };
        } else {
          console.warn(`[gbw] viewGb returned HTML: contentType=${fileProbe.contentType} preview=${fileProbe.htmlPreview.slice(0, 200)}`);
          nextMeta = {
            ...nextMeta,
            contentType: fileProbe.contentType,
            htmlPreview: fileProbe.htmlPreview,
            note: 'Captcha verification succeeded, but final response was not a direct file stream.',
          };
        }
      } catch (err) {
        // 取消优先：abort 不是文件完整性失败，直接向上传播，禁止降级成 failed 后继续重试。
        if (opts.signal?.aborted) throw opts.signal.reason instanceof Error ? opts.signal.reason : err;
        // download-integrity 抛 UpstreamError（0KB / 非 PDF magic）→ 降级 failed，
        // 让 autoDownloadInner 的 for 循环走下一轮重试（验证码已用、得重拿）。
        // 不 rethrow：抛出去会直接终止 OCR 重试循环，跟单次 OCR 错语义混淆。
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[gbw] tryDownloadFinalFile failed sessionId=${sessionId}: ${msg}`);
        nextStatus = 'failed';
        nextMeta = {
          ...nextMeta,
          note: 'Captcha verified but final file invalid (size/magic check failed).',
          downloadIntegrityError: msg,
        };
      }
    }

    const updated = this.downloadSessionStore.update(sessionId, {
      status: nextStatus,
      meta: nextMeta,
    });

    if (!updated) {
      throw new NotFoundError(`gbw download session not found after update: ${sessionId}`);
    }

    return stripDownloadSessionSecrets(updated);
  }

  async getDownloadSession(sessionId: string, userId: number): Promise<DownloadSessionInfo> {
    const session = this.downloadSessionStore.get(sessionId);
    if (!session || session.userId !== userId) {
      throw new NotFoundError(`gbw download session not found: ${sessionId}`);
    }

    return stripDownloadSessionSecrets(session);
  }

  async autoDownload(id: string, userId: number, maxRetries: number = 3, opts: { signal?: AbortSignal } = {}): Promise<DownloadSessionInfo> {
    // 源级并发限流：GBW autoDownload 含 OCR 识别 + 多次 HTTP 重试，多用户同时跑会
    // 把 OCR worker 队列堆死。4 并发的依据详见 src/shared/source-semaphore.ts
    return getSourceSemaphore('gbw').run(() => this.autoDownloadDirect(id, userId, maxRetries, opts.signal), opts.signal);
  }

  /**
   * 新版下载流程：先访问 newGbInfo 建立会话，再获取 showGb 页面判断是否需要验证码。
   * showGb 页面的 isValid 变量决定是否需要验证码：'true'=直接下载，'false'=需验证码。
   */
  private async autoDownloadDirect(id: string, userId: number, maxRetries: number, signal?: AbortSignal): Promise<DownloadSessionInfo> {
    throwIfAborted(signal);
    console.log(`[gbw] autoDownloadDirect: id=${id} userId=${userId}`);
    const detail = await this.getStandardDetail(id);
    const hcno = asString(detail.moreInfo?.hcno);
    console.log(`[gbw] autoDownloadDirect: stdNum=${detail.standardNumber} hcno=${hcno ?? 'null'}`);

    if (!hcno) {
      throw new BadRequestError('No hcno found for this gbw standard; download is not available');
    }

    // Step 1: 访问 newGbInfo 建立 session cookie
    const infoUrl = `${GBW_DOWNLOAD_BASE}/bzgk/std/newGbInfo?hcno=${hcno}&refer=outter`;
    console.log(`[gbw] autoDownloadDirect Step1: GET newGbInfo to establish session...`);
    const infoResponse = await pooledFetch(infoUrl, {
      headers: { 'User-Agent': USER_AGENT },
      redirect: 'follow',
      signal,
      timeoutMs: 15000,
      retries: 1,
    });
    const infoCookies = infoResponse.headers.getSetCookie?.() ?? [];
    const infoCookieHeader = extractCookieHeader(infoCookies);
    console.log(`[gbw] autoDownloadDirect Step1: newGbInfo status=${infoResponse.status} cookies=${infoCookies.length}`);

    // Step 2: 获取 showGb 下载页面（需要浏览器头才能拿到验证码页面而非重定向）
    const showUrl = `${GBW_DOWNLOAD_BASE}/bzgk/std/showGb?type=download&hcno=${hcno}&request_locale=zh`;
    console.log(`[gbw] autoDownloadDirect Step2: GET showGb (browser headers)...`);
    const showResponse = await pooledFetch(showUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        'Referer': infoUrl,
        'Cookie': infoCookieHeader,
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'same-origin',
      },
      redirect: 'follow',
      signal,
      timeoutMs: 15000,
      retries: 1,
    });
    const showCookies = showResponse.headers.getSetCookie?.() ?? [];
    const allCookies = [...infoCookies, ...showCookies];
    const cookieHeader = extractCookieHeader(allCookies);
    console.log(`[gbw] autoDownloadDirect Step2: showGb status=${showResponse.status} totalCookies=${allCookies.length}`);

    if (!cookieHeader) {
      throw new UpstreamError('Failed to establish gbw download session cookies');
    }

    // 解析页面判断是否需要验证码
    const showHtml = await showResponse.text();
    const isValidMatch = showHtml.match(/var isValid\s*=\s*['"]([^'"]+)['"]/);
    const isValid = isValidMatch?.[1] ?? 'unknown';
    const hcnoMatch = showHtml.match(/var hcno\s*=\s*['"]([^'"]+)['"]/);
    const pageHcno = hcnoMatch?.[1] ?? hcno;
    console.log(`[gbw] autoDownloadDirect Step2: isValid="${isValid}" pageHcno="${pageHcno}"`);

    if (isValid === 'true') {
      // 不需要验证码，直接下载
      const viewUrl = `${GBW_DOWNLOAD_BASE}/bzgk/std/viewGb?hcno=${pageHcno}`;
      console.log(`[gbw] autoDownloadDirect Step3: GET viewGb (no captcha needed)...`);
      try {
        const fileResult = await this.tryDownloadFinalFile(
          { cookies: [cookieHeader], showUrl, hcno: pageHcno, standardId: id },
          viewUrl,
          signal
        );

        if (fileResult.kind === 'file') {
          console.log(`[gbw] autoDownloadDirect SUCCESS: size=${fileResult.fileSize}B name=${fileResult.fileName}`);
          const session = this.downloadSessionStore.create({
            userId,
            standardId: id,
            source: 'gbw',
            status: 'downloaded',
            cookies: [cookieHeader],
            showUrl,
            hcno: pageHcno,
            meta: {
              hcno: pageHcno,
              filePath: fileResult.filePath,
              fileName: fileResult.fileName,
              fileSize: fileResult.fileSize,
              directDownload: true,
            },
          });
          return stripDownloadSessionSecrets(session);
        }

        console.warn(`[gbw] autoDownloadDirect: viewGb returned HTML, falling back to captcha flow`);
      } catch (e: any) {
        if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : e;
        console.log(`[gbw] Direct download failed: ${e?.message || e}, falling back to captcha flow`);
      }
    }

    // 需要验证码或直接下载失败，回退到验证码流程
    return this.autoDownloadInner(id, userId, maxRetries, signal);
  }

  private async autoDownloadInner(id: string, userId: number, maxRetries: number, signal?: AbortSignal): Promise<DownloadSessionInfo> {
    const attempts: OcrAttemptLog[] = [];
    console.log(`[gbw] autoDownloadInner: id=${id} maxRetries=${maxRetries}`);
    // First round creates the session (fetches cookie + captcha image). Subsequent
    // rounds reuse the cookie and only fetch a new captcha image, saving one HTTP
    // round-trip per retry.
    let session: DownloadSessionInfo | undefined;

    for (let round = 1; round <= maxRetries; round++) {
      throwIfAborted(signal);
      console.log(`[gbw] autoDownloadInner: round ${round}/${maxRetries}`);
      if (!session) {
        session = await this.createDownloadSession(id, userId, { signal });
      } else {
        const refreshed = await this.refreshSessionCaptcha(session.id, signal);
        if (refreshed) session = refreshed;
        else session = await this.createDownloadSession(id, userId, { signal }); // session expired — restart
      }

      if (!session.captchaImageBase64) {
        throw new UpstreamError('No captcha image in download session');
      }

      throwIfAborted(signal);
      const ocrResult = await ocrCaptcha(session.captchaImageBase64);
      const code = ocrResult.text.slice(0, 4);
      console.log(`[gbw] OCR round ${round}: raw="${ocrResult.rawText}" code="${code}" confidence=${ocrResult.confidence}`);

      if (code.length !== 4) {
        console.warn(`[gbw] OCR round ${round}: code length ${code.length} != 4, skipping`);
        attempts.push({ round, sessionId: session.id, ocrText: ocrResult.rawText, ocrConfidence: ocrResult.confidence, submittedCode: code, error: `OCR returned ${code.length} chars` });
        continue;
      }

      throwIfAborted(signal);
      const result = await this.submitDownloadCaptcha(session.id, code, userId, { signal });
      const record = this.downloadSessionStore.get(session.id);
      const verifyResponse = asString(record?.meta?.verifyResponse) ?? '';
      const integrityErr = asString(record?.meta?.downloadIntegrityError);
      console.log(`[gbw] captcha round ${round}: result=${result.status} verifyResponse="${verifyResponse}"`);

      attempts.push({
        round, sessionId: session.id, ocrText: ocrResult.rawText,
        ocrConfidence: ocrResult.confidence, submittedCode: code,
        verifyResponse, resultStatus: result.status,
        error: integrityErr ? `download-integrity: ${integrityErr}` : undefined,
      });

      if (result.status === 'downloaded' && record) {
        this.downloadSessionStore.update(session.id, {
          meta: {
            ...record.meta,
            ocrText: ocrResult.rawText,
            ocrConfidence: ocrResult.confidence,
            autoSubmitted: true,
            attempts,
            totalRounds: round,
          },
        });
        return stripDownloadSessionSecrets(this.downloadSessionStore.get(session.id) ?? result);
      }

      if (record) {
        this.downloadSessionStore.update(session.id, {
          meta: {
            ...record.meta,
            ocrText: ocrResult.rawText,
            ocrConfidence: ocrResult.confidence,
            autoSubmitted: true,
            retryAttempt: round,
          },
        });
      }
    }

    const integrityErrors = attempts.filter(a => a.error && a.error.includes('download-integrity'));
    const hasIntegrityIssue = integrityErrors.length > 0;
    const ocrFailures = attempts.filter(a => a.error && !a.error.includes('download-integrity'));
    const errorDetail = hasIntegrityIssue
      ? `Captcha 验证通过但 ${integrityErrors.length}/${maxRetries} 次文件下载返回空响应（上游不稳定）`
      : ocrFailures.length > 0
        ? `All ${maxRetries} OCR attempts failed to produce correct captcha`
        : `All ${maxRetries} download attempts failed (captcha submitted but download never completed)`;

    console.warn(`[gbw] autoDownloadInner FAILED: ${errorDetail}`);
    return {
      id: `gbw_auto_${Date.now()}`,
      standardId: id,
      source: 'gbw',
      status: 'failed',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      captchaImageBase64: undefined,
      meta: {
        attempts,
        maxRetries,
        hasIntegrityIssue,
        error: errorDetail,
      },
    };
  }

  /**
   * Re-fetch the captcha image on an existing session without rebuilding cookies.
   * Returns undefined if the session has been evicted from the store (caller should
   * fall back to createDownloadSession).
   */
  private async refreshSessionCaptcha(sessionId: string, signal?: AbortSignal): Promise<DownloadSessionInfo | undefined> {
    throwIfAborted(signal);
    const record = this.downloadSessionStore.get(sessionId);
    if (!record) {
      console.warn(`[gbw] refreshSessionCaptcha: session ${sessionId} not found in store, will recreate`);
      return undefined;
    }
    const cookieHeader = record.cookies.join('; ');
    const captchaUrl = `${GBW_DOWNLOAD_BASE}/bzgk/std/gc?_${Date.now()}`;
    console.log(`[gbw] refreshSessionCaptcha: GET gc for existing session ${sessionId}`);
    const captchaResponse = await pooledFetch(captchaUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        Referer: record.showUrl,
        Cookie: cookieHeader,
        Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      },
      signal,
      timeoutMs: 15000,
      retries: 1,
    });
    if (!captchaResponse.ok) {
      console.warn(`[gbw] refreshSessionCaptcha: gc failed status=${captchaResponse.status}, will recreate session`);
      return undefined;
    }
    const captchaBytes = Buffer.from(await captchaResponse.arrayBuffer());
    console.log(`[gbw] refreshSessionCaptcha: gc OK size=${captchaBytes.length}B`);
    const updated = this.downloadSessionStore.update(sessionId, {
      status: 'captcha_required',
      captchaImageBase64: captchaBytes.toString('base64'),
      captchaContentType: captchaResponse.headers.get('content-type') ?? 'image/jpeg',
    });
    if (!updated) return undefined;
    return stripDownloadSessionSecrets(updated);
  }

  private async tryDownloadFinalFile(
    session: { cookies: string[]; showUrl: string; hcno: string; standardId: string },
    viewUrl: string,
    signal?: AbortSignal,
  ): Promise<
    | { kind: 'file'; filePath: string; fileName: string; fileSize: number; contentType: string }
    | { kind: 'html'; contentType: string; htmlPreview: string }
  > {
    const cookieHeader = session.cookies.join('; ');
    console.log(`[gbw] viewGb: GET ${viewUrl} hcno=${session.hcno}`);
    const response = await pooledFetch(viewUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        Referer: session.showUrl,
        Cookie: cookieHeader,
      },
      redirect: 'follow',
      signal,
      timeoutMs: 30000,
      retries: 1,
    });

    if (!response.ok) {
      console.warn(`[gbw] viewGb FAILED: status=${response.status} statusText=${response.statusText}`);
      throw new UpstreamError('Failed to fetch gbw final download response', { status: response.status });
    }

    const rawContentType = response.headers.get('content-type') ?? '';
    const contentType = rawContentType.replace(/^content-type:\s*/i, '').toLowerCase();
    const contentLength = response.headers.get('content-length');
    console.log(`[gbw] viewGb: status=${response.status} contentType="${contentType}" contentLength=${contentLength}`);

    if (contentType.includes('html')) {
      const htmlPreview = (await response.text()).slice(0, 4000);
      console.warn(`[gbw] viewGb: returned HTML page (not PDF). preview=${htmlPreview.slice(0, 300)}`);
      return {
        kind: 'html',
        contentType,
        htmlPreview,
      };
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    console.log(`[gbw] viewGb: downloaded ${bytes.length}B, running assertDownloadedPdf...`);
    // 防 0KB / 错误页：buffer 校验失败抛 UpstreamError，被 autoDownloadInner 的 OCR
    // 重试循环 catch + 走下一轮 —— 不用动重试代码就拿到自动重试
    assertDownloadedPdf(bytes, `gbw hcno=${session.hcno}`);
    const detail = await this.getStandardDetail(session.standardId);
    const fileName = buildFileName(detail.standardNumber, detail.title, guessExtension(contentType));
    const filePath = path.join(getExportsDir(), fileName);
    await ensureExportsDir();
    await writeFile(filePath, bytes);
    console.log(`[gbw] viewGb: saved to ${filePath} (${bytes.length}B)`);

    return {
      kind: 'file',
      filePath,
      fileName,
      fileSize: bytes.length,
      contentType,
    };
  }

  private async checkOpenstdHasText(hcno: string): Promise<boolean> {
    try {
      const url = `${GBW_OPENSTD_BASE}/bzgk/std/newGbInfo?hcno=${hcno}`;
      const resp = await pooledFetch(url, {
        headers: { 'User-Agent': USER_AGENT },
        timeoutMs: 12000,
        retries: 1,
      });
      if (!resp.ok) return false;
      const html = await resp.text();
      // ck_btn = 在线预览, xz_btn = 下载标准 — both only present when text is available
      return html.includes('class="btn ck_btn') || html.includes('class="btn xz_btn');
    } catch {
      return false;
    }
  }

  private mapSearchRow(row: GbwSearchRow): StandardSummary {
    const sourceId = row.id ?? '';
    const standardNumber = parseStdCode(row.C_STD_CODE ?? '');
    const title = cleanText(row.C_C_NAME ?? '');
    const status = cleanText(row.STATE ?? '');
    const standardType = cleanText(row.STD_NATURE ?? '');

    return {
      id: createStandardId('gbw', sourceId),
      source: 'gbw',
      sourceId,
      standardNumber,
      title,
      standardType: standardType || undefined,
      status: status || undefined,
      publishDate: row.ISSUE_DATE ?? null,
      implementDate: row.ACT_DATE ?? null,
      abolishedDate: null,
      // Optimistic: assume text available for non-废弃 standards (most have text).
      // Batch check will correct to false if no text found.
      previewAvailable: !status || !status.includes('废止'),
      detailUrl: `${GBW_STD_BASE}/gb/search/gbDetailed?id=${sourceId}`,
      meta: row as Record<string, unknown>,
    };
  }
}

function parseStdCode(value: string): string {
  return cleanText(value).replace(/\s*\/\s*/g, '/');
}

function cleanText(value: string): string {
  return value
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractFieldMap($: any): Record<string, string> {
  const map: Record<string, string> = {};
  const titles = $('.title').toArray();
  for (const element of titles) {
    const title = cleanText($(element).text()).replace(/[:：]$/u, '');
    const content = cleanText($(element).next('.content').text());
    if (title) {
      map[title] = content;
    }
  }
  return map;
}

function extractBasicInfoField($: any, name: string): string | undefined {
  const names = $('.basicInfo-item.name').toArray();
  for (const element of names) {
    const label = cleanText($(element).text());
    if (label === name) {
      return cleanText($(element).next('.basicInfo-item.value').text()) || undefined;
    }
  }

  return undefined;
}

function extractHcno(html: string): string | undefined {
  const match = html.match(/hcno=([A-Fa-f0-9]{32})/);
  return match?.[1];
}

function extractCookieHeader(setCookies: string[]): string {
  return setCookies
    .map((value) => value.split(';')[0])
    .filter(Boolean)
    .join('; ');
}

function isVerificationSuccess(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === 'true' || normalized === 'success' || normalized === 'ok' || normalized === '1';
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function stripDownloadSessionSecrets(session: DownloadSessionInfo & { cookies?: string[]; showUrl?: string; hcno?: string }): DownloadSessionInfo {
  const { id, standardId, source, status, captchaImageBase64, captchaContentType, createdAt, updatedAt, meta } = session;
  return {
    id,
    standardId,
    source,
    status,
    captchaImageBase64,
    captchaContentType,
    createdAt,
    updatedAt,
    meta,
  };
}

function guessExtension(contentType: string): string {
  if (contentType.includes('pdf')) {
    return 'pdf';
  }
  if (contentType.includes('zip')) {
    return 'zip';
  }
  if (contentType.includes('msword') || contentType.includes('wordprocessingml')) {
    return 'docx';
  }
  if (contentType.includes('octet-stream') || contentType.includes('binary')) {
    return 'pdf'; // gbw viewGb always returns PDF; fallback to .pdf
  }
  return 'pdf';
}

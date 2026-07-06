import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import type {
  ExportResult,
  PreviewInfo,
  SearchStandardsInput,
  SourceAdapter,
  StandardDetail,
  StandardSummary,
} from '../../domain/standard';
import { BadRequestError, NotFoundError, UpstreamError } from '../../shared/errors';
import { assertDownloadedPdf } from '../../shared/download-integrity';
import { buildFileName, getExportsDir } from '../../shared/fs';
import { createStandardId, parseStandardId } from '../../shared/id';
import { searchCache } from '../../shared/cache';
import { pooledFetch } from '../../shared/http';
import { getSourceSemaphore } from '../../shared/source-semaphore';

// BY 内网系统配置（仅在 172.16.0.0/12 内网可达）。凭据必须从 .env.local
// 或真实环境变量注入，避免把账号密码写入仓库。
const BY_BASE = 'http://172.16.100.72:8080';
const LOGIN_URL = `${BY_BASE}/login.aspx`;
const MAX_PAGES = 5;
const TIMEOUT_MS = 10000;
const TIMEOUT_FAST_MS = 5000;

type ByRequestOptions = Pick<SearchStandardsInput, 'signal' | 'timeoutMs'>;

function readCredentials(): { deptId: string; username: string; password: string } {
  const deptId = process.env.BY_DEPT_ID?.trim();
  const username = process.env.BY_USERNAME?.trim();
  const password = process.env.BY_PASSWORD?.trim();
  if (!deptId || !username || !password) {
    throw new UpstreamError('BY 源凭据未配置：请在仓库根 .env.local 设置 BY_USERNAME / BY_PASSWORD / BY_DEPT_ID');
  }
  return { deptId, username, password };
}

interface BySearchItem {
  idx: number;
  stdNo: string;
  stdName: string;
  status: string;
  publish: string;
  implement: string;
  siid: string;
  pdfPath: string;
}

export class ByAdapter implements SourceAdapter {
  readonly source = 'by' as const;

  private sessionCookies: string | null = null;
  private loggedIn = false;
  /** In-flight login: concurrent callers share the same Promise instead of each
   * kicking off their own 3-step login dance against the upstream. */
  private loginInFlight: Promise<boolean> | null = null;
  /** Negative cache: once isAvailable fails (e.g. outside the LAN), don't
   * waste 3 seconds on every search/download call re-checking. Re-probe at
   * most every 60s so connectivity returning is detected without spamming. */
  private availabilityCache: { value: boolean; checkedAt: number } | null = null;
  private static readonly AVAILABILITY_CACHE_TTL_MS = 60_000;

  async searchStandards(input: SearchStandardsInput): Promise<StandardSummary[]> {
    const cacheKey = `by:search:${input.query}`;
    const cached = searchCache.get<StandardSummary[]>(cacheKey);
    if (cached) return cached;

    if (!(await this.isAvailable(input))) {
      throw new UpstreamError('BY internal network is not accessible');
    }

    if (!(await this.ensureLogin(input))) {
      throw new UpstreamError('BY login failed');
    }

    const keyword = input.query;
    let items = await this.searchInternal(keyword, input);

    // If no results and session might have expired, re-login and retry once
    if (items.length === 0 && this.loggedIn) {
      this.loggedIn = false;
      this.sessionCookies = null;
      if (await this.ensureLogin(input)) {
        items = await this.searchInternal(keyword, input);
      }
    }

    const result = items.map((item) => this.mapSearchItem(item));
    searchCache.set(cacheKey, result);
    // Side cache: raw items keyed by sourceId so getStandardDetail can skip a round-trip
    for (const item of items) {
      const sid = item.siid || item.stdNo;
      if (sid) searchCache.set(`by:item:${sid}`, item, 10 * 60 * 1000);
    }
    return result;
  }

  async getStandardDetail(id: string): Promise<StandardDetail> {
    const { sourceId } = parseStandardId(id);

    // Fast path: use the raw item cached during a recent search
    const cachedItem = searchCache.get<BySearchItem>(`by:item:${sourceId}`);
    if (cachedItem) {
      return this.mapDetail(cachedItem, id);
    }

    if (!(await this.ensureLogin())) {
      throw new UpstreamError('BY login failed');
    }

    const searchResults = await this.searchInternal(sourceId);
    const match = searchResults.find((item) => item.siid === sourceId || item.stdNo === sourceId);

    if (!match && !searchResults.length) {
      throw new NotFoundError(`BY detail not found for ${id}`);
    }

    const item = match ?? searchResults[0];
    searchCache.set(`by:item:${sourceId}`, item, 10 * 60 * 1000);
    return this.mapDetail(item, id);
  }

  async detectPreview(id: string): Promise<PreviewInfo> {
    const detail = await this.getStandardDetail(id);

    const downloadUrl =
      typeof detail.moreInfo?.pdfPath === 'string' ? this.resolvePdfUrl(detail.moreInfo.pdfPath) : '';

    return {
      standardId: id,
      pageUrls: [],
      previewUrl: `${BY_BASE}/Manager/StandManager/StandDetail.aspx?SIId=${detail.sourceId}`,
      downloadUrl: downloadUrl || undefined,
      captchaRequired: false,
      fileType: 'pdf',
      meta: {
        siid: detail.sourceId,
        pdfPath: detail.moreInfo?.pdfPath ?? null,
        capability: 'direct_pdf_download',
      },
    };
  }

  async exportStandard(id: string, onProgress?: (current: number, total: number) => void): Promise<ExportResult> {
    // 源级并发限流：BY 内网直 PDF，4 并发上限避免单台机器对内网 IIS 过度施压（详见
    // src/shared/source-semaphore.ts）
    return getSourceSemaphore('by').run(() => this.exportStandardInner(id, onProgress));
  }

  private async exportStandardInner(id: string, _onProgress?: (current: number, total: number) => void): Promise<ExportResult> {
    if (!(await this.ensureLogin())) {
      throw new UpstreamError('BY login failed');
    }

    const { sourceId } = parseStandardId(id);

    // Access detail page directly using siid
    const detailUrl = `${BY_BASE}/Manager/StandManager/StandDetail.aspx?SIId=${encodeURIComponent(sourceId)}`;
    let html: string;
    try {
      const resp = await pooledFetch(detailUrl, {
        headers: { Cookie: this.sessionCookies ?? '' },
        timeoutMs: TIMEOUT_FAST_MS,
        retries: 2,
      });
      if (!resp.ok) {
        throw new UpstreamError('BY detail page not accessible');
      }
      html = await resp.text();
    } catch (err) {
      throw new UpstreamError('BY export failed: cannot access detail page');
    }

    // Extract standard info from detail page
    const stdNo = stripHtml(extractRegex(html, /id="txtA100"[^>]*>([^<]+)/));
    const stdName = stripHtml(extractRegex(html, /id="txtA298"[^>]*>([^<]+)/));

    // Extract PDF path from hidden field
    const pdfPathMatch = html.match(/name="hidB000"[^>]+value="([^"]+)"/);
    if (!pdfPathMatch?.[1]) {
      throw new UpstreamError('BY export failed: no PDF path found on detail page');
    }

    const pdfUrl = this.resolvePdfUrl(pdfPathMatch[1]);
    const fileName = buildFileName(stdNo || sourceId, stdName || 'unknown');
    const filePath = path.join(getExportsDir(), fileName);

    const downloaded = await this.downloadPdf(pdfUrl, filePath);
    if (!downloaded) {
      throw new UpstreamError('BY export failed: PDF download failed');
    }

    return { standardId: id, filePath, fileName };
  }

  // --- Internal Methods ---

  private async isAvailable(options: ByRequestOptions = {}): Promise<boolean> {
    const cached = this.availabilityCache;
    if (cached && Date.now() - cached.checkedAt < ByAdapter.AVAILABILITY_CACHE_TTL_MS) {
      return cached.value;
    }
    try {
      const resp = await pooledFetch(BY_BASE, {
        method: 'HEAD',
        signal: options.signal,
        timeoutMs: Math.min(options.timeoutMs ?? 3000, 3000),
        retries: 1,
      });
      this.availabilityCache = { value: resp.ok, checkedAt: Date.now() };
      return resp.ok;
    } catch (err) {
      // Only log the first failure within a cache window — repeated logs from
      // every search/download call outside the corporate LAN are pure noise.
      if (!cached || cached.value) {
        console.warn('[by-adapter] isAvailable check failed (will cache 60s):', err instanceof Error ? err.message : String(err));
      }
      this.availabilityCache = { value: false, checkedAt: Date.now() };
      return false;
    }
  }

  private async ensureLogin(options: ByRequestOptions = {}): Promise<boolean> {
    if (this.loggedIn) return true;
    if (this.loginInFlight) return this.loginInFlight;
    this.loginInFlight = this.performLogin(options).finally(() => {
      this.loginInFlight = null;
    });
    return this.loginInFlight;
  }

  private async performLogin(options: ByRequestOptions = {}): Promise<boolean> {
    try {
      const credentials = readCredentials();
      const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
      // Step 1: GET login page
      const r1 = await pooledFetch(LOGIN_URL, { signal: options.signal, timeoutMs, retries: 1 });
      if (!r1.ok) {
        console.warn(`[by-adapter] login step 1 (GET login page) returned HTTP ${r1.status}`);
        return false;
      }

      const html1 = await r1.text();
      const cookies1 = extractSetCookie(r1);
      const vs1 = extractHiddenField(html1, '__VIEWSTATE');
      const ev1 = extractHiddenField(html1, '__EVENTVALIDATION');

      if (!vs1 || !ev1) {
        console.warn('[by-adapter] login step 1: missing __VIEWSTATE or __EVENTVALIDATION');
        return false;
      }

      // Step 2: POST department selection
      const deptBody = new URLSearchParams({
        __EVENTTARGET: 'ddlDept',
        __EVENTARGUMENT: '',
        __VIEWSTATE: vs1,
        __EVENTVALIDATION: ev1,
        ddlDept: credentials.deptId,
      });

      const r2 = await pooledFetch(LOGIN_URL, {
        method: 'POST',
        headers: mergeHeaders(cookies1, { 'Content-Type': 'application/x-www-form-urlencoded' }),
        body: deptBody.toString(),
        signal: options.signal,
        timeoutMs,
        retries: 1,
      });
      if (!r2.ok) {
        console.warn(`[by-adapter] login step 2 (dept select) returned HTTP ${r2.status}`);
        return false;
      }

      const html2 = await r2.text();
      const cookies2 = mergeCookies(cookies1, extractSetCookie(r2));
      const vs2 = extractHiddenField(html2, '__VIEWSTATE');
      const ev2 = extractHiddenField(html2, '__EVENTVALIDATION');

      if (!vs2 || !ev2) {
        console.warn('[by-adapter] login step 2: missing __VIEWSTATE or __EVENTVALIDATION after dept select');
        return false;
      }

      // Step 3: POST credentials
      const loginBody = new URLSearchParams({
        __EVENTTARGET: '',
        __EVENTARGUMENT: '',
        __VIEWSTATE: vs2,
        __EVENTVALIDATION: ev2,
        ddlDept: credentials.deptId,
        ddlUserName: credentials.username,
        txtLogidPwd: credentials.password,
        btnLogin: '登录',
      });

      const r3 = await pooledFetch(LOGIN_URL, {
        method: 'POST',
        headers: mergeHeaders(cookies2, { 'Content-Type': 'application/x-www-form-urlencoded' }),
        body: loginBody.toString(),
        redirect: 'manual',
        signal: options.signal,
        timeoutMs,
        retries: 1,
      });

      if (r3.status !== 302) {
        console.warn(`[by-adapter] login step 3 (credentials) expected 302 redirect, got HTTP ${r3.status} — credentials likely wrong`);
        return false;
      }

      const cookies3 = mergeCookies(cookies2, extractSetCookie(r3));
      const location = r3.headers.get('location');

      // Step 4: Follow landing page
      if (location) {
        const landingUrl = location.startsWith('http') ? location : `${BY_BASE}${location}`;
        const r4 = await pooledFetch(landingUrl, {
          headers: { Cookie: cookies3 },
          signal: options.signal,
          timeoutMs,
          retries: 1,
        });
        this.sessionCookies = mergeCookies(cookies3, extractSetCookie(r4));
      } else {
        this.sessionCookies = cookies3;
      }

      this.loggedIn = true;
      return true;
    } catch (err) {
      console.warn('[by-adapter] login failed:', err instanceof Error ? err.message : String(err));
      return false;
    }
  }

  private async searchInternal(keyword: string, options: ByRequestOptions = {}): Promise<BySearchItem[]> {
    const searchUrl = `${BY_BASE}/Customer/StandSerarch/StandInfoList.aspx?A100=${encodeURIComponent(keyword)}&A298=`;
    const cookieHeader = this.sessionCookies ?? '';
    const results: BySearchItem[] = [];
    const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;

    try {
      const r1 = await pooledFetch(searchUrl, {
        headers: { Cookie: cookieHeader },
        signal: options.signal,
        timeoutMs,
        retries: options.signal ? 1 : 2,
      });
      if (!r1.ok) return [];

      const html1 = await r1.text();
      results.push(...parseSearchPage(html1));

      // Pagination
      const totalPages = parseTotalPages(html1);
      const pagesToFetch = Math.min(totalPages, MAX_PAGES);

      let viewstate = extractHiddenField(html1, '__VIEWSTATE');
      let eventvalidation = extractHiddenField(html1, '__EVENTVALIDATION');

      for (let pageIdx = 2; pageIdx <= pagesToFetch; pageIdx++) {
        const body = new URLSearchParams({
          __EVENTTARGET: 'AspNetPager1',
          __EVENTARGUMENT: String(pageIdx),
          __VIEWSTATE: viewstate ?? '',
          __EVENTVALIDATION: eventvalidation ?? '',
          inputA100: keyword,
          inputA298: '',
        });

        const resp = await pooledFetch(searchUrl, {
          method: 'POST',
          headers: {
            Cookie: cookieHeader,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: body.toString(),
          signal: options.signal,
          timeoutMs,
          retries: 1,
        });

        if (!resp.ok) break;

        const html = await resp.text();
        results.push(...parseSearchPage(html));

        viewstate = extractHiddenField(html, '__VIEWSTATE');
        eventvalidation = extractHiddenField(html, '__EVENTVALIDATION');
      }
    } catch (err) {
      // Pagination failure is non-fatal: we keep whatever we collected so far,
      // but record the cause for diagnostics.
      console.warn('[by-adapter] search pagination error:', err instanceof Error ? err.message : String(err));
    }

    return results;
  }

  private resolvePdfUrl(pdfPath: string): string {
    const cleaned = pdfPath.replace(/^~/, '').replace(/^\/+/, '');
    if (pdfPath.startsWith('~')) {
      return `${BY_BASE}/${cleaned}`;
    }
    if (pdfPath.startsWith('/')) {
      return `${BY_BASE}${pdfPath}`;
    }
    return `${BY_BASE}/${pdfPath}`;
  }

  private async downloadPdf(pdfUrlOrPath: string, filePath: string): Promise<boolean> {
    try {
      const url = pdfUrlOrPath.startsWith('http') ? pdfUrlOrPath : this.resolvePdfUrl(pdfUrlOrPath);
      const resp = await pooledFetch(url, {
        headers: { Cookie: this.sessionCookies ?? '' },
        timeoutMs: TIMEOUT_FAST_MS,
        retries: 2,
      });
      if (!resp.ok) {
        console.warn(`[by-adapter] downloadPdf got HTTP ${resp.status} from ${url}`);
        return false;
      }

      const bytes = Buffer.from(await resp.arrayBuffer());
      // 防 0KB / 错误页：buffer 校验失败抛 UpstreamError，被本函数 catch → return false，
      // 走 by 现有"下载失败重试或换源"路径
      assertDownloadedPdf(bytes, `by url=${url}`);
      await writeFile(filePath, bytes);
      return true;
    } catch (err) {
      console.warn('[by-adapter] downloadPdf failed:', err instanceof Error ? err.message : String(err));
      return false;
    }
  }

  private mapSearchItem(item: BySearchItem): StandardSummary {
    return this.toSummary(item, createStandardId('by', item.siid || item.stdNo));
  }

  private mapDetail(item: BySearchItem, id: string): StandardDetail {
    return {
      ...this.toSummary(item, id),
      contentText: '',
      moreInfo: {
        siid: item.siid,
        pdfPath: item.pdfPath,
      },
    };
  }

  private toSummary(item: BySearchItem, id: string): StandardSummary {
    return {
      id,
      source: 'by',
      sourceId: item.siid || item.stdNo,
      standardNumber: item.stdNo,
      title: item.stdName,
      status: item.status || undefined,
      publishDate: item.publish || null,
      implementDate: item.implement || null,
      abolishedDate: null,
      previewAvailable: Boolean(item.pdfPath),
      detailUrl: `${BY_BASE}/Manager/StandManager/StandDetail.aspx?SIId=${item.siid}`,
      meta: item as unknown as Record<string, unknown>,
    };
  }
}

// --- HTML Parsing Helpers ---

function extractHiddenField(html: string, name: string): string | null {
  const match = html.match(new RegExp(`name="${name}"[^>]+value="([^"]+)"`));
  return match?.[1] ?? null;
}

function extractSetCookie(resp: Response): string {
  const cookies = resp.headers.getSetCookie?.() ?? [];
  return cookies.map((c) => c.split(';')[0]).filter(Boolean).join('; ');
}

function mergeCookies(existing: string, incoming: string): string {
  if (!incoming) return existing;
  if (!existing) return incoming;

  const map = new Map<string, string>();
  for (const c of existing.split(';')) {
    const [key, ...rest] = c.trim().split('=');
    if (key) map.set(key, rest.join('='));
  }
  for (const c of incoming.split(';')) {
    const [key, ...rest] = c.trim().split('=');
    if (key) map.set(key, rest.join('='));
  }

  return Array.from(map.entries())
    .map(([k, v]) => (v ? `${k}=${v}` : k))
    .join('; ');
}

function mergeHeaders(cookie: string, extra: Record<string, string>): HeadersInit {
  const headers: Record<string, string> = { ...extra };
  if (cookie) {
    headers['Cookie'] = cookie;
  }
  return headers;
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}


function parseSearchPage(html: string): BySearchItem[] {
  // Extract result blocks using regex (as in the Python reference)
  const blocks = html.match(/<table[\s\S]*?class="mt20"[\s\S]*?rpStand_HidSIId_\d[\s\S]*?<\/table>/gi) ?? [];

  return blocks.map((block, idx) => {
    const stdNo = stripHtml(extractRegex(block, /class="\s*c333 f16\s*">\s*([^<]+)/));
    const stdName = stripHtml(extractRegex(block, /<p\s+class="c333 mt5">\s*([^<]+)/));
    const status = stripHtml(extractRegex(block, /标准状态：<span\s+class='[^']*'>([^<]+)/));
    const publish = stripHtml(extractRegex(block, /发布日期：([0-9-]+)/));
    const implement = stripHtml(extractRegex(block, /实施日期：([0-9-]+)/));
    const siid = extractRegex(block, /id="rpStand_HidSIId_\d"\s+value="([^"]+)"/);
    const pdfPath = extractRegex(block, /id="rpStand_hdfB000_\d"\s+value="([^"]+)"/);

    return {
      idx: idx + 1,
      stdNo,
      stdName,
      status,
      publish,
      implement,
      siid,
      pdfPath,
    };
  });
}

function extractRegex(text: string, pattern: RegExp): string {
  const match = text.match(pattern);
  return match?.[1]?.trim() ?? '';
}

function parseTotalPages(html: string): number {
  const match = html.match(/当前页：<font[^>]*><b>\d+\/(\d+)<\/b>/);
  return match?.[1] ? parseInt(match[1], 10) : 1;
}

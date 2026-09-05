import type { Browser, LaunchOptions, Page } from 'playwright';

const CNAS_BASE = 'https://las.cnas.org.cn/LAS/publish';

export interface CnasCapability {
  num: number;
  objCh: string;
  paramNum: number;
  paramCh: string;
  paramEn: string;
  stdDescAndClause: string;
  stdDescAndClauseEn: string;
  stdCode: string;
  stdCodeEn: string;
  stdAllDesc: string;
  stdAllDescEn: string;
  limitCh: string;
  limitEn: string;
  stdStatus: number;
  bigTypeName: string;
  bigTypeNameE: string;
  typeName: string;
  typeNameE: string;
  startDate: string;
  branchId: string;
  objId: string;
  paramId: string;
  objStdId: string;
}

interface CnasApiResponse {
  totalSize: number;
  startIndex: number;
  sizePerPage: number;
  data: CnasCapability[];
}

export interface CnasLabInfo {
  baseInfoId: string;
  labNo: string;
  labName: string;
  certUpdateTs: string;
  validate: string;
  /** Extra URL params required by CNAS site (id, labType, scopeStr, orgEnOrCh, etc.) */
  urlParams: Record<string, string>;
}

export interface CnasOrgInfo {
  regNo: string;
  otherNames: string;
  address: string;
  validityPeriod: string;
  certTasks: CnasCertTask[];
}

export interface CnasCertTask {
  taskNo: string;
  reviewType: string;
  signDate: string;
  scopeStatus: string;
}

/**
 * Use Playwright's version-matched Chromium by default. Branded Google Chrome
 * starts Crashpad before page creation and can SIGTRAP in hardened read-only
 * containers. A channel remains available as an explicit compatibility escape hatch.
 */
export function getCnasBrowserLaunchOptions(
  env: NodeJS.ProcessEnv = process.env,
): LaunchOptions {
  const channel = env.CNAS_BROWSER_CHANNEL?.trim();
  return {
    headless: true,
    ...(channel ? { channel } : {}),
    args: ['--disable-blink-features=AutomationControlled'],
  };
}

export class CnasScraper {
  /** Shared headless Chromium. Each sync job creates its own context + page
   *  so multiple users can sync different labs in parallel without colliding. */
  private browser: import('playwright').Browser | null = null;
  private browserLaunch: Promise<import('playwright').Browser> | null = null;

  /** Cap concurrent CNAS pages to keep CNAS's anti-bot from tripping. */
  private maxConcurrent = 3;
  private activePages = 0;
  private waiters: Array<() => void> = [];

  /** Launch (or return) the shared headless Chromium. De-duped under load. */
  private async ensureBrowser(): Promise<import('playwright').Browser> {
    if (this.browser && this.browser.isConnected()) return this.browser;
    if (!this.browserLaunch) {
      this.browserLaunch = (async () => {
        const pw = await import('playwright');
        const b = await pw.chromium.launch(getCnasBrowserLaunchOptions());
        b.on('disconnected', () => { this.browser = null; this.browserLaunch = null; });
        this.browser = b;
        return b;
      })().catch(err => { this.browserLaunch = null; throw err; });
    }
    return this.browserLaunch;
  }

  /** Acquire a concurrency slot; waits if maxConcurrent already running. */
  private async acquireSlot(): Promise<void> {
    if (this.activePages < this.maxConcurrent) { this.activePages++; return; }
    await new Promise<void>(resolve => this.waiters.push(resolve));
    this.activePages++;
  }

  private releaseSlot(): void {
    this.activePages = Math.max(0, this.activePages - 1);
    const w = this.waiters.shift();
    if (w) w();
  }

  /** Open a fresh isolated page (own context). Caller must call release() in finally. */
  private async openPage(): Promise<{ page: Page; release: () => Promise<void> }> {
    await this.acquireSlot();
    let context: import('playwright').BrowserContext | null = null;
    try {
      const browser = await this.ensureBrowser();
      context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
      });
      await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
      });
      const page = await context.newPage();
      const ownedContext = context;
      let released = false;
      const release = async () => {
        if (released) return;
        released = true;
        try { await ownedContext.close(); } catch { /* best effort */ }
        this.releaseSlot();
      };
      return { page, release };
    } catch (err) {
      if (context) await context.close().catch(() => {});
      this.releaseSlot();
      throw err;
    }
  }

  /** Shutdown: close the shared browser. Called at app shutdown.
   *  3s 超时保护：Chrome 已崩溃时 close() 可能挂住，不能阻塞进程退出。 */
  async close(): Promise<void> {
    const b = this.browser;
    this.browser = null;
    this.browserLaunch = null;
    if (b) {
      await Promise.race([
        b.close().catch(() => {}),
        sleep(3000),
      ]);
    }
  }

  /**
   * 轮询等待反爬 JS challenge（页面标题含 __jsl）消失，替代固定 waitForTimeout(5000)。
   * 通常 1-2 秒即可通过，比硬等待更快；被拦截时最多等 timeoutMs 后返回 false。
   */
  private async waitAntiBot(page: Page, timeoutMs = 30000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const title = await page.title();
        if (title && !title.includes('__jsl')) return true;
      } catch { /* 页面可能正在导航，忽略瞬时错误继续轮询 */ }
      await sleep(500);
    }
    return false;
  }

  /** Navigate an already-acquired page to the lab URL and wait for anti-bot to settle. */
  private async navigateToLab(page: Page, labInfo: CnasLabInfo): Promise<void> {
    const params = new URLSearchParams({
      baseInfoId: labInfo.baseInfoId,
      licNo: labInfo.labNo,
      ...labInfo.urlParams,
    });
    const labUrl = `${CNAS_BASE}/orgBaseInfoScopePart.jsp?${params}`;
    await page.goto(labUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const settled = await this.waitAntiBot(page);
    if (!settled) {
      throw new Error('CNAS anti-bot challenge not resolved');
    }
  }

  /** Fetch the lab/organization name from the CNAS page */
  async fetchLabName(labInfo: CnasLabInfo): Promise<string> {
    const { page, release } = await this.openPage();
    try {
      await this.navigateToLab(page, labInfo);
      return await page.evaluate(() => {
        const el = document.querySelector('.orgName, .lab-name, h2, h3, .title');
        if (el) return el.textContent?.trim() ?? '';
        const t = document.title;
        if (t && !t.includes('__jsl')) return t;
        return '';
      });
    } catch {
      return '';
    } finally {
      await release();
    }
  }

  /** Fetch organization info from the CNAS org info page */
  async fetchOrgInfo(labInfo: CnasLabInfo): Promise<CnasOrgInfo> {
    const orgId = labInfo.urlParams?.id;
    if (!orgId) return { regNo: labInfo.labNo, otherNames: '', address: '', validityPeriod: '', certTasks: [] };

    const { page, release } = await this.openPage();
    try {
      const orgUrl = `${CNAS_BASE}/queryOrgInfo.action?id=${orgId}&orgEnOrCh=Ch`;
      await page.goto(orgUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      const settled = await this.waitAntiBot(page);
      if (!settled) {
        throw new Error('CNAS anti-bot challenge not resolved on org info page');
      }

      return await page.evaluate(() => {
        const getText = (el: Element | null) => el?.textContent?.trim() ?? '';

        const findValue = (labelText: string): string => {
          const tds = Array.from(document.querySelectorAll('td'));
          for (let i = 0; i < tds.length - 1; i++) {
            if (getText(tds[i]).includes(labelText)) return getText(tds[i + 1]);
          }
          return '';
        };

        const certTasks: Array<{ taskNo: string; reviewType: string; signDate: string; scopeStatus: string }> = [];
        const tables = Array.from(document.querySelectorAll('table'));
        for (const table of tables) {
          const headers = Array.from(table.querySelectorAll('th, td')).map(getText);
          const taskNoIdx = headers.findIndex(h => h.includes('任务编号'));
          const reviewIdx = headers.findIndex(h => h.includes('评审类型'));
          const signIdx = headers.findIndex(h => h.includes('签发日期'));
          const statusIdx = headers.findIndex(h => h.includes('公布状态'));
          if (taskNoIdx < 0) continue;
          const rows = Array.from(table.querySelectorAll('tr')).slice(1);
          for (const row of rows) {
            const cells = Array.from(row.querySelectorAll('td'));
            if (cells.length <= taskNoIdx) continue;
            certTasks.push({
              taskNo: getText(cells[taskNoIdx]),
              reviewType: reviewIdx >= 0 && cells[reviewIdx] ? getText(cells[reviewIdx]) : '',
              signDate: signIdx >= 0 && cells[signIdx] ? getText(cells[signIdx]) : '',
              scopeStatus: statusIdx >= 0 && cells[statusIdx] ? getText(cells[statusIdx]) : '',
            });
          }
          if (certTasks.length) break;
        }

        return {
          regNo: findValue('注册编号'),
          otherNames: findValue('其他名称'),
          address: findValue('单位地址') || findValue('地址'),
          validityPeriod: findValue('认可有效期限') || findValue('有效期'),
          certTasks,
        };
      });
    } finally {
      await release();
    }
  }

  /** Fetch a single page of capabilities, returns null if anti-bot triggered.
   *  返回 { antiBot: true } 表示反爬拦截；{ crash: true } 表示浏览器/页面已关闭。 */
  private async fetchPage(
    page: Page,
    baseinfoId: string,
    start: number,
    pageSize: number,
  ): Promise<CnasApiResponse | null | { crash: true }> {
    if (page.isClosed()) return { crash: true };
    try {
      // BrowserContext.request shares the challenge cookies with the page, but is not
      // tied to its JavaScript execution context. CNAS can navigate the document while
      // a request is in flight; using page.evaluate(fetch) made that harmless redirect
      // abort the whole sync with "Execution context was destroyed".
      const body = new URLSearchParams({
        baseinfoId,
        type: 'L1',
        enstart: '0',
        startIndex: String(start),
        sizePerPage: String(pageSize),
      });
      const response = await page.request.post(`${CNAS_BASE}/queryPublishLCheckObj.action?`, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Referer: page.url(),
        },
        data: body.toString(),
        timeout: 30000,
      });
      const text = await response.text();
      if (!response.ok() || (!text.startsWith('{') && !text.startsWith('['))) {
        console.log(`fetchPage failed: Non-JSON response (${response.status()}): ${text.substring(0, 100)}`);
        return null;
      }
      return JSON.parse(text) as CnasApiResponse;
    } catch (err) {
      if (isPageResetError(err)) return { crash: true };
      console.log(`fetchPage failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /** Fetch capabilities for a single lab */
  async fetchCapabilities(
    labInfo: CnasLabInfo,
    onProgress?: (fetched: number, total: number) => void,
  ): Promise<CnasCapability[]> {
    const all: CnasCapability[] = [];
    let start = 0;
    const pageSize = 200;
    let total = Infinity;
    const maxRetries = 5;
    let requestCount = 0;

    // page/release 可变：浏览器崩溃时释放旧 page，重建新的继续同步。
    let handle = await this.openPage();

    try {
      await this.navigateToLab(handle.page, labInfo);
      while (all.length < total) {
        let json: CnasApiResponse | null = null;
        let retries = 0;

        while (!json && retries < maxRetries) {
          const res = await this.fetchPage(handle.page, labInfo.baseInfoId, start, pageSize);

          if (res && typeof res === 'object' && 'crash' in res) {
            // 浏览器/页面已关闭：释放旧句柄、重建新 page 并重新导航，不消耗反爬重试次数。
            console.warn(`[cnas] browser crash at offset ${start}, rebuilding page and re-navigating...`);
            await handle.release();
            handle = await this.openPage();
            await this.navigateToLab(handle.page, labInfo);
            requestCount = 0;
            continue;
          }

          json = res as CnasApiResponse | null;
          if (!json) {
            retries++;
            requestCount = 0;
            const waitSec = 15 + retries * 20;
            console.log(`CNAS anti-bot at offset ${start}, waiting ${waitSec}s then re-navigating (retry ${retries}/${maxRetries})...`);
            await sleep(waitSec * 1000);
            await this.navigateToLab(handle.page, labInfo);
          }
        }

        if (!json) throw new Error(`CNAS fetch failed at offset ${start} after ${maxRetries} retries`);

        total = json.totalSize;
        const records = json.data ?? [];
        if (records.length === 0) break;

        all.push(...records);
        onProgress?.(all.length, total);
        start += pageSize;
        requestCount++;

        if (requestCount >= 8 && start < total) {
          console.log(`Proactive re-navigation after ${requestCount} requests...`);
          await sleep(5000);
          await this.navigateToLab(handle.page, labInfo);
          requestCount = 0;
          await sleep(3000 + Math.random() * 2000);
        } else if (start < total) {
          await sleep(1500 + Math.random() * 2000);
        }
      }
    } finally {
      await handle.release();
    }

    return all;
  }

  /** Parse CNAS URL to extract lab info */
  static parseUrl(url: string): CnasLabInfo | null {
    try {
      const u = new URL(url);
      const params = u.searchParams;
      const baseInfoId = params.get('baseInfoId');
      const licNo = params.get('licNo');
      if (!baseInfoId || !licNo) return null;

      const extraKeys = ['id', 'labType', 'scopeStr', 'orgEnOrCh', 'attactdate'];
      const urlParams: Record<string, string> = {};
      for (const key of extraKeys) {
        const val = params.get(key);
        if (val) urlParams[key] = val;
      }

      return {
        baseInfoId,
        labNo: licNo,
        labName: '',
        certUpdateTs: params.get('certUpdateTs') ?? '',
        validate: params.get('validate') ?? '',
        urlParams,
      };
    } catch {
      return null;
    }
  }

  /** Fetch lab info (lightweight check) */
  async fetchLabInfo(baseInfoId: string, urlParams: Record<string, string> = {}): Promise<{ certDate: string; totalSize: number }> {
    const { page, release } = await this.openPage();
    try {
      const labInfo: CnasLabInfo = { baseInfoId, labNo: '', labName: '', certUpdateTs: '', validate: '', urlParams };
      await this.navigateToLab(page, labInfo);
      const result = await this.fetchPage(page, baseInfoId, 0, 1);
      if (!result || 'crash' in result) throw new Error('CNAS check could not read capability data');
      const json = result;
      return {
        certDate: json.data?.[0]?.startDate ?? '',
        totalSize: json.totalSize,
      };
    } finally {
      await release();
    }
  }

  /** Check for updates (lightweight) */
  async checkForUpdate(
    baseInfoId: string,
    cachedCertDate: string,
    urlParams: Record<string, string> = {},
  ): Promise<{ hasUpdate: boolean; currentCertDate: string; totalSize: number }> {
    const info = await this.fetchLabInfo(baseInfoId, urlParams);
    return {
      hasUpdate: info.certDate !== cachedCertDate,
      currentCertDate: info.certDate,
      totalSize: info.totalSize,
    };
  }
}
function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/** 判断是否是页面需要重建的瞬时错误（区别于反爬返回的 HTML）。 */
export function isCnasPageResetError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /Target (page, context or browser has been closed|closed)/i.test(msg)
    || /browser has been closed/i.test(msg)
    || /Browser closed/i.test(msg)
    || /Connection (closed|reset)/i.test(msg)
    || /Execution context was destroyed/i.test(msg)
    || /frame was detached/i.test(msg);
}

const isPageResetError = isCnasPageResetError;

import type { Browser, Page } from 'playwright';

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
        const b = await pw.chromium.launch({
          headless: true,
          channel: 'chrome',
          args: ['--disable-blink-features=AutomationControlled'],
        });
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

  /** Shutdown: close the shared browser. Called at app shutdown. */
  async close(): Promise<void> {
    const b = this.browser;
    this.browser = null;
    this.browserLaunch = null;
    if (b) await b.close().catch(() => {});
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
    await page.waitForTimeout(5000);

    const title = await page.title();
    if (!title || title.includes('__jsl')) {
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
      await page.waitForTimeout(5000);

      const title = await page.title();
      if (!title || title.includes('__jsl')) {
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

  /** Fetch a single page of capabilities, returns null if anti-bot triggered */
  private async fetchPage(
    page: Page,
    baseinfoId: string,
    start: number,
    pageSize: number,
  ): Promise<CnasApiResponse | null> {
    const result = await page.evaluate(async (params: { baseinfoId: string; start: number; pageSize: number }) => {
      try {
        const body = new URLSearchParams({
          baseinfoId: params.baseinfoId,
          type: 'L1',
          enstart: '0',
          startIndex: String(params.start),
          sizePerPage: String(params.pageSize),
        });
        const resp = await fetch('/LAS/publish/queryPublishLCheckObj.action?', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
        });
        const text = await resp.text();
        if (text.startsWith('{') || text.startsWith('[')) {
          return { ok: true, text };
        }
        return { ok: false, error: `Non-JSON response (${resp.status}): ${text.substring(0, 100)}` };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    }, { baseinfoId, start, pageSize });

    if (!result.ok) {
      console.log(`fetchPage failed: ${result.error}`);
      return null;
    }
    try {
      return JSON.parse(result.text!) as CnasApiResponse;
    } catch {
      return null;
    }
  }

  /** Fetch capabilities for a single lab */
  async fetchCapabilities(
    labInfo: CnasLabInfo,
    onProgress?: (fetched: number, total: number) => void,
  ): Promise<CnasCapability[]> {
    const { page, release } = await this.openPage();

    const all: CnasCapability[] = [];
    let start = 0;
    const pageSize = 200;
    let total = Infinity;
    const maxRetries = 5;
    let requestCount = 0;

    try {
      await this.navigateToLab(page, labInfo);
      while (all.length < total) {
        let json: CnasApiResponse | null = null;
        let retries = 0;

        while (!json && retries < maxRetries) {
          json = await this.fetchPage(page, labInfo.baseInfoId, start, pageSize);
          if (!json) {
            retries++;
            requestCount = 0;
            const waitSec = 15 + retries * 20;
            console.log(`CNAS anti-bot at offset ${start}, waiting ${waitSec}s then re-navigating (retry ${retries}/${maxRetries})...`);
            await sleep(waitSec * 1000);
            await this.navigateToLab(page, labInfo);
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
          await this.navigateToLab(page, labInfo);
          requestCount = 0;
          await sleep(3000 + Math.random() * 2000);
        } else if (start < total) {
          await sleep(1500 + Math.random() * 2000);
        }
      }
    } finally {
      await release();
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
      const result = await page.evaluate(async (baseinfoId: string) => {
        try {
          const body = new URLSearchParams({
            baseinfoId, type: 'L1', enstart: '0', startIndex: '0', sizePerPage: '1',
          });
          const resp = await fetch('/LAS/publish/queryPublishLCheckObj.action?', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body.toString(),
          });
          return { ok: resp.status === 200, text: await resp.text() };
        } catch (e) {
          return { ok: false, error: String(e) };
        }
      }, baseInfoId);

      if (!result.ok) throw new Error(`CNAS check failed: ${result.error}`);
      let json: CnasApiResponse;
      try {
        json = JSON.parse(result.text!) as CnasApiResponse;
      } catch {
        throw new Error('CNAS check returned HTML instead of JSON (anti-bot triggered)');
      }
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

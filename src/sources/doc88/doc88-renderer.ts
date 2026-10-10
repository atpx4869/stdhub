import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Browser, BrowserContext, Page } from 'playwright';
import { chromium } from 'playwright';

import { DOC88_UA } from './doc88-search';

// Doc88 may define Viewer/Core as global lexical bindings, not window properties.
// These declarations are erased; browser evaluate functions keep the original lookup.
declare const Viewer: any;
declare const Core: any;

const MIN_RENDERED_PNG_BYTES = 35_000;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export interface Doc88RenderOptions {
  cookie: string;
  pageTimeoutMs: number;
  scale: number;
  signal?: AbortSignal;
  onProgress?: (phase: 'opening' | 'rendering' | 'assembling', current: number, total: number, message: string) => void;
}

export interface Doc88RenderResult {
  title: string;
  totalPages: number;
  renderedPages: number;
  outPath: string;
}

function parseCookies(raw: string) {
  const cookies = raw.split(';').map(value => value.trim()).filter(value => value.includes('=')).map(value => {
    const separator = value.indexOf('=');
    return { name: value.slice(0, separator), value: value.slice(separator + 1), domain: '.doc88.com', path: '/' };
  });
  cookies.push({ name: 'cdb_IMGR', value: '1', domain: '.doc88.com', path: '/' });
  cookies.push({ name: 'cdb_H5R', value: '1', domain: '.doc88.com', path: '/' });
  return cookies;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('任务已取消');
}

async function openReader(ctx: BrowserContext, pcode: string, signal?: AbortSignal) {
  throwIfAborted(signal);
  const page = await ctx.newPage();
  page.setDefaultTimeout(90_000);
  try {
    await page.goto(`https://www.doc88.com/p-${pcode}.html`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    throwIfAborted(signal);
    try {
      await page.waitForSelector('.outer_page, div[id^="outer_page_"], div[id^="page_"]', { timeout: 60_000 });
    } catch {
      const body = (await page.textContent('body').catch(() => '')) || '';
      if (/安全验证|频繁操作/.test(body)) throw new Error('Doc88 当前触发了访问频率限制');
      throw new Error('Doc88 阅读器未初始化');
    }
    let meta: { total: number; name: string } | null = null;
    for (let attempt = 0; attempt < 60 && !meta; attempt++) {
      throwIfAborted(signal);
      const raw = await page.evaluate(() => {
        try {
          const viewer = typeof Viewer !== 'undefined' ? Viewer : (typeof Core !== 'undefined' ? Core.api : null);
          if (!viewer?._F8) return '';
          return JSON.stringify({ total: viewer._F8, name: viewer._6b?.p_name || '' });
        } catch { return ''; }
      }).catch(() => '');
      if (raw) { try { meta = JSON.parse(raw); } catch { /* retry */ } }
      if (!meta) await sleep(300);
    }
    if (!meta?.total) throw new Error('无法读取 Doc88 文档页数');
    await page.evaluate(() => {
      try {
        const viewer = typeof Viewer !== 'undefined' ? Viewer : (typeof Core !== 'undefined' ? Core.api : null);
        if (!viewer?._F8) return '';
        const before = viewer._OA;
        viewer._OA = viewer._F8;
        viewer._wt = false;
        let made = 0;
        for (let index = 1; index <= viewer._F8; index++) {
          if (!document.getElementById(`outer_page_${index}`)) {
            try { viewer._QR(index, 0); made++; } catch { /* best effort */ }
          }
        }
        return JSON.stringify({ total: viewer._F8, from: before, made });
      } catch { return ''; }
    });
    for (let attempt = 0; attempt < 40; attempt++) {
      throwIfAborted(signal);
      const count = await page.evaluate(() => document.querySelectorAll('div[id^="outer_page_"]').length).catch(() => 0);
      if (count >= meta.total) break;
      await sleep(250);
    }
    return { page, meta };
  } catch (error) {
    await page.close().catch(() => {});
    throw error;
  }
}

async function capturePage(page: Page, pageNumber: number): Promise<Buffer | null> {
  const dataUrl = await page.evaluate((number) => {
    try {
      const element = document.getElementById(`outer_page_${number}`) || document.getElementById(`page_${number}`);
      if (!element) return '';
      const canvases = element.querySelectorAll('canvas');
      if (!canvases.length) return '';
      let canvas = canvases[0];
      for (let index = 1; index < canvases.length; index++) {
        if (canvases[index].width * canvases[index].height > canvas.width * canvas.height) canvas = canvases[index];
      }
      if (!canvas.width || !canvas.height) return '';
      return canvas.toDataURL('image/png');
    } catch { return ''; }
  }, pageNumber).catch(() => '');
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) return null;
  const comma = dataUrl.indexOf(',');
  return comma < 0 ? null : Buffer.from(dataUrl.slice(comma + 1), 'base64');
}

async function renderPages(page: Page, total: number, tempDir: string, options: Doc88RenderOptions) {
  const files: string[] = [];
  for (let pageNumber = 1; pageNumber <= total; pageNumber++) {
    throwIfAborted(options.signal);
    options.onProgress?.('rendering', pageNumber - 1, total, `正在渲染第 ${pageNumber}/${total} 页`);
    await page.evaluate(number => {
      const element = document.getElementById(`outer_page_${number}`) || document.getElementById(`page_${number}`);
      element?.scrollIntoView({ block: 'center', behavior: 'instant' });
    }, pageNumber).catch(() => {});
    let best: Buffer | null = null;
    let unchanged = 0;
    const deadline = Date.now() + Math.min(options.pageTimeoutMs, 15_000);
    while (Date.now() < deadline) {
      throwIfAborted(options.signal);
      await sleep(best ? 400 : 500);
      const candidate = await capturePage(page, pageNumber);
      if (candidate && candidate.length > 3_000) {
        if (!best || candidate.length > best.length * 1.05) { best = candidate; unchanged = 0; }
        else unchanged++;
      } else unchanged++;
      if (best && best.length >= MIN_RENDERED_PNG_BYTES) break;
      if (best && unchanged >= 8) break;
    }
    if (!best || best.length < MIN_RENDERED_PNG_BYTES) throw new Error(`第 ${pageNumber} 页渲染超时或未完成`);
    const file = path.join(tempDir, `page${String(pageNumber).padStart(4, '0')}.png`);
    await fs.writeFile(file, best);
    files.push(file);
    options.onProgress?.('rendering', pageNumber, total, `已完成 ${pageNumber}/${total} 页`);
  }
  return files;
}

async function assemblePdf(ctx: BrowserContext, files: string[], outPath: string, options: Doc88RenderOptions) {
  throwIfAborted(options.signal);
  options.onProgress?.('assembling', files.length, files.length, '正在合成 PDF');
  const first = await fs.readFile(files[0]);
  const width = first.readUInt32BE(16);
  const height = first.readUInt32BE(20);
  const tempDir = path.dirname(files[0]);
  const htmlPath = path.join(tempDir, '_print.html');
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>@page{size:${width}px ${height}px;margin:0}*{margin:0;padding:0}.pg{width:${width}px;height:${height}px;overflow:hidden;page-break-after:always}.pg:last-child{page-break-after:auto}img{width:100%;height:100%;object-fit:contain;display:block}</style></head><body>${files.map(file => `<div class="pg"><img src="${path.basename(file)}"></div>`).join('')}</body></html>`;
  await fs.writeFile(htmlPath, html, 'utf8');
  const pdfPage = await ctx.newPage();
  try {
    await pdfPage.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' });
    throwIfAborted(options.signal);
    await pdfPage.pdf({ path: outPath, printBackground: true, preferCSSPageSize: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } });
  } finally {
    await pdfPage.close().catch(() => {});
  }
}

export class Doc88Renderer {
  private browser: Browser | null = null;
  private browserLaunch: Promise<Browser> | null = null;
  private contexts = new Set<BrowserContext>();
  private closed = false;

  private async ensureBrowser(): Promise<Browser> {
    if (this.closed) throw new Error('Doc88 浏览器正在关闭');
    if (this.browser?.isConnected()) return this.browser;
    if (!this.browserLaunch) {
      this.browserLaunch = chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--window-size=1400,2000', '--mute-audio', '--disable-background-timer-throttling'],
      }).then(async browser => {
        if (this.closed) { await browser.close(); throw new Error('Doc88 浏览器正在关闭'); }
        this.browser = browser;
        browser.on('disconnected', () => { this.browser = null; this.browserLaunch = null; });
        return browser;
      }).catch(error => { this.browserLaunch = null; throw error; });
    }
    return this.browserLaunch;
  }

  async render(pcode: string, outPath: string, options: Doc88RenderOptions): Promise<Doc88RenderResult> {
    if (!options.cookie) throw new Error('Doc88 Cookie 未配置');
    throwIfAborted(options.signal);
    const browser = await this.ensureBrowser();
    throwIfAborted(options.signal);
    const context = await browser.newContext({ viewport: { width: 1400, height: 1200 }, deviceScaleFactor: options.scale, userAgent: DOC88_UA });
    this.contexts.add(context);
    const onAbort = () => { void context.close().catch(() => {}); };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    let tempDir = '';
    try {
      throwIfAborted(options.signal);
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'stdhub-doc88-'));
      await context.addCookies(parseCookies(options.cookie));
      options.onProgress?.('opening', 0, 0, '正在打开 Doc88 阅读器');
      const { page, meta } = await openReader(context, pcode, options.signal);
      try {
        const files = await renderPages(page, meta.total, tempDir, options);
        await assemblePdf(context, files, outPath, options);
        return { title: meta.name, totalPages: meta.total, renderedPages: files.length, outPath };
      } finally {
        await page.close().catch(() => {});
      }
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
      this.contexts.delete(context);
      await context.close().catch(() => {});
      if (tempDir) await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async close() {
    this.closed = true;
    await Promise.allSettled([...this.contexts].map(context => context.close()));
    const browser = this.browser || await this.browserLaunch?.catch(() => null);
    this.browser = null;
    this.browserLaunch = null;
    if (browser) await browser.close().catch(() => {});
  }
}

export const DOC88_RENDER_INVARIANTS = Object.freeze({ userAgent: DOC88_UA, minPngBytes: MIN_RENDERED_PNG_BYTES, jobs: 1, cookieFlags: ['cdb_IMGR', 'cdb_H5R'], preferCssPageSize: true });

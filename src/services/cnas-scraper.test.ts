import { describe, expect, it, vi } from 'vitest';
import { CnasScraper, getCnasBrowserLaunchOptions, isCnasPageResetError } from './cnas-scraper';

describe('getCnasBrowserLaunchOptions', () => {
  it('uses Playwright bundled Chromium by default', () => {
    const options = getCnasBrowserLaunchOptions({});

    expect(options).not.toHaveProperty('channel');
    expect(options.headless).toBe(true);
    expect(options.args).toContain('--disable-blink-features=AutomationControlled');
    expect(options.args).not.toContain('--disable-crash-reporter');
  });

  it('allows an explicit browser channel override', () => {
    expect(getCnasBrowserLaunchOptions({ CNAS_BROWSER_CHANNEL: ' chrome ' })).toMatchObject({
      channel: 'chrome',
    });
  });

  it('ignores an empty browser channel override', () => {
    expect(getCnasBrowserLaunchOptions({ CNAS_BROWSER_CHANNEL: '   ' })).not.toHaveProperty('channel');
  });
});

describe('isCnasPageResetError', () => {
  it('treats CNAS navigation races as a recoverable page reset', () => {
    expect(isCnasPageResetError(new Error(
      'page.evaluate: Execution context was destroyed, most likely because of a navigation',
    ))).toBe(true);
    expect(isCnasPageResetError(new Error('frame was detached'))).toBe(true);
  });

  it('does not hide ordinary request failures as browser resets', () => {
    expect(isCnasPageResetError(new Error('CNAS check returned HTML'))).toBe(false);
  });
});

describe('CNAS capability requests', () => {
  it('uses the context request client so document navigation cannot destroy the request', async () => {
    const post = vi.fn().mockResolvedValue({
      ok: () => true,
      status: () => 200,
      text: () => Promise.resolve('{"totalSize":1,"startIndex":0,"sizePerPage":1,"data":[]}'),
    });
    const page = {
      isClosed: () => false,
      url: () => 'https://las.cnas.org.cn/LAS/publish/orgBaseInfoScopePart.jsp',
      request: { post },
      evaluate: vi.fn(() => { throw new Error('page.evaluate must not be used'); }),
    };

    const result = await (new CnasScraper() as any).fetchPage(page, 'base-id', 0, 1);

    expect(result).toMatchObject({ totalSize: 1 });
    expect(post).toHaveBeenCalledOnce();
    expect(page.evaluate).not.toHaveBeenCalled();
  });
});

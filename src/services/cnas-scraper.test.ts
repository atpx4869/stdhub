import { describe, expect, it } from 'vitest';
import { getCnasBrowserLaunchOptions } from './cnas-scraper';

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

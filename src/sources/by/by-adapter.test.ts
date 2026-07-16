import { describe, expect, it } from 'vitest';

import { ByAdapter } from './by-adapter';

describe('ByAdapter basics', () => {
  it('has source by', () => {
    const adapter = new ByAdapter();
    expect(adapter.source).toBe('by');
  });

  it('searches for 18584-2024 on by internal network', async () => {
    const adapter = new ByAdapter();

    try {
      const results = await adapter.searchStandards({ query: '18584-2024' });
      if (results.length === 0) {
        return; // intranet unavailable, skip
      }
      expect(results[0]?.id.startsWith('by:')).toBe(true);
    } catch (e: any) {
      if (e.message?.includes('not accessible') || e.message?.includes('login failed') || e.message?.includes('凭据未配置')) {
        return; // intranet unavailable, skip
      }
      throw e;
    }
  }, 15000);
});

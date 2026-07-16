import { describe, expect, it } from 'vitest';

import { BzZhengguiAdapter } from './bz-zhenggui-adapter';

describe('BzZhengguiAdapter (new platform)', () => {
  it('searches for 3325-2024 on new platform', async () => {
    const adapter = new BzZhengguiAdapter();
    const results = await adapter.searchStandards({ query: '3325-2024' });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.id.startsWith('bz:')).toBe(true);
    expect(results[0]?.standardNumber).toBe('GB/T 3325-2024');
  }, 30000);

  it('gets detail for a search result', async () => {
    const adapter = new BzZhengguiAdapter();
    const results = await adapter.searchStandards({ query: '3325-2024' });
    const detail = await adapter.getStandardDetail(results[0].id);

    expect(detail.title).toBeTruthy();
    expect(detail.standardNumber).toBe('GB/T 3325-2024');
  }, 30000);
});

import { describe, expect, it } from 'vitest';

import { GbwAdapter } from './gbw-adapter';

describe('GbwAdapter basics', () => {
  it('maps search rows to gbw ids', async () => {
    const adapter = new GbwAdapter();
    const result = await adapter.searchStandards({ query: '3324-2024' });

    expect(result.length).toBeGreaterThan(0);
    expect(result[0]?.id.startsWith('gbw:')).toBe(true);
    expect(result[0]?.standardNumber).toContain('3324-2024');
  }, 30000);
});

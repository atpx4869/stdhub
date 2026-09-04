import { beforeEach, describe, expect, it, vi } from 'vitest';

import { searchCache } from '../../shared/cache';
import { pooledFetch } from '../../shared/http';
import { GbwAdapter } from './gbw-adapter';

vi.mock('../../shared/http', () => ({
  pooledFetch: vi.fn(),
}));

describe('GbwAdapter basics', () => {
  beforeEach(() => {
    searchCache.clear();
    vi.mocked(pooledFetch).mockReset();
  });

  it('maps search rows to gbw ids', async () => {
    vi.mocked(pooledFetch).mockResolvedValueOnce(new Response(JSON.stringify({
      total: 1,
      pageNumber: 1,
      rows: [{
        id: 'gb3324-2024',
        C_STD_CODE: 'GB / T 3324-2024',
        C_C_NAME: '木家具通用技术条件',
        STD_NATURE: '推荐性',
        STATE: '废止',
        ISSUE_DATE: '2024-06-29',
        ACT_DATE: '2025-01-01',
      }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    const adapter = new GbwAdapter();
    const result = await adapter.searchStandards({ query: '3324-2024' });

    expect(result.length).toBeGreaterThan(0);
    expect(result[0]?.id.startsWith('gbw:')).toBe(true);
    expect(result[0]?.standardNumber).toContain('3324-2024');
    expect(new URL(vi.mocked(pooledFetch).mock.calls[0][0]).searchParams.get('searchText')).toBe('3324-2024');
  });
});

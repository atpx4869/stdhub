import { beforeEach, describe, expect, it, vi } from 'vitest';

import { searchCache } from '../../shared/cache';
import { pooledFetch } from '../../shared/http';
import { BzZhengguiAdapter } from './bz-zhenggui-adapter';

vi.mock('../../shared/http', () => ({
  pooledFetch: vi.fn(),
}));

const standardRow = {
  id: 3325,
  stdNo: 'GB/T 3325-2024',
  cnName: '金属家具通用技术条件',
  enName: 'General technical requirements for metal furniture',
  pubDate: '2024-06-29',
  actDate: '2025-01-01',
  stdStatus: '1',
  isPdf: '1',
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('BzZhengguiAdapter (new platform)', () => {
  beforeEach(() => {
    searchCache.clear();
    vi.mocked(pooledFetch).mockReset();
  });

  it('searches for 3325-2024 on new platform', async () => {
    vi.mocked(pooledFetch).mockResolvedValueOnce(jsonResponse({
      code: 200,
      data: { records: [standardRow], total: 1 },
    }));
    const adapter = new BzZhengguiAdapter();
    const results = await adapter.searchStandards({ query: '3325-2024' });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.id.startsWith('bz:')).toBe(true);
    expect(results[0]?.standardNumber).toBe('GB/T 3325-2024');
    expect(pooledFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/gxist-standard/standardstd/list?'),
      expect.objectContaining({ retries: undefined }),
    );
    expect(new URL(vi.mocked(pooledFetch).mock.calls[0][0]).searchParams.get('keywords')).toBe('3325-2024');
  });

  it('gets detail for a search result', async () => {
    vi.mocked(pooledFetch)
      .mockResolvedValueOnce(jsonResponse({
        code: 200,
        data: { records: [standardRow], total: 1 },
      }))
      .mockResolvedValueOnce(jsonResponse({ code: 200, data: standardRow }));
    const adapter = new BzZhengguiAdapter();
    const results = await adapter.searchStandards({ query: '3325-2024' });
    const detail = await adapter.getStandardDetail(results[0].id);

    expect(detail.title).toBeTruthy();
    expect(detail.standardNumber).toBe('GB/T 3325-2024');
    expect(pooledFetch).toHaveBeenLastCalledWith(
      'https://bz.gxzl.org.cn/api/gxist-standard/standardstd/detail?id=3325',
    );
  });
});

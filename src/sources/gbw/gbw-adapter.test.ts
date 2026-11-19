import { beforeEach, describe, expect, it, vi } from 'vitest';

import { searchCache } from '../../shared/cache';
import { pooledFetch } from '../../shared/http';
import { resetTextAvailabilityCache } from '../../shared/text-availability-cache';
import { resetUpstreamGates } from '../../shared/upstream-gate';
import { GbwAdapter } from './gbw-adapter';

vi.mock('../../shared/http', () => ({
  pooledFetch: vi.fn(),
}));

describe('GbwAdapter basics', () => {
  beforeEach(() => {
    searchCache.clear();
    resetTextAvailabilityCache();
    resetUpstreamGates();
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
    expect(result[0]?.status).toBe('废止');
    expect(result[0]?.previewAvailable).toBe(false);
    expect(result[0]?.textAvailability?.state).toBe('unknown');
    const [url, init] = vi.mocked(pooledFetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://std.samr.gov.cn/gb/search/gbQueryPage');
    expect(init.method).toBe('POST');
    expect(String(init.body)).toContain('searchText=3324-2024');
    expect(String(init.body)).toContain('pageNumber=1');
    expect((init.headers as Record<string, string>)['X-Requested-With']).toBe('XMLHttpRequest');
  });

  it('accepts prefixed polling IDs and preserves unknown request failures', async () => {
    const adapter = new GbwAdapter();
    vi.mocked(pooledFetch).mockResolvedValueOnce(new Response('unavailable', { status: 503 }));
    expect(adapter.getTextAvailability(['gbw:test-failed-probe'])).toEqual({});
    await vi.waitFor(() => {
      expect(adapter.getTextAvailability(['gbw:test-failed-probe'])['gbw:test-failed-probe']).toMatchObject({ state: 'unknown' });
    });
  });

  it('does not classify an upstream text request failure as no text', async () => {
    const adapter = new GbwAdapter();
    vi.mocked(pooledFetch).mockRejectedValueOnce(new Error('network timeout'));
    const result = await (adapter as any).checkOpenstdHasText('1234567890ABCDEF1234567890ABCDEF');
    expect(result).toMatchObject({ state: 'unknown', reason: 'fulltext_request_failed' });
  });
  it('treats openstd 404 as confirmed no text', async () => {
    const adapter = new GbwAdapter();
    vi.mocked(pooledFetch).mockResolvedValueOnce(new Response('missing', { status: 404 }));
    const result = await (adapter as any).checkOpenstdHasText('1234567890ABCDEF1234567890ABCDEF');
    expect(result).toMatchObject({ state: 'unavailable', reason: 'no_fulltext_entry' });
  });

  it('treats an empty openstd page as unknown throttle, not absence', async () => {
    const adapter = new GbwAdapter();
    vi.mocked(pooledFetch).mockResolvedValueOnce(new Response('   ', { status: 200 }));
    const result = await (adapter as any).checkOpenstdHasText('1234567890ABCDEF1234567890ABCDEF');
    expect(result).toMatchObject({ state: 'unknown', reason: 'throttled_empty_page' });
  });

  it('confirms absence when a detail page has no hcno', async () => {
    const adapter = new GbwAdapter();
    vi.mocked(pooledFetch).mockResolvedValueOnce(new Response('<html>no hcno</html>', { status: 200 }));
    expect(adapter.getTextAvailability(['probe-no-hcno'])).toEqual({});
    await vi.waitFor(() => {
      expect(adapter.getTextAvailability(['probe-no-hcno'])['probe-no-hcno']).toMatchObject({
        state: 'unavailable',
        reason: 'missing_fulltext_record',
      });
    });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { searchCache } from '../../shared/cache';
import { pooledFetch } from '../../shared/http';
import { resetTextAvailabilityCache } from '../../shared/text-availability-cache';
import { getUpstreamGate, resetUpstreamGates } from '../../shared/upstream-gate';
import { GbwAdapter } from './gbw-adapter';

vi.mock('../../shared/http', () => ({
  pooledFetch: vi.fn(),
}));

const hcno = '1234567890ABCDEF1234567890ABCDEF';
const availablePage = '<p>标准号 GB/T 3324-2024 标准名称 木家具</p>' +
  '<a class="ck_btn" onclick="showGb()">在线预览</a><a class="xz_btn" onclick="download()">下载标准</a>';

describe('GbwAdapter basics', () => {
  afterEach(() => vi.useRealTimers());
  beforeEach(() => {
    searchCache.clear();
    resetTextAvailabilityCache();
    resetUpstreamGates();
    vi.mocked(pooledFetch).mockReset();
  });

  it('finishes overlapping cold probes in 12s with four shared slots and deduplicates polling', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-19T00:00:00Z'));
    const adapter = new GbwAdapter();
    const ids = Array.from({ length: 20 }, (_, i) => 'throughput-' + i);
    let active = 0;
    let peak = 0;
    vi.mocked(pooledFetch).mockImplementation(async url => {
      active++;
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 1_000));
      active--;
      return new Response(String(url).includes('gbDetailed') ? '<a href="?hcno=' + hcno + '">text</a>' : availablePage);
    });
    expect(adapter.getTextAvailability(ids)).toEqual({});
    // A separate batch must share the same bound; repeated IDs must not requeue.
    adapter.getTextAvailability([...ids, 'extra-probe']);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.mocked(pooledFetch)).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(Object.values(adapter.getTextAvailability(ids)).map(v => v.state)).toEqual(Array(20).fill('available'));
    expect(peak).toBe(4);
    expect(vi.mocked(pooledFetch)).toHaveBeenCalledTimes(42);
  });

  it.each([
    [429, 'limited', 'fulltext_http_429'],
    [403, 'denied', 'fulltext_http_403'],
    [503, 'busy', 'fulltext_http_503'],
    [200, '   ', 'throttled_empty_page'],
    [200, '<p>Access Denied</p>', 'verification_or_access_denied'],
  ])('backs off on %s/%s then resumes healthy traffic immediately', async (status, body, reason) => {
    vi.useFakeTimers();
    const adapter = new GbwAdapter();
    const check = () => (adapter as any).checkOpenstdHasText(hcno);
    vi.mocked(pooledFetch).mockResolvedValueOnce(new Response(body, { status }))
      .mockImplementation(async () => new Response(availablePage));
    await expect(check()).resolves.toMatchObject({ state: 'unknown', reason });
    const pending = check();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(pooledFetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({ state: 'available' });
    await expect(check()).resolves.toMatchObject({ state: 'available' });
    expect(pooledFetch).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not pace 404, unrelated HTTP errors or transport failures', async () => {
    vi.useFakeTimers();
    const adapter = new GbwAdapter();
    const check = () => (adapter as any).checkOpenstdHasText(hcno);
    vi.mocked(pooledFetch).mockResolvedValueOnce(new Response('missing', { status: 404 }))
      .mockResolvedValueOnce(new Response('error', { status: 500 }))
      .mockRejectedValueOnce(new Error('network timeout'));
    await expect(check()).resolves.toMatchObject({ state: 'unavailable' });
    await expect(check()).resolves.toMatchObject({ state: 'unknown', reason: 'fulltext_http_500' });
    await expect(check()).resolves.toMatchObject({ state: 'unknown', reason: 'fulltext_request_failed' });
    expect(getUpstreamGate('openstd').hits).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
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

  it.each(['   ', '<p>Access Denied</p>'])('keeps empty/restricted detail pages unknown: %s', async html => {
    const adapter = new GbwAdapter();
    vi.mocked(pooledFetch).mockResolvedValueOnce(new Response(html));
    adapter.getTextAvailability(['detail-restricted']);
    await vi.waitFor(() => {
      expect(adapter.getTextAvailability(['detail-restricted'])['detail-restricted']).toMatchObject({ state: 'unknown' });
    });
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

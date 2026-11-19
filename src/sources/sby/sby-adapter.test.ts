import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { pooledFetch } from '../../shared/http';
import { SbyAdapter } from './sby-adapter';

vi.mock('../../shared/http', () => ({
  pooledFetch: vi.fn(),
}));

const SAMPLE = {
  stdId: 'std-18584',
  a100: 'GB 18584-2024',
  a298: '家具中有害物质限量',
  a301: '',
  a102: '某部',
  stdTypeName: '1-国家标准',
  stdStatusName: '现行',
  a101: '2024-06-25',
  a205: '2025-07-01',
  a210: '',
  a305: '88',
  b000: '/files/18584.pdf',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function pdfResponse(bytes = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(2048, 32)])): Response {
  return new Response(bytes, {
    status: 200,
    headers: { 'Content-Type': 'application/pdf' },
  });
}

describe('SbyAdapter', () => {
  const original = {
    url: process.env.SBY_BASE_URL,
    pages: process.env.SBY_MAX_PAGES,
  };

  beforeEach(() => {
    vi.mocked(pooledFetch).mockReset();
    process.env.SBY_BASE_URL = 'https://sby.example.test';
    process.env.SBY_MAX_PAGES = '2';
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (original.url === undefined) delete process.env.SBY_BASE_URL;
    else process.env.SBY_BASE_URL = original.url;
    if (original.pages === undefined) delete process.env.SBY_MAX_PAGES;
    else process.env.SBY_MAX_PAGES = original.pages;
  });

  it('keeps health checks independent and cached', async () => {
    vi.mocked(pooledFetch).mockResolvedValue(jsonResponse({ code: 200, rows: [], total: 0 }));
    const adapter = new SbyAdapter();
    await expect(adapter.isAvailable()).resolves.toBe(true);
    await expect(adapter.isAvailable()).resolves.toBe(true);
    expect(pooledFetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(vi.mocked(pooledFetch).mock.calls[0]?.[1]?.body)))
      .toEqual({ pageNum: 1, pageSize: 1, keyword: '' });
  });

  it('rejects a slow initial response within the caller budget and aborts HTTP', async () => {
    vi.useFakeTimers();
    vi.mocked(pooledFetch).mockImplementation(() => new Promise(() => {}));
    const result = new SbyAdapter().searchStandards({ query: '18584', timeoutMs: 500 });
    const assertion = expect(result).rejects.toThrow(/超时/);
    await vi.advanceTimersByTimeAsync(500);
    await assertion;
    const init = vi.mocked(pooledFetch).mock.calls[0]?.[1];
    expect(init?.timeoutMs).toBe(500);
    expect(init?.retries).toBe(1);
    expect(init?.signal?.aborted).toBe(true);
    expect(pooledFetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains completed pages when a later response body stalls', async () => {
    vi.useFakeTimers();
    const cancelBody = vi.fn();
    const slowBody = new Response(new ReadableStream({ cancel: cancelBody }));
    vi.mocked(pooledFetch)
      .mockResolvedValueOnce(jsonResponse({ rows: [SAMPLE], total: 100 }))
      .mockResolvedValueOnce(slowBody);
    const result = new SbyAdapter().searchStandards({ query: '18584' });
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(result).resolves.toMatchObject([{ id: 'sby:std-18584' }]);
    expect(vi.mocked(pooledFetch).mock.calls[1]?.[1]?.signal?.aborted).toBe(true);
    expect(cancelBody).toHaveBeenCalledTimes(1);
    expect(pooledFetch).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('caps cumulative pagination at ten seconds rather than resetting the budget per page', async () => {
    vi.useFakeTimers();
    process.env.SBY_MAX_PAGES = '5';
    vi.mocked(pooledFetch).mockImplementation((_url, init) => new Promise(resolve => {
      const page = JSON.parse(String(init?.body)).pageNum as number;
      if (page < 3) setTimeout(() => resolve(jsonResponse({
        rows: [{ ...SAMPLE, stdId: 'std-' + page }], total: 100,
      })), page === 1 ? 7_000 : 2_000);
    }));
    const result = new SbyAdapter().searchStandards({ query: 'GB' });
    await vi.advanceTimersByTimeAsync(9_999);
    let settled = false;
    void result.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toHaveLength(2);
    expect(vi.mocked(pooledFetch).mock.calls[2]?.[1]?.timeoutMs).toBe(1_000);
    expect(vi.mocked(pooledFetch).mock.calls[2]?.[1]?.signal?.aborted).toBe(true);
    expect(pooledFetch).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])('rejects explicit cancellation even with completed pages: %s', async (hasPage) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    if (hasPage) vi.mocked(pooledFetch).mockResolvedValueOnce(jsonResponse({ rows: [SAMPLE], total: 100 }));
    vi.mocked(pooledFetch).mockImplementation(() => new Promise(() => {}));
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const result = new SbyAdapter().searchStandards({ query: '18584', signal: controller.signal });
    const assertion = expect(result).rejects.toThrow(/已取消/);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await assertion;
    expect(vi.mocked(pooledFetch).mock.calls.at(-1)?.[1]?.signal?.aborted).toBe(true);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not request anything when already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(new SbyAdapter().searchStandards({ query: '18584', signal: controller.signal }))
      .rejects.toThrow(/已取消/);
    expect(pooledFetch).not.toHaveBeenCalled();
  });

  it('does not hide later network errors behind partial results', async () => {
    vi.mocked(pooledFetch)
      .mockResolvedValueOnce(jsonResponse({ rows: [SAMPLE], total: 100 }))
      .mockRejectedValueOnce(new Error('socket hang up'));
    await expect(new SbyAdapter().searchStandards({ query: '18584' })).rejects.toThrow(/socket hang up/);
  });

  it('does not gate searches on a cached unhealthy status and preserves valid empty results', async () => {
    vi.mocked(pooledFetch)
      .mockResolvedValueOnce(jsonResponse({}, 503))
      .mockResolvedValueOnce(jsonResponse({ rows: [], total: 0 }));
    const adapter = new SbyAdapter();
    await expect(adapter.isAvailable()).resolves.toBe(false);
    await expect(adapter.searchStandards({ query: 'missing' })).resolves.toEqual([]);
    expect(pooledFetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(vi.mocked(pooledFetch).mock.calls[1]?.[1]?.body)).keyword).toBe('missing');
  });

  it('limits a default slow first page to eight seconds without retrying', async () => {
    vi.useFakeTimers();
    vi.mocked(pooledFetch).mockImplementation(() => new Promise(() => {}));
    const result = new SbyAdapter().searchStandards({ query: '18584' });
    const assertion = expect(result).rejects.toThrow(/超时/);
    await vi.advanceTimersByTimeAsync(8_000);
    await assertion;
    expect(pooledFetch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(pooledFetch).mock.calls[0]?.[1]?.retries).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('has source sby', () => {
    expect(new SbyAdapter().source).toBe('sby');
  });

  it('posts indexList with keyword and uses rows not records', async () => {
    vi.mocked(pooledFetch)
      .mockResolvedValueOnce(jsonResponse({
        code: 200,
        total: 1,
        rows: [SAMPLE],
        records: [{ stdId: 'wrong', a100: 'GB/T 00000-1999', b000: 'x' }],
      }));

    const results = await new SbyAdapter().searchStandards({ query: '18584-2024' });
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe('sby:std-18584');
    expect(results[0]?.standardNumber).toBe('GB 18584-2024');
    expect(results[0]?.previewAvailable).toBe(true);
    expect(results[0]?.title).toBe('家具中有害物质限量');

    expect(vi.mocked(pooledFetch)).toHaveBeenCalledTimes(1);
    const searchInit = vi.mocked(pooledFetch).mock.calls[0]?.[1] as { body?: string };
    const searchBody = JSON.parse(String(searchInit.body));
    expect(searchBody).toEqual({ pageNum: 1, pageSize: 20, keyword: '18584-2024' });
    expect(String(vi.mocked(pooledFetch).mock.calls[0]?.[0])).toBe('https://sby.example.test/stage-api/title/std/indexList');
  });

  it('treats empty b000 as no text even when page count exists', async () => {
    vi.mocked(pooledFetch)
      .mockResolvedValueOnce(jsonResponse({ code: 200, total: 1, rows: [{ ...SAMPLE, b000: '', a305: '120' }] }));

    const results = await new SbyAdapter().searchStandards({ query: '18584-2024' });
    expect(results[0]?.previewAvailable).toBe(false);
    expect(results[0]?.meta?.pages).toBe('120');
  });

  it('does not swallow network failures as empty results', async () => {
    vi.mocked(pooledFetch)
      .mockRejectedValueOnce(new Error('socket hang up'));

    await expect(new SbyAdapter().searchStandards({ query: '18584-2024' }))
      .rejects.toThrow(/socket hang up/);
  });

  it('does not fall back to the first search hit when detail is missing', async () => {
    vi.mocked(pooledFetch)
      .mockResolvedValueOnce(jsonResponse({ code: 200, total: 1, rows: [SAMPLE] }))
      .mockResolvedValueOnce(jsonResponse({ msg: 'missing' }, 404));

    const adapter = new SbyAdapter();
    await adapter.searchStandards({ query: '18584-2024' });
    await expect(adapter.getStandardDetail('sby:unknown-id')).rejects.toThrow(/HTTP 404|未找到/);
  });

  it('refreshes null list b000 from the info API before export', async () => {
    vi.mocked(pooledFetch)
      .mockResolvedValueOnce(jsonResponse({ code: 200, total: 1, rows: [{ ...SAMPLE, b000: null }] }))
      .mockResolvedValueOnce(jsonResponse({ code: 200, data: SAMPLE }));

    const adapter = new SbyAdapter();
    const results = await adapter.searchStandards({ query: '18584-2024' });
    expect(results[0]?.previewAvailable).toBe(false);
    const detail = await adapter.getStandardDetail('sby:std-18584');
    expect(detail.previewAvailable).toBe(true);
    expect(detail.meta?.textPath).toBe('/files/18584.pdf');
    expect(String(vi.mocked(pooledFetch).mock.calls[1]?.[0])).toBe('https://sby.example.test/stage-api/title/std/info/std-18584');
  });

  it('rejects HTTP 200 JSON downloads as missing PDFs', async () => {
    vi.mocked(pooledFetch)
      .mockResolvedValueOnce(jsonResponse({ code: 200, total: 1, rows: [SAMPLE] }))
      .mockResolvedValueOnce(jsonResponse({ code: 200, data: SAMPLE }))
      .mockResolvedValueOnce(jsonResponse({ code: 500, msg: 'no file' }));

    const adapter = new SbyAdapter();
    await adapter.searchStandards({ query: '18584-2024' });
    await expect(adapter.exportStandard('sby:std-18584')).rejects.toThrow(/无电子件/);
  });

  it('downloads a validated PDF after a successful search', async () => {
    const pdfBytes = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(2048, 65)]);
    vi.mocked(pooledFetch)
      .mockResolvedValueOnce(jsonResponse({ code: 200, total: 1, rows: [SAMPLE] }))
      .mockResolvedValueOnce(jsonResponse({ code: 200, data: SAMPLE }))
      .mockResolvedValueOnce(pdfResponse(pdfBytes));

    const adapter = new SbyAdapter();
    await adapter.searchStandards({ query: '18584-2024' });
    const exported = await adapter.exportStandard('sby:std-18584');
    expect(exported.filePath).toMatch(/GB 18584-2024.*\.pdf$/);

    const pdfCall = vi.mocked(pooledFetch).mock.calls[2];
    expect(String(pdfCall?.[0])).toBe('https://sby.example.test/stage-api/title/std/stdDownload');
    expect(JSON.parse(String((pdfCall?.[1] as { body?: string }).body))).toEqual({ id: 'std-18584' });
  });

  it('paginates with pageNum and stops at max pages', async () => {
    const page = (n: number) => jsonResponse({
      code: 200,
      total: 100,
      rows: [{ ...SAMPLE, stdId: 'std-' + n, a100: 'GB ' + n + '-2024' }],
    });
    vi.mocked(pooledFetch)
      .mockResolvedValueOnce(page(1))
      .mockResolvedValueOnce(page(2))
      .mockResolvedValueOnce(page(3));

    const results = await new SbyAdapter().searchStandards({ query: 'GB' });
    expect(results).toHaveLength(2);
    expect(vi.mocked(pooledFetch)).toHaveBeenCalledTimes(2);
  });
});

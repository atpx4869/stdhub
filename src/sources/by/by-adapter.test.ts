import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadDotEnvLocal } from '../../shared/env-loader';
import { pooledFetch } from '../../shared/http';
import { ByAdapter, classifyByQuery } from './by-adapter';

vi.mock('../../shared/http', () => ({
  pooledFetch: vi.fn(),
}));

loadDotEnvLocal();

const SAMPLE = {
  code: 'GB 18584-2024',
  name_cn: '家具中有害物质限量',
  name_en: '',
  status: '现行',
  publish: '2024-06-25',
  implement: '2025-07-01',
  kind: '国家标准',
  nature: '强制',
  amend: '',
  sid: 'f0f302aa-228f-4c39-9c76-bc7b3c5383c0',
  pdf: '/Upload/PDFAttach/f7459d79-6eda-413e-87c4-5e603ce01a4c.pdf',
  page: 1,
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

describe('classifyByQuery', () => {
  it('treats standard numbers as code and titles as name', () => {
    expect(classifyByQuery('18584-2024')).toEqual({ code: '18584-2024' });
    expect(classifyByQuery('GB/T 10004')).toEqual({ code: 'GB/T 10004' });
    expect(classifyByQuery('家具中有害物质限量')).toEqual({ name: '家具中有害物质限量' });
  });
});

describe('ByAdapter API wrapper', () => {
  const original = {
    url: process.env.BY_API_URL,
    token: process.env.BY_API_TOKEN,
    pages: process.env.BY_API_MAX_PAGES,
    baseUrl: process.env.BY_BASE_URL,
  };

  beforeEach(() => {
    vi.mocked(pooledFetch).mockReset();
    process.env.BY_API_URL = 'https://by.example.test';
    process.env.BY_API_TOKEN = 'test-token';
    process.env.BY_API_MAX_PAGES = '5';
    delete process.env.BY_BASE_URL;
  });

  afterEach(() => {
    const restore = (key: 'BY_API_URL' | 'BY_API_TOKEN' | 'BY_API_MAX_PAGES' | 'BY_BASE_URL', value: string | undefined) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore('BY_API_URL', original.url);
    restore('BY_API_TOKEN', original.token);
    restore('BY_API_MAX_PAGES', original.pages);
    restore('BY_BASE_URL', original.baseUrl);
  });

  it('has source by', () => {
    expect(new ByAdapter().source).toBe('by');
  });

  it('searches by code, caches sid, and never puts the token in the URL', async () => {
    vi.mocked(pooledFetch)
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: { status: 'ok' } }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: { count: 1, items: [SAMPLE] } }));

    const adapter = new ByAdapter();
    const results = await adapter.searchStandards({ query: '18584-2024' });
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe('by:' + SAMPLE.sid);
    expect(results[0]?.standardNumber).toBe('GB 18584-2024');
    expect(results[0]?.previewAvailable).toBe(true);
    expect(results[0]?.detailUrl).toBe('');

    const searchCall = vi.mocked(pooledFetch).mock.calls[1];
    const searchUrl = new URL(String(searchCall?.[0]));
    expect(searchUrl.origin).toBe('https://by.example.test');
    expect(searchUrl.pathname).toBe('/api/search');
    expect(searchUrl.searchParams.get('code')).toBe('18584-2024');
    expect(searchUrl.searchParams.get('pages')).toBe('5');
    expect(searchUrl.searchParams.get('name')).toBeNull();
    expect(searchUrl.href).not.toContain('token');
    expect(searchUrl.href).not.toContain('test-token');
    expect((searchCall?.[1] as { headers?: Record<string, string> } | undefined)?.headers?.['X-Token']).toBe('test-token');

    const detail = await adapter.getStandardDetail('by:' + SAMPLE.sid);
    expect(detail.title).toBe('家具中有害物质限量');
    expect(detail.moreInfo?.nature).toBe('强制');
  });

  it('searches Chinese titles with the name parameter', async () => {
    vi.mocked(pooledFetch)
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: { count: 0, items: [] } }));

    const adapter = new ByAdapter();
    await expect(adapter.searchStandards({ query: '家具中有害物质限量' })).resolves.toEqual([]);
    const searchUrl = new URL(String(vi.mocked(pooledFetch).mock.calls[1]?.[0]));
    expect(searchUrl.searchParams.get('name')).toBe('家具中有害物质限量');
    expect(searchUrl.searchParams.get('code')).toBeNull();
  });

  it('does not swallow network failures as empty results', async () => {
    vi.mocked(pooledFetch)
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockRejectedValueOnce(new Error('socket hang up'));

    await expect(new ByAdapter().searchStandards({ query: '18584-2024' }))
      .rejects.toThrow(/socket hang up/);
  });

  it('maps unauthorized responses to a token configuration error', async () => {
    vi.mocked(pooledFetch)
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse({ ok: false, code: 'UNAUTHORIZED', error: 'nope' }, 401));

    await expect(new ByAdapter().searchStandards({ query: '18584-2024' }))
      .rejects.toThrow(/BY_API_TOKEN/);
  });

  it('requires a token before calling the search API', async () => {
    delete process.env.BY_API_TOKEN;
    vi.mocked(pooledFetch).mockResolvedValueOnce(jsonResponse({ ok: true }));
    await expect(new ByAdapter().searchStandards({ query: '18584-2024' }))
      .rejects.toThrow(/BY_API_TOKEN/);
    expect(vi.mocked(pooledFetch)).toHaveBeenCalledTimes(1);
  });

  it('warms the wrapper session then downloads a PDF', async () => {
    const pdfBytes = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(2048, 65)]);
    vi.mocked(pooledFetch)
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: { count: 1, items: [SAMPLE] } }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: { count: 1, items: [SAMPLE] } }))
      .mockResolvedValueOnce(pdfResponse(pdfBytes));

    const adapter = new ByAdapter();
    await adapter.searchStandards({ query: '18584-2024' });
    const exported = await adapter.exportStandard('by:' + SAMPLE.sid);
    expect(exported.filePath).toMatch(/GB 18584-2024.*\.pdf$/);

    const pdfCall = vi.mocked(pooledFetch).mock.calls[3];
    const pdfUrl = new URL(String(pdfCall?.[0]));
    expect(pdfUrl.pathname).toBe('/api/pdf');
    expect(pdfUrl.searchParams.get('sid')).toBe(SAMPLE.sid);
    expect(pdfUrl.href).not.toContain('test-token');
  });

  it('retries PDF after a NO_PDF session miss', async () => {
    const pdfBytes = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(2048, 66)]);
    vi.mocked(pooledFetch)
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: { count: 1, items: [SAMPLE] } }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: { count: 1, items: [SAMPLE] } }))
      .mockResolvedValueOnce(jsonResponse({ ok: false, code: 'NO_PDF', error: '请先搜索，再下载该标准的 PDF' }, 400))
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: { count: 1, items: [SAMPLE] } }))
      .mockResolvedValueOnce(pdfResponse(pdfBytes));

    const adapter = new ByAdapter();
    await adapter.searchStandards({ query: '18584-2024' });
    await expect(adapter.exportStandard('by:' + SAMPLE.sid)).resolves.toMatchObject({
      filePath: expect.stringMatching(/GB 18584-2024.*\.pdf$/),
    });
    expect(vi.mocked(pooledFetch).mock.calls.filter(call => String(call[0]).includes('/api/pdf'))).toHaveLength(2);
  });
});

describe('ByAdapter live wrapper', () => {
  beforeEach(async () => {
    const actual = await vi.importActual<typeof import('../../shared/http')>('../../shared/http');
    vi.mocked(pooledFetch).mockImplementation(actual.pooledFetch);
  });

  it.runIf(Boolean(process.env.BY_API_TOKEN?.trim()))('searches 18584-2024 through the configured API', async () => {
    const adapter = new ByAdapter();
    const results = await adapter.searchStandards({ query: '18584-2024' });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.id.startsWith('by:')).toBe(true);
    expect(results[0]?.standardNumber).toMatch(/18584-2024/);
  }, 30_000);
});

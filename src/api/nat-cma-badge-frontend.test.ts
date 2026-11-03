import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const script = readFileSync('public/js/app-nat-cma-badge.js', 'utf8');
it('loads the national CMA badge module in the actual page', () => {
  const html = readFileSync('public/index.html', 'utf8');
  expect(html).toContain('<script src="/js/app-nat-cma-badge.js?v=__STDHUB_ASSET_VERSION__"></script>');
});
function setup(fetcher = vi.fn(async () => ({ ok: true, data: {} }))) {
  const listeners: Record<string, (event: any) => void> = {};
  const refresh = vi.fn();
  const open = vi.fn();
  const window: any = { refreshLocalBadgePriority: refresh, openNatCmaTableStandard: open };
  const elements: any[] = [];
  let now = 100;
  vm.runInNewContext(script, {
    window, document: { querySelectorAll: () => elements, addEventListener: (type: string, fn: any) => { listeners[type] = fn; } },
    fetch: fetcher, readApiResponse: async (r: any) => r.data,
    Date: { now: () => now },
  });
  return { window, fetcher, elements, listeners, refresh, open, advance: () => { now += 60001; } };
}

describe('国CMA approved-table badges', () => {
  it('queries the approved table, uses 国CMA wording and preserves restriction hints', async () => {
    const fetcher = vi.fn(async () => ({ ok: true, data: { 'GB/T 32487-2016': { abilityCount: 1, limited: true, summary: '不测：阻燃性能' } } }));
    const api = setup(fetcher);
    await api.window.fetchNatCmaBadges(['GB/T 32487-2016']);
    expect((fetcher.mock.calls as unknown[][])[0]?.[0]).toBe('/api/nat-cma/table/batch-match');
    const html = api.window.natCmaBadgeHtml('GB/T 32487-2016');
    expect(html).toContain('>国CMA<');
    expect(html).toContain('不测：阻燃性能');
    expect(html).toContain('命中不等于全标准覆盖');
    expect(html).toContain('湖北省产品质量监督检验研究院已批准能力表');
    expect(html).not.toContain('场所订阅');
  });
  it('deduplicates cached exact input keys and never invents another year match', async () => {
    const api = setup(vi.fn(async () => ({ ok: true, data: { 'GB 18584-2024': { abilityCount: 2 } } })));
    await api.window.fetchNatCmaBadges(['GB 18584-2024', 'GB 18584-2024', 'GB 18584-2001']);
    await api.window.fetchNatCmaBadges(['GB 18584-2024']);
    expect(api.fetcher).toHaveBeenCalledTimes(1);
    expect(api.window.natCmaBadgeHtml('GB 18584-2001')).not.toContain('>国CMA<');
    expect(api.window.natCmaBadgeHtml('GB 18584-2024')).toContain('>国CMA<');
  });
  it('does not cache HTTP failures as absence and retries later', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce({ ok: true, data: { A: { abilityCount: 1 } } });
    const api = setup(fetcher);
    await api.window.fetchNatCmaBadges(['A']);
    expect(api.window.__natCmaMatchCache.has('A')).toBe(false);
    await api.window.fetchNatCmaBadges(['A']);
    expect(api.window.natCmaBadgeHtml('A')).toContain('>国CMA<');
  });
  it('expires successful positive and negative cache entries', async () => {
    const api = setup(vi.fn(async () => ({ ok: true, data: { A: { abilityCount: 1 } } })));
    await api.window.fetchNatCmaBadges(['A', 'B']);
    api.advance();
    expect(api.window.natCmaBadgeHtml('A')).toContain('badge-pending');
    await api.window.fetchNatCmaBadges(['A', 'B']);
    expect(api.fetcher).toHaveBeenCalledTimes(2);
  });
  it('chunks batches at 100 standards and shares concurrent requests', async () => {
    let resolve!: (value: any) => void;
    const deferred = new Promise(resolve_ => { resolve = resolve_; });
    const api = setup(vi.fn(() => deferred) as any);
    const codes = Array.from({ length: 205 }, (_, i) => 'S' + i);
    const one = api.window.fetchNatCmaBadges(codes);
    const two = api.window.fetchNatCmaBadges(codes);
    expect(api.fetcher).toHaveBeenCalledTimes(3);
    resolve({ ok: true, data: {} });
    await Promise.all([one, two]);
  });
  it('discards old in-flight results after batch invalidation', async () => {
    let resolve!: (value: any) => void;
    const api = setup(vi.fn(() => new Promise(r => { resolve = r; })) as any);
    const pending = api.window.fetchNatCmaBadges(['A']);
    api.window.natCmaInvalidateCache();
    resolve({ ok: true, data: { A: { abilityCount: 99 } } });
    await pending;
    expect(api.window.__natCmaMatchCache.size).toBe(0);
  });
  it('escapes workbook text and standard attributes before rendering', async () => {
    const code = 'A" onclick="alert(1)';
    const api = setup(vi.fn(async () => ({ ok: true, data: { [code]: { abilityCount: 1, summary: '<img src=x onerror=alert(1)>' } } })));
    await api.window.fetchNatCmaBadges([code]);
    const html = api.window.natCmaBadgeHtml(code);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('data-nat-cma="A" onclick=');
    expect(html).toContain('&lt;img');
  });
  it('supports click and keyboard without triggering containing result row', () => {
    const api = setup();
    const target = { getAttribute: () => 'GB/T 32487-2016' };
    const event = { type: 'keydown', key: 'Enter', target: { closest: () => target }, preventDefault: vi.fn(), stopPropagation: vi.fn() };
    api.listeners.keydown(event);
    expect(api.open).toHaveBeenCalledWith('GB/T 32487-2016');
    expect(event.stopPropagation).toHaveBeenCalledOnce();
  });
});

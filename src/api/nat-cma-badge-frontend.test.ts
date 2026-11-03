import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const script = readFileSync('public/js/app-nat-cma-badge.js', 'utf8');
it('loads the national CMA badge module in the actual page', () => {
  const html = readFileSync('public/index.html', 'utf8');
  expect(html).toContain('<script src="/js/app-nat-cma-badge.js?v=__STDHUB_ASSET_VERSION__"></script>');
});
function setup(fetcher: any = vi.fn(async () => ({ ok: true, data: {} }))) {
  const listeners: Record<string, (event: any) => void> = {};
  const refresh = vi.fn();
  const open = vi.fn();
  const disposers = new Map<string, () => void>();
  const request = vi.fn(async (path: string, init?: any) => {
    const response: any = await fetcher(path, init);
    if (!response.ok) throw new Error('Request failed');
    return response.data;
  });
  const content: any = { isConnected: true, innerHTML: '', textContent: '' };
  let closeDialog: (value: boolean) => void = () => {};
  const modal = vi.fn((options: any) => {
    const promise = new Promise<boolean>(resolve => { closeDialog = resolve; });
    options.onMount({ querySelector: () => content }, { finish: closeDialog });
    return promise;
  });
  const window: any = { refreshLocalBadgePriority: refresh, openNatCmaTableStandard: open,
    StdHub: { api: { request }, modal: { confirmHtml: modal }, lifecycle: {
      register: (scope: string, key: string, dispose: () => void) => {
        const name = scope + ':' + key;
        disposers.get(name)?.(); disposers.set(name, dispose);
        return () => { if (disposers.get(name) === dispose) disposers.delete(name); dispose(); };
      },
    } },
  };
  const elements: any[] = [];
  let now = 100;
  vm.runInNewContext(script, {
    window, document: { querySelectorAll: () => elements, addEventListener: (type: string, fn: any) => { listeners[type] = fn; }, removeEventListener: vi.fn() },
    fetch: fetcher, readApiResponse: async (r: any) => r.data,
    Date: { now: () => now },
  });
  return { window, fetcher, request, modal, content, disposers, close: () => closeDialog(false), elements, listeners, refresh, open, advance: () => { now += 60001; } };
}

describe('国CMA approved-table badges', () => {
  it.each(['click', 'Enter', ' '])('activates details with %s and ignores other keyboard keys', (activation) => {
    const api = setup();
    const details = vi.spyOn(api.window.StdHub.natCmaBadge, 'openDetails').mockImplementation(() => {});
    const target = { closest: () => ({ getAttribute: () => 'GB 18584-2024' }) };
    const event = { type: activation === 'click' ? 'click' : 'keydown', key: activation, target, preventDefault: vi.fn(), stopPropagation: vi.fn() };
    api.listeners[event.type](event);
    api.listeners.keydown({ ...event, type: 'keydown', key: 'ArrowDown' });
    expect(details).toHaveBeenCalledExactlyOnceWith('GB 18584-2024');
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });
  it('opens exact abilities independently of qual permission with escaped parameters, restrictions, notes and provenance', async () => {
    const api = setup(vi.fn(async () => ({ ok: true, data: {
      orgName: '湖北省产品质量监督检验研究院',
      batch: { name: '批准批次', filename: '<img src=x>.xlsx', importedAt: '2026-11-03' },
      entries: [{ majorCategory: '化工', category: '家具', parameterName: '<script>参数</script>', stdName: '家具要求', stdCode: 'GB 18584-2024', limitDesc: '不测：阻燃性能', note: '仅限木制品', sheetName: '能力<表>', rowNumber: 42 }],
    } })));
    const pending = api.window.StdHub.natCmaBadge.openDetails('GB 18584-2024');
    await vi.waitFor(() => expect(api.content.innerHTML).toContain('不测：阻燃性能'));
    expect(api.request).toHaveBeenCalledWith('/api/nat-cma/table/abilities?stdCode=GB%2018584-2024');
    for (const text of ['参数', '限制范围', '仅限木制品', '批准批次', '&lt;img src=x&gt;.xlsx', '能力&lt;表&gt;', '42', '未匹配仅表示本表未收录，不代表无资质']) expect(api.content.innerHTML).toContain(text);
    expect(api.content.innerHTML).not.toContain('<script>');
    expect(api.content.innerHTML).not.toContain('<img');
    expect(api.open).not.toHaveBeenCalled();
    api.close(); await pending;
  });
  it('renders empty and failed detail lookups without claiming no qualification', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce({ ok: true, data: { entries: [], batch: null } }).mockRejectedValueOnce(new Error('offline'));
    const api = setup(fetcher);
    let pending = api.window.StdHub.natCmaBadge.openDetails('GB 18584-2001');
    await vi.waitFor(() => expect(api.content.innerHTML).toContain('当前启用能力表未匹配该完整标准号及年版'));
    expect(api.content.innerHTML).toContain('不代表无资质');
    api.close(); await pending;
    pending = api.window.StdHub.natCmaBadge.openDetails('GB 18584-2001');
    await vi.waitFor(() => expect(api.content.textContent).toContain('读取失败'));
    expect(api.content.textContent).toContain('不代表本表未收录或无资质');
    api.close(); await pending;
  });
  it('does not update a closed detail dialog after a delayed response', async () => {
    let resolve!: (value: any) => void;
    const api = setup(vi.fn(() => new Promise(r => { resolve = r; })));
    const pending = api.window.StdHub.natCmaBadge.openDetails('GB 18584-2024');
    api.close(); await pending;
    resolve({ ok: true, data: { entries: [] } });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(api.content.innerHTML).toBe('');
  });
  it('registers global event cleanup and namespace compatibility hooks', async () => {
    const api = setup();
    expect(api.window.StdHub.natCmaBadge.html).toBe(api.window.natCmaBadgeHtml);
    expect(api.window.StdHub.natCmaBadge.fetch).toBe(api.window.fetchNatCmaBadges);
    expect(api.window.StdHub.natCmaBadge.invalidate).toBe(api.window.natCmaInvalidateCache);
    api.disposers.get('global:nat-cma-badge-events')!();
    expect(api.window.__natCmaBadgeReady).toBe(false);
  });

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
    const details = vi.spyOn(api.window.StdHub.natCmaBadge, 'openDetails').mockImplementation(() => {});
    const target = { getAttribute: () => 'GB/T 32487-2016' };
    const event = { type: 'keydown', key: 'Enter', target: { closest: () => target }, preventDefault: vi.fn(), stopPropagation: vi.fn() };
    api.listeners.keydown(event);
    expect(details).toHaveBeenCalledWith('GB/T 32487-2016');
    expect(api.open).not.toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
  });
});

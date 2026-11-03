import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const filename = path.resolve(__dirname, '../../public/js/app-qual-lab.js');
function setup(role = 'admin', allowedTabs: string[] | null = null) {
  const nodes: Record<string, any> = {};
  const node = (id: string) => nodes[id] ||= { innerHTML: '', textContent: '', value: '', hidden: false, disabled: false, dataset: {}, files: [], setAttribute: vi.fn(), querySelectorAll: () => [], addEventListener: vi.fn(), classList: { contains: () => false }, scrollIntoView: vi.fn() };
  const fetch = vi.fn(async (_url: string, _init?: any): Promise<any> => ({ ok: true, status: 200, payload: { total: 0, items: [], batch: null } }));
  const listeners: Record<string, (...args: any[]) => unknown> = {};
  const context = vm.createContext({
    window: { addEventListener: (event: string, fn: (...args: any[]) => unknown) => { listeners[event] = fn; } },
    document: { readyState: 'loading', addEventListener() {}, getElementById: node },
    currentUser: { role, allowedTabs }, fetch, readApiResponse: async (res: any) => res.payload,
    URLSearchParams, FormData, showConfirm: vi.fn(async () => true), switchTab: vi.fn(), showToast: vi.fn(), natCmaInvalidateCache: vi.fn(),
  });
  vm.runInContext(readFileSync(filename, 'utf8'), context, { filename });
  return { context, node, fetch, listeners, run: (code: string) => vm.runInContext(code, context) };
}

describe('approved national CMA table frontend', () => {
  it('renders escaped standard, parameters, restrictions, notes and provenance with partial coverage notice', () => {
    const ui = setup();
    const result = ui.run('renderNatCmaTableGroups(' + JSON.stringify([{ stdCode: '<svg/onload=1>', stdName: 'name', abilityCount: 1, entries: [{ parameterName: '<img src=x onerror=1>', limitDesc: '<b>only listed</b>', note: 'no flame test', sheetName: '表<1>', rowNumber: 6365 }] }]) + ')');
    expect(result).not.toContain('<svg'); expect(result).not.toContain('<img'); expect(result).not.toContain('<b>');
    expect(result).toContain('&lt;svg/onload=1&gt;'); expect(result).toContain('含限制/备注');
    expect(result).toContain('不代表该标准全部项目'); expect(result).toContain('no flame test');
    expect(result).toContain('6365'); expect(result).toContain('表&lt;1&gt;');
  });
  it('loads version status from the explicit status route', async () => {
    const ui = setup('guest', ['qual']);
    await ui.run('loadNatCmaSubscriptions()');
    expect(ui.fetch.mock.calls[0][0]).toBe('/api/nat-cma/table/status');
  });
  it('renders escaped unresolved identifier warnings without implying badge eligibility', () => {
    const ui = setup();
    const result = ui.run('renderNatCmaTableGroups(' + JSON.stringify([{stdCode: 'GB/T5486-2008', exactMatchAvailable:false, entries:[{standardWarning:'<script>verify</script>', stdCode:'GB/T5486-2008 6'}]}]) + ')');
    expect(result).toContain('标准号待核对，不参与徽章自动匹配');
    expect(result).toContain('&lt;script&gt;verify&lt;/script&gt;');
    expect(result).not.toContain('<script>');
    expect(result).toContain('此原表行仅供人工核对');
  });
  it('allows permitted nonadmins to browse blank queries in 20-standard pages', async () => {
    const ui = setup('guest', ['qual']);
    await ui.run('searchNatCmaAbilities(20)');
    expect(ui.fetch.mock.calls[0][0]).toBe('/api/nat-cma/table/search?q=&limit=20&offset=20');
    expect(ui.node('natCmaSearchResults').innerHTML).toContain('每页 20 个标准');
  });
  it('denies query without qual permission and denies nonadmin import and activation', async () => {
    const ui = setup('guest', ['search']);
    await ui.run('searchNatCmaAbilities(0)'); await ui.run('previewNatCmaTable()');
    await ui.run('confirmNatCmaTable()'); await ui.run('activateNatCmaTable(1)');
    expect(ui.fetch).not.toHaveBeenCalled();
  });
  it('uploads multipart preview only, limits samples and warnings, and requires later confirmation', async () => {
    const ui = setup(); ui.node('natCmaTableFile').files = [new Blob(['workbook'])];
    ui.fetch.mockImplementation(async () => ({ ok: true, status: 200, payload: { previewId: 'preview', filename: '<x>.xlsx', samples: Array.from({ length: 12 }, (_, n) => ({ parameterName: 'sample-' + n })), warnings: Array.from({ length: 55 }, (_, n) => ({ row: n, message: '<script>x</script>' })) } }));
    await ui.run('previewNatCmaTable()');
    expect(ui.fetch).toHaveBeenCalledTimes(1); expect(ui.fetch.mock.calls[0][0]).toBe('/api/nat-cma/table/preview');
    const options = ui.fetch.mock.calls[0][1]; expect(options.body).toBeInstanceOf(FormData); expect(options.headers).toBeUndefined();
    const html = ui.node('natCmaTablePreview').innerHTML;
    expect(html).not.toContain('sample-10'); expect(html).not.toContain('<script>'); expect(html).toContain('&lt;x&gt;.xlsx');
    expect(ui.node('natCmaTableConfirm').hidden).toBe(false);
    expect(ui.run('_natCmaTablePreview')).toBe('preview');
  });
  it('does not import when confirmation is cancelled', async () => {
    const ui = setup(); ui.run('_natCmaTablePreview = "preview"'); ui.context.showConfirm = vi.fn(async () => false);
    await ui.run('confirmNatCmaTable()'); expect(ui.fetch).not.toHaveBeenCalled();
  });
  it('confirms a prepared preview with optional batch name, then refreshes active data and badge cache', async () => {
    const ui = setup(); ui.run('_natCmaTablePreview = "preview-id"'); ui.node('natCmaTableBatchName').value = '  approved v2  ';
    await ui.run('confirmNatCmaTable()');
    expect(ui.fetch.mock.calls[0][0]).toBe('/api/nat-cma/table/confirm');
    expect(JSON.parse(ui.fetch.mock.calls[0][1].body)).toEqual({ previewId: 'preview-id', name: 'approved v2' });
    expect(ui.context.natCmaInvalidateCache).toHaveBeenCalledOnce();
    expect(ui.run('_natCmaTablePreview')).toBeNull(); expect(ui.node('natCmaTableConfirm').hidden).toBe(true);
  });
  it('explains duplicate reuse does not activate a prior batch', async () => {
    const ui = setup(); ui.run('_natCmaTablePreview = "duplicate"');
    ui.fetch.mockImplementation(async (url: string) => ({ ok: true, status: 200, payload: url.endsWith('/confirm') ? { alreadyImported: true, batch: { name: 'old' } } : { items: [], total: 0, batch: null } }));
    await ui.run('confirmNatCmaTable()');
    expect(ui.node('natCmaTablePreview').textContent).toContain('当前启用版本未更改');
    expect(ui.fetch.mock.calls.map(call => call[0])).not.toContain('/api/nat-cma/table/activate');
  });
  it('activates a history batch only after confirmation and invalidates badge cache', async () => {
    const ui = setup();
    await ui.run('activateNatCmaTable(7)');
    expect(ui.fetch.mock.calls[0][0]).toBe('/api/nat-cma/table/activate');
    expect(JSON.parse(ui.fetch.mock.calls[0][1].body)).toEqual({ batchId: 7 });
    expect(ui.context.natCmaInvalidateCache).toHaveBeenCalledOnce();
    expect(ui.context.showConfirm).toHaveBeenCalledOnce();
  });
  it('exposes fixed source badge navigation and clears category filter', async () => {
    const ui = setup('guest', ['qual']); ui.node('natCmaCategory').value = 'old';
    await ui.context.window.openNatCmaTableStandard('GB/T 32487-2016');
    expect(ui.context.switchTab).toHaveBeenCalledWith('qual');
    expect(ui.node('natCmaSearchInput').value).toBe('GB/T 32487-2016'); expect(ui.node('natCmaCategory').value).toBe('');
    expect(ui.fetch.mock.calls[0][0]).toContain('/api/nat-cma/table/search?');
  });
  it('never calls suspended crawler or subscription endpoints from compatibility globals', async () => {
    const ui = setup();
    ui.run('startNatCmaSyncPoll(); subscribeNatCma(); unsubscribeNatCma(); syncNatCma(); syncAllNatCma();');
    expect(ui.fetch).not.toHaveBeenCalled();
  });
  it('clears loading state and uses textContent for server errors', async () => {
    const ui = setup(); ui.fetch.mockImplementation(async () => ({ ok: false, status: 500, payload: { message: '<img onerror=1>' } }));
    await ui.run('searchNatCmaAbilities(0)');
    expect(ui.node('natCmaSearchResults').textContent).toContain('<img onerror=1>');
    expect(ui.node('natCmaSearchResults').setAttribute).toHaveBeenLastCalledWith('aria-busy', 'false');
  });
});

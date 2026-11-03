import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const filename = path.resolve(__dirname, '../../public/js/app-qual-lab.js');
const managementFile = path.resolve(__dirname, '../../public/js/app-qual-table-management.js');
function setup(role = 'admin', allowedTabs: string[] | null = null) {
  const nodes: Record<string, any> = {};
  const node = (id: string): any => nodes[id] ||= {
    id, innerHTML: '', textContent: '', value: '', hidden: false, disabled: false, dataset: {}, files: [], style: {},
    listeners: {} as Record<string, Function>, setAttribute: vi.fn(), querySelectorAll: () => [],
    addEventListener(event: string, fn: Function) { this.listeners[event] = fn; },
    removeEventListener(event: string, fn: Function) { if (this.listeners[event] === fn) delete this.listeners[event]; },
    remove() { delete nodes[id]; }, contains: () => true,
    classList: { contains: () => false }, scrollIntoView: vi.fn(),
    closest() { return this; }, hasAttribute(name: string) { return name === 'data-nat-cma-activate' && this.dataset.natCmaActivate != null; },
  };
  ['natCmaTablePanel', 'natCmaSection', 'natCmaSearchInput', 'natCmaCategory', 'natCmaSearchResults', 'natCmaTableAdmin',
    'natCmaTableAdminStatus', 'natCmaTableFile', 'natCmaTableBatchName', 'natCmaTablePreview', 'natCmaTableConfirm',
    'natCmaTableBatches', 'natCmaTablePreviewButton', 'page-settings', 'page-qual'].forEach(node);
  const fetch = vi.fn(async (url: string, _init?: any): Promise<any> => ({ ok: true, status: 200,
    payload: url.endsWith('/preview') ? { previewId: 'preview-id', filename: 'approved.xlsx', samples: [], warnings: [] } : { total: 0, items: [], batch: null } }));
  const listeners: Record<string, (...args: any[]) => unknown> = {};
  const disposers = new Map<string, Function>();
  const window = { addEventListener: (event: string, fn: (...args: any[]) => unknown) => { listeners[event] = fn; },
    onAuthReady: vi.fn(), StdHub: { api: { fetch }, lifecycle: { register(scope: string, key: string, dispose: Function) {
      const id = scope + ':' + key; disposers.get(id)?.(); disposers.set(id, dispose);
    } } } };
  const context = vm.createContext({ window,
    document: { readyState: 'loading', addEventListener() {}, getElementById: (id: string) => nodes[id] || null },
    currentUser: { role, allowedTabs }, fetch, readApiResponse: async (res: any) => res.payload,
    URLSearchParams, FormData, AbortController, showConfirm: vi.fn(async () => true), switchTab: vi.fn(), showToast: vi.fn(), natCmaInvalidateCache: vi.fn(),
  });
  vm.runInContext(readFileSync(filename, 'utf8'), context, { filename });
  vm.runInContext(readFileSync(managementFile, 'utf8'), context, { filename: managementFile });
  const run = (code: string) => vm.runInContext(code, context);
  const click = (id: string) => node('natCmaTableAdmin').listeners.click?.({ target: node(id) });
  const mount = async () => { await run('window.StdHub.natCmaTableManagement.mount()'); fetch.mockClear(); };
  const preparePreview = async () => {
    await mount(); node('natCmaTableFile').files = [new Blob(['workbook'])];
    await click('natCmaTablePreviewButton'); fetch.mockClear();
  };
  return { context, node, nodes, fetch, listeners, run, click, mount, preparePreview, disposers };
}

describe('approved national CMA table frontend', () => {
  it('places administrator controls only in the existing qualification settings section', () => {
    const html = readFileSync(path.resolve('public/index.html'), 'utf8');
    const settings = readFileSync(path.resolve('public/js/app-settings.js'), 'utf8');
    const query = readFileSync(filename, 'utf8');
    expect(html).not.toContain('id="natCmaTableAdmin"');
    expect(html).not.toContain('id="natCmaTableFile"');
    expect(html).toContain('/js/app-qual-table-management.js?v=__STDHUB_ASSET_VERSION__');
    expect(settings).toContain('natCmaTableManagement?.render()');
    expect(settings).toContain('natCmaTableManagement?.mount()');
    for (const token of ['previewNatCmaTable', 'confirmNatCmaTable', 'activateNatCmaTable', '/batches', '/preview', '/confirm', '/activate']) expect(query).not.toContain(token);
    expect(setup().run('window.StdHub.natCmaTableManagement.render()')).toContain('批次历史');
    expect(setup('guest', ['qual']).run('window.StdHub.natCmaTableManagement.render()')).toBe('');
  });
  it('renders escaped standard, parameters, restrictions, notes and provenance with partial coverage notice', () => {
    const ui = setup();
    const result = ui.run('renderNatCmaTableGroups(' + JSON.stringify([{ stdCode: '<svg/onload=1>', stdName: 'name', abilityCount: 1, entries: [{ parameterName: '<img src=x onerror=1>', limitDesc: '<b>only listed</b>', note: 'no flame test', sheetName: '表<1>', rowNumber: 6365 }] }]) + ')');
    expect(result).not.toContain('<svg'); expect(result).not.toContain('<img'); expect(result).not.toContain('<b>');
    expect(result).toContain('&lt;svg/onload=1&gt;'); expect(result).toContain('含限制/备注');
    expect(result).toContain('不代表该标准全部项目'); expect(result).toContain('no flame test');
    expect(result).toContain('6365'); expect(result).toContain('表&lt;1&gt;');
  });
  it('loads only version status for admins on the read-only query page', async () => {
    const ui = setup(); await ui.run('loadNatCmaSubscriptions()');
    expect(ui.fetch.mock.calls.map(call => call[0])).toEqual(['/api/nat-cma/table/status']);
  });
  it('renders unresolved identifier warnings without implying badge eligibility', () => {
    const result = setup().run('renderNatCmaTableGroups(' + JSON.stringify([{stdCode: 'GB/T5486-2008', exactMatchAvailable:false, entries:[{standardWarning:'<script>verify</script>', stdCode:'GB/T5486-2008 6'}]}]) + ')');
    expect(result).toContain('标准号待核对，不参与徽章自动匹配');
    expect(result).toContain('&lt;script&gt;verify&lt;/script&gt;'); expect(result).not.toContain('<script>');
    expect(result).toContain('此原表行仅供人工核对');
  });
  it('allows permitted nonadmins to browse blank queries in 20-standard pages', async () => {
    const ui = setup('guest', ['qual']); await ui.run('searchNatCmaAbilities(20)');
    expect(ui.fetch.mock.calls[0][0]).toBe('/api/nat-cma/table/search?q=&limit=20&offset=20');
    expect(ui.node('natCmaSearchResults').innerHTML).toContain('每页 20 个标准');
  });
  it('denies query without permission and never mounts nonadmin management handlers', async () => {
    const ui = setup('guest', ['search']); await ui.run('searchNatCmaAbilities(0)'); await ui.mount();
    await ui.click('natCmaTablePreviewButton'); await ui.click('natCmaTableConfirm');
    expect(ui.node('natCmaTableAdmin').listeners.click).toBeUndefined(); expect(ui.fetch).not.toHaveBeenCalled();
  });
  it('uploads multipart preview only, escapes content and limits samples and warnings', async () => {
    const ui = setup(); await ui.mount(); ui.node('natCmaTableFile').files = [new Blob(['workbook'])];
    ui.fetch.mockImplementation(async () => ({ ok: true, status: 200, payload: { previewId: 'preview', filename: '<x>.xlsx', samples: Array.from({ length: 12 }, (_, n) => ({ parameterName: 'sample-' + n })), warnings: Array.from({ length: 55 }, (_, n) => ({ row: n, message: '<script>x</script>' })) } }));
    await ui.click('natCmaTablePreviewButton');
    expect(ui.fetch).toHaveBeenCalledTimes(1); expect(ui.fetch.mock.calls[0][0]).toBe('/api/nat-cma/table/preview');
    const options = ui.fetch.mock.calls[0][1]; expect(options.body).toBeInstanceOf(FormData); expect(options.headers).toBeUndefined();
    const html = ui.node('natCmaTablePreview').innerHTML;
    expect(html).not.toContain('sample-10'); expect(html).not.toContain('<script>'); expect(html).toContain('&lt;x&gt;.xlsx');
    expect((html.match(/&lt;script&gt;/g) || []).length).toBe(50); expect(ui.node('natCmaTableConfirm').hidden).toBe(false);
  });
  it('does not import without a preview, after file changes, or when confirmation is cancelled', async () => {
    const ui = setup(); await ui.mount(); await ui.click('natCmaTableConfirm'); expect(ui.fetch).not.toHaveBeenCalled();
    await ui.preparePreview(); ui.context.showConfirm = vi.fn(async () => false);
    await ui.click('natCmaTableConfirm'); expect(ui.fetch).not.toHaveBeenCalled();
    ui.context.showConfirm = vi.fn(async () => true);
    ui.node('natCmaTableAdmin').listeners.change({ target: ui.node('natCmaTableFile') });
    await ui.click('natCmaTableConfirm'); expect(ui.fetch).not.toHaveBeenCalled(); expect(ui.node('natCmaTableConfirm').hidden).toBe(true);
  });
  it('confirms once, refreshes settings history, public status, current query and badge cache', async () => {
    const ui = setup(); await ui.preparePreview(); ui.node('natCmaTableBatchName').value = '  approved v2  ';
    await Promise.all([ui.click('natCmaTableConfirm'), ui.click('natCmaTableConfirm')]);
    expect(ui.fetch.mock.calls[0][0]).toBe('/api/nat-cma/table/confirm');
    expect(JSON.parse(ui.fetch.mock.calls[0][1].body)).toEqual({ previewId: 'preview-id', name: 'approved v2' });
    expect(ui.fetch.mock.calls.filter(call => call[0].endsWith('/confirm'))).toHaveLength(1);
    expect(ui.fetch.mock.calls.map(call => call[0])).toContain('/api/nat-cma/table/batches');
    expect(ui.fetch.mock.calls.map(call => call[0])).toContain('/api/nat-cma/table/status');
    expect(ui.fetch.mock.calls.some(call => call[0].includes('/search?'))).toBe(true);
    expect(ui.context.natCmaInvalidateCache).toHaveBeenCalledOnce(); expect(ui.node('natCmaTableConfirm').hidden).toBe(true);
    ui.fetch.mockClear(); await ui.click('natCmaTableConfirm'); expect(ui.fetch).not.toHaveBeenCalled();
  });
  it('explains duplicate reuse without automatically activating a prior batch', async () => {
    const ui = setup(); await ui.preparePreview();
    ui.fetch.mockImplementation(async (url: string) => ({ ok: true, status: 200, payload: url.endsWith('/confirm') ? { alreadyImported: true, batch: { name: 'old' } } : { items: [], total: 0, batch: null } }));
    await ui.click('natCmaTableConfirm'); expect(ui.node('natCmaTablePreview').textContent).toContain('当前启用版本未更改');
    expect(ui.fetch.mock.calls.map(call => call[0])).not.toContain('/api/nat-cma/table/activate');
  });
  it('activates history only after confirmation and refreshes badges', async () => {
    const ui = setup(); await ui.mount(); const button = ui.node('historyBatch'); button.dataset.natCmaActivate = '7';
    ui.context.showConfirm = vi.fn(async () => false); await ui.click('historyBatch'); expect(ui.fetch).not.toHaveBeenCalled();
    ui.context.showConfirm = vi.fn(async () => true); await ui.click('historyBatch');
    expect(ui.fetch.mock.calls[0][0]).toBe('/api/nat-cma/table/activate');
    expect(JSON.parse(ui.fetch.mock.calls[0][1].body)).toEqual({ batchId: 7 }); expect(ui.context.natCmaInvalidateCache).toHaveBeenCalledOnce();
  });
  it('remounts safely without duplicate handlers and discards previews on leaving settings', async () => {
    const ui = setup(); await ui.preparePreview(); ui.disposers.get('tab:nat-cma-table-management')?.();
    expect(ui.node('natCmaTableConfirm').hidden).toBe(true); expect(ui.node('natCmaTableAdmin').listeners.click).toBeUndefined();
    await ui.mount(); await ui.click('natCmaTableConfirm'); expect(ui.fetch).not.toHaveBeenCalled();
    ui.node('natCmaTableFile').files = [new Blob(['workbook'])]; await ui.click('natCmaTablePreviewButton');
    expect(ui.fetch.mock.calls.map(call => call[0])).toEqual(['/api/nat-cma/table/preview']);
  });
  it('discards an in-flight preview and removes management DOM on logout', async () => {
    const ui = setup(); await ui.mount(); ui.node('natCmaTableFile').files = [new Blob(['workbook'])];
    let resolve!: (value: any) => void;
    ui.fetch.mockImplementation(() => new Promise(done => { resolve = done; }));
    const pending = ui.click('natCmaTablePreviewButton');
    ui.context.currentUser = { role: 'guest', allowedTabs: ['qual'] }; ui.context.window.onAuthReady();
    expect(ui.nodes.natCmaTableAdmin).toBeUndefined();
    expect(ui.fetch.mock.calls[0][1].signal.aborted).toBe(true);
    resolve({ ok: true, payload: { previewId: 'stale-preview', filename: 'stale.xlsx' } }); await pending;
    expect(ui.node('natCmaTableConfirm').hidden).toBe(true); expect(ui.node('natCmaTablePreview').innerHTML).not.toContain('stale.xlsx');
  });
  it('does not render query responses after authorization has changed', async () => {
    const ui = setup(); let resolve!: (value: any) => void;
    ui.fetch.mockImplementation(() => new Promise(done => { resolve = done; }));
    const pending = ui.run('searchNatCmaAbilities(0)');
    ui.context.currentUser = { role: 'guest', allowedTabs: ['search'] }; ui.context.window.onAuthReady();
    resolve({ ok: true, payload: { items: [{ stdCode: 'stale-standard' }], total: 1 } }); await pending;
    expect(ui.node('natCmaSearchResults').innerHTML).not.toContain('stale-standard');
  });
  it('blocks confirmation if authorization changes while the confirmation dialog is open', async () => {
    const ui = setup(); await ui.preparePreview(); let accept!: (value: boolean) => void;
    ui.context.showConfirm = vi.fn(() => new Promise(done => { accept = done; }));
    const pending = ui.click('natCmaTableConfirm');
    ui.context.currentUser = { role: 'guest', allowedTabs: ['qual'] }; ui.context.window.onAuthReady();
    accept(true); await pending; expect(ui.fetch).not.toHaveBeenCalled();
  });
  it('exposes badge navigation and clears category filters', async () => {
    const ui = setup('guest', ['qual']); ui.node('natCmaCategory').value = 'old';
    await ui.context.window.openNatCmaTableStandard('GB/T 32487-2016');
    expect(ui.context.switchTab).toHaveBeenCalledWith('qual'); expect(ui.node('natCmaSearchInput').value).toBe('GB/T 32487-2016');
    expect(ui.node('natCmaCategory').value).toBe(''); expect(ui.fetch.mock.calls[0][0]).toContain('/api/nat-cma/table/search?');
  });
  it('keeps crawler compatibility globals inert and renders server errors as text', async () => {
    const ui = setup(); ui.run('startNatCmaSyncPoll(); subscribeNatCma(); unsubscribeNatCma(); syncNatCma(); syncAllNatCma();');
    expect(ui.fetch).not.toHaveBeenCalled();
    ui.fetch.mockImplementation(async () => ({ ok: false, status: 500, payload: { message: '<img onerror=1>' } }));
    await ui.run('searchNatCmaAbilities(0)'); expect(ui.node('natCmaSearchResults').textContent).toContain('<img onerror=1>');
    expect(ui.node('natCmaSearchResults').setAttribute).toHaveBeenLastCalledWith('aria-busy', 'false');
  });
});

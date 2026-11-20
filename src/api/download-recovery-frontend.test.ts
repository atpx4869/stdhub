import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const scripts = ['app-foundation.js', 'app-core.js', 'app-download-center.js', 'app-download-single.js', 'app-download-batch.js'].map(name => {
  const filename = path.resolve(__dirname, '../../public/js', name);
  return new vm.Script(readFileSync(filename, 'utf8'), { filename });
});

class Button {
  disabled = false;
  textContent = '';
  innerHTML = '';
  style: Record<string, string> = {};
  classList = { toggle() {}, add() {}, remove() {} };
  listeners = new Map<string, (event: Event) => void>();
  addEventListener(name: string, listener: (event: Event) => void) { this.listeners.set(name, listener); }
  removeEventListener(name: string, listener: (event: Event) => void) {
    if (this.listeners.get(name) === listener) this.listeners.delete(name);
  }
  querySelector() { return null; }
  click() { this.listeners.get('click')?.(new Event('click')); }
}

class Stream {
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(readonly path: string) {}
  close() { this.closed = true; }
  send(data: unknown) { this.onmessage?.({ data: JSON.stringify({ data, error: null }) }); }
}

const envelope = (data: unknown, status = 200) => Response.json({ data, error: null }, { status });
const apiError = (code: string, status: number) => Response.json({ data: null, error: { code, message: code } }, { status });
const queued = (id = 'task_original') => ({ id, status: 'queued', phase: 'queued' });
const running = (id = 'task_original') => ({ id, status: 'running', phase: 'saving' });
const success = (id = 'task_original') => ({
  id, status: 'success', phase: 'complete', fileId: 22, fileName: 'GB-T-100.pdf', fileSize: 2_400,
  timingsMs: { queue: 0, transfer: 240, compose: 18, library: 32 },
});
const fixture = {
  id: 'gbw:1', standardNumber: 'GB/T 100', _source: 'gbw', sources: ['gbw', 'bz', 'by', 'sby'],
  _sourceIds: { gbw: 'gbw:1', bz: 'bz:2', by: 'by:3', sby: 'sby:4' }, previewAvailable: false,
};

function setup({ storage = new Map<string, string>(), item = fixture, guest = true } = {}) {
  const nodes = new Map<string, Button>();
  const node = (id: string) => {
    if (!nodes.has(id)) nodes.set(id, new Button());
    return nodes.get(id)!;
  };
  const streams: Stream[] = [];
  const fetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
  const logs = vi.fn(), toasts = vi.fn(), savePdf = vi.fn(), history = vi.fn(), row = vi.fn();
  const library = new Map<string, number>();
  const context = vm.createContext({
    document: {
      addEventListener() {}, readyState: 'loading', body: node('body'), getElementById: node,
      querySelector: () => null, querySelectorAll: () => [],
    },
    addEventListener() {},
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
    AbortController, Date, setTimeout, clearTimeout, fetch,
    EventSource: class extends Stream { constructor(url: string) { super(url); streams.push(this); } },
    testItems: [item], _libraryFileIds: library, applyLibraryDots() {},
    currentUser: { role: guest ? 'guest' : 'admin' },
    addLog() { return 1; }, updateLog: logs, showToast: toasts, updateToolbar() {},
    setRowDownloadState: row, downloadLocalFile: savePdf, recordDownload: history, formatSize: String,
  });
  context.window = context;
  for (const script of scripts) script.runInContext(context);
  const run = <T = unknown>(code: string): T => vm.runInContext(code, context);
  run('results = testItems; selectedIds.add(results[0].id)');
  const requests = () => fetch.mock.calls.map(([url, init]) => (init?.method ?? 'GET') + ' ' + url);
  const task = () => run<Record<string, unknown>>('downloadTasks[0]');
  return { storage, node, streams, fetch, logs, toasts, savePdf, history, row, library, run, requests, task };
}

const post = (id: string) => 'POST /api/standards/' + encodeURIComponent(id) + '/export';
const get = 'GET /api/tasks/task_original';
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('download priority and source-specific evidence', () => {
  it.each([
    { key: 'bzxz_priority_v2', order: ['gbw', 'sby', 'by', 'bz'] },
    { key: 'bzxz_priority', order: ['gbw', 'by', 'bz', 'sby'] },
    { key: 'bzxz_priority', order: ['gbw', 'by', 'bz'] },
  ])('migrates $key default $order only once', ({ key, order }) => {
    const storage = new Map([
      [key, JSON.stringify(order)], ['bzxz_download_sources', '["bz","by"]'],
      ['bzxz_search_preferences_v1', '{"searchSources":["by","bz"]}'],
    ]);
    const first = setup({ storage });
    expect(first.run('downloadPriority')).toEqual(['sby', 'gbw', 'by', 'bz']);
    expect(storage.get('bzxz_priority_v3')).toBe('["sby","gbw","by","bz"]');
    expect(storage.get(key)).toBe(JSON.stringify(order));
    expect(first.run('downloadSources')).toEqual(['bz', 'by']);
    expect(first.run('[...selectedSources]')).toEqual(['by', 'bz']);
    first.run("downloadPriority = ['gbw','sby','by','bz']; saveSettings()");
    expect(setup({ storage }).run('downloadPriority')).toEqual(['gbw', 'sby', 'by', 'bz']);
  });

  it.each(['bzxz_priority', 'bzxz_priority_v2'])('preserves a customized %s order and all switches off', key => {
    const storage = new Map([[key, '["sby","bz","gbw","by"]'], ['bzxz_download_sources', '[]']]);
    const ui = setup({ storage });
    expect(ui.run('downloadPriority')).toEqual(['sby', 'bz', 'gbw', 'by']);
    expect(ui.run('downloadSources')).toEqual([]);
    expect(ui.run('getOrderedDownloadSourcesForResult(results[0])')).toEqual([]);
  });

  it('honors a v2 custom order even when it coincides with an earlier default', () => {
    const storage = new Map([
      ['bzxz_priority', '["sby","bz","gbw","by"]'],
      ['bzxz_priority_v2', '["gbw","by","bz","sby"]'],
    ]);
    expect(setup({ storage }).run('downloadPriority')).toEqual(['gbw', 'by', 'bz', 'sby']);
  });

  it('uses SBY, BW, BY, BZ by default for fresh preferences', () => {
    const ui = setup();
    expect(ui.run('getOrderedDownloadSourcesForResult(results[0])')).toEqual(['sby', 'gbw', 'by', 'bz']);
  });

  it('skips only confirmed source-specific absence and an explicit source overrides it', async () => {
    const ui = setup();
    ui.run(
      "results[0] = { ...results[0], _previewAvailableBySource: { bz: false }, _textAvailabilityBySource: { " +
      "gbw: { state: 'unavailable', reason: 'no_fulltext_entry' }, sby: { state: 'unknown', reason: 'list_text_unconfirmed' }, " +
      "by: { state: 'unavailable', reason: 'source_result' } } }",
    );
    expect(ui.run('getOrderedDownloadSourcesForResult(results[0])')).toEqual(['sby', 'by', 'bz']);
    ui.library.set('gbw:1', 77);
    ui.fetch.mockResolvedValueOnce(envelope(success(), 202));
    await ui.run<Promise<void>>("downloadSpecificSource('gbw:1', 'gbw')");
    expect(ui.requests()).toEqual([post('gbw:1')]);
    expect(ui.savePdf).toHaveBeenCalledWith(22, 'GB-T-100.pdf');
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["downloadOne('gbw:1')", 'downloadSelectedResults()'])('keeps green-dot direct download in %s', async action => {
    const ui = setup({ guest: false, storage: new Map([['bzxz_download_sources', '[]']]) });
    ui.library.set('gbw:1', 77);
    ui.fetch.mockResolvedValueOnce(new Response(null, { headers: { 'Content-Disposition': "attachment; filename*=UTF-8''Local%20PDF.pdf", 'Content-Length': '99' } }));
    await ui.run<Promise<void>>(action);
    expect(ui.requests()).toEqual(['HEAD /api/files/77/pdf/download']);
    expect(ui.savePdf).toHaveBeenCalledWith(77, 'Local PDF.pdf');
    expect(ui.history).toHaveBeenCalledWith('gbw', 'Local PDF.pdf', 'GB/T 100', 77);
    expect(ui.task()).toMatchObject({ status: 'success', progress: '本地库命中' });
    ui.run("StdHub.lifecycle.disposeScope('tab')");
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('single export task observation', () => {
  it.each(['connection-error', 'business-envelope', 'parse-error', 'silence'])('recovers the original task after %s', async reason => {
    const ui = setup();
    ui.fetch.mockResolvedValueOnce(envelope(queued(), 202)).mockResolvedValueOnce(envelope(running())).mockResolvedValueOnce(envelope(success()));
    const done = ui.run<Promise<void>>("downloadOne('gbw:1')");
    await flush();
    const stream = ui.streams[0];
    expect(stream.path).toBe('/api/tasks/task_original/stream');
    expect(ui.task()).toMatchObject({ phase: 'queued', serverTaskId: 'task_original' });
    if (reason === 'connection-error') stream.onerror?.();
    if (reason === 'business-envelope') stream.onmessage?.({ data: '{"data":null,"error":{"code":"UPSTREAM_ERROR","message":"stale"}}' });
    if (reason === 'parse-error') stream.onmessage?.({ data: '!not JSON' });
    if (reason === 'silence') await vi.advanceTimersByTimeAsync(15_000);
    await flush();
    expect(ui.requests()).toEqual([post('sby:4'), get]);
    expect(ui.task()).toMatchObject({ phase: 'saving', progress: 'SBY 正在入库', serverTaskId: 'task_original' });
    expect(stream.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(2_000);
    await done;
    expect(ui.requests()).toEqual([post('sby:4'), get, get]);
    expect(ui.task()).toMatchObject({ source: 'sby', status: 'success', serverTaskId: 'task_original', timingsMs: success().timingsMs });
    expect(ui.task().progress).toContain('排队 0ms · 传输 240ms · 合成 18ms · 入库 32ms');
    expect(ui.savePdf).toHaveBeenCalledWith(22, 'GB-T-100.pdf');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('moves through the four source IDs only after explicit failure or noncreation', async () => {
    const ui = setup();
    ui.fetch.mockResolvedValueOnce(envelope(queued(), 202))
      .mockResolvedValueOnce(envelope({ id: 'task_original', status: 'failed', phase: 'failed', errorMessage: '证实无正文' }))
      .mockResolvedValueOnce(apiError('TOO_MANY_REQUESTS', 429))
      .mockResolvedValueOnce(envelope({ id: 'task_by', status: 'failed', errorMessage: '上游失败' }, 202))
      .mockResolvedValueOnce(envelope(success('task_bz'), 202));
    const done = ui.run<Promise<void>>("downloadOne('gbw:1')");
    await flush();
    ui.streams[0].onerror?.();
    await done;
    expect(ui.requests()).toEqual([post('sby:4'), get, post('gbw:1'), post('by:3'), post('bz:2')]);
    expect(ui.task()).toMatchObject({ status: 'success', source: 'bz', serverTaskId: 'task_bz' });
    expect(ui.streams.every(stream => stream.closed)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ['cancelled', 'cancelled', '已取消'],
    ['libraryError', 'fail', '已取得正文，但入库失败'],
    ['unreadable', 'unknown', '无法确认原下载任务状态'],
  ])('does not change source after %s in the search selection', async (reason, status, text) => {
    const ui = setup();
    ui.fetch.mockResolvedValueOnce(envelope(queued(), 202));
    const done = ui.run<Promise<void>>('downloadSelectedResults()');
    await flush();
    const stream = ui.streams[0];
    if (reason === 'unreadable') {
      ui.fetch.mockResolvedValueOnce(apiError('NOT_FOUND', 404));
      stream.onerror?.();
    } else if (reason === 'cancelled') {
      stream.send({ id: 'task_original', status: 'cancelled', phase: 'cancelled' });
    } else {
      stream.send({ id: 'task_original', status: 'failed', phase: 'failed', errorMessage: 'failed', libraryError: '磁盘错误' });
    }
    await done;
    expect(ui.requests()).toEqual(reason === 'unreadable' ? [post('sby:4'), get] : [post('sby:4')]);
    expect(ui.task()).toMatchObject({ status, serverTaskId: 'task_original', error: expect.stringContaining(text) });
    expect(stream.closed).toBe(true);
    ui.run("StdHub.lifecycle.disposeScope('tab')");
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['network error', 'generic HTTP error', 'missing ID', 'create deadline'])('does not replace an uncertain creation: %s', async reason => {
    const ui = setup();
    if (reason === 'network error') ui.fetch.mockRejectedValueOnce(new TypeError('network interrupted'));
    if (reason === 'generic HTTP error') ui.fetch.mockResolvedValueOnce(apiError('INTERNAL_ERROR', 500));
    if (reason === 'missing ID') ui.fetch.mockResolvedValueOnce(envelope({ status: 'queued' }, 202));
    if (reason === 'create deadline') ui.fetch.mockReturnValueOnce(new Promise<Response>(() => {}));
    const done = ui.run<Promise<void>>("downloadOne('gbw:1')");
    if (reason === 'create deadline') {
      await vi.advanceTimersByTimeAsync(30_000);
      expect(ui.fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
    }
    await done;
    expect(ui.requests()).toEqual([post('sby:4')]);
    expect(ui.task()).toMatchObject({ status: 'unknown', error: expect.stringContaining('无法确认是否已创建'), retry: null });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds polling for a persistently active task without cancelling or replacing it', async () => {
    const ui = setup();
    ui.fetch.mockResolvedValueOnce(envelope(queued(), 202)).mockImplementation(async () => envelope(running()));
    const done = ui.run<Promise<void>>("downloadOne('gbw:1')");
    await flush();
    ui.streams[0].onerror?.();
    await vi.advanceTimersByTimeAsync(300_000);
    await done;
    expect(ui.requests().filter(request => request.startsWith('POST'))).toEqual([post('sby:4')]);
    expect(ui.requests().filter(request => request === get).length).toBeGreaterThan(1);
    expect(ui.task()).toMatchObject({ status: 'unknown', error: expect.stringContaining('观察期限'), serverTaskId: 'task_original' });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('download operation ownership and cleanup', () => {
  it('cancels the original task even if the user cancels before the create response', async () => {
    const ui = setup();
    let acknowledge!: (response: Response) => void;
    ui.fetch.mockImplementationOnce(() => new Promise(resolve => { acknowledge = resolve; }))
      .mockResolvedValueOnce(envelope({ cancelled: true, task: { id: 'task_original', status: 'cancelled', phase: 'cancelled' } }));
    const button = ui.node('source');
    button.innerHTML = '下载';
    ui.run("var sourceButton = document.getElementById('source')");
    const done = ui.run<Promise<void>>("downloadSpecificSource('gbw:1', 'sby', sourceButton)");
    expect(button.textContent).toBe('取消下载');
    button.click();
    expect(ui.fetch.mock.calls[0][1]?.signal?.aborted).toBe(false);
    acknowledge(envelope(queued(), 202));
    await done;
    expect(ui.requests()).toEqual([post('sby:4'), 'POST /api/tasks/task_original/cancel']);
    expect(ui.task()).toMatchObject({ status: 'cancelled', serverTaskId: 'task_original' });
    expect(ui.streams).toHaveLength(0);
    expect(button.listeners.size).toBe(0);
    expect(button.innerHTML).toBe('下载');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops only the active selection and removes its timers and SSE', async () => {
    const ui = setup();
    ui.fetch.mockResolvedValueOnce(envelope(queued(), 202)).mockResolvedValueOnce(envelope(queued('task_selection'), 202))
      .mockResolvedValueOnce(envelope({ cancelled: true, task: { id: 'task_selection', status: 'cancelled' } }));
    const single = ui.run<Promise<void>>("downloadOne('gbw:1')");
    await flush();
    ui.run("results.push({ id: 'gbw:5', standardNumber: 'GB/T 500', sources: ['gbw'] }); selectedIds.add('gbw:5')");
    const selection = ui.run<Promise<void>>('downloadSelectedResults()');
    await flush();
    ui.node('stopDownload').click();
    await selection;
    // The already-running row was not submitted again by the selection.
    expect(ui.requests()).toEqual([post('sby:4'), post('gbw:5'), 'POST /api/tasks/task_selection/cancel']);
    expect(ui.streams.map(stream => stream.closed)).toEqual([false, true]);
    ui.streams[0].send(success());
    await single;
    ui.run("StdHub.lifecycle.disposeScope('tab')");
    expect(ui.streams.every(stream => stream.closed)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never retries or changes source when cancellation cannot be confirmed', async () => {
    const ui = setup();
    ui.fetch.mockResolvedValueOnce(envelope(queued(), 202))
      .mockRejectedValueOnce(new TypeError('cancel response lost'))
      .mockResolvedValueOnce(envelope(running()));
    const done = ui.run<Promise<void>>("downloadSpecificSource('gbw:1', 'by', document.getElementById('source'))");
    await flush();
    ui.node('source').click();
    await done;
    expect(ui.requests()).toEqual([post('by:3'), 'POST /api/tasks/task_original/cancel', get]);
    expect(ui.task()).toMatchObject({ status: 'unknown', serverTaskId: 'task_original', error: expect.stringContaining('未能确认服务器已取消') });
    expect(ui.streams[0].closed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('tab disposal aborts an in-flight status read without failing or cancelling the server task', async () => {
    const ui = setup();
    ui.fetch.mockResolvedValueOnce(envelope(queued(), 202)).mockImplementationOnce(async (_url, options) =>
      new Promise((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(options.signal?.reason))),
    );
    const done = ui.run<Promise<void>>("downloadOne('gbw:1')");
    await flush();
    ui.streams[0].onerror?.();
    await flush();
    expect(ui.requests()).toEqual([post('sby:4'), get]);
    ui.run("StdHub.lifecycle.disposeScope('tab')");
    await done;
    expect(ui.fetch.mock.calls[1][1]?.signal?.aborted).toBe(true);
    expect(ui.task()).toMatchObject({ status: 'unknown', serverTaskId: 'task_original', error: expect.stringContaining('已离开下载页面') });
    expect(ui.requests()).toEqual([post('sby:4'), get]);
    expect(ui.toasts).not.toHaveBeenCalled();
    expect(ui.row).not.toHaveBeenCalledWith('gbw:1', 'fail');
    expect(ui.streams[0].closed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

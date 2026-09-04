import BetterSqlite3 from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';

import { StandardDownloadOrchestrator } from './standard-download-orchestrator';

function makeOrchestrator(overrides: {
  runDownload?: (...args: any[]) => Promise<any>;
  moveToLibrary?: (...args: any[]) => Promise<any>;
  autoDownloadSources?: string[];
} = {}) {
  const db = new BetterSqlite3(':memory:');
  const autoDownloadSources = new Set(overrides.autoDownloadSources || []);
  const sourceRegistry = { get: (source: string) => autoDownloadSources.has(source) ? { autoDownload: vi.fn() } : {} } as any;
  const runDownload = overrides.runDownload ?? vi.fn(async () => ({
    result: { standardId: 'bz:123', filePath: 'tmp.pdf', fileName: 'tmp.pdf', fileSize: 2048 },
  }));
  const moveToLibrary = overrides.moveToLibrary ?? vi.fn(async () => ({
    fileId: 7, absPath: 'library.pdf', fileName: 'library.pdf', libraryUrl: '/api/files/7/pdf/download',
  }));
  const orchestrator = new StandardDownloadOrchestrator(db as any, sourceRegistry, { runDownload, moveToLibrary });
  return { db, orchestrator, runDownload, moveToLibrary };
}

describe('StandardDownloadOrchestrator', () => {
  it('reuses one in-flight download for the same source and standard id', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const runDownload = vi.fn(async () => {
      await gate;
      return { result: { standardId: 'bz:123', filePath: 'tmp.pdf', fileName: 'tmp.pdf', fileSize: 2048 } };
    });
    const { db, orchestrator } = makeOrchestrator({ runDownload });

    const first = orchestrator.download('bz', 'bz:123', { id: 'a', userId: 1, channel: 'direct' });
    const second = orchestrator.download('bz', 'bz:123', { id: 'b', userId: 2, channel: 'preview' });
    expect(first.created).toBe(true);
    expect(first.reused).toBe(false);
    expect(second.created).toBe(false);
    expect(second.reused).toBe(true);
    expect(runDownload).toHaveBeenCalledTimes(1);
    release();
    await expect(Promise.all([first.promise, second.promise])).resolves.toHaveLength(2);
    db.close();
  });

  it('allows different source or standard keys to run concurrently', async () => {
    let entered = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const runDownload = vi.fn(async () => {
      entered += 1;
      await gate;
      return { result: { standardId: 'test', filePath: `tmp-${entered}.pdf`, fileName: 'tmp.pdf', fileSize: 2048 } };
    });
    const { db, orchestrator } = makeOrchestrator({ runDownload });
    const jobs = [
      orchestrator.download('bz', 'bz:1', { id: 'a', userId: 1, channel: 'direct' }).promise,
      orchestrator.download('by', 'by:1', { id: 'b', userId: 1, channel: 'direct' }).promise,
      orchestrator.download('bz', 'bz:2', { id: 'c', userId: 1, channel: 'direct' }).promise,
    ];
    await vi.waitFor(() => expect(entered).toBe(3));
    release();
    await Promise.all(jobs);
    db.close();
  });

  it('only aborts when the last subscriber unsubscribes', async () => {
    let observedSignal!: AbortSignal;
    const runDownload = vi.fn(async (_source, _id, _user, signal: AbortSignal) => {
      observedSignal = signal;
      await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      throw new Error('unreachable');
    });
    const { db, orchestrator } = makeOrchestrator({ runDownload });
    const first = orchestrator.download('bz', 'bz:123', { id: 'a', userId: 1, channel: 'direct' });
    const second = orchestrator.download('bz', 'bz:123', { id: 'b', userId: 2, channel: 'preview' });
    expect(first.unsubscribe()).toEqual({ aborted: false, remainingSubscribers: 1 });
    expect(observedSignal.aborted).toBe(false);
    expect(second.unsubscribe()).toEqual({ aborted: true, remainingSubscribers: 0 });
    await expect(first.promise).rejects.toThrow('No download subscribers remain');
    db.close();
  });

  it('reports library_failed without losing the downloaded file result', async () => {
    const { db, orchestrator } = makeOrchestrator({
      moveToLibrary: vi.fn(async () => ({ error: 'library unavailable' })),
    });
    const handle = orchestrator.download('bz', 'bz:123', { id: 'a', userId: 1, channel: 'direct' });
    await expect(handle.promise).resolves.toMatchObject({
      status: 'library_failed',
      filePath: 'tmp.pdf',
      fileName: 'tmp.pdf',
      libraryError: 'library unavailable',
    });
    db.close();
  });

  it('reports library_failed when moveToLibrary returns no fileId and no error', async () => {
    const { db, orchestrator } = makeOrchestrator({
      moveToLibrary: vi.fn(async () => ({})),
    });
    const handle = orchestrator.download('bz', 'bz:123', { id: 'a', userId: 1, channel: 'direct' });
    await expect(handle.promise).resolves.toMatchObject({
      status: 'library_failed',
      fileId: undefined,
      libraryError: '下载完成但文件未写入本地库',
    });
    db.close();
  });

  it('does not share user-owned autoDownload sessions across users', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const runDownload = vi.fn(async (_source, _id, userId) => {
      await gate;
      return { result: { standardId: 'gbw:1', filePath: `u${userId}.pdf`, fileName: `u${userId}.pdf`, fileSize: 2048 } };
    });
    const { db, orchestrator } = makeOrchestrator({ runDownload, autoDownloadSources: ['gbw'] });
    const first = orchestrator.download('gbw', 'gbw:1', { id: 'a', userId: 1, channel: 'direct' });
    const second = orchestrator.download('gbw', 'gbw:1', { id: 'b', userId: 2, channel: 'direct' });
    expect(first.reused).toBe(false);
    expect(second.reused).toBe(false);
    expect(runDownload).toHaveBeenCalledTimes(2);
    release();
    await Promise.all([first.promise, second.promise]);
    db.close();
  });

  it('close aborts and waits for active flights', async () => {
    let observedSignal!: AbortSignal;
    const runDownload = vi.fn(async (_source, _id, _user, signal: AbortSignal) => {
      observedSignal = signal;
      await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      throw new Error('unreachable');
    });
    const { db, orchestrator } = makeOrchestrator({ runDownload });
    const handle = orchestrator.download('bz', 'bz:shutdown', { id: 'a', userId: 1, channel: 'direct' });
    await orchestrator.close();
    expect(observedSignal.aborted).toBe(true);
    await expect(handle.promise).rejects.toThrow('Application shutting down');
    db.close();
  });

  it('starts a fresh download after the prior flight settles', async () => {
    const { db, orchestrator, runDownload } = makeOrchestrator();
    await orchestrator.download('bz', 'bz:123', { id: 'a', userId: 1, channel: 'direct' }).promise;
    await orchestrator.download('bz', 'bz:123', { id: 'b', userId: 1, channel: 'direct' }).promise;
    expect(runDownload).toHaveBeenCalledTimes(2);
    db.close();
  });
});

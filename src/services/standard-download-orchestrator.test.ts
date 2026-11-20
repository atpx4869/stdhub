import BetterSqlite3 from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';

import { measureDownloadStage } from '../shared/download-timing';
import { ExportTaskService } from './export-task-service';
import { ExportTaskStore } from './export-task-store';
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

  it('replays progress to an export that joins an existing flight and keeps its full stage timings', async () => {
    vi.useFakeTimers();
    try {
      const pause = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); });
      const runDownload = vi.fn(async (_source, _id, _user, _signal, report) => {
        await measureDownloadStage('queue', () => pause(16));
        await measureDownloadStage('transfer', async () => {
          report(1, 2);
          await pause(40);
          report(2, 2);
        });
        await measureDownloadStage('compose', () => pause(25));
        return { result: { standardId: 'bz:123', filePath: 'tmp.pdf', fileName: 'tmp.pdf', fileSize: 2048, totalPages: 2 } };
      });
      const moveToLibrary = vi.fn(async () => {
        await pause(30);
        return { fileId: 7 };
      });
      const { db, orchestrator } = makeOrchestrator({ runDownload, moveToLibrary });
      try {
        const firstPhase = vi.fn();
        const first = orchestrator.download('bz', 'bz:123', { id: 'initial', userId: 1, channel: 'preview' }, undefined, firstPhase);
        expect(firstPhase).toHaveBeenCalledExactlyOnceWith('queued');
        await vi.advanceTimersByTimeAsync(26);
        const store = new ExportTaskStore();
        const sut = new ExportTaskService(store, orchestrator);
        const task = sut.createTask('bz', 'bz:123', 2, { queueMs: 7 });
        expect(task).toMatchObject({ status: 'running', phase: 'downloading', currentPage: 1, totalPages: 2 });
        expect(runDownload).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(55);
        expect(moveToLibrary).toHaveBeenCalledTimes(1);
        expect(store.get(task.id)).toMatchObject({ status: 'running', phase: 'saving', currentPage: 2 });
        expect(firstPhase.mock.calls.flat()).toEqual(['queued', 'connecting', 'downloading', 'verifying', 'saving']);
        await vi.advanceTimersByTimeAsync(30);
        const timingsMs = { queue: 16, transfer: 40, compose: 25, library: 30 };
        await expect(first.promise).resolves.toMatchObject({ status: 'downloaded', timingsMs });
        expect(first.getTimings?.()).toEqual(timingsMs);
        expect(store.get(task.id)).toMatchObject({ status: 'success', phase: 'complete', fileId: 7, timingsMs: { ...timingsMs, queue: 23 } });
      } finally {
        db.close();
      }
    } finally {
      vi.useRealTimers();
    }
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

  it('does not reuse an aborted flight that has not finished unwinding', async () => {
    let rejectFirst!: (error: Error) => void;
    const firstRun = new Promise<never>((_resolve, reject) => { rejectFirst = reject; });
    let releaseSecond!: () => void;
    const secondRun = new Promise<void>(resolve => { releaseSecond = resolve; });
    const runDownload = vi.fn(async () => {
      if (runDownload.mock.calls.length === 1) return firstRun;
      await secondRun;
      return { result: { standardId: 'bz:retry', filePath: 'new.pdf', fileName: 'new.pdf', fileSize: 2048 } };
    });
    const { db, orchestrator } = makeOrchestrator({ runDownload });
    try {
      const first = orchestrator.download('bz', 'bz:retry', { id: 'first', userId: 1, channel: 'export' });
      expect(first.unsubscribe()).toEqual({ aborted: true, remainingSubscribers: 0 });
      const second = orchestrator.download('bz', 'bz:retry', { id: 'second', userId: 1, channel: 'export' });
      const rejected = expect(first.promise).rejects.toThrow('adapter observed abort late');
      rejectFirst(new Error('adapter observed abort late'));
      await rejected;
      const third = orchestrator.download('bz', 'bz:retry', { id: 'third', userId: 2, channel: 'preview' });
      expect(second).toMatchObject({ created: true, reused: false });
      expect(third).toMatchObject({ created: false, reused: true });
      expect(third.promise).toBe(second.promise);
      expect(runDownload).toHaveBeenCalledTimes(2);
      releaseSecond();
      await expect(second.promise).resolves.toMatchObject({ status: 'downloaded', fileId: 7 });
    } finally {
      db.close();
    }
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

  it('includes library timing on a thrown post-body error', async () => {
    const { db, orchestrator } = makeOrchestrator({
      moveToLibrary: vi.fn(async () => { throw new Error('local database unavailable'); }),
    });
    try {
      const handle = orchestrator.download('bz', 'bz:123', { id: 'a', userId: 1, channel: 'export' });
      await expect(handle.promise).resolves.toMatchObject({
        status: 'library_failed', filePath: 'tmp.pdf', libraryError: 'local database unavailable',
        timingsMs: { library: expect.any(Number) },
      });
    } finally {
      db.close();
    }
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

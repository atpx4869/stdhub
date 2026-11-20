import { describe, expect, it, vi } from 'vitest';
import type { DownloadStageTimings } from '../shared/download-timing';
import { ExportTaskService } from './export-task-service';
import { ExportTaskStore } from './export-task-store';
import type { DownloadHandle, OrchestratedDownloadResult, StandardDownloadOrchestrator } from './standard-download-orchestrator';

type Download = StandardDownloadOrchestrator['download'];

function makeFlight(promise: DownloadHandle['promise'], timingsMs?: DownloadStageTimings) {
  const unsubscribe = vi.fn(() => ({ aborted: true, remainingSubscribers: 0 }));
  return { key: 'k', created: true, reused: false, promise, unsubscribe, getTimings: () => timingsMs ?? {} };
}

const RESULT: OrchestratedDownloadResult = {
  source: 'bz', standardId: 'bz:1', status: 'downloaded', fileId: 9,
  fileSize: 2048, totalPages: 12, fileName: 'x.pdf', filePath: '/p/x.pdf',
};

describe('ExportTaskService', () => {
  it('starts one export-channel flight and adds the request queue time to completed stages', async () => {
    const store = new ExportTaskStore();
    const result = { ...RESULT, timingsMs: { queue: 10, transfer: 20, compose: 30, library: 40 } };
    const download = vi.fn<Download>(() => makeFlight(Promise.resolve(result)));
    const sut = new ExportTaskService(store, { download });
    const onFinished = vi.fn();

    const task = sut.createTask('bz', 'bz:1', 1, { queueMs: 7, onFinished });
    expect(task).toMatchObject({ status: 'running', phase: 'connecting', timingsMs: { queue: 7 } });
    expect(download).toHaveBeenCalledExactlyOnceWith('bz', 'bz:1', { id: task.id, userId: 1, channel: 'export' }, expect.any(Function), expect.any(Function));

    await vi.waitFor(() => expect(store.get(task.id)).toMatchObject({
      status: 'success', phase: 'complete', fileId: 9, totalPages: 12, fileName: 'x.pdf',
      timingsMs: { queue: 17, transfer: 20, compose: 30, library: 40 },
    }));
    expect(onFinished).toHaveBeenCalledExactlyOnceWith(store.get(task.id));
  });

  it('reuses a queued task for the same user and shares BZ across users without a second flight', async () => {
    const store = new ExportTaskStore();
    let release!: (result: OrchestratedDownloadResult) => void;
    const pending = new Promise<OrchestratedDownloadResult>(resolve => { release = resolve; });
    const download = vi.fn<Download>((_source, _id, _sub, _progress, phase) => {
      phase?.('queued');
      return makeFlight(pending);
    });
    const sut = new ExportTaskService(store, { download });
    const first = sut.createTask('bz', 'bz:1', 1, { queueMs: 10 });
    const sameUser = sut.createTask('bz', 'bz:1', 1, { queueMs: 100 });
    const second = sut.createTask('bz', 'bz:1', 2, { queueMs: 1000 });
    expect(first).toMatchObject({ status: 'queued', phase: 'queued' });
    expect(sameUser).toBe(first);
    expect(second).toMatchObject({ id: first.id, subscribers: [1, 2], timingsMs: { queue: 10 } });
    expect(download).toHaveBeenCalledTimes(1);
    release(RESULT);
    await vi.waitFor(() => expect(store.get(first.id)?.status).toBe('success'));
  });

  it('updates active status with phases and cannot roll back saving with late page callbacks', async () => {
    const store = new ExportTaskStore();
    const download = vi.fn<Download>(() => makeFlight(Promise.resolve(RESULT)));
    const sut = new ExportTaskService(store, { download });
    const task = sut.createTask('bz', 'bz:1', 1);
    const [, , , onProgress, onPhase] = download.mock.calls[0];
    onPhase!('queued');
    expect(store.get(task.id)).toMatchObject({ status: 'queued', phase: 'queued' });
    onProgress!(3, 10);
    expect(store.get(task.id)).toMatchObject({ status: 'running', phase: 'downloading', currentPage: 3, totalPages: 10 });
    onPhase!('verifying');
    expect(store.get(task.id)?.phase).toBe('verifying');
    onPhase!('saving');
    onProgress!(4, 10);
    expect(store.get(task.id)).toMatchObject({ status: 'running', phase: 'saving', currentPage: 3 });
    await vi.waitFor(() => expect(store.get(task.id)?.status).toBe('success'));
    const terminal = store.get(task.id);
    onPhase!('queued');
    onProgress!(9, 10);
    expect(store.get(task.id)).toBe(terminal);
  });

  it('marks a post-body library error as failure, while retaining timing and a distinct fallback signal', async () => {
    const store = new ExportTaskStore();
    const result = { ...RESULT, fileId: undefined, status: 'library_failed' as const, libraryError: 'disk full', timingsMs: { transfer: 23, library: 9 } };
    const sut = new ExportTaskService(store, { download: () => makeFlight(Promise.resolve(result)) });
    const task = sut.createTask('bz', 'bz:1', 1);
    await vi.waitFor(() => expect(store.get(task.id)).toMatchObject({
      status: 'failed', phase: 'failed', errorMessage: '已取得正文，但保存到本地库失败',
      libraryError: 'disk full', fileName: 'x.pdf', timingsMs: { transfer: 23, library: 9 },
    }));
  });

  it('records the reached stages of an upstream error without a library failure flag', async () => {
    const store = new ExportTaskStore();
    const download = vi.fn<Download>(() => makeFlight(Promise.reject(new Error('upstream 503')), { transfer: 50 }));
    const sut = new ExportTaskService(store, { download });
    const task = sut.createTask('bz', 'bz:1', 1, { queueMs: 5 });
    await vi.waitFor(() => expect(store.get(task.id)).toMatchObject({
      status: 'failed', phase: 'failed', errorMessage: 'upstream 503', timingsMs: { queue: 5, transfer: 50 },
    }));
    expect(store.get(task.id)?.libraryError).toBeUndefined();
  });

  it('unsubscribes on cancel and cannot overwrite terminal state with a late rejection', async () => {
    const store = new ExportTaskStore();
    let rejectFlight!: (error: Error) => void;
    const pending = new Promise<OrchestratedDownloadResult>((_resolve, reject) => { rejectFlight = reject; });
    const flight = makeFlight(pending, { transfer: 6 });
    const sut = new ExportTaskService(store, { download: () => flight });
    const onFinished = vi.fn();
    const task = sut.createTask('bz', 'bz:1', 1, { onFinished });
    expect(sut.cancel(task.id)).toBe(true);
    expect(flight.unsubscribe).toHaveBeenCalledTimes(1);
    const cancelled = store.get(task.id);

    rejectFlight(new Error('No download subscribers remain'));
    await pending.catch(() => {});
    expect(store.get(task.id)).toBe(cancelled);
    expect(cancelled).toMatchObject({ status: 'cancelled', phase: 'cancelled', errorMessage: '用户已取消下载', timingsMs: { transfer: 6 } });
    expect(onFinished).toHaveBeenCalledExactlyOnceWith(cancelled);
    expect(sut.cancel(task.id)).toBe(false);
    expect(flight.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('cancel on an already-settled task is a no-op', async () => {
    const store = new ExportTaskStore();
    const flight = makeFlight(Promise.resolve(RESULT));
    const sut = new ExportTaskService(store, { download: () => flight });
    const task = sut.createTask('bz', 'bz:1', 1);
    await vi.waitFor(() => expect(store.get(task.id)?.status).toBe('success'));
    expect(sut.cancel(task.id)).toBe(false);
    expect(flight.unsubscribe).not.toHaveBeenCalled();
  });

  it('getTask throws NotFoundError for an unknown id', () => {
    const sut = new ExportTaskService(new ExportTaskStore(), { download: vi.fn() });
    expect(() => sut.getTask('missing')).toThrow('Export task not found: missing');
  });
});

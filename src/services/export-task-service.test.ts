import { describe, expect, it, vi } from 'vitest';

import { ExportTaskService } from './export-task-service';
import { ExportTaskStore } from './export-task-store';

function makeFlight(promise: Promise<unknown>) {
  const unsubscribe = vi.fn(() => ({ aborted: false, remainingSubscribers: 0 }));
  return { key: 'k', created: true, reused: false, promise, unsubscribe };
}

const RESULT = {
  source: 'bz' as const,
  standardId: 'bz:1',
  status: 'downloaded' as const,
  fileId: 9,
  fileSize: 2048,
  totalPages: 12,
  fileName: 'x.pdf',
  filePath: '/p/x.pdf',
};

describe('ExportTaskService (D3c orchestrator wiring)', () => {
  it('creates a task and starts one export-channel flight on a new export', async () => {
    const store = new ExportTaskStore();
    const download = vi.fn((_source: string, _id: string, _sub: unknown) => makeFlight(Promise.resolve(RESULT)));
    const sut = new ExportTaskService(store, { download } as any);

    const task = sut.createTask('bz', 'bz:1', 1);
    expect(task.status).toBe('queued');
    expect(download).toHaveBeenCalledTimes(1);
    expect(download.mock.calls[0][0]).toBe('bz');
    expect(download.mock.calls[0][1]).toBe('bz:1');
    expect(download.mock.calls[0][2]).toMatchObject({ id: task.id, userId: 1, channel: 'export' });

    await vi.waitFor(() => expect(store.get(task.id)?.status).toBe('success'));
    const settled = store.get(task.id)!;
    expect(settled.fileId).toBe(9);
    expect(settled.totalPages).toBe(12);
    expect(settled.fileName).toBe('x.pdf');
    expect(settled.phase).toBe('complete');
  });

  it('reuses the active task without starting a second flight', async () => {
    const store = new ExportTaskStore();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const download = vi.fn((_s: string, _i: string, _sub: unknown) => makeFlight(gate.then(() => RESULT)));
    const sut = new ExportTaskService(store, { download } as any);

    const first = sut.createTask('bz', 'bz:1', 1);
    const second = sut.createTask('bz', 'bz:1', 2);
    expect(download).toHaveBeenCalledTimes(1);
    expect(second.id).toBe(first.id);
    expect(second.subscribers).toEqual([1, 2]);
    release();
  });

  it('forwards progress and phase callbacks into the store', async () => {
    const store = new ExportTaskStore();
    let onProgress!: (current: number, total: number) => void;
    let onPhase!: (phase: 'downloading' | 'verifying' | 'saving') => void;
    const download = vi.fn((...args: any[]) => {
      onProgress = args[3];
      onPhase = args[4];
      return makeFlight(Promise.resolve(RESULT));
    });
    const sut = new ExportTaskService(store, { download } as any);

    const task = sut.createTask('bz', 'bz:1', 1);
    onProgress(3, 10);
    expect(store.get(task.id)?.phase).toBe('downloading');
    expect(store.get(task.id)?.currentPage).toBe(3);
    expect(store.get(task.id)?.totalPages).toBe(10);

    onPhase('verifying');
    expect(store.get(task.id)?.phase).toBe('verifying');
    onPhase('saving');
    expect(store.get(task.id)?.phase).toBe('saving');
  });

  it('marks failed when the flight rejects', async () => {
    const store = new ExportTaskStore();
    const download = vi.fn((_s: string, _i: string, _sub: unknown) => makeFlight(Promise.reject(new Error('upstream 503'))));
    const sut = new ExportTaskService(store, { download } as any);

    const task = sut.createTask('bz', 'bz:1', 1);
    await vi.waitFor(() => expect(store.get(task.id)?.status).toBe('failed'));
    expect(store.get(task.id)?.errorMessage).toBe('upstream 503');
    expect(store.get(task.id)?.phase).toBe('failed');
  });

  it('cancel aborts the flight and a late rejection never overwrites cancelled', async () => {
    const store = new ExportTaskStore();
    let rejectFlight!: (e: Error) => void;
    const flight = new Promise<unknown>((_resolve, reject) => { rejectFlight = reject; });
    const unsubscribe = vi.fn(() => ({ aborted: true, remainingSubscribers: 0 }));
    const download = vi.fn((_s: string, _i: string, _sub: unknown) => ({ key: 'k', created: true, reused: false, promise: flight, unsubscribe }));
    const sut = new ExportTaskService(store, { download } as any);

    const task = sut.createTask('bz', 'bz:1', 1);
    expect(sut.cancel(task.id)).toBe(true);
    expect(unsubscribe).toHaveBeenCalledTimes(1);

    rejectFlight(new Error('No download subscribers remain'));
    await vi.waitFor(() => expect(store.get(task.id)?.status).toBe('cancelled'));
    expect(store.get(task.id)?.errorMessage).toBe('用户已取消下载');
  });

  it('cancel on an already-settled task is a no-op', async () => {
    const store = new ExportTaskStore();
    const unsubscribe = vi.fn(() => ({ aborted: true, remainingSubscribers: 0 }));
    const download = vi.fn((_s: string, _i: string, _sub: unknown) => ({ key: 'k', created: true, reused: false, promise: Promise.resolve(RESULT), unsubscribe }));
    const sut = new ExportTaskService(store, { download } as any);

    const task = sut.createTask('bz', 'bz:1', 1);
    await vi.waitFor(() => expect(store.get(task.id)?.status).toBe('success'));
    expect(sut.cancel(task.id)).toBe(false);
    expect(unsubscribe).toHaveBeenCalledTimes(0);
  });

  it('getTask throws NotFoundError for an unknown id', () => {
    const store = new ExportTaskStore();
    const sut = new ExportTaskService(store, { download: vi.fn() } as any);
    expect(() => sut.getTask('missing')).toThrow('Export task not found: missing');
  });
});
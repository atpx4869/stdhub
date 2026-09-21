import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BadRequestError } from '../shared/errors';
import { CompletionTaskStore } from './completion-task-store';

describe('CompletionTaskStore', () => {
  beforeEach(() => vi.useRealTimers());
  afterEach(() => vi.useRealTimers());

  it('returns a structured queue full error', async () => {
    const store = new CompletionTaskStore(1, 0);
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    store.create(1, async () => { await pending; return {}; });
    expect(() => store.create(1, async () => ({}))).toThrowError(expect.objectContaining({ code: 'COMPLETE_QUEUE_FULL', statusCode: 429 }));
    release();
    await store.close();
  });

  it('preserves AppError codes and details on async failure', async () => {
    const store = new CompletionTaskStore(1, 1);
    const task = store.create(1, async () => { throw new BadRequestError('stale', { token: true }); });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(store.get(task.id, 1)).toMatchObject({ status: 'failed', error: { code: 'BAD_REQUEST', message: 'stale', details: { token: true } } });
    await store.close();
  });

  it('aborts and waits for running promises during close', async () => {
    const store = new CompletionTaskStore(1, 1);
    let settled = false;
    store.create(1, async (_id, signal) => {
      await new Promise<void>(resolve => signal.addEventListener('abort', () => setTimeout(resolve, 20), { once: true }));
      settled = true;
      return {};
    });
    await new Promise(resolve => setTimeout(resolve, 5));
    await store.close(1_000);
    expect(settled).toBe(true);
  });

  it('returns a recoverable completion error for missing tasks after restart', () => {
    const restartedStore = new CompletionTaskStore(1, 1);
    expect(() => restartedStore.get('task-created-before-restart', 1)).toThrowError(expect.objectContaining({
      code: 'COMPLETE_TASK_NOT_FOUND',
      statusCode: 404,
      message: '补全任务已结束或服务已重启，请重新执行',
    }));
  });

  it('expires terminal tasks when they are read after the retention period', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
    const store = new CompletionTaskStore(1, 1);
    const task = store.create(1, async () => ({}));
    await vi.runAllTimersAsync();
    expect(store.get(task.id, 1).status).toBe('success');

    vi.setSystemTime(new Date('2025-01-01T00:31:00.000Z'));
    expect(() => store.get(task.id, 1)).toThrowError(expect.objectContaining({
      code: 'COMPLETE_TASK_NOT_FOUND',
      statusCode: 404,
    }));
    await store.close();
  });
});

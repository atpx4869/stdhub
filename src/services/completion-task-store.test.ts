import { describe, expect, it } from 'vitest';

import { BadRequestError } from '../shared/errors';
import { CompletionTaskStore } from './completion-task-store';

describe('CompletionTaskStore', () => {
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
});

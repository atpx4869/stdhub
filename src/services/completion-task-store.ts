import { randomUUID } from 'node:crypto';

import type { CompletionTask, CompletionTaskPhase } from '../domain/completion';
import { AppError, CompletionError, NotFoundError } from '../shared/errors';

interface InternalTask {
  publicTask: CompletionTask;
  controller: AbortController;
  listeners: Set<(task: CompletionTask) => void>;
  run: (taskId: string, signal: AbortSignal) => Promise<Partial<CompletionTask>>;
  runningPromise?: Promise<void>;
}

export class CompletionTaskStore {
  private readonly tasks = new Map<string, InternalTask>();
  private readonly queue: string[] = [];
  private active = 0;
  private closed = false;
  private nextCleanupAt = 0;

  constructor(private readonly concurrency: number, private readonly maxQueued: number) {}

  create(userId: number, run: (taskId: string, signal: AbortSignal) => Promise<Partial<CompletionTask>>): CompletionTask {
    this.cleanupExpired();
    if (this.closed) throw new CompletionError(503, 'COMPLETE_SERVICE_CLOSED', '补全任务服务已关闭');
    if (this.active >= this.concurrency && this.queue.length >= this.maxQueued) throw new CompletionError(429, 'COMPLETE_QUEUE_FULL', '补全任务队列已满，请稍后重试');
    const now = new Date().toISOString();
    const publicTask: CompletionTask = {
      id: randomUUID(), userId, status: 'queued', phase: 'queued', current: 0, total: 0,
      message: '等待执行', createdAt: now, updatedAt: now,
    };
    const internal: InternalTask = { publicTask, controller: new AbortController(), listeners: new Set(), run };
    this.tasks.set(publicTask.id, internal);
    this.queue.push(publicTask.id);
    void this.drain();
    return structuredClone(publicTask);
  }

  get(taskId: string, userId: number): CompletionTask {
    const internal = this.tasks.get(taskId);
    if (!internal || internal.publicTask.userId !== userId) throw new NotFoundError('Completion task not found');
    return structuredClone(internal.publicTask);
  }

  update(taskId: string, patch: Partial<CompletionTask>): CompletionTask {
    const internal = this.tasks.get(taskId);
    if (!internal) throw new NotFoundError('Completion task not found');
    internal.publicTask = { ...internal.publicTask, ...patch, id: internal.publicTask.id, userId: internal.publicTask.userId, updatedAt: new Date().toISOString() };
    const snapshot = structuredClone(internal.publicTask);
    for (const listener of internal.listeners) listener(snapshot);
    return snapshot;
  }

  progress(taskId: string, phase: CompletionTaskPhase, current: number, total: number, message: string): void {
    this.update(taskId, { status: 'running', phase, current, total, message });
  }

  cancel(taskId: string, userId: number): CompletionTask {
    const task = this.get(taskId, userId);
    const internal = this.tasks.get(taskId)!;
    if (task.status === 'success' || task.status === 'failed' || task.status === 'cancelled') return task;
    internal.controller.abort(new Error('任务已取消'));
    const queueIndex = this.queue.indexOf(taskId);
    if (queueIndex >= 0) this.queue.splice(queueIndex, 1);
    return this.update(taskId, { status: 'cancelled', phase: 'cancelled', message: '任务已取消' });
  }

  subscribe(taskId: string, userId: number, listener: (task: CompletionTask) => void): () => void {
    this.get(taskId, userId);
    const internal = this.tasks.get(taskId)!;
    internal.listeners.add(listener);
    listener(structuredClone(internal.publicTask));
    return () => internal.listeners.delete(listener);
  }

  async close(timeoutMs = 10_000): Promise<void> {
    this.closed = true;
    for (const task of this.tasks.values()) {
      if (task.publicTask.status === 'queued' || task.publicTask.status === 'running') task.controller.abort(new Error('应用正在关闭'));
    }
    this.queue.length = 0;
    const running = [...this.tasks.values()].map(task => task.runningPromise).filter((promise): promise is Promise<void> => Boolean(promise));
    if (!running.length) return;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled(running),
        new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('等待补全任务结束超时')), timeoutMs); }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private cleanupExpired(): void {
    const now = Date.now();
    if (now < this.nextCleanupAt) return;
    this.nextCleanupAt = now + 60_000;
    for (const [id, task] of this.tasks) {
      if (['success', 'failed', 'cancelled'].includes(task.publicTask.status) && Date.parse(task.publicTask.updatedAt) < now - 30 * 60_000) this.tasks.delete(id);
    }
  }

  private async drain(): Promise<void> {
    while (!this.closed && this.active < this.concurrency && this.queue.length) {
      const taskId = this.queue.shift()!;
      const internal = this.tasks.get(taskId);
      if (!internal || internal.publicTask.status === 'cancelled') continue;
      this.active++;
      this.update(taskId, { status: 'running', phase: 'parsing', message: '正在解析工作簿' });
      const runningPromise = internal.run(taskId, internal.controller.signal)
        .then(patch => {
          if (internal.publicTask.status !== 'cancelled') this.update(taskId, { ...patch, status: 'success', phase: 'complete', message: '补全完成' });
        })
        .catch(error => {
          if (internal.controller.signal.aborted || internal.publicTask.status === 'cancelled') {
            if (internal.publicTask.status !== 'cancelled') this.update(taskId, { status: 'cancelled', phase: 'cancelled', message: '任务已取消' });
            return;
          }
          const appError = error instanceof AppError ? error : null;
          this.update(taskId, {
            status: 'failed', phase: 'failed', message: '补全失败',
            error: {
              code: appError?.code ?? 'COMPLETION_FAILED',
              message: error instanceof Error ? error.message : String(error),
              ...(appError?.details !== undefined ? { details: appError.details } : {}),
            },
          });
        })
        .finally(() => {
          this.active--;
          internal.runningPromise = undefined;
          void this.drain();
        });
      internal.runningPromise = runningPromise;
    }
  }
}

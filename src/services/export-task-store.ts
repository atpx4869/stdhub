import crypto from 'node:crypto';
import type { AdapterSourceName, ExportTask } from '../domain/standard';

const TTL_MS = 60 * 60 * 1000; // 1 hour after a terminal state

type TerminalStatus = 'success' | 'failed' | 'cancelled';
type ActivePhase = 'queued' | 'connecting' | 'downloading' | 'verifying' | 'saving';
type ExportTaskOutput = Pick<ExportTask, 'filePath' | 'fileName' | 'fileSize' | 'totalPages' | 'fileId' | 'libraryError' | 'timingsMs'>;

export function isActiveExportTask(task: ExportTask): boolean {
  return task.status === 'queued' || task.status === 'running';
}

function downloadKey(source: AdapterSourceName, standardId: string, userId: number): string {
  // BW autoDownload creates user-owned download sessions. Other sources share the
  // same active task across users just as they share the underlying download.
  return JSON.stringify([source, standardId, source === 'gbw' ? userId : null]);
}

export class ExportTaskStore {
  private readonly tasks = new Map<string, ExportTask>();
  private readonly activeByDownload = new Map<string, string>();
  private cleanupTimer: ReturnType<typeof setInterval> | undefined;

  create(source: AdapterSourceName, standardId: string, userId: number, queueMs?: number): { task: ExportTask; created: boolean } {
    const key = downloadKey(source, standardId, userId);
    const existingId = this.activeByDownload.get(key);
    const existing = existingId ? this.tasks.get(existingId) : undefined;
    if (existing && isActiveExportTask(existing)) {
      const task = existing.subscribers.includes(userId) ? existing : this.updateActive(existing.id, {
        subscribers: [...existing.subscribers, userId],
      })!;
      return { task, created: false };
    }

    const now = new Date().toISOString();
    const task: ExportTask = {
      // Opaque id; not a substitute for per-user subscriber checks.
      id: `task_${crypto.randomUUID()}`,
      userId,
      subscribers: [userId],
      source,
      standardId,
      status: 'queued',
      phase: 'queued',
      ...(queueMs !== undefined ? { timingsMs: { queue: queueMs } } : {}),
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.set(task.id, task);
    this.activeByDownload.set(key, task.id);
    this.ensureCleanup();
    return { task, created: true };
  }

  markPhase(taskId: string, phase: ActivePhase): void {
    const status = phase === 'queued' ? 'queued' : 'running';
    const current = this.tasks.get(taskId);
    if (current?.phase === phase && current.status === status) return;
    this.updateActive(taskId, { phase, status });
  }

  markProgress(taskId: string, currentPage: number, totalPages: number): void {
    const current = this.tasks.get(taskId);
    if (current?.phase === 'verifying' || current?.phase === 'saving') return;
    this.updateActive(taskId, { currentPage, totalPages, status: 'running', phase: 'downloading' });
  }

  markSuccess(taskId: string, output: ExportTaskOutput): ExportTask | undefined {
    return this.finish(taskId, 'success', output);
  }

  markFailed(taskId: string, errorMessage: string, output: ExportTaskOutput = {}): ExportTask | undefined {
    return this.finish(taskId, 'failed', { ...output, errorMessage });
  }

  markCancelled(taskId: string, timingsMs?: ExportTask['timingsMs']): ExportTask | undefined {
    return this.finish(taskId, 'cancelled', {
      errorMessage: '用户已取消下载',
      ...(timingsMs ? { timingsMs } : {}),
    });
  }

  get(taskId: string): ExportTask | undefined {
    return this.tasks.get(taskId);
  }

  isSubscriber(taskId: string, userId: number): boolean {
    return this.tasks.get(taskId)?.subscribers.includes(userId) ?? false;
  }

  private updateActive(taskId: string, partial: Partial<ExportTask>): ExportTask | undefined {
    const current = this.tasks.get(taskId);
    if (!current || !isActiveExportTask(current)) return;
    const task = { ...current, ...partial, updatedAt: new Date().toISOString() };
    this.tasks.set(taskId, task);
    return task;
  }

  private finish(taskId: string, status: TerminalStatus, partial: Partial<ExportTask>): ExportTask | undefined {
    const task = this.updateActive(taskId, { ...partial, status, phase: status === 'success' ? 'complete' : status });
    if (!task) return;
    const key = downloadKey(task.source, task.standardId, task.userId);
    if (this.activeByDownload.get(key) === taskId) this.activeByDownload.delete(key);
    return task;
  }

  private ensureCleanup(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => {
      const cutoff = Date.now() - TTL_MS;
      for (const [id, task] of this.tasks) {
        if (!isActiveExportTask(task) && Date.parse(task.updatedAt) <= cutoff) this.tasks.delete(id);
      }
      if (this.tasks.size === 0) {
        clearInterval(this.cleanupTimer);
        this.cleanupTimer = undefined;
      }
    }, 600_000);
    this.cleanupTimer.unref?.();
  }
}

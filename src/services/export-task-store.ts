import crypto from 'node:crypto';
import type { ExportResult, ExportTask } from '../domain/standard';

const TTL_MS = 60 * 60 * 1000; // 1 hour

export class ExportTaskStore {
  private readonly tasks = new Map<string, ExportTask>();
  // 跨用户下载去重的核心索引：standardId → 当前活跃任务 id
  // - 活跃定义：status ∈ {queued, running}；终态 (success/failed) 不算活跃
  // - 终态时 markSuccess/markFailed 会摘除映射，让下一次下载能重新起任务
  //   （否则旧的成功 task 缓存几小时，文件可能被清理 / 用户想重新下也走不通）
  private readonly activeByStandard = new Map<string, string>();
  private _cleanupTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * 创建 task；若同 standardId 已有活跃 task（queued/running），把 userId 加入订阅者
   * 并返回已存在的 task，不再起底层导出（adapter.exportStandard 不再被第二次调用）。
   *
   * 调用方（ExportTaskService.createTask）拿到 task 后看 status：
   * - queued (新建)：跑 runTask
   * - queued/running (复用)：直接返回给前端，前端走相同 SSE 流拿进度
   * - success/failed 不会到这（活跃判断已排除）
   */
  create(standardId: string, userId: number): ExportTask {
    const existingId = this.activeByStandard.get(standardId);
    if (existingId) {
      const existing = this.tasks.get(existingId);
      // 活跃索引兜底：若 existing 已被 cleanup 删掉但索引没清，按新建处理
      if (existing && (existing.status === 'queued' || existing.status === 'running')) {
        if (!existing.subscribers.includes(userId)) {
          existing.subscribers = [...existing.subscribers, userId];
          existing.updatedAt = new Date().toISOString();
        }
        return existing;
      }
      this.activeByStandard.delete(standardId);
    }

    const now = new Date().toISOString();
    const task: ExportTask = {
      // Unpredictable opaque id — combined with per-user ownership checks this
      // prevents adjacent users from snooping each other's export progress.
      id: `task_${crypto.randomUUID()}`,
      userId,
      subscribers: [userId],
      standardId,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
    };

    this.tasks.set(task.id, task);
    this.activeByStandard.set(standardId, task.id);
    this.ensureCleanup();
    return task;
  }

  markRunning(taskId: string): void {
    this.update(taskId, { status: 'running' });
  }

  markSuccess(
    taskId: string,
    result: ExportResult & { fileId?: number; libraryError?: string },
  ): void {
    this.update(taskId, {
      status: 'success',
      filePath: result.filePath,
      fileName: result.fileName,
      fileSize: result.fileSize,
      totalPages: result.totalPages,
      ...(result.fileId !== undefined ? { fileId: result.fileId } : {}),
      ...(result.libraryError !== undefined ? { libraryError: result.libraryError } : {}),
    });
    this.releaseActive(taskId);
  }

  markFailed(taskId: string, errorMessage: string): void {
    this.update(taskId, {
      status: 'failed',
      errorMessage,
    });
    this.releaseActive(taskId);
  }

  markProgress(taskId: string, currentPage: number, totalPages: number): void {
    this.update(taskId, { currentPage, totalPages });
  }

  get(taskId: string): ExportTask | undefined {
    return this.tasks.get(taskId);
  }

  /** 判断给定用户是否有权访问 task —— 含初始 owner 和后续加入的订阅者 */
  isSubscriber(taskId: string, userId: number): boolean {
    const task = this.tasks.get(taskId);
    return !!task && task.subscribers.includes(userId);
  }

  private update(taskId: string, partial: Partial<ExportTask>): void {
    const current = this.tasks.get(taskId);
    if (!current) {
      return;
    }

    this.tasks.set(taskId, {
      ...current,
      ...partial,
      updatedAt: new Date().toISOString(),
    });
  }

  /** 终态时摘除 activeByStandard 索引；下次同标准下载会起新 task */
  private releaseActive(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    if (this.activeByStandard.get(task.standardId) === taskId) {
      this.activeByStandard.delete(task.standardId);
    }
  }

  private ensureCleanup(): void {
    if (this._cleanupTimer) return;
    this._cleanupTimer = setInterval(() => {
      const cutoff = Date.now() - TTL_MS;
      for (const [id, task] of this.tasks) {
        if (new Date(task.createdAt).getTime() < cutoff) {
          this.tasks.delete(id);
          if (this.activeByStandard.get(task.standardId) === id) {
            this.activeByStandard.delete(task.standardId);
          }
        }
      }
      if (this.tasks.size === 0 && this._cleanupTimer) {
        clearInterval(this._cleanupTimer);
        this._cleanupTimer = null;
      }
    }, 600_000); // every 10 min
    // Don't keep the event loop alive solely for this housekeeping interval —
    // the process should be free to exit when nothing else is pending.
    this._cleanupTimer.unref?.();
  }
}

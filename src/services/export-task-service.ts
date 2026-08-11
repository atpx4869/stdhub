import { NotFoundError } from '../shared/errors';
import type { ExportTask, SourceName } from '../domain/standard';
import type { ExportTaskStore } from './export-task-store';
import type { DownloadHandle, StandardDownloadOrchestrator } from './standard-download-orchestrator';

/**
 * 异步导出任务（`POST /api/standards/:id/export` + SSE `/api/tasks/:taskId/stream`）。
 *
 * D3c 迁移：export task 从「adapter.exportStandard 直跑」迁入统一编排器
 * `StandardDownloadOrchestrator`（channel `export`），与 multi-download / preview
 * 共享同一 in-flight flight —— 同标准并发时底层 adapter 只被调用一次。
 *
 * 职责分工：
 * - `ExportTaskStore`  负责 task 生命周期（排队/进度/终态）、跨用户 subscribers 与 SSE 回放。
 * - 编排器             负责 in-flight 收敛、AbortSignal 贯穿与 moveToLibrary 入库。
 * - 本类               是胶水：只在「确实新建」时挂一次编排器 flight（复用任务直接返回
 *                      store 现有 task，前端走 SSE 拿进度），并把编排器结果写回 store。
 *
 * 取消语义：`cancel()` 先 `store.markCancelled` 置终态（防编排器 reject 后回写覆盖），
 * 再 `handle.unsubscribe()` —— export 通道只有 taskId 一个订阅者，退订即触发 abort。
 * 用户 HTTP 断连不调 unsubscribe（任务中心语义：任务在后台继续跑完，不因一个请求断开而中止）。
 */
export class ExportTaskService {
  private readonly handles = new Map<string, DownloadHandle>();

  constructor(
    private readonly store: ExportTaskStore,
    private readonly orchestrator: StandardDownloadOrchestrator,
  ) {}

  createTask(source: SourceName, standardId: string, userId: number): ExportTask {
    const task = this.store.create(standardId, userId);
    // 仅 'queued' 且无其它订阅者才是真正新建：复用活跃任务时 store 返回已存在的 task，
    // 这里不重复挂 flight（否则同 standard 会被二次调用 adapter，去重失效）。
    if (task.subscribers.length === 1 && task.status === 'queued') {
      const handle = this.orchestrator.download(source, standardId, {
        id: task.id,
        userId,
        channel: 'export',
      }, (current, total) => this.store.markProgress(task.id, current, total), (phase) => {
        if (phase === 'verifying' || phase === 'saving') this.store.markPhase(task.id, phase);
      });
      this.handles.set(task.id, handle);
      void handle.promise.then(
        (result) => this.onSettled(task.id, result),
        (error) => this.onSettled(task.id, undefined, error),
      );
    }
    return task;
  }

  getTask(taskId: string): ExportTask {
    const task = this.store.get(taskId);
    if (!task) {
      throw new NotFoundError(`Export task not found: ${taskId}`);
    }
    return task;
  }

  cancel(taskId: string): boolean {
    const cancelled = this.store.markCancelled(taskId);
    if (cancelled) {
      const handle = this.handles.get(taskId);
      if (handle) {
        handle.unsubscribe();
        this.handles.delete(taskId);
      }
    }
    return cancelled;
  }

  private onSettled(
    taskId: string,
    result?: import('./standard-download-orchestrator').OrchestratedDownloadResult,
    error?: unknown,
  ): void {
    const task = this.store.get(taskId);
    if (!task || task.status === 'cancelled') return; // 用户已取消：终态优先，不回写覆盖
    this.handles.delete(taskId);

    if (error) {
      const message = error instanceof Error ? error.message : 'Unknown export error';
      this.store.markFailed(taskId, message);
      return;
    }
    if (!result) return;

    this.store.markSuccess(taskId, {
      standardId: result.standardId,
      filePath: result.filePath || '',
      fileName: result.fileName || '',
      fileSize: result.fileSize,
      totalPages: result.totalPages,
      ...(result.fileId !== undefined ? { fileId: result.fileId } : {}),
      ...(result.libraryError !== undefined ? { libraryError: result.libraryError } : {}),
    });
  }
}

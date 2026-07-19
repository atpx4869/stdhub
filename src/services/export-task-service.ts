import { NotFoundError } from '../shared/errors';
import type Database from 'better-sqlite3';
import type { SourceAdapter, ExportTask, SourceName } from '../domain/standard';
import { ExportTaskStore } from './export-task-store';
import { stat } from 'node:fs/promises';

const activeExportControllers = new Map<string, AbortController>();

export function cancelExportTask(store: ExportTaskStore, taskId: string): boolean {
  const cancelled = store.markCancelled(taskId);
  if (cancelled) activeExportControllers.get(taskId)?.abort();
  return cancelled;
}
import type { SourceRegistry } from './source-registry';
import { moveDownloadToLibrary } from './download-to-library';

/**
 * 异步导出任务（`POST /api/standards/:id/export` + SSE `/api/tasks/:taskId/stream`）。
 *
 * 历史：早期只把文件落到 `data/exports/`，结果绕过了 `moveDownloadToLibrary` 入库 hook，
 * 桌面端按"下载"后 BZ/BY 的 PDF 不会出现在 `<exe 同级>/standards/`，也就拿不到 fileId
 * 用来点亮绿点。现在 runTask 在 adapter 跑完后立即入库，把 `fileId` / `libraryError`
 * 写回 task —— SSE 端流式回放最终 frame 时，前端就能拿到 fileId 写回 `_libraryFileIds`。
 */
export class ExportTaskService {
  constructor(
    private readonly adapter: SourceAdapter,
    private readonly store: ExportTaskStore,
    private readonly db: Database.Database,
    private readonly sourceRegistry: SourceRegistry,
    private readonly source: SourceName,
  ) {}

  createTask(standardId: string, userId: number): ExportTask {
    const task = this.store.create(standardId, userId);
    // 仅 'queued' 才是真正新建：复用活跃任务时 store 返回的是已存在的 task（status
    // 可能是 queued 或 running）。这里如果对复用 task 也跑 runTask，会重复调 adapter，
    // 整个去重就废了 —— 用 createdAt === updatedAt && status === 'queued' 也行，
    // 但 subscribers 检查更简洁：新建时 subscribers.length === 1，复用时 ≥ 2。
    if (task.subscribers.length === 1 && task.status === 'queued') {
      void this.runTask(task.id, standardId);
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

  private async runTask(taskId: string, standardId: string): Promise<void> {
    this.store.markRunning(taskId);
    const controller = new AbortController();
    activeExportControllers.set(taskId, controller);

    try {
      const result = await this.adapter.exportStandard(standardId, {
        onProgress: (current, total) => this.store.markProgress(taskId, current, total),
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;

      let fileSize = result.fileSize;
      if (!fileSize) {
        try { fileSize = (await stat(result.filePath)).size; } catch {}
      }
      if (controller.signal.aborted) return;

      this.store.markPhase(taskId, 'verifying');
      this.store.markPhase(taskId, 'saving');
      const moved = await moveDownloadToLibrary(
        this.db,
        this.sourceRegistry,
        this.source,
        standardId,
        { filePath: result.filePath, fileName: result.fileName, fileSize },
      );
      if (controller.signal.aborted) return;

      this.store.markSuccess(taskId, {
        ...result,
        fileSize,
        ...(moved.absPath ? { filePath: moved.absPath } : {}),
        ...(moved.fileName ? { fileName: moved.fileName } : {}),
        ...(moved.fileId !== undefined ? { fileId: moved.fileId } : {}),
        ...(moved.error ? { libraryError: moved.error } : {}),
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      const message = error instanceof Error ? error.message : 'Unknown export error';
      this.store.markFailed(taskId, message);
    } finally {
      activeExportControllers.delete(taskId);
    }
  }
}

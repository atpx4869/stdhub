import { NotFoundError } from '../shared/errors';
import type { AdapterSourceName, ExportTask } from '../domain/standard';
import type { DownloadStageTimings } from '../shared/download-timing';
import type { ExportTaskStore } from './export-task-store';
import type { DownloadHandle, OrchestratedDownloadResult, StandardDownloadOrchestrator } from './standard-download-orchestrator';

interface CreateExportTaskOptions {
  queueMs?: number;
  onFinished?: (task: ExportTask) => void;
}

interface ExportFlight {
  handle?: DownloadHandle;
  startedAt: number;
  onFinished?: CreateExportTaskOptions['onFinished'];
}

/** A task owns one export subscription; opening or closing an SSE stream does not change it. */
export class ExportTaskService {
  private readonly flights = new Map<string, ExportFlight>();

  constructor(
    private readonly store: ExportTaskStore,
    private readonly orchestrator: Pick<StandardDownloadOrchestrator, 'download'>,
  ) {}

  createTask(source: AdapterSourceName, standardId: string, userId: number, options: CreateExportTaskOptions = {}): ExportTask {
    const { task, created } = this.store.create(source, standardId, userId, options.queueMs);
    if (!created) return task;

    const flight: ExportFlight = { startedAt: performance.now() - (options.queueMs ?? 0), onFinished: options.onFinished };
    this.flights.set(task.id, flight);
    this.store.markPhase(task.id, 'connecting');
    try {
      const handle = this.orchestrator.download(source, standardId, { id: task.id, userId, channel: 'export' },
        (current, total) => this.store.markProgress(task.id, current, total),
        phase => this.store.markPhase(task.id, phase),
      );
      flight.handle = handle;
      void handle.promise.then(
        result => this.onDownloaded(task.id, flight, result),
        error => this.onRejected(task.id, flight, error),
      );
    } catch (error) {
      this.onRejected(task.id, flight, error);
    }
    return this.getTask(task.id);
  }

  getTask(taskId: string): ExportTask {
    const task = this.store.get(taskId);
    if (!task) throw new NotFoundError(`Export task not found: ${taskId}`);
    return task;
  }

  cancel(taskId: string): boolean {
    const flight = this.flights.get(taskId);
    const task = this.store.markCancelled(taskId, this.finalTimings(taskId, flight?.handle?.getTimings?.()));
    if (!task) return false;
    // Freeze terminal state first; any late progress and pending rejection are ignored.
    flight?.handle?.unsubscribe();
    if (flight) this.finish(task, flight);
    return true;
  }

  private finalTimings(taskId: string, shared?: DownloadStageTimings): DownloadStageTimings | undefined {
    const timings = { ...shared };
    const gateQueue = this.store.get(taskId)?.timingsMs?.queue;
    if (gateQueue !== undefined) timings.queue = (timings.queue ?? 0) + gateQueue;
    return Object.keys(timings).length > 0 ? timings : undefined;
  }

  private onDownloaded(taskId: string, flight: ExportFlight, result: OrchestratedDownloadResult): void {
    const timingsMs = this.finalTimings(taskId, result.timingsMs ?? flight.handle?.getTimings?.());
    const output = {
      filePath: result.filePath || '',
      fileName: result.fileName || '',
      fileSize: result.fileSize,
      ...(result.totalPages !== undefined ? { totalPages: result.totalPages } : {}),
      ...(result.fileId !== undefined ? { fileId: result.fileId } : {}),
      ...(timingsMs ? { timingsMs } : {}),
    };
    const task = result.status === 'library_failed'
      ? this.store.markFailed(taskId, '已取得正文，但保存到本地库失败', {
        ...output, libraryError: result.libraryError || '下载完成但文件未写入本地库',
      })
      : this.store.markSuccess(taskId, output);
    if (task) this.finish(task, flight);
  }

  private onRejected(taskId: string, flight: ExportFlight, error: unknown): void {
    const timingsMs = this.finalTimings(taskId, flight.handle?.getTimings?.());
    const task = this.store.markFailed(taskId, error instanceof Error ? error.message : 'Unknown export error',
      timingsMs ? { timingsMs } : {},
    );
    if (task) this.finish(task, flight);
  }

  private finish(task: ExportTask, flight: ExportFlight): void {
    this.flights.delete(task.id);
    console.log('[download-task]', {
      source: task.source, taskId: task.id, status: task.status, durationMs: Math.round(performance.now() - flight.startedAt),
      ...(task.timingsMs ? { timingsMs: task.timingsMs } : {}),
    });
    try { flight.onFinished?.(task); } catch { /* usage recording must not change the task's outcome */ }
  }
}

import type Database from 'better-sqlite3';
import type { DownloadSessionInfo, ExportResult, SourceName } from '../domain/standard';
import type { SourceRegistry } from './source-registry';
import { moveDownloadToLibrary, type MoveDownloadResult } from './download-to-library';

export type DownloadChannel = 'direct' | 'preview' | 'export';

export interface DownloadSubscriber {
  id: string;
  userId: number;
  channel: DownloadChannel;
}

export interface OrchestratedDownloadResult {
  source: SourceName;
  standardId: string;
  status: 'downloaded' | 'library_failed';
  filePath?: string;
  fileName?: string;
  fileSize?: number;
  fileId?: number;
  downloadUrl?: string;
  libraryError?: string;
  session?: DownloadSessionInfo;
}

export interface DownloadHandle {
  key: string;
  created: boolean;
  reused: boolean;
  promise: Promise<OrchestratedDownloadResult>;
  unsubscribe(): { aborted: boolean; remainingSubscribers: number };
}

interface ActiveDownload {
  controller: AbortController;
  subscribers: Map<string, DownloadSubscriber>;
  promise: Promise<OrchestratedDownloadResult>;
}

interface OrchestratorDependencies {
  runDownload?: (
    source: SourceName,
    standardId: string,
    userId: number,
    signal: AbortSignal,
    onProgress?: (current: number, total: number) => void,
  ) => Promise<{ result: ExportResult; session?: DownloadSessionInfo }>;
  moveToLibrary?: (
    source: SourceName,
    standardId: string,
    result: ExportResult,
  ) => Promise<MoveDownloadResult>;
}

export class StandardDownloadOrchestrator {
  private closed = false;
  private readonly active = new Map<string, ActiveDownload>();
  private readonly runDownload: NonNullable<OrchestratorDependencies['runDownload']>;
  private readonly moveToLibrary: NonNullable<OrchestratorDependencies['moveToLibrary']>;

  constructor(
    private readonly db: Database.Database,
    private readonly sourceRegistry: SourceRegistry,
    dependencies: OrchestratorDependencies = {},
  ) {
    this.runDownload = dependencies.runDownload ?? this.downloadFromAdapter.bind(this);
    this.moveToLibrary = dependencies.moveToLibrary ?? ((source, standardId, result) =>
      moveDownloadToLibrary(this.db, this.sourceRegistry, source, standardId, result));
  }

  download(
    source: SourceName,
    standardId: string,
    subscriber: DownloadSubscriber,
    onProgress?: (current: number, total: number) => void,
  ): DownloadHandle {
    if (this.closed) throw new Error('Download orchestrator is closed');
    const key = this.makeKey(source, standardId, subscriber.userId);
    const existing = this.active.get(key);
    if (existing) {
      existing.subscribers.set(subscriber.id, subscriber);
      return this.makeHandle(key, existing, subscriber.id, false);
    }

    const controller = new AbortController();
    const active: ActiveDownload = {
      controller,
      subscribers: new Map([[subscriber.id, subscriber]]),
      promise: Promise.resolve(null as never),
    };
    active.promise = this.execute(source, standardId, subscriber.userId, controller.signal, onProgress)
      .finally(() => {
        if (this.active.get(key) === active) this.active.delete(key);
      });
    this.active.set(key, active);
    return this.makeHandle(key, active, subscriber.id, true);
  }

  private makeHandle(key: string, active: ActiveDownload, subscriberId: string, created: boolean): DownloadHandle {
    return {
      key,
      created,
      reused: !created,
      promise: active.promise,
      unsubscribe: () => {
        active.subscribers.delete(subscriberId);
        const remainingSubscribers = active.subscribers.size;
        if (remainingSubscribers === 0 && this.active.get(key) === active && !active.controller.signal.aborted) {
          active.controller.abort(new Error('No download subscribers remain'));
          return { aborted: true, remainingSubscribers };
        }
        return { aborted: false, remainingSubscribers };
      },
    };
  }

  private async execute(
    source: SourceName,
    standardId: string,
    userId: number,
    signal: AbortSignal,
    onProgress?: (current: number, total: number) => void,
  ): Promise<OrchestratedDownloadResult> {
    const downloaded = await this.runDownload(source, standardId, userId, signal, onProgress);
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Download cancelled');

    const moved = await this.moveToLibrary(source, standardId, downloaded.result);
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Download cancelled');

    return {
      source,
      standardId,
      status: moved.error ? 'library_failed' : 'downloaded',
      filePath: moved.absPath || downloaded.result.filePath,
      fileName: moved.fileName || downloaded.result.fileName,
      fileSize: downloaded.result.fileSize,
      fileId: moved.fileId,
      downloadUrl: moved.libraryUrl,
      libraryError: moved.error,
      session: downloaded.session,
    };
  }

  private async downloadFromAdapter(
    source: SourceName,
    standardId: string,
    userId: number,
    signal: AbortSignal,
    onProgress?: (current: number, total: number) => void,
  ): Promise<{ result: ExportResult; session?: DownloadSessionInfo }> {
    const adapter = this.sourceRegistry.get(source);
    if (adapter.autoDownload) {
      const session = await adapter.autoDownload(standardId, userId, 3, { signal });
      if (session.status !== 'downloaded') throw new Error(session.status);
      const meta = session.meta as { filePath?: string; fileName?: string; fileSize?: number };
      if (!meta.filePath) throw new Error('下载完成但没有文件路径');
      return {
        session,
        result: {
          standardId,
          filePath: meta.filePath,
          fileName: meta.fileName || '',
          fileSize: meta.fileSize || 0,
        },
      };
    }
    return { result: await adapter.exportStandard(standardId, { signal, onProgress }) };
  }

  async close(): Promise<void> {
    this.closed = true;
    const flights = Array.from(this.active.values());
    for (const active of flights) {
      if (!active.controller.signal.aborted) active.controller.abort(new Error('Application shutting down'));
    }
    await Promise.allSettled(flights.map(active => active.promise));
    this.active.clear();
  }

  private makeKey(source: SourceName, standardId: string, userId?: number): string {
    const adapter = this.sourceRegistry.get(source);
    return adapter.autoDownload ? `${source}:${standardId}:user:${userId}` : `${source}:${standardId}`;
  }
}

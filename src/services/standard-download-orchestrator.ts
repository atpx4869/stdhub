import type Database from 'better-sqlite3';
import type { AdapterSourceName, DownloadSessionInfo, ExportResult } from '../domain/standard';
import { DownloadTiming, measureDownloadStage, runWithDownloadTiming, type DownloadStageTimings } from '../shared/download-timing';
import type { SourceRegistry } from './source-registry';
import { moveDownloadToLibrary, type MoveDownloadResult } from './download-to-library';

export type DownloadChannel = 'direct' | 'preview' | 'export';

export interface DownloadSubscriber {
  id: string;
  userId: number;
  channel: DownloadChannel;
}

export type OrchestratedPhase = 'queued' | 'connecting' | 'downloading' | 'verifying' | 'saving';

export interface OrchestratedDownloadResult {
  source: AdapterSourceName;
  standardId: string;
  status: 'downloaded' | 'library_failed';
  filePath?: string;
  fileName?: string;
  fileSize?: number;
  totalPages?: number;
  fileId?: number;
  downloadUrl?: string;
  libraryError?: string;
  session?: DownloadSessionInfo;
  timingsMs?: DownloadStageTimings;
}

export interface DownloadHandle {
  key: string;
  created: boolean;
  reused: boolean;
  promise: Promise<OrchestratedDownloadResult>;
  /** The measures completed so far, including stages of a rejected download. */
  getTimings?(): DownloadStageTimings;
  unsubscribe(): { aborted: boolean; remainingSubscribers: number };
}

type ProgressObserver = (current: number, total: number) => void;
type PhaseObserver = (phase: OrchestratedPhase) => void;

interface DownloadObserver {
  onProgress?: ProgressObserver;
  onPhase?: PhaseObserver;
}

interface FlightProgress {
  phase: OrchestratedPhase;
  pages?: [current: number, total: number];
}

interface ActiveDownload {
  controller: AbortController;
  subscribers: Map<string, DownloadObserver>;
  progress: FlightProgress;
  timing: DownloadTiming;
  promise: Promise<OrchestratedDownloadResult>;
}

interface OrchestratorDependencies {
  runDownload?: (
    source: AdapterSourceName,
    standardId: string,
    userId: number,
    signal: AbortSignal,
    onProgress?: ProgressObserver,
  ) => Promise<{ result: ExportResult; session?: DownloadSessionInfo }>;
  moveToLibrary?: (
    source: AdapterSourceName,
    standardId: string,
    result: ExportResult,
  ) => Promise<MoveDownloadResult>;
}

function notify(run: () => void): void {
  try { run(); } catch { /* progress consumers must not affect the shared flight */ }
}

function checkAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Download cancelled');
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
    source: AdapterSourceName,
    standardId: string,
    subscriber: DownloadSubscriber,
    onProgress?: ProgressObserver,
    onPhase?: PhaseObserver,
  ): DownloadHandle {
    if (this.closed) throw new Error('Download orchestrator is closed');
    const key = this.makeKey(source, standardId, subscriber.userId);
    const observer = { onProgress, onPhase };
    const existing = this.active.get(key);
    // A cancelling flight may still be unwinding, but cannot serve a new subscriber.
    if (existing && !existing.controller.signal.aborted) {
      existing.subscribers.set(subscriber.id, observer);
      const { pages, phase } = existing.progress;
      if (pages) notify(() => observer.onProgress?.(...pages));
      notify(() => observer.onPhase?.(phase));
      return this.makeHandle(key, existing, subscriber.id, false);
    }

    const controller = new AbortController();
    const subscribers = new Map([[subscriber.id, observer]]);
    const progress: FlightProgress = { phase: 'connecting' };
    let settled = false;
    const reportPhase: PhaseObserver = phase => {
      if (settled || controller.signal.aborted || phase === progress.phase) return;
      progress.phase = phase;
      for (const observer of subscribers.values()) notify(() => observer.onPhase?.(phase));
    };
    const reportProgress: ProgressObserver = (current, total) => {
      if (settled || controller.signal.aborted || progress.phase === 'verifying' || progress.phase === 'saving') return;
      reportPhase('downloading');
      progress.pages = [current, total];
      for (const observer of subscribers.values()) notify(() => observer.onProgress?.(current, total));
    };
    const timing = new DownloadTiming(undefined, (stage, transition) => {
      if (stage === 'queue') {
        if (transition === 'start') reportPhase('queued');
        else if (progress.phase === 'queued') reportPhase('connecting');
      } else if (stage === 'transfer' && transition === 'start') {
        reportPhase('downloading');
      }
    });
    const active: ActiveDownload = {
      controller,
      subscribers,
      progress,
      timing,
      promise: runWithDownloadTiming(timing, () =>
        this.execute(source, standardId, subscriber.userId, controller.signal, reportProgress, reportPhase, timing),
      ).finally(() => {
        settled = true;
        subscribers.clear();
        if (this.active.get(key) === active) this.active.delete(key);
      }),
    };
    this.active.set(key, active);
    return this.makeHandle(key, active, subscriber.id, true);
  }

  private makeHandle(key: string, active: ActiveDownload, subscriberId: string, created: boolean): DownloadHandle {
    return {
      key,
      created,
      reused: !created,
      promise: active.promise,
      getTimings: () => active.timing.snapshot(),
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
    source: AdapterSourceName,
    standardId: string,
    userId: number,
    signal: AbortSignal,
    onProgress: ProgressObserver,
    onPhase: PhaseObserver,
    timing: DownloadTiming,
  ): Promise<OrchestratedDownloadResult> {
    const downloaded = await this.runDownload(source, standardId, userId, signal, onProgress);
    checkAborted(signal);

    onPhase('verifying');
    let moved: MoveDownloadResult = {};
    if (downloaded.result.filePath) {
      checkAborted(signal);
      onPhase('saving');
      try {
        moved = await measureDownloadStage('library', () => this.moveToLibrary(source, standardId, downloaded.result));
      } catch (error) {
        // Once the adapter supplied a file, a local failure must not be treated
        // as a source failure and cause another upstream download.
        moved = { error: error instanceof Error ? error.message : '无法保存文件到本地库' };
      }
      checkAborted(signal);
    }

    // A fileId is required for success; an empty move result is not a successful import.
    const libraryError = moved.error || (moved.fileId ? undefined : '下载完成但文件未写入本地库');
    const timingsMs = timing.snapshot();
    return {
      source,
      standardId,
      status: libraryError ? 'library_failed' : 'downloaded',
      filePath: moved.absPath || downloaded.result.filePath,
      fileName: moved.fileName || downloaded.result.fileName,
      fileSize: downloaded.result.fileSize,
      totalPages: downloaded.result.totalPages,
      fileId: moved.fileId,
      downloadUrl: moved.libraryUrl,
      libraryError,
      session: downloaded.session,
      ...(Object.keys(timingsMs).length > 0 ? { timingsMs } : {}),
    };
  }

  private async downloadFromAdapter(
    source: AdapterSourceName,
    standardId: string,
    userId: number,
    signal: AbortSignal,
    onProgress?: ProgressObserver,
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

  private makeKey(source: AdapterSourceName, standardId: string, userId?: number): string {
    const adapter = this.sourceRegistry.get(source);
    return adapter.autoDownload ? `${source}:${standardId}:user:${userId}` : `${source}:${standardId}`;
  }
}

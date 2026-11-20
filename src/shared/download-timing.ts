import { AsyncLocalStorage } from 'node:async_hooks';

export type DownloadTimingStage = 'queue' | 'transfer' | 'compose' | 'library';
export type DownloadStageTimings = Partial<Record<DownloadTimingStage, number>>;

const STAGES: readonly DownloadTimingStage[] = ['queue', 'transfer', 'compose', 'library'];

/** Per-flight elapsed milliseconds. Stages not reached are absent, not zero. */
export class DownloadTiming {
  private readonly durations: DownloadStageTimings = {};

  constructor(
    initial: DownloadStageTimings = {},
    private readonly onStage?: (stage: DownloadTimingStage, transition: 'start' | 'end') => void,
  ) {
    for (const stage of STAGES) {
      const value = initial[stage];
      if (value !== undefined) this.add(stage, value);
    }
  }

  add(stage: DownloadTimingStage, elapsedMs: number): void {
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return;
    this.durations[stage] = (this.durations[stage] ?? 0) + elapsedMs;
  }

  start(stage: DownloadTimingStage): () => void {
    const start = performance.now();
    this.reportStage(stage, 'start');
    return () => {
      this.add(stage, performance.now() - start);
      this.reportStage(stage, 'end');
    };
  }

  private reportStage(stage: DownloadTimingStage, transition: 'start' | 'end'): void {
    // A progress observer must never change the outcome of the download.
    try { this.onStage?.(stage, transition); } catch { /* noncritical progress */ }
  }

  snapshot(): DownloadStageTimings {
    const result: DownloadStageTimings = {};
    for (const stage of STAGES) {
      const value = this.durations[stage];
      if (value !== undefined) result[stage] = Math.round(value);
    }
    return result;
  }
}

const activeTiming = new AsyncLocalStorage<DownloadTiming>();

export function runWithDownloadTiming<T>(timing: DownloadTiming, run: () => T): T {
  return activeTiming.run(timing, run);
}

/** Measure a whole stage (e.g. a batch of parallel page requests), including failures. */
export function measureDownloadStage<T>(stage: DownloadTimingStage, run: () => T): T {
  const timing = activeTiming.getStore();
  if (!timing) return run();
  const finish = timing.start(stage);
  try {
    const result = run();
    if (result instanceof Promise) return result.finally(finish) as T;
    finish();
    return result;
  } catch (error) {
    finish();
    throw error;
  }
}

import { afterEach, describe, expect, it, vi } from 'vitest';
import { DownloadTiming, measureDownloadStage, runWithDownloadTiming } from './download-timing';

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

afterEach(() => vi.useRealTimers());

describe('download stage timing', () => {
  it('accumulates sequential attempts, including failed ones, and omits stages not reached', async () => {
    vi.useFakeTimers({ toFake: ['performance', 'setTimeout'] });
    const timing = new DownloadTiming({ queue: 8 });
    const error = new Error('upstream error');
    const work = runWithDownloadTiming(timing, async () => {
      await expect(measureDownloadStage('transfer', async () => {
        await wait(17);
        throw error;
      })).rejects.toBe(error);
      expect(await measureDownloadStage('transfer', async () => {
        await wait(21);
        return 'pdf';
      })).toBe('pdf');
      await measureDownloadStage('library', () => wait(4));
    });
    await vi.advanceTimersByTimeAsync(42);
    await work;
    expect(timing.snapshot()).toEqual({ queue: 8, transfer: 38, library: 4 });
  });

  it('keeps concurrent flights separate and measures a parallel page group by wall time', async () => {
    vi.useFakeTimers({ toFake: ['performance', 'setTimeout'] });
    const a = new DownloadTiming();
    const b = new DownloadTiming();
    const left = runWithDownloadTiming(a, async () => {
      await measureDownloadStage('transfer', () => Promise.all([wait(6), wait(10), wait(8)]));
      await measureDownloadStage('compose', () => wait(4));
    });
    const right = runWithDownloadTiming(b, async () => {
      await measureDownloadStage('queue', () => wait(2));
      await measureDownloadStage('transfer', () => wait(16));
    });
    await vi.advanceTimersByTimeAsync(18);
    await Promise.all([left, right]);
    expect(a.snapshot()).toEqual({ transfer: 10, compose: 4 });
    expect(b.snapshot()).toEqual({ queue: 2, transfer: 16 });
  });

  it('notifies stages in order without letting progress failures affect the download', async () => {
    vi.useFakeTimers({ toFake: ['performance', 'setTimeout'] });
    const events: string[] = [];
    const timing = new DownloadTiming({ queue: 11 }, (stage, transition) => {
      events.push(stage + ':' + transition);
      if (stage === 'transfer') throw new Error('observer disconnected');
    });
    const work = runWithDownloadTiming(timing, async () => {
      await measureDownloadStage('queue', () => wait(7));
      await measureDownloadStage('transfer', () => wait(3));
      return measureDownloadStage('compose', () => 'PDF');
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(await work).toBe('PDF');
    expect(events).toEqual(['queue:start', 'queue:end', 'transfer:start', 'transfer:end', 'compose:start', 'compose:end']);
    expect(timing.snapshot()).toEqual({ queue: 18, transfer: 3, compose: 0 });
  });

  it('preserves the synchronous result or error and exposes a detached snapshot', () => {
    const timing = new DownloadTiming({ queue: 0, compose: NaN, library: -1 });
    const noContext = measureDownloadStage('transfer', () => 'pass through');
    expect(noContext).toBe('pass through');
    runWithDownloadTiming(timing, () => {
      expect(measureDownloadStage('transfer', () => 123)).toBe(123);
      expect(() => measureDownloadStage('library', () => { throw new Error('IO'); })).toThrow('IO');
    });
    const snapshot = timing.snapshot();
    expect(snapshot.queue).toBe(0);
    expect(snapshot.library).toBeGreaterThanOrEqual(0);
    expect(snapshot.compose).toBeUndefined();
    snapshot.queue = 100;
    expect(timing.snapshot().queue).toBe(0);
  });
});

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CapLibService } from './cap-lib-service';
import type { QualificationService } from './qualification-service';
import {
  AutoSyncScheduler,
  computeNextFireMs,
  validateCronExpression,
  type SyncResult,
} from './auto-sync-scheduler';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createScheduler(): {
  db: Database.Database;
  scheduler: AutoSyncScheduler;
} {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE cma_capability_lib_meta (
      domain TEXT PRIMARY KEY,
      subscribed INTEGER NOT NULL DEFAULT 0
    );
  `);

  const qualSvc = {
    syncHubeiQualifications: vi.fn(async () => ({ cnas: null, cma: null })),
    syncCnasLab: vi.fn(),
    syncCmaLab: vi.fn(),
  } as unknown as QualificationService;
  const capLibSvc = {
    startSync: vi.fn(() => 'job-1'),
    cleanupStaleRows: vi.fn(() => 0),
  } as unknown as CapLibService;

  return {
    db,
    scheduler: new AutoSyncScheduler(db, qualSvc, capLibSvc),
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function runCron(scheduler: AutoSyncScheduler, kind: 'qualification' | 'capability-library'): Promise<void> {
  const schedulerForTest = scheduler as unknown as {
    runQualCycle(): Promise<void>;
    runCapLibCycle(): Promise<void>;
  };
  return kind === 'qualification'
    ? schedulerForTest.runQualCycle()
    : schedulerForTest.runCapLibCycle();
}

function stubRun(
  scheduler: AutoSyncScheduler,
  method: 'runQualSync' | 'runCapLibSync',
  implementation: () => Promise<unknown>,
): ReturnType<typeof vi.fn> {
  const schedulerForTest = scheduler as unknown as Record<string, unknown>;
  const mock = vi.fn(implementation);
  schedulerForTest[method] = mock;
  return mock;
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('auto-sync cron scheduling', () => {
  it('finds a monthly trigger more than seven days away', () => {
    const now = new Date(2026, 0, 2, 0, 0, 0, 0);
    const delay = computeNextFireMs('0 3 1 * *', now);

    expect(delay).not.toBeNull();
    const next = new Date(now.getTime() + delay!);
    expect([next.getFullYear(), next.getMonth(), next.getDate(), next.getHours(), next.getMinutes()])
      .toEqual([2026, 1, 1, 3, 0]);
  });

  it('finds an annual trigger across the year boundary', () => {
    const now = new Date(2026, 0, 2, 0, 0, 0, 0);
    const delay = computeNextFireMs('0 0 1 1 *', now);

    expect(delay).not.toBeNull();
    const next = new Date(now.getTime() + delay!);
    expect([next.getFullYear(), next.getMonth(), next.getDate(), next.getHours(), next.getMinutes()])
      .toEqual([2027, 0, 1, 0, 0]);
  });

  it('still rejects malformed expressions', () => {
    expect(() => validateCronExpression('0 25 * * *')).toThrow();
    expect(() => validateCronExpression('invalid cron')).toThrow();
  });
});

describe('AutoSyncScheduler mutual exclusion', () => {
  it('serializes qualification and capability-library cron requests at the same time', async () => {
    const { db, scheduler } = createScheduler();
    const qualGate = deferred<SyncResult['qualResult']>();
    const order: string[] = [];
    stubRun(scheduler, 'runQualSync', async () => {
      order.push('qual:start');
      const result = await qualGate.promise;
      order.push('qual:end');
      return result;
    });
    stubRun(scheduler, 'runCapLibSync', async () => {
      order.push('caplib:start');
      return { domains: [], errors: [] };
    });

    const qualRun = runCron(scheduler, 'qualification');
    const capLibRequest = runCron(scheduler, 'capability-library');

    expect(scheduler.getState()).toMatchObject({
      running: true,
      activeKind: 'qualification',
      queuedKinds: ['capability-library'],
    });
    expect(order).toEqual(['qual:start']);

    qualGate.resolve({ cnas: [], cma: [], natCma: [] });
    await qualRun;
    await capLibRequest;
    await flushMicrotasks();

    expect(order).toEqual(['qual:start', 'qual:end', 'caplib:start']);
    expect(scheduler.getState()).toMatchObject({ running: false, activeKind: null, queuedKinds: [] });
    db.close();
  });

  it('deduplicates queued cron requests by kind', async () => {
    const { db, scheduler } = createScheduler();
    const qualGate = deferred<SyncResult['qualResult']>();
    const capLibMock = stubRun(scheduler, 'runCapLibSync', async () => ({ domains: [], errors: [] }));
    stubRun(scheduler, 'runQualSync', () => qualGate.promise);

    const activeRun = runCron(scheduler, 'qualification');
    await runCron(scheduler, 'capability-library');
    await runCron(scheduler, 'capability-library');
    await runCron(scheduler, 'qualification');
    await runCron(scheduler, 'qualification');

    expect(scheduler.getState().queuedKinds).toEqual(['capability-library', 'qualification']);

    qualGate.resolve({ cnas: [], cma: [], natCma: [] });
    await activeRun;
    await flushMicrotasks();
    await flushMicrotasks();

    expect(capLibMock).toHaveBeenCalledTimes(1);
    expect(scheduler.getState().queuedKinds).toEqual([]);
    db.close();
  });

  it('returns the existing busy result for a manual trigger without enqueuing it', async () => {
    const { db, scheduler } = createScheduler();
    const qualGate = deferred<SyncResult['qualResult']>();
    stubRun(scheduler, 'runQualSync', () => qualGate.promise);

    const activeRun = runCron(scheduler, 'qualification');
    const result = await scheduler.trigger();

    expect(result.error).toBe('同步正在进行中，请稍后再试');
    expect(result.durationMs).toBe(0);
    expect(scheduler.getState().queuedKinds).toEqual([]);

    qualGate.resolve({ cnas: [], cma: [], natCma: [] });
    await activeRun;
    await flushMicrotasks();
    db.close();
  });

  it('releases the lock after an exception and continues with the queued cron kind', async () => {
    const { db, scheduler } = createScheduler();
    const failureGate = deferred<SyncResult['qualResult']>();
    const capLibMock = stubRun(scheduler, 'runCapLibSync', async () => ({ domains: [], errors: [] }));
    stubRun(scheduler, 'runQualSync', () => failureGate.promise);

    const activeRun = runCron(scheduler, 'qualification');
    await runCron(scheduler, 'capability-library');
    failureGate.reject(new Error('qualification exploded'));
    await activeRun;
    await flushMicrotasks();
    await flushMicrotasks();

    expect(capLibMock).toHaveBeenCalledTimes(1);
    expect(scheduler.getState()).toMatchObject({ running: false, activeKind: null, queuedKinds: [] });
    expect(scheduler.getState().lastRunResult?.error).toBeNull();
    db.close();
  });

  it('does not retry a deterministic qualification configuration failure', async () => {
    const { db, scheduler } = createScheduler();
    const schedulerForTest = scheduler as any;
    const retry = vi.fn();
    const rows = await schedulerForTest.retryQualificationFailures(
      'CNAS', [{ lab_no: 'L0290', error: 'No base_info_id for lab: L0290' }],
      retry, (row: any) => row.lab_no,
    );
    expect(retry).not.toHaveBeenCalled();
    expect(rows[0].error).toContain('No base_info_id');
    db.close();
  });

  it('retries a browser reset immediately', async () => {
    const { db, scheduler } = createScheduler();
    const schedulerForTest = scheduler as any;
    const retry = vi.fn(async () => ({ action: 'manual_forced', records: 10 }));
    const rows = await schedulerForTest.retryQualificationFailures(
      'CNAS', [{ lab_no: 'L0290', error: 'Target page, context or browser has been closed' }],
      retry, (row: any) => row.lab_no,
    );
    expect(retry).toHaveBeenCalledTimes(1);
    expect(rows[0]).toMatchObject({ action: 'manual_forced', records: 10 });
    expect(rows[0].error).toBeUndefined();
    db.close();
  });

  it('waits for the active run during close and does not drain queued work', async () => {
    const { db, scheduler } = createScheduler();
    const qualGate = deferred<SyncResult['qualResult']>();
    const capLibMock = stubRun(scheduler, 'runCapLibSync', async () => ({ domains: [], errors: [] }));
    stubRun(scheduler, 'runQualSync', () => qualGate.promise);
    const activeRun = runCron(scheduler, 'qualification');
    await runCron(scheduler, 'capability-library');
    let closed = false;
    const closing = scheduler.close().then(() => { closed = true; });
    await flushMicrotasks();
    expect(closed).toBe(false);
    qualGate.resolve({ cnas: [], cma: [], natCma: [] });
    await activeRun;
    await closing;
    expect(capLibMock).not.toHaveBeenCalled();
    db.close();
  });

  it('clears queued cron work on stop without cancelling the active run', async () => {
    const { db, scheduler } = createScheduler();
    const qualGate = deferred<SyncResult['qualResult']>();
    const capLibMock = stubRun(scheduler, 'runCapLibSync', async () => ({ domains: [], errors: [] }));
    stubRun(scheduler, 'runQualSync', () => qualGate.promise);

    const activeRun = runCron(scheduler, 'qualification');
    await runCron(scheduler, 'capability-library');
    scheduler.stop();

    expect(scheduler.getState()).toMatchObject({
      running: true,
      activeKind: 'qualification',
      queuedKinds: [],
      nextQualRunAt: null,
      nextCapLibRunAt: null,
    });

    qualGate.resolve({ cnas: [], cma: [], natCma: [] });
    await activeRun;
    await flushMicrotasks();

    expect(capLibMock).not.toHaveBeenCalled();
    expect(scheduler.getState()).toMatchObject({ running: false, activeKind: null, queuedKinds: [] });
    db.close();
  });
});

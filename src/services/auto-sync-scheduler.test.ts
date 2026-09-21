import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CapLibService, getSyncProgress } from './cap-lib-service';
import type { QualificationService } from './qualification-service';
import { getDb } from './db';
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

function createScheduler(capLibOverrides?: Partial<CapLibService>): {
  db: Database.Database;
  scheduler: AutoSyncScheduler;
  capLibSvc: CapLibService;
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
    startSyncTracked: vi.fn(() => ({ jobId: 'job-1', done: Promise.resolve() })),
    cleanupStaleRows: vi.fn(() => 0),
    ...capLibOverrides,
  } as unknown as CapLibService;

  return {
    db,
    scheduler: new AutoSyncScheduler(db, qualSvc, capLibSvc),
    capLibSvc,
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

describe('CapLibService tracked sync', () => {
  function createService(): { db: Database.Database; service: CapLibService } {
    const db = getDb(':memory:');
    return { db, service: new CapLibService(db) };
  }

  function mockRemoteResponse(rows: unknown[]): Response {
    return {
      ok: true,
      status: 200,
      json: async () => ({ total: rows.length, rows, code: 200, msg: 'ok' }),
    } as Response;
  }

  it('waits until a successful tracked sync finishes', async () => {
    const { db, service } = createService();
    const gate = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn(() => gate.promise));

    const tracked = service.startSyncTracked('食品检验');
    let settled = false;
    void tracked.done.finally(() => { settled = true; });
    await flushMicrotasks();
    expect(settled).toBe(false);

    gate.resolve(mockRemoteResponse([]));
    await tracked.done;

    expect(settled).toBe(true);
    expect(getSyncProgress(tracked.jobId)?.phase).toBe('done');
    db.close();
  });

  it('rejects a failed tracked sync and records progress error', async () => {
    const { db, service } = createService();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('remote unavailable'); }));

    const tracked = service.startSyncTracked('生态环境监测');
    await expect(tracked.done).rejects.toThrow('远端第 1 页请求失败：remote unavailable');
    expect(getSyncProgress(tracked.jobId)).toMatchObject({
      phase: 'error',
      domain: '生态环境监测',
      error: '远端第 1 页请求失败：remote unavailable',
    });
    db.close();
  });

  it('reuses the same tracked handle for an active domain', async () => {
    const { db, service } = createService();
    const gate = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn(() => gate.promise));

    const first = service.startSyncTracked('医疗器械检验');
    const second = service.startSyncTracked('医疗器械检验');

    expect(second.jobId).toBe(first.jobId);
    expect(second.done).toBe(first.done);
    expect(service.startSync('医疗器械检验')).toBe(first.jobId);

    gate.resolve(mockRemoteResponse([]));
    await first.done;
    db.close();
  });
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

describe('AutoSyncScheduler run summary persistence', () => {
  it('keeps a summary in state immediately while trigger returns the complete result', async () => {
    const { db, scheduler } = createScheduler();
    stubRun(scheduler, 'runQualSync', async () => ({
      cnas: [
        { lab_no: 'CNAS-1', records: 3 },
        { lab_no: 'CNAS-2', error: 'CNAS failed' },
      ],
      cma: [{ cert_number: 'CMA-1', records: 5 }],
      natCma: [],
    }));
    stubRun(scheduler, 'runCapLibSync', async () => ({
      domains: [{ domain: 'food', jobId: 'job-food' }],
      errors: ['environment: unavailable'],
    }));

    const result = await scheduler.trigger();

    expect(result.qualResult?.cnas).toHaveLength(2);
    expect(result.capLibResult?.domains).toEqual([{ domain: 'food', jobId: 'job-food' }]);
    expect(scheduler.getState().lastRunResult).toEqual({
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      durationMs: result.durationMs,
      error: null,
      qualSummary: { cnasSuccess: 1, cmaSuccess: 1, failed: 1 },
      capLibSummary: { domainsStarted: 1, errors: 1 },
    });
    expect(scheduler.getState().lastRunResult).not.toHaveProperty('qualResult');
    expect(scheduler.getState().lastRunResult).not.toHaveProperty('capLibResult');
    db.close();
  });

  it('loads exactly the same summary after scheduler restart', async () => {
    const { db, scheduler } = createScheduler();
    stubRun(scheduler, 'runQualSync', async () => ({
      cnas: [{ lab_no: 'CNAS-1', records: 3 }],
      cma: [{ cert_number: 'CMA-1', error: 'CMA failed' }],
      natCma: [],
    }));
    stubRun(scheduler, 'runCapLibSync', async () => ({
      domains: [{ domain: 'food', jobId: 'job-food' }],
      errors: [],
    }));
    await scheduler.trigger();
    const stateBeforeRestart = scheduler.getState();

    const reloaded = new AutoSyncScheduler(
      db,
      {} as QualificationService,
      {} as CapLibService,
    );
    reloaded.start();

    expect(reloaded.getState().lastRunAt).toBe(stateBeforeRestart.lastRunAt);
    expect(reloaded.getState().lastRunResult).toEqual(stateBeforeRestart.lastRunResult);
    db.close();
  });

  it('normalizes a legacy complete result and ignores bad persisted JSON', () => {
    const { db } = createScheduler();
    const legacyResult: SyncResult = {
      startedAt: '2026-03-01T01:00:00.000Z',
      finishedAt: '2026-03-01T01:00:02.000Z',
      durationMs: 2000,
      qualResult: {
        cnas: [{ lab_no: 'CNAS-1' }, { lab_no: 'CNAS-2', error: 'failed' }],
        cma: [{ cert_number: 'CMA-1' }],
        natCma: [{ cert_code: 'NAT-1' }],
      },
      capLibResult: {
        domains: [{ domain: 'food', jobId: 'job-food' }],
        errors: ['one failure'],
      },
      error: null,
    };
    const upsert = db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    upsert.run('autosync_last_run_at', legacyResult.startedAt);
    upsert.run('autosync_last_result', JSON.stringify(legacyResult));

    const legacyScheduler = new AutoSyncScheduler(
      db,
      {} as QualificationService,
      {} as CapLibService,
    );
    legacyScheduler.start();
    expect(legacyScheduler.getState().lastRunResult).toEqual({
      startedAt: legacyResult.startedAt,
      finishedAt: legacyResult.finishedAt,
      durationMs: 2000,
      error: null,
      qualSummary: { cnasSuccess: 1, cmaSuccess: 1, failed: 1 },
      capLibSummary: { domainsStarted: 1, errors: 1 },
    });

    upsert.run('autosync_last_result', '{not-json');
    const malformedScheduler = new AutoSyncScheduler(
      db,
      {} as QualificationService,
      {} as CapLibService,
    );
    malformedScheduler.start();
    expect(malformedScheduler.getState().lastRunAt).toBe(legacyResult.startedAt);
    expect(malformedScheduler.getState().lastRunResult).toBeNull();

    upsert.run('autosync_last_result', JSON.stringify({
      startedAt: legacyResult.startedAt,
      finishedAt: legacyResult.finishedAt,
      durationMs: 'not-a-number',
      error: null,
      qualSummary: null,
      capLibSummary: null,
    }));
    const invalidShapeScheduler = new AutoSyncScheduler(
      db,
      {} as QualificationService,
      {} as CapLibService,
    );
    invalidShapeScheduler.start();
    expect(invalidShapeScheduler.getState().lastRunResult).toBeNull();
    db.close();
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

  it('holds the scheduler lock until capability jobs settle and then cleans up', async () => {
    const firstGate = deferred<void>();
    const secondGate = deferred<void>();
    const startSyncTracked = vi.fn((domain: string) => ({
      jobId: `job-${domain}`,
      done: domain === '食品检验' ? firstGate.promise : secondGate.promise,
    }));
    const cleanupStaleRows = vi.fn(() => 0);
    const { db, scheduler } = createScheduler({ startSyncTracked, cleanupStaleRows } as Partial<CapLibService>);
    db.prepare('INSERT INTO cma_capability_lib_meta (domain, subscribed) VALUES (?, 1)').run('食品检验');
    db.prepare('INSERT INTO cma_capability_lib_meta (domain, subscribed) VALUES (?, 1)').run('生态环境监测');

    const run = runCron(scheduler, 'capability-library');
    await flushMicrotasks();
    expect(scheduler.getState()).toMatchObject({ running: true, activeKind: 'capability-library' });
    expect(cleanupStaleRows).not.toHaveBeenCalled();

    firstGate.resolve();
    await flushMicrotasks();
    expect(scheduler.getState().running).toBe(true);
    expect(cleanupStaleRows).not.toHaveBeenCalled();

    secondGate.resolve();
    await run;
    expect(cleanupStaleRows).toHaveBeenCalledWith(3);
    expect(scheduler.getState()).toMatchObject({ running: false, activeKind: null });
    db.close();
  });

  it('collects failed capability domains after all jobs settle', async () => {
    const delayedGate = deferred<void>();
    const startSyncTracked = vi.fn((domain: string) => ({
      jobId: `job-${domain}`,
      done: domain === '食品检验'
        ? Promise.reject(new Error('upstream failed'))
        : delayedGate.promise,
    }));
    const cleanupStaleRows = vi.fn(() => 0);
    const { db, scheduler } = createScheduler({ startSyncTracked, cleanupStaleRows } as Partial<CapLibService>);
    db.prepare('INSERT INTO cma_capability_lib_meta (domain, subscribed) VALUES (?, 1)').run('食品检验');
    db.prepare('INSERT INTO cma_capability_lib_meta (domain, subscribed) VALUES (?, 1)').run('生态环境监测');

    const schedulerForTest = scheduler as unknown as {
      runCapLibSync(): Promise<SyncResult['capLibResult']>;
    };
    const run = schedulerForTest.runCapLibSync();
    await flushMicrotasks();
    expect(cleanupStaleRows).not.toHaveBeenCalled();

    delayedGate.resolve();
    const result = await run;

    expect(cleanupStaleRows).not.toHaveBeenCalled();
    expect(result).toEqual({
      domains: [
        { domain: '食品检验', jobId: 'job-食品检验' },
        { domain: '生态环境监测', jobId: 'job-生态环境监测' },
      ],
      errors: ['食品检验: upstream failed'],
    });
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

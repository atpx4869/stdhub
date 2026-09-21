/**
 * 自动同步调度器。
 *
 * 统一编排资质订阅（CMA/CNAS）和 CMA 一单一库领域订阅的定时同步。
 * 资质同步和能力库同步使用独立的 cron 表达式，可错峰安排。
 *
 * 调度流程：
 * 1. 读取 settings 表中的 autosync_* 配置
 * 2. 解析各自的 cron 表达式，计算下次触发时间
 * 3. setTimeout 精确触发 → runQualCycle() / runCapLibCycle()
 * 4. 记录结果，console.log 输出摘要
 */
import type Database from 'better-sqlite3';
import type { QualificationService } from './qualification-service';
import type { CapLibService } from './cap-lib-service';
import type { NatCmaService } from './nat-cma-service';
import { getSetting, setSetting } from './db';
import { HUBEI_QUALIFICATION_PROFILE } from './hubei-qualification-profile';
import { classifyQualificationSyncError } from '../shared/errors';

// ─── 重试配置 ──────────────────────────────────────────────────────────


// ─── 类型 ─────────────────────────────────────────────────────────────

export interface SyncResult {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  qualResult: {
    cnas: Array<{ lab_no: string; action?: string; records?: number; error?: string }>;
    cma: Array<{ cert_number: string; action?: string; records?: number; error?: string }>;
    natCma: Array<{ cert_code: string; records?: number; error?: string }>;
  } | null;
  capLibResult: {
    domains: Array<{ domain: string; jobId: string }>;
    errors: string[];
  } | null;
  error: string | null;
}

export type SyncRunKind = 'manual' | 'qualification' | 'capability-library';
export type CronSyncRunKind = Exclude<SyncRunKind, 'manual'>;

/** Stable, bounded representation used by scheduler state and persistence. */
export interface SchedulerRunSummary {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  error: string | null;
  qualSummary: {
    cnasSuccess: number;
    cmaSuccess: number;
    failed: number;
  } | null;
  capLibSummary: {
    domainsStarted: number;
    errors: number;
  } | null;
}

export interface SchedulerState {
  running: boolean;
  enabled: boolean;
  lastRunAt: string | null;
  lastRunResult: SchedulerRunSummary | null;
  nextQualRunAt: number | null;
  nextCapLibRunAt: number | null;
  qualCron: string;
  capLibCron: string;
  qualEnabled: boolean;
  capLibEnabled: boolean;
  activeKind: SyncRunKind | null;
  queuedKinds: CronSyncRunKind[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return isNonNegativeNumber(value) && Number.isInteger(value);
}

function isNullableError(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function parseQualSummary(value: unknown): SchedulerRunSummary['qualSummary'] | undefined {
  if (value === null) return null;
  if (!isRecord(value)
    || !isNonNegativeInteger(value.cnasSuccess)
    || !isNonNegativeInteger(value.cmaSuccess)
    || !isNonNegativeInteger(value.failed)) {
    return undefined;
  }
  return {
    cnasSuccess: value.cnasSuccess,
    cmaSuccess: value.cmaSuccess,
    failed: value.failed,
  };
}

function parseCapLibSummary(value: unknown): SchedulerRunSummary['capLibSummary'] | undefined {
  if (value === null) return null;
  if (!isRecord(value)
    || !isNonNegativeInteger(value.domainsStarted)
    || !isNonNegativeInteger(value.errors)) {
    return undefined;
  }
  return {
    domainsStarted: value.domainsStarted,
    errors: value.errors,
  };
}

/** Convert a complete API result into the stable state/persistence representation. */
function summarizeRun(result: SyncResult): SchedulerRunSummary {
  return {
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    durationMs: result.durationMs,
    error: result.error,
    qualSummary: result.qualResult ? {
      cnasSuccess: result.qualResult.cnas.filter(row => !row.error).length,
      cmaSuccess: result.qualResult.cma.filter(row => !row.error).length,
      failed: result.qualResult.cnas.filter(row => row.error).length
        + result.qualResult.cma.filter(row => row.error).length,
    } : null,
    capLibSummary: result.capLibResult ? {
      domainsStarted: result.capLibResult.domains.length,
      errors: result.capLibResult.errors.length,
    } : null,
  };
}

/**
 * Parse persisted state. The summary shape is current; complete SyncResult objects are
 * accepted as a legacy format and normalized immediately.
 */
function parsePersistedRunSummary(value: unknown): SchedulerRunSummary | null {
  if (!isRecord(value)
    || typeof value.startedAt !== 'string'
    || typeof value.finishedAt !== 'string'
    || !isNonNegativeNumber(value.durationMs)
    || !isNullableError(value.error)) {
    return null;
  }

  if (Object.hasOwn(value, 'qualSummary') && Object.hasOwn(value, 'capLibSummary')) {
    const qualSummary = parseQualSummary(value.qualSummary);
    const capLibSummary = parseCapLibSummary(value.capLibSummary);
    if (qualSummary === undefined || capLibSummary === undefined) return null;
    return {
      startedAt: value.startedAt,
      finishedAt: value.finishedAt,
      durationMs: value.durationMs,
      error: value.error,
      qualSummary,
      capLibSummary,
    };
  }

  if (!Object.hasOwn(value, 'qualResult') || !Object.hasOwn(value, 'capLibResult')) return null;
  const qualResultValue = value.qualResult;
  const capLibResultValue = value.capLibResult;

  let qualSummary: SchedulerRunSummary['qualSummary'];
  if (qualResultValue === null) {
    qualSummary = null;
  } else {
    if (!isRecord(qualResultValue)
      || !Array.isArray(qualResultValue.cnas)
      || !Array.isArray(qualResultValue.cma)) {
      return null;
    }
    const cnasRows: unknown[] = qualResultValue.cnas;
    const cmaRows: unknown[] = qualResultValue.cma;
    const countErrors = (rows: unknown[]): number => rows.filter(
      row => isRecord(row) && typeof row.error === 'string' && row.error.length > 0,
    ).length;
    qualSummary = {
      cnasSuccess: cnasRows.length - countErrors(cnasRows),
      cmaSuccess: cmaRows.length - countErrors(cmaRows),
      failed: countErrors(cnasRows) + countErrors(cmaRows),
    };
  }

  let capLibSummary: SchedulerRunSummary['capLibSummary'];
  if (capLibResultValue === null) {
    capLibSummary = null;
  } else {
    if (!isRecord(capLibResultValue)
      || !Array.isArray(capLibResultValue.domains)
      || !Array.isArray(capLibResultValue.errors)) {
      return null;
    }
    capLibSummary = {
      domainsStarted: capLibResultValue.domains.length,
      errors: capLibResultValue.errors.length,
    };
  }

  return {
    startedAt: value.startedAt,
    finishedAt: value.finishedAt,
    durationMs: value.durationMs,
    error: value.error,
    qualSummary,
    capLibSummary,
  };
}

// ─── Cron 解析 ─────────────────────────────────────────────────────────

interface CronFields {
  minute: number[];   // 0-59
  hour: number[];     // 0-23
  dom: number[];      // 1-31
  month: number[];    // 1-12
  dow: number[];      // 0-6 (Sun=0)
}

function parseCronField(field: string, min: number, max: number): number[] {
  const values = new Set<number>();
  for (const part of field.split(',')) {
    if (part === '*') {
      for (let i = min; i <= max; i++) values.add(i);
      continue;
    }
    const stepMatch = part.match(/^\*\/(\d+)$/);
    if (stepMatch) {
      const step = parseInt(stepMatch[1], 10);
      if (!Number.isFinite(step) || step < 1) throw new Error(`Invalid step: ${part}`);
      for (let i = min; i <= max; i += step) values.add(i);
      continue;
    }
    const rangeMatch = part.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const a = parseInt(rangeMatch[1], 10);
      const b = parseInt(rangeMatch[2], 10);
      if (!Number.isFinite(a) || !Number.isFinite(b) || a < min || b > max || a > b) {
        throw new Error(`Invalid range: ${part}`);
      }
      for (let i = a; i <= b; i++) values.add(i);
      continue;
    }
    if (!/^\d+$/.test(part)) throw new Error(`Invalid value: ${part}`);
    const val = parseInt(part, 10);
    if (!Number.isFinite(val) || val < min || val > max) {
      throw new Error(`Invalid value: ${part}`);
    }
    values.add(val);
  }
  if (values.size === 0) throw new Error(`Empty field: ${field}`);
  return [...values].sort((a, b) => a - b);
}

function parseCron(expr: string): CronFields {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`Cron must have 5 fields, got ${parts.length}`);
  return {
    minute: parseCronField(parts[0], 0, 59),
    hour: parseCronField(parts[1], 0, 23),
    dom: parseCronField(parts[2], 1, 31),
    month: parseCronField(parts[3], 1, 12),
    dow: parseCronField(parts[4], 0, 6),
  };
}

export function validateCronExpression(expr: string): void {
  parseCron(expr);
}

function cronFieldsMatch(fields: CronFields, date: Date): boolean {
  return (
    fields.minute.includes(date.getMinutes()) &&
    fields.hour.includes(date.getHours()) &&
    fields.dom.includes(date.getDate()) &&
    fields.month.includes(date.getMonth() + 1) &&
    fields.dow.includes(date.getDay())
  );
}

const CRON_SEARCH_MINUTES = 366 * 24 * 60;

/**
 * 查找下一次触发时间。搜索窗口覆盖完整闰年，避免月度/年度 cron 因原先仅扫描
 * 7 天而被误报为“解析失败”并永久停止调度。
 */
export function computeNextFireMs(cronExpr: string, now: Date): number | null {
  const fields = parseCron(cronExpr);
  const cursor = new Date(now);
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);

  for (let i = 0; i < CRON_SEARCH_MINUTES; i++) {
    if (cronFieldsMatch(fields, cursor)) {
      return cursor.getTime() - now.getTime();
    }
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return null;
}

// ─── 调度器 ─────────────────────────────────────────────────────────────

export class AutoSyncScheduler {
  private db: Database.Database;
  private qualSvc: QualificationService;
  private capLibSvc: CapLibService;
  private natCmaSvc?: NatCmaService;
  private qualTimer: ReturnType<typeof setTimeout> | null = null;
  private capLibTimer: ReturnType<typeof setTimeout> | null = null;
  private state: SchedulerState;
  private active = false;
  private queuedKinds: CronSyncRunKind[] = [];
  private generation = 0;
  private schedulingActive = false;
  private activeRun: Promise<SyncResult> | null = null;

  constructor(db: Database.Database, qualSvc: QualificationService, capLibSvc: CapLibService, natCmaSvc?: NatCmaService) {
    this.db = db;
    this.qualSvc = qualSvc;
    this.capLibSvc = capLibSvc;
    this.natCmaSvc = natCmaSvc;
    this.state = {
      running: false,
      enabled: false,
      lastRunAt: null,
      lastRunResult: null,
      nextQualRunAt: null,
      nextCapLibRunAt: null,
      qualCron: '0 3 * * 0',
      capLibCron: '0 3 * * *',
      qualEnabled: true,
      capLibEnabled: true,
      activeKind: null,
      queuedKinds: [],
    };
  }

  start(): void {
    this.stop();
    this.readSettings();
    this.loadLastRunResult();
    if (!this.state.enabled) {
      console.log('[auto-sync] 调度器未启用');
      return;
    }
    this.schedulingActive = true;
    const generation = this.generation;
    this.scheduleQual(generation);
    this.scheduleCapLib(generation);
    console.log(`[auto-sync] 调度器启动`);
    if (this.state.qualEnabled) {
      console.log(`  资质同步: cron=${this.state.qualCron}, 下次=${this.state.nextQualRunAt ? new Date(this.state.nextQualRunAt).toISOString() : 'N/A'}`);
    }
    if (this.state.capLibEnabled) {
      console.log(`  能力库同步: cron=${this.state.capLibCron}, 下次=${this.state.nextCapLibRunAt ? new Date(this.state.nextCapLibRunAt).toISOString() : 'N/A'}`);
    }
  }

  stop(): void {
    this.generation += 1;
    this.schedulingActive = false;
    if (this.qualTimer) { clearTimeout(this.qualTimer); this.qualTimer = null; }
    if (this.capLibTimer) { clearTimeout(this.capLibTimer); this.capLibTimer = null; }
    this.queuedKinds = [];
    this.state.queuedKinds = [];
    this.state.nextQualRunAt = null;
    this.state.nextCapLibRunAt = null;
    console.log('[auto-sync] 调度器已停止');
  }

  reload(): void {
    this.stop();
    this.readSettings();
    if (this.state.enabled) {
      this.schedulingActive = true;
      const generation = this.generation;
      this.scheduleQual(generation);
      this.scheduleCapLib(generation);
      console.log(`[auto-sync] 设置已重载`);
    }
  }

  async trigger(): Promise<SyncResult> {
    const result = this.requestRun('manual');
    if (result) return result;
    return this.busyResult();
  }

  getState(): SchedulerState {
    return {
      ...this.state,
      queuedKinds: [...this.queuedKinds],
    };
  }

  /** Stop scheduling first, then wait for the active cycle before app shutdown closes DB/scrapers. */
  async close(): Promise<void> {
    this.stop();
    const activeRun = this.activeRun;
    if (activeRun) await activeRun.catch(() => {});
  }

  private readSettings(): void {
    this.state.enabled = getSetting(this.db, 'autosync_enabled', '0') === '1';
    this.state.qualCron = getSetting(this.db, 'autosync_qual_cron', '0 3 * * 0');
    this.state.capLibCron = getSetting(this.db, 'autosync_caplib_cron', '0 3 * * *');
    this.state.qualEnabled = getSetting(this.db, 'autosync_qual_enabled', '1') === '1';
    this.state.capLibEnabled = getSetting(this.db, 'autosync_caplib_enabled', '1') === '1';
  }

  private loadLastRunResult(): void {
    const lastRunAt = getSetting(this.db, 'autosync_last_run_at', '');
    const lastResultJson = getSetting(this.db, 'autosync_last_result', '');
    this.state.lastRunAt = lastRunAt || null;
    this.state.lastRunResult = null;
    if (!lastResultJson) return;

    try {
      this.state.lastRunResult = parsePersistedRunSummary(JSON.parse(lastResultJson));
    } catch {
      // Invalid persisted JSON must not leak an unvalidated shape into the status API.
    }
  }

  private scheduleQual(generation: number): void {
    if (this.qualTimer) { clearTimeout(this.qualTimer); this.qualTimer = null; }
    if (!this.schedulingActive || generation !== this.generation || !this.state.qualEnabled) return;

    const delayMs = computeNextFireMs(this.state.qualCron, new Date());
    if (delayMs === null) {
      console.error(`[auto-sync] 资质同步 cron 解析失败: ${this.state.qualCron}`);
      return;
    }

    this.state.nextQualRunAt = Date.now() + delayMs;
    this.qualTimer = setTimeout(() => {
      this.qualTimer = null;
      if (!this.isCurrentGeneration(generation)) return;
      void this.runQualCycle();
      if (this.isCurrentGeneration(generation)) this.scheduleQual(generation);
    }, delayMs);
  }

  private scheduleCapLib(generation: number): void {
    if (this.capLibTimer) { clearTimeout(this.capLibTimer); this.capLibTimer = null; }
    if (!this.schedulingActive || generation !== this.generation || !this.state.capLibEnabled) return;

    const delayMs = computeNextFireMs(this.state.capLibCron, new Date());
    if (delayMs === null) {
      console.error(`[auto-sync] 能力库同步 cron 解析失败: ${this.state.capLibCron}`);
      return;
    }

    this.state.nextCapLibRunAt = Date.now() + delayMs;
    this.capLibTimer = setTimeout(() => {
      this.capLibTimer = null;
      if (!this.isCurrentGeneration(generation)) return;
      void this.runCapLibCycle();
      if (this.isCurrentGeneration(generation)) this.scheduleCapLib(generation);
    }, delayMs);
  }

  /**
   * 请求一次同步。手动请求在锁忙时立即失败；Cron 请求按类型最多排队一次。
   * 返回 null 表示请求未立即启动（手动冲突或 Cron 已入队/已去重）。
   */
  private requestRun(kind: SyncRunKind): Promise<SyncResult> | null {
    if (this.active) {
      if (kind !== 'manual' && !this.queuedKinds.includes(kind) && this.queuedKinds.length < 2) {
        this.queuedKinds.push(kind);
        this.state.queuedKinds = [...this.queuedKinds];
        console.log(`[auto-sync] ${this.kindLabel(kind)}: 当前有同步启动流程，已排队`);
      }
      return null;
    }

    const run = this.executeRun(kind);
    this.activeRun = run;
    void run.finally(() => {
      if (this.activeRun === run) this.activeRun = null;
    });
    return run;
  }

  /** 在统一互斥锁内启动一次同步流程。 */
  private async executeRun(kind: SyncRunKind): Promise<SyncResult> {
    this.active = true;
    this.state.running = true;
    this.state.activeKind = kind;
    const startedAt = new Date();
    console.log(`[auto-sync] ${this.kindLabel(kind)}开始`);

    let qualResult: SyncResult['qualResult'] = null;
    let capLibResult: SyncResult['capLibResult'] = null;
    let error: string | null = null;

    try {
      if ((kind === 'manual' && this.state.qualEnabled) || kind === 'qualification') {
        qualResult = await this.runQualSync();
      }
      if ((kind === 'manual' && this.state.capLibEnabled) || kind === 'capability-library') {
        capLibResult = await this.runCapLibSync();
      }
    } catch (runError) {
      error = runError instanceof Error ? runError.message : String(runError);
      console.error(`[auto-sync] ${this.kindLabel(kind)}异常:`, error);
    } finally {
      this.active = false;
      this.state.running = false;
      this.state.activeKind = null;
      queueMicrotask(() => this.drainNext());
    }

    const finishedAt = new Date();
    const durationMs = finishedAt.getTime() - startedAt.getTime();
    const result: SyncResult = {
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs,
      qualResult,
      capLibResult,
      error,
    };

    const summary = summarizeRun(result);
    this.state.lastRunAt = result.startedAt;
    this.state.lastRunResult = summary;
    setSetting(this.db, 'autosync_last_run_at', result.startedAt);
    this.persistLastResult(summary);
    console.log(`[auto-sync] ${this.kindLabel(kind)}结束 · 耗时: ${(durationMs / 1000).toFixed(1)}s`);
    return result;
  }

  /** 锁释放后在 microtask 中串行启动下一项。 */
  private drainNext(): void {
    if (this.active) return;
    const nextKind = this.queuedKinds.shift();
    this.state.queuedKinds = [...this.queuedKinds];
    if (!nextKind) return;
    void this.requestRun(nextKind);
  }

  private async runQualCycle(): Promise<void> {
    const run = this.requestRun('qualification');
    if (run) await run;
  }

  private async runCapLibCycle(): Promise<void> {
    const run = this.requestRun('capability-library');
    if (run) await run;
  }

  private busyResult(): SyncResult {
    const now = new Date().toISOString();
    return {
      startedAt: now,
      finishedAt: now,
      durationMs: 0,
      qualResult: null,
      capLibResult: null,
      error: '同步正在进行中，请稍后再试',
    };
  }

  private kindLabel(kind: SyncRunKind): string {
    if (kind === 'qualification') return '资质同步周期';
    if (kind === 'capability-library') return '能力库同步周期';
    return '手动同步周期';
  }

  private isCurrentGeneration(generation: number): boolean {
    return this.schedulingActive && generation === this.generation;
  }

  private persistLastResult(summary: SchedulerRunSummary): void {
    try {
      setSetting(this.db, 'autosync_last_result', JSON.stringify(summary));
    } catch { /* ignore persistence failures; the completed run result is still returned */ }
  }

  private async runQualSync(): Promise<SyncResult['qualResult']> {
    try {
      const fixedResult = await this.qualSvc.syncHubeiQualifications('ALL');
      let cnasResult: Array<{ lab_no: string; action?: string; records?: number; error?: string }> = fixedResult.cnas
        ? [{ lab_no: HUBEI_QUALIFICATION_PROFILE.cnas.labNo, ...fixedResult.cnas }]
        : [];
      let cmaResult: Array<{ cert_number: string; action?: string; records?: number; error?: string }> = fixedResult.cma
        ? [{ cert_number: HUBEI_QUALIFICATION_PROFILE.cma.certNumber, ...fixedResult.cma }]
        : [];

      cnasResult = await this.retryQualificationFailures(
        'CNAS', cnasResult,
        async (id) => this.qualSvc.syncCnasLab(id, true),
        row => row.lab_no,
      );
      cmaResult = await this.retryQualificationFailures(
        'CMA', cmaResult,
        async (id) => this.qualSvc.syncCmaLab(id, true),
        row => row.cert_number,
      );

      const natCmaResult: NonNullable<SyncResult['qualResult']>['natCma'] = [];
      const cnasCount = cnasResult.filter(r => !r.error).length;
      const cmaCount = cmaResult.filter(r => !r.error).length;
      const failedCount = cnasResult.filter(r => r.error).length + cmaResult.filter(r => r.error).length;
      console.log(`[auto-sync] 资质同步完成: CNAS ${cnasCount}个, CMA ${cmaCount}个成功${failedCount > 0 ? `, ${failedCount}个仍失败` : ''}`);

      return { cnas: cnasResult, cma: cmaResult, natCma: natCmaResult };
    } catch (err) {
      console.error('[auto-sync] 资质同步失败:', err instanceof Error ? err.message : String(err));
      return { cnas: [], cma: [], natCma: [] };
    }
  }

  private async retryQualificationFailures<T extends { error?: string }>(
    source: 'CNAS' | 'CMA',
    rows: T[],
    sync: (id: string) => Promise<{ action: string; records: number }>,
    getId: (row: T) => string,
  ): Promise<T[]> {
    const next = [...rows];
    for (let index = 0; index < next.length; index++) {
      const initialError = next[index].error;
      if (!initialError) continue;
      const policy = classifyQualificationSyncError(initialError);
      if (!policy.retryable) {
        console.warn(`[auto-sync] ${source} ${getId(next[index])} 不重试 (${policy.code}): ${initialError}`);
        continue;
      }

      let currentPolicy = policy;
      const maxAttempts = 2;
      for (let attempt = 0; attempt < maxAttempts && currentPolicy.retryable; attempt++) {
        const delayMs = currentPolicy.delaysMs[Math.min(attempt, currentPolicy.delaysMs.length - 1)] ?? 0;
        console.log(`[auto-sync] ${source} ${getId(next[index])} ${currentPolicy.code}，${delayMs}ms 后重试 ${attempt + 1}/${maxAttempts}`);
        if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
        try {
          const result = await sync(getId(next[index]));
          next[index] = { ...next[index], ...result, error: undefined };
          break;
        } catch (retryError) {
          const message = retryError instanceof Error ? retryError.message : String(retryError);
          next[index] = { ...next[index], error: message };
          currentPolicy = classifyQualificationSyncError(message);
        }
      }
    }
    return next;
  }

  private async runCapLibSync(): Promise<SyncResult['capLibResult']> {
    try {
      const domains = this.db.prepare(
        "SELECT domain FROM cma_capability_lib_meta WHERE subscribed = 1"
      ).all() as Array<{ domain: string }>;

      const domainJobs: Array<{ domain: string; jobId: string }> = [];
      const trackedJobs: Array<{ domain: string; done: Promise<void> }> = [];
      const errors: string[] = [];

      for (const { domain } of domains) {
        try {
          const tracked = this.capLibSvc.startSyncTracked(domain);
          domainJobs.push({ domain, jobId: tracked.jobId });
          trackedJobs.push({ domain, done: tracked.done });
        } catch (err) {
          const msg = `${domain}: ${err instanceof Error ? err.message : String(err)}`;
          errors.push(msg);
          console.error(`[auto-sync] 能力库同步启动失败: ${msg}`);
        }
      }

      if (domainJobs.length > 0) {
        console.log(`[auto-sync] 能力库同步已启动: ${domainJobs.map(d => d.domain).join(', ')}`);
      }

      const settled = await Promise.allSettled(trackedJobs.map(job => job.done));
      for (let index = 0; index < settled.length; index++) {
        const result = settled[index];
        if (result.status === 'fulfilled') continue;
        const domain = trackedJobs[index].domain;
        const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
        const error = `${domain}: ${message}`;
        errors.push(error);
        console.error(`[auto-sync] 能力库同步失败: ${error}`);
      }

      // 只有本轮全部领域成功，才清理长期未见数据；任一上游失败时保留旧快照。
      if (errors.length === 0) {
        try {
          const cleaned = this.capLibSvc.cleanupStaleRows(3);
          if (cleaned > 0) {
            console.log(`[auto-sync] 能力库清理完成: 删除 ${cleaned} 条 3 天未见的孤儿行`);
          }
        } catch (cleanupErr) {
          console.error('[auto-sync] 能力库清理失败:', cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr));
        }
      } else {
        console.warn('[auto-sync] 本轮能力库存在失败领域，跳过孤儿数据清理以保护旧快照');
      }

      return { domains: domainJobs, errors };
    } catch (err) {
      console.error('[auto-sync] 能力库同步失败:', err instanceof Error ? err.message : String(err));
      return { domains: [], errors: [err instanceof Error ? err.message : String(err)] };
    }
  }
}

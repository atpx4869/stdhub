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

export interface SchedulerState {
  running: boolean;
  enabled: boolean;
  lastRunAt: string | null;
  lastRunResult: SyncResult | null;
  nextQualRunAt: number | null;
  nextCapLibRunAt: number | null;
  qualCron: string;
  capLibCron: string;
  qualEnabled: boolean;
  capLibEnabled: boolean;
  activeKind: SyncRunKind | null;
  queuedKinds: CronSyncRunKind[];
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
    if (lastRunAt) this.state.lastRunAt = lastRunAt;
    if (lastResultJson) {
      try {
        this.state.lastRunResult = JSON.parse(lastResultJson);
      } catch { /* ignore parse error */ }
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

    this.state.lastRunAt = result.startedAt;
    this.state.lastRunResult = result;
    setSetting(this.db, 'autosync_last_run_at', result.startedAt);
    this.persistLastResult(result);
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

  private persistLastResult(result: SyncResult): void {
    try {
      // 只保存关键信息，避免存储过大
      const minimal = {
        startedAt: result.startedAt,
        finishedAt: result.finishedAt,
        durationMs: result.durationMs,
        error: result.error,
        qualSummary: result.qualResult ? {
          cnasSuccess: result.qualResult.cnas.filter(r => !r.error).length,
          cmaSuccess: result.qualResult.cma.filter(r => !r.error).length,
          failed: result.qualResult.cnas.filter(r => r.error).length + result.qualResult.cma.filter(r => r.error).length,
        } : null,
        capLibSummary: result.capLibResult ? {
          domainsStarted: result.capLibResult.domains.length,
          errors: result.capLibResult.errors.length,
        } : null,
      };
      setSetting(this.db, 'autosync_last_result', JSON.stringify(minimal));
    } catch { /* ignore */ }
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
      const errors: string[] = [];

      for (const { domain } of domains) {
        try {
          // startSync 仅启动领域后台 job 并立即返回；本调度锁只覆盖“启动任务”的流程，
          // 不覆盖 CapLibService 内部 fire-and-forget job 的完整后台生命周期。
          const jobId = this.capLibSvc.startSync(domain);
          domainJobs.push({ domain, jobId });
        } catch (err) {
          const msg = `${domain}: ${err instanceof Error ? err.message : String(err)}`;
          errors.push(msg);
          console.error(`[auto-sync] 能力库同步启动失败: ${msg}`);
        }
      }

      if (domainJobs.length > 0) {
        console.log(`[auto-sync] 能力库同步已启动: ${domainJobs.map(d => d.domain).join(', ')}`);
      }

      // 同步完成后自动清理 3 天未见的孤儿行
      try {
        const cleaned = this.capLibSvc.cleanupStaleRows(3);
        if (cleaned > 0) {
          console.log(`[auto-sync] 能力库清理完成: 删除 ${cleaned} 条 3 天未见的孤儿行`);
        }
      } catch (cleanupErr) {
        console.error('[auto-sync] 能力库清理失败:', cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr));
      }

      return { domains: domainJobs, errors };
    } catch (err) {
      console.error('[auto-sync] 能力库同步失败:', err instanceof Error ? err.message : String(err));
      return { domains: [], errors: [err instanceof Error ? err.message : String(err)] };
    }
  }
}

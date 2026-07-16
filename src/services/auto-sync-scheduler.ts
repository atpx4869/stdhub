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
import { getSetting, setSetting } from './db';

// ─── 重试配置 ──────────────────────────────────────────────────────────

/** 资质同步失败后重试次数 */
const QUAL_SYNC_MAX_RETRIES = 2;
/** 重试间隔（毫秒） */
const QUAL_SYNC_RETRY_DELAY_MS = 30_000;

// ─── 类型 ─────────────────────────────────────────────────────────────

export interface SyncResult {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  qualResult: {
    cnas: Array<{ lab_no: string; action?: string; records?: number; error?: string }>;
    cma: Array<{ cert_number: string; action?: string; records?: number; error?: string }>;
  } | null;
  capLibResult: {
    domains: Array<{ domain: string; jobId: string }>;
    errors: string[];
  } | null;
  error: string | null;
}

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

function cronFieldsMatch(fields: CronFields, date: Date): boolean {
  return (
    fields.minute.includes(date.getMinutes()) &&
    fields.hour.includes(date.getHours()) &&
    fields.dom.includes(date.getDate()) &&
    fields.month.includes(date.getMonth() + 1) &&
    fields.dow.includes(date.getDay())
  );
}

function computeNextFireMs(cronExpr: string, now: Date): number | null {
  const fields = parseCron(cronExpr);
  const cursor = new Date(now);
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);

  for (let i = 0; i < 10080; i++) {
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
  private qualTimer: ReturnType<typeof setTimeout> | null = null;
  private capLibTimer: ReturnType<typeof setTimeout> | null = null;
  private state: SchedulerState;

  constructor(db: Database.Database, qualSvc: QualificationService, capLibSvc: CapLibService) {
    this.db = db;
    this.qualSvc = qualSvc;
    this.capLibSvc = capLibSvc;
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
    };
  }

  start(): void {
    this.readSettings();
    this.loadLastRunResult();
    if (!this.state.enabled) {
      console.log('[auto-sync] 调度器未启用');
      return;
    }
    this.scheduleQual();
    this.scheduleCapLib();
    console.log(`[auto-sync] 调度器启动`);
    if (this.state.qualEnabled) {
      console.log(`  资质同步: cron=${this.state.qualCron}, 下次=${this.state.nextQualRunAt ? new Date(this.state.nextQualRunAt).toISOString() : 'N/A'}`);
    }
    if (this.state.capLibEnabled) {
      console.log(`  能力库同步: cron=${this.state.capLibCron}, 下次=${this.state.nextCapLibRunAt ? new Date(this.state.nextCapLibRunAt).toISOString() : 'N/A'}`);
    }
  }

  stop(): void {
    if (this.qualTimer) { clearTimeout(this.qualTimer); this.qualTimer = null; }
    if (this.capLibTimer) { clearTimeout(this.capLibTimer); this.capLibTimer = null; }
    this.state.nextQualRunAt = null;
    this.state.nextCapLibRunAt = null;
    console.log('[auto-sync] 调度器已停止');
  }

  reload(): void {
    this.stop();
    this.readSettings();
    if (this.state.enabled) {
      this.scheduleQual();
      this.scheduleCapLib();
      console.log(`[auto-sync] 设置已重载`);
    }
  }

  async trigger(): Promise<SyncResult> {
    if (this.state.running) {
      return {
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: 0,
        qualResult: null,
        capLibResult: null,
        error: '同步正在进行中，请稍后再试',
      };
    }
    return this.runCycle();
  }

  getState(): SchedulerState {
    return { ...this.state };
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

  private scheduleQual(): void {
    if (this.qualTimer) { clearTimeout(this.qualTimer); this.qualTimer = null; }
    if (!this.state.qualEnabled) return;

    const delayMs = computeNextFireMs(this.state.qualCron, new Date());
    if (delayMs === null) {
      console.error(`[auto-sync] 资质同步 cron 解析失败: ${this.state.qualCron}`);
      return;
    }

    this.state.nextQualRunAt = Date.now() + delayMs;
    this.qualTimer = setTimeout(async () => {
      await this.runQualCycle();
      this.scheduleQual();
    }, delayMs);
  }

  private scheduleCapLib(): void {
    if (this.capLibTimer) { clearTimeout(this.capLibTimer); this.capLibTimer = null; }
    if (!this.state.capLibEnabled) return;

    const delayMs = computeNextFireMs(this.state.capLibCron, new Date());
    if (delayMs === null) {
      console.error(`[auto-sync] 能力库同步 cron 解析失败: ${this.state.capLibCron}`);
      return;
    }

    this.state.nextCapLibRunAt = Date.now() + delayMs;
    this.capLibTimer = setTimeout(async () => {
      await this.runCapLibCycle();
      this.scheduleCapLib();
    }, delayMs);
  }

  private async runCycle(): Promise<SyncResult> {
    this.state.running = true;
    const startedAt = new Date();
    console.log('[auto-sync] 开始执行同步周期');

    let qualResult: SyncResult['qualResult'] = null;
    let capLibResult: SyncResult['capLibResult'] = null;
    let error: string | null = null;

    try {
      if (this.state.qualEnabled) {
        qualResult = await this.runQualSync();
      }
      if (this.state.capLibEnabled) {
        capLibResult = await this.runCapLibSync();
      }
    } finally {
      this.state.running = false;
    }

    const finishedAt = new Date();
    const durationMs = finishedAt.getTime() - startedAt.getTime();
    console.log(`[auto-sync] 同步周期结束 · 总耗时: ${(durationMs / 1000).toFixed(1)}s`);

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
    this.persistLastResult(result);

    return result;
  }

  private async runQualCycle(): Promise<void> {
    if (this.state.running) {
      console.log('[auto-sync] 资质同步: 上一周期尚未完成，跳过');
      return;
    }

    console.log('[auto-sync] 资质同步周期开始');
    const startedAt = new Date().toISOString();
    const qualResult = await this.runQualSync();
    this.state.lastRunAt = startedAt;
    setSetting(this.db, 'autosync_last_run_at', startedAt);
  }

  private async runCapLibCycle(): Promise<void> {
    if (this.state.running) {
      console.log('[auto-sync] 能力库同步: 上一周期尚未完成，跳过');
      return;
    }

    console.log('[auto-sync] 能力库同步周期开始');
    const startedAt = new Date().toISOString();
    const capLibResult = await this.runCapLibSync();
    this.state.lastRunAt = startedAt;
    setSetting(this.db, 'autosync_last_run_at', startedAt);
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
      let cnasResult = await this.qualSvc.syncAllCnasLabs();
      let cmaResult = await this.qualSvc.syncAllCmaLabs();

      // 重试失败的实验室
      for (let retry = 0; retry < QUAL_SYNC_MAX_RETRIES; retry++) {
        const failedCnas = cnasResult.filter(r => r.error);
        const failedCma = cmaResult.filter(r => r.error);
        if (failedCnas.length === 0 && failedCma.length === 0) break;

        console.log(`[auto-sync] 重试第 ${retry + 1}/${QUAL_SYNC_MAX_RETRIES} 次: CNAS ${failedCnas.length}个, CMA ${failedCma.length}个失败实验室`);
        await new Promise(resolve => setTimeout(resolve, QUAL_SYNC_RETRY_DELAY_MS));

        for (const lab of failedCnas) {
          try {
            const r = await this.qualSvc.syncCnasLab(lab.lab_no, true);
            const idx = cnasResult.findIndex(x => x.lab_no === lab.lab_no);
            if (idx >= 0) cnasResult[idx] = { lab_no: lab.lab_no, ...r };
          } catch (retryErr) {
            console.warn(`[auto-sync] CNAS ${lab.lab_no} 重试失败:`, retryErr instanceof Error ? retryErr.message : String(retryErr));
          }
        }
        for (const lab of failedCma) {
          try {
            const r = await this.qualSvc.syncCmaLab(lab.cert_number, true);
            const idx = cmaResult.findIndex(x => x.cert_number === lab.cert_number);
            if (idx >= 0) cmaResult[idx] = { cert_number: lab.cert_number, ...r };
          } catch (retryErr) {
            console.warn(`[auto-sync] CMA ${lab.cert_number} 重试失败:`, retryErr instanceof Error ? retryErr.message : String(retryErr));
          }
        }
      }

      const cnasCount = cnasResult.filter(r => !r.error).length;
      const cmaCount = cmaResult.filter(r => !r.error).length;
      const failedCount = cnasResult.filter(r => r.error).length + cmaResult.filter(r => r.error).length;
      console.log(`[auto-sync] 资质同步完成: CNAS ${cnasCount}个, CMA ${cmaCount}个成功${failedCount > 0 ? `, ${failedCount}个仍失败` : ''}`);

      return { cnas: cnasResult, cma: cmaResult };
    } catch (err) {
      console.error('[auto-sync] 资质同步失败:', err instanceof Error ? err.message : String(err));
      return { cnas: [], cma: [] };
    }
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

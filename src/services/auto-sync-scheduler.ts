/**
 * 自动同步调度器。
 *
 * 统一编排资质订阅（CMA/CNAS）和 CMA 一单一库领域订阅的定时同步。
 * 沿用 app.ts 标准查新的 setInterval 模式，不引入新依赖。
 *
 * 调度流程：
 * 1. 读取 settings 表中的 autosync_* 配置
 * 2. 解析 cron 表达式，计算下次触发时间
 * 3. setTimeout 精确触发 → runCycle() → 分别执行资质同步和能力库同步
 * 4. 记录结果，console.log 输出摘要
 */
import type Database from 'better-sqlite3';
import type { QualificationService } from './qualification-service';
import type { CapLibService } from './cap-lib-service';
import { getSetting, setSetting } from './db';

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
  nextRunAt: number | null;
  cron: string;
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
    // * = all values
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

/**
 * 计算从 now 到下一次 cron 触发的毫秒数。
 * 向前遍历最多 7 天（10080 分钟），找不到返回 null。
 */
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
  private timer: ReturnType<typeof setTimeout> | null = null;
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
      nextRunAt: null,
      cron: '0 3 * * *',
      qualEnabled: true,
      capLibEnabled: true,
    };
  }

  start(): void {
    this.readSettings();
    if (!this.state.enabled) {
      console.log('[auto-sync] 调度器未启用');
      return;
    }
    this.schedule();
    console.log(`[auto-sync] 调度器启动 · cron: ${this.state.cron} · 下次运行: ${this.state.nextRunAt ? new Date(this.state.nextRunAt).toISOString() : 'N/A'}`);
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.state.nextRunAt = null;
    console.log('[auto-sync] 调度器已停止');
  }

  reload(): void {
    this.stop();
    this.readSettings();
    if (this.state.enabled) {
      this.schedule();
      console.log(`[auto-sync] 设置已重载 · cron: ${this.state.cron} · 下次运行: ${this.state.nextRunAt ? new Date(this.state.nextRunAt).toISOString() : 'N/A'}`);
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
    this.state.cron = getSetting(this.db, 'autosync_cron', '0 3 * * *');
    this.state.qualEnabled = getSetting(this.db, 'autosync_qual_enabled', '1') === '1';
    this.state.capLibEnabled = getSetting(this.db, 'autosync_caplib_enabled', '1') === '1';
  }

  private schedule(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    const delayMs = computeNextFireMs(this.state.cron, new Date());
    if (delayMs === null) {
      console.error(`[auto-sync] 无法解析 cron 表达式: ${this.state.cron}`);
      return;
    }

    this.state.nextRunAt = Date.now() + delayMs;
    this.timer = setTimeout(async () => {
      await this.runCycle();
      this.schedule();
    }, delayMs);
  }

  private async runCycle(): Promise<SyncResult> {
    if (this.state.running) {
      console.log('[auto-sync] 上一周期尚未完成，跳过');
      return {
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: 0,
        qualResult: null,
        capLibResult: null,
        error: '上一周期尚未完成',
      };
    }

    this.state.running = true;
    const startedAt = new Date();
    console.log('[auto-sync] 开始执行同步周期');

    let qualResult: SyncResult['qualResult'] = null;
    let capLibResult: SyncResult['capLibResult'] = null;
    let error: string | null = null;

    if (this.state.qualEnabled) {
      try {
        const cnasResult = await this.qualSvc.syncAllCnasLabs();
        const cmaResult = await this.qualSvc.syncAllCmaLabs();
        qualResult = { cnas: cnasResult, cma: cmaResult };
        const cnasCount = cnasResult.filter(r => !r.error).length;
        const cmaCount = cmaResult.filter(r => !r.error).length;
        console.log(`[auto-sync] 资质同步完成: CNAS ${cnasCount}个实验室, CMA ${cmaCount}个实验室`);
      } catch (err) {
        console.error('[auto-sync] 资质同步失败:', err instanceof Error ? err.message : String(err));
        qualResult = { cnas: [], cma: [] };
        error = `资质同步失败: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    if (this.state.capLibEnabled) {
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

        capLibResult = { domains: domainJobs, errors };
        if (domainJobs.length > 0) {
          console.log(`[auto-sync] 能力库同步已启动: ${domainJobs.map(d => d.domain).join(', ')}`);
        }
      } catch (err) {
        console.error('[auto-sync] 能力库同步失败:', err instanceof Error ? err.message : String(err));
        capLibResult = { domains: [], errors: [err instanceof Error ? err.message : String(err)] };
        error = error ? `${error}; 能力库同步失败: ${err instanceof Error ? err.message : String(err)}` : `能力库同步失败: ${err instanceof Error ? err.message : String(err)}`;
      }
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
    this.state.running = false;

    setSetting(this.db, 'autosync_last_run_at', result.startedAt);

    return result;
  }
}

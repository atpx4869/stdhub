/**
 * 自动同步调度器路由。
 *
 * 路径前缀 /api/auto-sync，提供调度器状态查询、设置管理、手动触发等端点。
 */
import express from 'express';
import { z } from 'zod';
import type Database from 'better-sqlite3';
import { validateCronExpression, type AutoSyncScheduler } from '../services/auto-sync-scheduler';
import { getSetting, setSettings } from '../services/db';
import { normalizeError } from '../shared/errors';
import { respond, respondError } from '../shared/response';
import { toCamelCase } from '../shared/case';
import { heavySyncInFlightGuard, heavySyncRateLimit } from '../shared/high-cost-guard';

export interface AutoSyncRouteOptions {
  /** 测试/嵌入模式禁止设置更新重新启动 cron timers。 */
  allowScheduling?: boolean;
}

export function createAutoSyncRoutes(
  db: Database.Database,
  requireAuth: express.RequestHandler,
  requireAdmin: express.RequestHandler,
  scheduler: AutoSyncScheduler,
  options: AutoSyncRouteOptions = {},
): express.Router {
  const router = express.Router();
  const allowScheduling = options.allowScheduling !== false;

  // ── 状态查询（需要登录） ──────────────────────────────────────────

  router.get('/api/auto-sync/status', requireAuth, (_req, res, next) => {
    try {
      const state = scheduler.getState();
      respond(res, toCamelCase(state));
    } catch (e) { next(normalizeError(e)); }
  });

  // ── 设置查询 ──────────────────────────────────────────────────────

  router.get('/api/auto-sync/settings', requireAuth, (_req, res, next) => {
    try {
      // 一次性读取所有设置，减少DB查询
      const rows = db.prepare(
        "SELECT key, value FROM settings WHERE key IN ('autosync_enabled', 'autosync_qual_cron', 'autosync_caplib_cron', 'autosync_qual_enabled', 'autosync_caplib_enabled')"
      ).all() as Array<{ key: string; value: string }>;
      const map = Object.fromEntries(rows.map(r => [r.key, r.value]));
      respond(res, toCamelCase({
        autosyncEnabled: (map.autosync_enabled || '0') === '1',
        autosyncQualCron: map.autosync_qual_cron || '0 3 * * 0',
        autosyncCaplibCron: map.autosync_caplib_cron || '0 3 * * *',
        autosyncQualEnabled: (map.autosync_qual_enabled || '1') === '1',
        autosyncCaplibEnabled: (map.autosync_caplib_enabled || '1') === '1',
      }));
    } catch (e) { next(normalizeError(e)); }
  });

  // ── 设置更新（需要管理员） ────────────────────────────────────────

  router.put('/api/auto-sync/settings', requireAuth, requireAdmin, (req, res, next) => {
    try {
      const schema = z.object({
        autosyncEnabled: z.boolean().optional(),
        autosyncQualCron: z.string().trim().optional(),
        autosyncCaplibCron: z.string().trim().optional(),
        autosyncQualEnabled: z.boolean().optional(),
        autosyncCaplibEnabled: z.boolean().optional(),
      });
      const updates = schema.parse(req.body);

      const validateCron = (cron: string): boolean => {
        try { validateCronExpression(cron); return true; }
        catch { return false; }
      };
      if (updates.autosyncQualCron !== undefined && !validateCron(updates.autosyncQualCron)) {
        respondError(res, 400, 'INVALID_CRON', '资质同步 Cron 表达式格式无效');
        return;
      }
      if (updates.autosyncCaplibCron !== undefined && !validateCron(updates.autosyncCaplibCron)) {
        respondError(res, 400, 'INVALID_CRON', '能力库同步 Cron 表达式格式无效');
        return;
      }

      const settings: Array<readonly [string, string]> = [];
      if (updates.autosyncEnabled !== undefined) settings.push(['autosync_enabled', updates.autosyncEnabled ? '1' : '0']);
      if (updates.autosyncQualCron !== undefined) settings.push(['autosync_qual_cron', updates.autosyncQualCron]);
      if (updates.autosyncCaplibCron !== undefined) settings.push(['autosync_caplib_cron', updates.autosyncCaplibCron]);
      if (updates.autosyncQualEnabled !== undefined) settings.push(['autosync_qual_enabled', updates.autosyncQualEnabled ? '1' : '0']);
      if (updates.autosyncCaplibEnabled !== undefined) settings.push(['autosync_caplib_enabled', updates.autosyncCaplibEnabled ? '1' : '0']);
      if (settings.length > 0) {
        setSettings(db, settings);
        // commit 后才重载 scheduler，避免副作用观察到半套设置。
        if (allowScheduling) scheduler.reload();
        else scheduler.stop();
      }
      respond(res, { ok: true });
    } catch (e) { next(normalizeError(e)); }
  });

  // ── 手动触发（需要管理员） ────────────────────────────────────────

  router.post('/api/auto-sync/trigger', requireAuth, requireAdmin, heavySyncRateLimit, heavySyncInFlightGuard, async (_req, res, next) => {
    try {
      const result = await scheduler.trigger();
      respond(res, toCamelCase(result));
    } catch (e) { next(normalizeError(e)); }
  });

  return router;
}

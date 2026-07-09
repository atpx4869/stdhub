/**
 * 自动同步调度器路由。
 *
 * 路径前缀 /api/auto-sync，提供调度器状态查询、设置管理、手动触发等端点。
 */
import express from 'express';
import type Database from 'better-sqlite3';
import type { AutoSyncScheduler } from '../services/auto-sync-scheduler';
import { getSetting, setSetting } from '../services/db';
import { normalizeError } from '../shared/errors';
import { respond, respondError } from '../shared/response';
import { toCamelCase } from '../shared/case';

export function createAutoSyncRoutes(
  db: Database.Database,
  requireAuth: express.RequestHandler,
  requireAdmin: express.RequestHandler,
  scheduler: AutoSyncScheduler,
): express.Router {
  const router = express.Router();

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
      respond(res, toCamelCase({
        autosyncEnabled: getSetting(db, 'autosync_enabled', '0') === '1',
        autosyncCron: getSetting(db, 'autosync_cron', '0 3 * * *'),
        autosyncQualEnabled: getSetting(db, 'autosync_qual_enabled', '1') === '1',
        autosyncCaplibEnabled: getSetting(db, 'autosync_caplib_enabled', '1') === '1',
      }));
    } catch (e) { next(normalizeError(e)); }
  });

  // ── 设置更新（需要管理员） ────────────────────────────────────────

  router.put('/api/auto-sync/settings', requireAuth, requireAdmin, (req, res, next) => {
    try {
      const { autosyncEnabled, autosyncCron, autosyncQualEnabled, autosyncCaplibEnabled } = req.body as {
        autosyncEnabled?: boolean;
        autosyncCron?: string;
        autosyncQualEnabled?: boolean;
        autosyncCaplibEnabled?: boolean;
      };

      if (autosyncEnabled !== undefined) {
        setSetting(db, 'autosync_enabled', autosyncEnabled ? '1' : '0');
      }
      if (autosyncCron !== undefined) {
        // 简单校验：5个字段
        const parts = autosyncCron.trim().split(/\s+/);
        if (parts.length !== 5) {
          respondError(res, 400, 'INVALID_CRON', 'Cron 表达式必须包含 5 个字段');
          return;
        }
        setSetting(db, 'autosync_cron', autosyncCron.trim());
      }
      if (autosyncQualEnabled !== undefined) {
        setSetting(db, 'autosync_qual_enabled', autosyncQualEnabled ? '1' : '0');
      }
      if (autosyncCaplibEnabled !== undefined) {
        setSetting(db, 'autosync_caplib_enabled', autosyncCaplibEnabled ? '1' : '0');
      }

      // 重载调度器
      scheduler.reload();
      respond(res, { ok: true });
    } catch (e) { next(normalizeError(e)); }
  });

  // ── 手动触发（需要管理员） ────────────────────────────────────────

  router.post('/api/auto-sync/trigger', requireAuth, requireAdmin, async (_req, res, next) => {
    try {
      const result = await scheduler.trigger();
      respond(res, toCamelCase(result));
    } catch (e) { next(normalizeError(e)); }
  });

  return router;
}

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
      const { autosyncEnabled, autosyncQualCron, autosyncCaplibCron, autosyncQualEnabled, autosyncCaplibEnabled } = req.body as {
        autosyncEnabled?: boolean;
        autosyncQualCron?: string;
        autosyncCaplibCron?: string;
        autosyncQualEnabled?: boolean;
        autosyncCaplibEnabled?: boolean;
      };

      if (autosyncEnabled !== undefined) {
        setSetting(db, 'autosync_enabled', autosyncEnabled ? '1' : '0');
      }

      // 校验 cron 表达式的函数
      const validateCron = (cron: string, name: string): boolean => {
        const parts = cron.trim().split(/\s+/);
        if (parts.length !== 5) return false;
        const fieldPatterns = [
          /^(\*|\*\/\d+|\d+(-\d+)?)(,(\*|\*\/\d+|\d+(-\d+)?))*$/,
          /^(\*|\*\/\d+|\d+(-\d+)?)(,(\*|\*\/\d+|\d+(-\d+)?))*$/,
          /^(\*|\*\/\d+|\d+(-\d+)?)(,(\*|\*\/\d+|\d+(-\d+)?))*$/,
          /^(\*|\*\/\d+|\d+(-\d+)?)(,(\*|\*\/\d+|\d+(-\d+)?))*$/,
          /^(\*|\*\/\d+|\d+(-\d+)?)(,(\*|\*\/\d+|\d+(-\d+)?))*$/,
        ];
        for (let i = 0; i < 5; i++) {
          if (!fieldPatterns[i].test(parts[i])) return false;
        }
        return true;
      };

      if (autosyncQualCron !== undefined) {
        if (!validateCron(autosyncQualCron, '资质同步')) {
          respondError(res, 400, 'INVALID_CRON', '资质同步 Cron 表达式格式无效');
          return;
        }
        setSetting(db, 'autosync_qual_cron', autosyncQualCron.trim());
      }
      if (autosyncCaplibCron !== undefined) {
        if (!validateCron(autosyncCaplibCron, '能力库同步')) {
          respondError(res, 400, 'INVALID_CRON', '能力库同步 Cron 表达式格式无效');
          return;
        }
        setSetting(db, 'autosync_caplib_cron', autosyncCaplibCron.trim());
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

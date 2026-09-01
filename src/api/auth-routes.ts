import { Router } from 'express';
import type Database from 'better-sqlite3';
import { respond } from '../shared/response';

export function createAuthRoutes(_db: Database.Database, _requireAuth: any) {
  const router = Router();

  // GET /api/auth/status — 单用户开放管理员模式，返回固定管理员身份
  router.get('/status', (_req, res) => {
    respond(res, {
      needsSetup: false,
      user: { id: 1, username: 'admin', displayName: '管理员', role: 'admin', allowedTabs: null },
      registrationEnabled: false,
      loginRequired: false,
      publicSettings: { downloadPreferLocal: true },
    });
  });

  return router;
}

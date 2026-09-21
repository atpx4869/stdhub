import express from 'express';
import { z } from 'zod';
import type Database from 'better-sqlite3';
import type { QualificationService } from '../services/qualification-service';
import { normalizeError } from '../shared/errors';
import { respond } from '../shared/response';
import { toCamelCase } from '../shared/case';
import { trackEvent, extractUsageCtx } from '../services/usage-tracker';
import type { RequireTab } from './auth-middleware';
import { heavySyncInFlightGuard, heavySyncRateLimit, highCostInFlightGuard, highCostRateLimit } from '../shared/high-cost-guard';

export function createQualificationRoutes(
  db: Database.Database,
  requireAuth: express.RequestHandler,
  requireAdmin: express.RequestHandler,
  requireTab: RequireTab,
  svc: QualificationService,
): express.Router & { qualificationService: QualificationService } {
  const router = express.Router() as express.Router & { qualificationService: QualificationService };
  router.qualificationService = svc;

  // 此 router 由 app.use(router) 挂在根上（无 mount path），不能用 router.use() 整 router
  // 守卫——那会命中全站每个请求。改用 per-route guard。requireTab 内部已含 requireAuth。
  const requireQual = requireTab('qual');

  // ─── Batch query for search result badges ───
  // 例外：batch-query 既服务「资质查询」页，也给「标准检索」结果点亮资质徽章。
  // 因此放行 qual 或 search 任一 tab（OR 语义），否则只开搜索权限的用户徽章会全灭。
  router.post('/api/qualifications/batch-query', requireTab('qual', 'search'), highCostRateLimit, highCostInFlightGuard, (req, res, next) => {
    try {
      const schema = z.object({
        stdCodes: z.array(z.string().trim()).min(1).max(200),
        includeCrossYear: z.boolean().optional().default(false),
      });
      const { stdCodes, includeCrossYear } = schema.parse(req.body);
      respond(res, toCamelCase(svc.queryByStdCodes(stdCodes, { includeCrossYear })));
    } catch (e) { next(normalizeError(e)); }
  });

  // ─── Fixed Hubei qualification profile ───
  router.get('/api/qualifications/profile', requireQual, requireAdmin, (_req, res, next) => {
    try {
      respond(res, toCamelCase(svc.getHubeiQualificationStatus()));
    } catch (e) { next(normalizeError(e)); }
  });

  router.post('/api/qualifications/sync/:source', requireQual, requireAdmin, heavySyncRateLimit, heavySyncInFlightGuard, async (req, res, next) => {
    try {
      const source = z.enum(['cnas', 'cma', 'all']).parse(req.params.source).toUpperCase() as 'CNAS' | 'CMA' | 'ALL';
      const force = z.coerce.boolean().default(false).parse(req.query.force);
      respond(res, toCamelCase(await svc.syncHubeiQualifications(source, force)));
    } catch (e) { next(normalizeError(e)); }
  });

  // ─── Qualification search ───
  router.get('/api/qualifications/search', requireQual,(req, res, next) => {
    try {
      const schema = z.object({
        q: z.string().trim().min(1).max(500),
        source: z.enum(['CNAS', 'CMA']).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
        offset: z.coerce.number().int().min(0).max(100_000_000).default(0),
      });
      const { q, source, limit, offset } = schema.parse(req.query);
      const startedAt = performance.now();
      const items = svc.searchQualifications(q, source, limit, { offset });
      const queryMs = Math.round((performance.now() - startedAt) * 10) / 10;
      if (queryMs >= 100) console.warn(`[qual-search] slow query ${queryMs}ms source=${source || 'ALL'} offset=${offset} q=${q.slice(0, 80)}`);
      trackEvent(db, req.user!.id, 'qual_search', source, undefined, { query: q, resultCount: items.length }, { ...extractUsageCtx(req), result: 'success' });
      respond(res, { items: toCamelCase(items), total: offset + items.length, offset, hasMore: items.length >= limit });
    } catch (e) {
      try { trackEvent(db, req.user!.id, 'qual_search', undefined, undefined, undefined, { ...extractUsageCtx(req), result: 'fail', error: e instanceof Error ? e.message : String(e) }); } catch { /* ignore */ }
      next(normalizeError(e));
    }
  });

  // ─── 按标准查（关键词 → 按 std_code 聚合分组，产品标准可展开 / 方法直显）───
  router.get('/api/qualifications/search-by-standard', requireQual, (req, res, next) => {
    try {
      const schema = z.object({
        q: z.string().trim().min(1).max(500),
        source: z.enum(['CNAS', 'CMA']).optional(),
        limit: z.coerce.number().int().min(1).max(300).default(100),
        includeRows: z.enum(['true', 'false']).optional().default('true'),
      });
      const { q, source, limit, includeRows } = schema.parse(req.query);
      const groups = svc.searchByStandard(q, source, limit, { includeRows: includeRows !== 'false' });
      trackEvent(db, req.user!.id, 'qual_search_by_std', source, undefined, { query: q, resultCount: groups.length }, { ...extractUsageCtx(req), result: 'success' });
      respond(res, { items: toCamelCase(groups), total: groups.length });
    } catch (e) {
      try { trackEvent(db, req.user!.id, 'qual_search_by_std', undefined, undefined, undefined, { ...extractUsageCtx(req), result: 'fail', error: e instanceof Error ? e.message : String(e) }); } catch { /* ignore */ }
      next(normalizeError(e));
    }
  });

  router.get('/api/qualifications/standard-group-rows', requireQual, (req, res, next) => {
    try {
      const schema = z.object({
        stdCode: z.string().trim().min(1).max(200),
        source: z.enum(['CNAS', 'CMA']).optional(),
        limit: z.coerce.number().int().min(1).max(300).default(20),
      });
      const { stdCode, source, limit } = schema.parse(req.query);
      const rows = svc.getStandardGroupRows(stdCode, source, limit);
      respond(res, { items: toCamelCase(rows), total: rows.length });
    } catch (e) {
      next(normalizeError(e));
    }
  });

  router.post('/api/qualifications/visual', requireQual,(req, res, next) => {
    try {
      const schema = z.object({
        queries: z.array(z.string().trim().min(1).max(500)).min(1).max(100),
        limitPerQuery: z.coerce.number().int().min(1).max(1000).default(500),
      });
      const { queries, limitPerQuery } = schema.parse(req.body);
      const unique = [...new Set(queries)];
      respond(res, toCamelCase(svc.queryVisualKeywords(unique, limitPerQuery)));
    } catch (e) { next(normalizeError(e)); }
  });

  // ─── Sync (under /qualifications/labs/{cnas|cma}/sync) ───
  router.post('/api/qualifications/labs/cnas/sync', requireQual, requireAdmin, heavySyncRateLimit, heavySyncInFlightGuard, async (req, res, next) => {
    try {
      const schema = z.object({ labNo: z.string().trim().optional(), force: z.coerce.boolean().default(false) });
      const { labNo, force } = schema.parse(req.query);

      if (labNo) {
        respond(res, toCamelCase(await svc.syncCnasLab(labNo, force)));
      } else {
        respond(res, toCamelCase(await svc.syncAllCnasLabs(force)));
      }
    } catch (e) { next(normalizeError(e)); }
  });

  router.post('/api/qualifications/labs/cma/sync', requireQual, requireAdmin, heavySyncRateLimit, heavySyncInFlightGuard, async (req, res, next) => {
    try {
      const schema = z.object({ certNumber: z.string().trim().optional(), force: z.coerce.boolean().default(false) });
      const { certNumber, force } = schema.parse(req.query);

      if (certNumber) {
        respond(res, toCamelCase(await svc.syncCmaLab(certNumber, force)));
      } else {
        respond(res, toCamelCase(await svc.syncAllCmaLabs(force)));
      }
    } catch (e) { next(normalizeError(e)); }
  });

  // ─── Sync Logs ───
  router.get('/api/qualifications/labs/cnas/sync-logs', requireQual, requireAdmin,(req, res) => {
    const limit = Math.max(1, Math.min(Number.parseInt(String(req.query.limit ?? ''), 10) || 20, 100));
    respond(res, { items: toCamelCase(svc.getCnasSyncLogs(limit)) });
  });

  router.get('/api/qualifications/labs/cma/sync-logs', requireQual, requireAdmin,(req, res) => {
    const limit = Math.max(1, Math.min(Number.parseInt(String(req.query.limit ?? ''), 10) || 20, 100));
    respond(res, { items: toCamelCase(svc.getCmaSyncLogs(limit)) });
  });

  // ─── Settings ───
  router.get('/api/qualifications/settings', requireQual, requireAdmin,(_req, res) => {
    respond(res, svc.getSettings());
  });

  router.put('/api/qualifications/settings', requireQual, requireAdmin,(req, res, next) => {
    try {
      const schema = z.record(
        z.string().refine(key => key.startsWith('qual_'), { message: 'Invalid qualification setting key' }),
        z.string(),
      );
      const data = schema.parse(req.body);
      svc.updateSettings(data);
      respond(res, svc.getSettings());
    } catch (e) { next(normalizeError(e)); }
  });

  // ─── Stats ───
  router.get('/api/qualifications/stats', requireQual, requireAdmin,(_req, res) => {
    const cnasCount = (db.prepare('SELECT COUNT(*) as c FROM cnas_qualifications').get() as any).c;
    const cmaCount = (db.prepare('SELECT COUNT(*) as c FROM cma_qualifications').get() as any).c;
    const cnasLabs = (db.prepare('SELECT COUNT(*) as c FROM cnas_labs').get() as any).c;
    const cmaLabs = (db.prepare('SELECT COUNT(*) as c FROM cma_labs').get() as any).c;
    respond(res, { cnasQualifications: cnasCount, cmaQualifications: cmaCount, cnasLabs, cmaLabs });
  });

  return router;
}

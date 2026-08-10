import express from 'express';
import { z } from 'zod';
import type Database from 'better-sqlite3';
import type { QualificationService } from '../services/qualification-service';
import { PRESET_CNAS_LABS } from '../services/preset-cnas-labs';
import { normalizeError } from '../shared/errors';
import { respond, respondError } from '../shared/response';
import { toCamelCase, toSnakeCase } from '../shared/case';
import { trackEvent, extractUsageCtx } from '../services/usage-tracker';
import type { RequireTab } from './auth-middleware';
import { heavySyncInFlightGuard, heavySyncRateLimit, highCostInFlightGuard, highCostRateLimit } from '../shared/high-cost-guard';

export function createQualificationRoutes(
  db: Database.Database,
  requireAuth: express.RequestHandler,
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

  // ─── Qualification search ───
  router.get('/api/qualifications/search', requireQual,(req, res, next) => {
    try {
      const schema = z.object({
        q: z.string().trim().min(1).max(500),
        source: z.enum(['CNAS', 'CMA']).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
        offset: z.coerce.number().int().min(0).max(5000).default(0),
      });
      const { q, source, limit, offset } = schema.parse(req.query);
      const items = svc.searchQualifications(q, source, limit, { offset });
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

  // ─── CNAS Labs (under /qualifications/labs/cnas) ───
  router.get('/api/qualifications/labs/cnas', requireQual,(_req, res) => {
    respond(res, { items: toCamelCase(svc.listCnasLabs()) });
  });

  router.post('/api/qualifications/labs/cnas', requireQual,(req, res, next) => {
    try {
      const schema = z.object({
        labNo: z.string().trim().min(1).max(50),
        labName: z.string().trim().max(200).optional(),
        baseInfoId: z.string().trim().max(100).optional(),
        certUpdateTs: z.string().trim().max(50).optional(),
        validate: z.string().trim().max(50).optional(),
        urlParams: z.record(z.string(), z.string()).optional(),
      });
      const data = schema.parse(req.body);
      const lab = svc.addCnasLab(toSnakeCase(data));
      respond(res, toCamelCase(lab), 201);
    } catch (e) { next(normalizeError(e)); }
  });

  router.delete('/api/qualifications/labs/cnas/:labNo', requireQual,(req, res, next) => {
    try {
      svc.deleteCnasLab(req.params.labNo as string);
      respond(res, { ok: true });
    } catch (e) { next(normalizeError(e)); }
  });

  router.put('/api/qualifications/labs/cnas/:labNo', requireQual,(req, res, next) => {
    try {
      const schema = z.object({ labName: z.string().trim().max(200) });
      const { labName } = schema.parse(req.body);
      db.prepare('UPDATE cnas_labs SET lab_name = ? WHERE lab_no = ?').run(labName, req.params.labNo);
      respond(res, { ok: true });
    } catch (e) { next(normalizeError(e)); }
  });

  // ─── Preset CNAS labs (built-in recommendations) ───────────────────────────
  router.get('/api/qualifications/presets/cnas', requireQual,(_req, res) => {
    const existing = db.prepare('SELECT lab_no FROM cnas_labs').all() as { lab_no: string }[];
    const subscribed = new Set(existing.map(r => r.lab_no));
    const items = PRESET_CNAS_LABS.map(p => ({
      labName: p.labName,
      labNo: p.labNo,
      baseInfoId: p.baseInfoId,
      certUpdateTs: p.certUpdateTs || '',
      validate: p.validate || '',
      note: p.note || '',
      subscribed: subscribed.has(p.labNo),
    }));
    respond(res, { items });
  });

  router.post('/api/qualifications/presets/cnas/:labNo/subscribe', requireQual,(req, res, next) => {
    try {
      const labNo = String(req.params.labNo);
      const preset = PRESET_CNAS_LABS.find(p => p.labNo === labNo);
      if (!preset) { respondError(res, 404, 'NOT_FOUND', '未找到内置候选机构'); return; }
      const lab = svc.addCnasLab({
        lab_no: preset.labNo,
        lab_name: preset.labName,
        base_info_id: preset.baseInfoId,
        cert_update_ts: preset.certUpdateTs || '',
        validate: preset.validate || '',
        url_params: preset.urlParams || {},
      });
      respond(res, toCamelCase(lab), 201);
    } catch (e) { next(normalizeError(e)); }
  });


  // ─── CMA Labs (under /qualifications/labs/cma) ───
  router.get('/api/qualifications/labs/cma/search', requireQual,async (req, res, next) => {
    try {
      const schema = z.object({ q: z.string().trim().min(1).max(200) });
      const { q } = schema.parse(req.query);
      const items = await svc.searchCmaLabs(q);
      respond(res, { items: toCamelCase(items), total: items.length });
    } catch (e) { next(normalizeError(e)); }
  });

  router.get('/api/qualifications/labs/cma', requireQual,(_req, res) => {
    respond(res, { items: toCamelCase(svc.listCmaLabs()) });
  });

  router.post('/api/qualifications/labs/cma', requireQual,async (req, res, next) => {
    try {
      const schema = z.object({
        publicDetailId: z.string().trim().min(1).max(120),
      });
      const data = schema.parse(req.body);
      const lab = await svc.addCmaLab(toSnakeCase(data));
      respond(res, toCamelCase(lab), 201);
    } catch (e) { next(normalizeError(e)); }
  });

  router.delete('/api/qualifications/labs/cma/:certNumber', requireQual,(req, res, next) => {
    try {
      svc.deleteCmaLab(req.params.certNumber as string);
      respond(res, { ok: true });
    } catch (e) { next(normalizeError(e)); }
  });

  router.put('/api/qualifications/labs/cma/:certNumber', requireQual,(req, res, next) => {
    try {
      const schema = z.object({ labName: z.string().trim().max(200) });
      const { labName } = schema.parse(req.body);
      db.prepare('UPDATE cma_labs SET lab_name = ? WHERE cert_number = ?').run(labName, req.params.certNumber);
      respond(res, { ok: true });
    } catch (e) { next(normalizeError(e)); }
  });

  // ─── Qualification links (under /qualifications/links) ───
  router.post('/api/qualifications/links', requireQual,(req, res, next) => {
    try {
      const schema = z.object({
        displayName: z.string().trim().min(1).max(200),
        cnasLabNo: z.string().trim().max(80).optional(),
        cmaCertNumber: z.string().trim().max(80).optional(),
      });
      const data = schema.parse(req.body);
      svc.linkQualificationLabs(toSnakeCase(data));
      respond(res, { ok: true });
    } catch (e) { next(normalizeError(e)); }
  });

  router.delete('/api/qualifications/links/:source/:id', requireQual,(req, res, next) => {
    try {
      const schema = z.object({
        source: z.enum(['CNAS', 'CMA']),
        id: z.string().trim().min(1).max(80),
      });
      const { source, id } = schema.parse(req.params);
      svc.unlinkQualificationLab(source, id);
      respond(res, { ok: true });
    } catch (e) { next(normalizeError(e)); }
  });

  // ─── Sync (under /qualifications/labs/{cnas|cma}/sync) ───
  router.post('/api/qualifications/labs/cnas/sync', requireQual, heavySyncRateLimit, heavySyncInFlightGuard, async (req, res, next) => {
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

  router.post('/api/qualifications/labs/cma/sync', requireQual, heavySyncRateLimit, heavySyncInFlightGuard, async (req, res, next) => {
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
  router.get('/api/qualifications/labs/cnas/sync-logs', requireQual,(req, res) => {
    const limit = Math.max(1, Math.min(Number.parseInt(String(req.query.limit ?? ''), 10) || 20, 100));
    respond(res, { items: toCamelCase(svc.getCnasSyncLogs(limit)) });
  });

  router.get('/api/qualifications/labs/cma/sync-logs', requireQual,(req, res) => {
    const limit = Math.max(1, Math.min(Number.parseInt(String(req.query.limit ?? ''), 10) || 20, 100));
    respond(res, { items: toCamelCase(svc.getCmaSyncLogs(limit)) });
  });

  // ─── Settings ───
  router.get('/api/qualifications/settings', requireQual,(_req, res) => {
    respond(res, svc.getSettings());
  });

  router.put('/api/qualifications/settings', requireQual,(req, res, next) => {
    try {
      const schema = z.record(z.string(), z.string());
      const data = schema.parse(req.body);
      for (const [k, v] of Object.entries(data)) {
        svc.updateSetting(k, v);
      }
      respond(res, svc.getSettings());
    } catch (e) { next(normalizeError(e)); }
  });

  // ─── Stats ───
  router.get('/api/qualifications/stats', requireQual,(_req, res) => {
    const cnasCount = (db.prepare('SELECT COUNT(*) as c FROM cnas_qualifications').get() as any).c;
    const cmaCount = (db.prepare('SELECT COUNT(*) as c FROM cma_qualifications').get() as any).c;
    const cnasLabs = (db.prepare('SELECT COUNT(*) as c FROM cnas_labs').get() as any).c;
    const cmaLabs = (db.prepare('SELECT COUNT(*) as c FROM cma_labs').get() as any).c;
    respond(res, { cnasQualifications: cnasCount, cmaQualifications: cmaCount, cnasLabs, cmaLabs });
  });

  return router;
}

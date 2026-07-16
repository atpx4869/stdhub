/**
 * 国家 CMA 资质订阅路由。
 *
 * 场所用于管理订阅范围；当前公开数据源返回机构级能力，
 * 因此同步、缓存与统计均按证书去重，由 NatCmaService 统一处理。
 */
import express from 'express';
import { z } from 'zod';
import { respond, respondError } from '../shared/response';
import type { RequireTab } from './auth-middleware';
import { NatCmaService } from '../services/nat-cma-service';

export function createNatCmaRoutes(
  natCmaService: NatCmaService,
  requireAuth: express.RequestHandler,
  requireTab: RequireTab,
): express.Router {
  const router = express.Router();
  const requireQual = requireTab('qual');

  router.get('/api/nat-cma/orgs', requireAuth, (_req, res) => {
    respond(res, { items: natCmaService.listOrgs() });
  });

  router.get('/api/nat-cma/subscriptions', requireAuth, (_req, res) => {
    respond(res, { items: natCmaService.listSubscriptions() });
  });

  router.post('/api/nat-cma/subscribe', requireQual, (req, res, next) => {
    try {
      const { certCode, placeId } = z.object({
        certCode: z.string().trim().min(1),
        placeId: z.string().trim().min(1),
      }).parse(req.body);
      const place = natCmaService.subscribe(certCode, placeId);
      respond(res, { ok: true, place });
    } catch (error) {
      if (error instanceof z.ZodError) {
        respondError(res, 400, 'BAD_REQUEST', '请求参数无效');
        return;
      }
      next(error);
    }
  });

  router.delete('/api/nat-cma/subscribe/:placeId', requireQual, (req, res, next) => {
    try {
      const { placeId } = z.object({ placeId: z.string().trim().min(1) }).parse(req.params);
      const certCode = z.string().trim().min(1).parse(req.query.certCode);
      natCmaService.unsubscribe(certCode, placeId);
      respond(res, { ok: true });
    } catch (error) {
      if (error instanceof z.ZodError) {
        respondError(res, 400, 'BAD_REQUEST', '请求参数无效');
        return;
      }
      next(error);
    }
  });

  router.post('/api/nat-cma/sync/:placeId', requireQual, (req, res, next) => {
    try {
      const { placeId } = z.object({ placeId: z.string().trim().min(1) }).parse(req.params);
      const status = natCmaService.startSyncForPlace(placeId);
      respond(res, { ok: true, status, abilityScope: 'organization' });
    } catch (error) {
      next(error);
    }
  });

  router.post('/api/nat-cma/sync-all', requireQual, (_req, res, next) => {
    try {
      const result = natCmaService.startSyncAll();
      respond(res, { ok: true, ...result, abilityScope: 'organization' });
    } catch (error) {
      next(error);
    }
  });

  router.get('/api/nat-cma/sync/progress', requireAuth, (_req, res) => {
    respond(res, { items: natCmaService.getProgressByPlace() });
  });

  router.get('/api/nat-cma/status', requireAuth, (_req, res) => {
    respond(res, natCmaService.getStatus());
  });

  return router;
}

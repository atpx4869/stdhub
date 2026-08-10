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
import { NatCmaService, NAT_CMA_SUSPENDED_MESSAGE } from '../services/nat-cma-service';

export function createNatCmaRoutes(
  natCmaService: NatCmaService,
  requireAuth: express.RequestHandler,
  requireTab: RequireTab,
): express.Router {
  const router = express.Router();
  const requireQual = requireTab('qual');
  const requireSearchOrQual = requireTab('qual', 'search');
  const suspended = (_req: express.Request, res: express.Response) => {
    respondError(res, 503, 'NAT_CMA_SUSPENDED', NAT_CMA_SUSPENDED_MESSAGE);
  };

  router.get('/api/nat-cma/orgs', requireAuth, (_req, res) => {
    respond(res, { items: natCmaService.listOrgs() });
  });

  router.get('/api/nat-cma/subscriptions', requireAuth, (_req, res) => {
    respond(res, { items: natCmaService.listSubscriptions() });
  });

  router.post('/api/nat-cma/subscribe', requireQual, suspended);

  router.delete('/api/nat-cma/subscribe/:placeId', requireQual, suspended);

  router.post('/api/nat-cma/sync/:placeId', requireQual, suspended);

  router.post('/api/nat-cma/sync-all', requireQual, suspended);

  router.get('/api/nat-cma/sync/progress', requireAuth, (_req, res) => {
    respond(res, { items: natCmaService.getProgressByPlace() });
  });

  router.get('/api/nat-cma/search', requireSearchOrQual, (req, res, next) => {
    try {
      const { q, limit, offset } = z.object({
        q: z.string().trim().min(1).max(500),
        limit: z.coerce.number().int().min(1).max(200).default(50),
        offset: z.coerce.number().int().min(0).default(0),
      }).parse(req.query);
      respond(res, natCmaService.search(q, { limit, offset }));
    } catch (error) { next(error); }
  });

  router.post('/api/nat-cma/batch-match', requireSearchOrQual, suspended);

  router.get('/api/nat-cma/status', requireAuth, (_req, res) => {
    respond(res, natCmaService.getStatus());
  });

  return router;
}

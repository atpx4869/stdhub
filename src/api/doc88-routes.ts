import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';

import { normalizeError } from '../shared/errors';
import { highCostRateLimit } from '../shared/high-cost-guard';
import { respond } from '../shared/response';
import { Doc88Service } from '../sources/doc88/doc88-service';

export function createDoc88Routes(
  requireAdmin: (req: Request, res: Response, next: NextFunction) => void,
  service: Doc88Service,
) {
  const router = Router();

  router.get('/api/doc88/search', requireAdmin, highCostRateLimit, async (req, res, next) => {
    try {
      const query = z.object({
        keyword: z.string().trim().min(1).max(200),
        page: z.coerce.number().int().min(1).max(100).default(1),
        pageSize: z.coerce.number().int().min(1).max(30).default(20),
      }).parse(req.query);
      const result = await service.search(query.keyword, query.page, query.pageSize);
      respond(res, { ...result, page: query.page, pageSize: query.pageSize });
    } catch (error) { next(normalizeError(error)); }
  });

  router.get('/api/doc88/health', requireAdmin, (_req, res) => {
    respond(res, service.getHealth());
  });

  router.post('/api/doc88/tasks', requireAdmin, highCostRateLimit, (req, res, next) => {
    try {
      const input = z.object({
        pcode: z.string().regex(/^\d{6,20}$/),
        title: z.string().trim().max(300).default(''),
        standardNumber: z.string().trim().min(1).max(100),
        cleanTitle: z.string().trim().max(300).default(''),
      }).parse(req.body);
      respond(res, service.createTask(req.user!.id, input), 202);
    } catch (error) { next(normalizeError(error)); }
  });

  router.get('/api/doc88/tasks', requireAdmin, (req, res, next) => {
    try { respond(res, { items: service.listTasks(req.user!.id) }); }
    catch (error) { next(normalizeError(error)); }
  });

  router.get('/api/doc88/tasks/:taskId', requireAdmin, (req, res, next) => {
    try { respond(res, service.getTask(String(req.params.taskId), req.user!.id)); }
    catch (error) { next(normalizeError(error)); }
  });

  router.post('/api/doc88/tasks/:taskId/cancel', requireAdmin, (req, res, next) => {
    try { respond(res, service.cancel(String(req.params.taskId), req.user!.id)); }
    catch (error) { next(normalizeError(error)); }
  });

  router.get('/api/doc88/tasks/:taskId/stream', requireAdmin, (req, res) => {
    try {
      service.getTask(String(req.params.taskId), req.user!.id);
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      const unsubscribe = service.subscribe(String(req.params.taskId), req.user!.id, task => {
        res.write(`data: ${JSON.stringify({ data: task, error: null })}\n\n`);
        if (['success', 'failed', 'cancelled'].includes(task.status)) res.end();
      });
      req.on('close', unsubscribe);
    } catch {
      res.status(404).json({ data: null, error: { code: 'DOC88_TASK_NOT_FOUND', message: 'Doc88 任务不存在或已清理' } });
    }
  });

  return router;
}

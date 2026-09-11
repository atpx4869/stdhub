import { Router, type RequestHandler } from 'express';
import type { SourceRegistry } from '../services/source-registry';
import { respond } from '../shared/response';
import { getOcrStatus } from '../sources/shared/captcha-ocr';
import { getRecentLogs } from '../shared/log-buffer';
import { getEnvironmentReport, runEnvironmentCheck } from '../services/environment-check';
import { getHostStats } from '../shared/http';
import { getSourceSemaphoreStats } from '../shared/source-semaphore';
import { getProxyTokenStatus } from './proxy-token-guard';
import { readConfig } from '../config';

export function createDiagnosticsRoutes(requireAdmin: RequestHandler, sourceRegistry: SourceRegistry, appVersion: string) {
  const router = Router();
  router.get('/api/health', (_req, res) => respond(res, {
    ok: true,
    version: appVersion,
    sources: sourceRegistry.list(),
    features: { natCma: { state: 'suspended', readOnly: true } },
  }));
  router.get('/api/security/status', requireAdmin, (_req, res) => respond(res, {
    ...getProxyTokenStatus(),
    authMode: 'open_admin',
    allowOpenAdmin: readConfig().allowOpenAdmin,
  }));
  router.get('/api/diagnostics/ocr', requireAdmin, (_req, res) => {
    const status = getOcrStatus();
    const average = (metric: { count: number; totalMs: number }) => metric.count === 0 ? 0 : Math.round(metric.totalMs / metric.count);
    respond(res, { ...status, solves: {
      ddddocr: { ...status.solves.ddddocr, avgMs: average(status.solves.ddddocr) },
      tesseract: { ...status.solves.tesseract, avgMs: average(status.solves.tesseract) },
    } });
  });
  router.get('/api/diagnostics/logs', requireAdmin, (req, res) => {
    const limit = Math.max(1, Math.min(Number.parseInt(String(req.query.limit ?? ''), 10) || 200, 500));
    respond(res, { items: getRecentLogs(limit) });
  });
  router.get('/api/diagnostics/environment', requireAdmin, (_req, res) => respond(res, getEnvironmentReport()));
  router.post('/api/diagnostics/environment/recheck', requireAdmin, async (_req, res, next) => {
    try { await runEnvironmentCheck(); respond(res, getEnvironmentReport()); } catch (error) { next(error); }
  });
  router.get('/api/diagnostics/hosts', requireAdmin, (_req, res) => respond(res, { hosts: getHostStats() }));
  router.get('/api/diagnostics/sources', requireAdmin, (_req, res) => respond(res, { sources: getSourceSemaphoreStats() }));
  return router;
}

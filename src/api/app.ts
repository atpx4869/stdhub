import express, { type NextFunction, type Request, type Response } from 'express';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

import { ExportTaskStore } from '../services/export-task-store';
import { ExportTaskService } from '../services/export-task-service';
import { StandardDownloadOrchestrator } from '../services/standard-download-orchestrator';
import { SourceRegistry } from '../services/source-registry';
import { getDb } from '../services/db';
import { createAuthMiddleware } from './auth-middleware';
import { createAuthRoutes } from './auth-routes';
import { createAdminRoutes } from './admin-routes';
import { createAnnouncementRoutes } from './announcement-routes';
import { createStatsRoutes } from './stats-routes';
import { createQualificationRoutes } from './cnas-routes';
import { createCapLibRoutes } from './cap-lib-routes';
import { createStandardsRoutes } from './standards-routes';
import { createCheckRoutes } from './check-routes';
import { createPreviewRoutes } from './preview-routes';
import { createLabrRoutes } from './labr-routes';
import { createAutoSyncRoutes } from './auto-sync-routes';
import { QualificationService } from '../services/qualification-service';
import { AppError } from '../shared/errors';
import { respondError } from '../shared/response';
import { createProxyTokenGuard } from './proxy-token-guard';
import { createNatCmaRoutes } from './nat-cma-routes';
import { NatCmaService, NationalCmaProviderUnavailable } from '../services/nat-cma-service';
import { LabrService } from '../sources/labr/labr-service';
import { PdfPreviewService, type PreviewServiceOptions } from '../services/pdf-preview-service';
import { readConfig } from '../config';
import { createDownloadRoutes } from './download-routes';
import { createDiagnosticsRoutes } from './diagnostics-routes';
import { startAppBackgroundRuntime } from '../services/app-background-runtime';

/**
 * Legacy → canonical route rewrites. Express matches by url, so we just patch req.url
 * before the router sees it. New code should only emit canonical paths.
 */
const LEGACY_ROUTE_REWRITES: Array<[RegExp, string]> = [
  [/^\/api\/standards\/qualifications(\?|$)/, '/api/qualifications/batch-query$1'],
  [/^\/api\/cnas\/labs(\/.*)?$/, '/api/qualifications/labs/cnas$1'],
  [/^\/api\/cnas\/sync(\?|$)/, '/api/qualifications/labs/cnas/sync$1'],
  [/^\/api\/cnas\/sync-logs(\?|$)/, '/api/qualifications/labs/cnas/sync-logs$1'],
  [/^\/api\/cma\/search-labs(\?|$)/, '/api/qualifications/labs/cma/search$1'],
  [/^\/api\/cma\/labs(\/.*)?$/, '/api/qualifications/labs/cma$1'],
  [/^\/api\/cma\/sync(\?|$)/, '/api/qualifications/labs/cma/sync$1'],
  [/^\/api\/cma\/sync-logs(\?|$)/, '/api/qualifications/labs/cma/sync-logs$1'],
  [/^\/api\/qualification-links(\/.*)?$/, '/api/qualifications/links$1'],
];

function legacyRouteAlias(req: Request, _res: Response, next: NextFunction): void {
  for (const [pattern, replacement] of LEGACY_ROUTE_REWRITES) {
    if (pattern.test(req.url)) {
      req.url = req.url.replace(pattern, replacement);
      break;
    }
  }
  next();
}

export interface CreateAppOptions {
  baseDir?: string;
  dbPath?: string;
  /** 测试/嵌入模式可关闭启动自检、库扫描、watcher 和定时调度；生产默认开启。 */
  startBackgroundJobs?: boolean;
  /** Preview converter overrides used by integration tests and embedded deployments. */
  previewServiceOptions?: PreviewServiceOptions;
}

export function createApp(options: CreateAppOptions = {}) {
  const config = readConfig();
  const app = express();
  const sourceRegistry = new SourceRegistry();
  const exportTaskStore = new ExportTaskStore();
  const db = options.dbPath ? getDb(options.dbPath) : getDb();
  const downloadOrchestrator = new StandardDownloadOrchestrator(db, sourceRegistry);
  const exportTaskService = new ExportTaskService(exportTaskStore, downloadOrchestrator);
  if (config.isTest) app.locals.db = db;
  const { requireAuth, requireAdmin, requireTab, attachUser, tokenHash, requireSameOrigin } = createAuthMiddleware(db);

  // 读取 package.json 版本号（启动时一次性读取）
  let appVersion = '';
  try {
    const pkgPath = path.join(options.baseDir ?? process.cwd(), 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    appVersion = pkg.version || '';
  } catch {
    // 读取失败，尝试环境变量
    appVersion = config.appVersion;
  }

  const baseDir = path.resolve(options.baseDir ?? process.cwd());
  const pdfPreviewService = new PdfPreviewService(db, baseDir, options.previewServiceOptions);
  app.locals.pdfPreviewService = pdfPreviewService;
  // 显式 dbPath 通常用于测试/嵌入 app，默认不启动后台任务；生产无 dbPath 时保持开启。
  // 如果确实需要自定义 DB + 后台任务，调用方必须显式传 startBackgroundJobs:true，
  // 并承担 A2 完整 shutdown 的资源生命周期约束。
  const startBackgroundJobs = options.startBackgroundJobs ?? !options.dbPath;

  // 默认只信任紧邻的一层反代（Lucky/nginx/caddy），避免直接访问服务时任意伪造
  // X-Forwarded-For。复杂多级代理部署可通过 STDHUB_TRUST_PROXY 显式覆盖。
  app.set('trust proxy', config.trustProxy);

  app.use((_req, res, next) => {
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; script-src-attr 'none'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: blob:; font-src 'self' https://fonts.gstatic.com; connect-src 'self' https:; object-src 'none'; base-uri 'self'; frame-ancestors 'self'");
    next();
  });

  // 可选：由 Lucky 等反代注入私密 Header，阻止直接暴露容器端口后的未授权访问。
  app.use(createProxyTokenGuard());
  app.use(express.json({ limit: '1mb' }));

  // Attach a guest identity by default; an administrator session upgrades the request.
  app.use(attachUser);
  app.use(requireSameOrigin);

  const publicDir = path.join(baseDir, 'public');
  const indexPath = path.join(publicDir, 'index.html');
  const assetVersion = encodeURIComponent(appVersion || 'dev');

  // index.html uses one server-injected version token for every local asset. This
  // prevents mixed JS/CSS generations after NAS upgrades while keeping static
  // files cacheable and independently addressable.
  app.get(['/', '/index.html'], (_req, res) => {
    if (!existsSync(indexPath)) { res.status(404).send('StdHub frontend is unavailable'); return; }
    const html = readFileSync(indexPath, 'utf8').replaceAll('__STDHUB_ASSET_VERSION__', assetVersion);
    res.type('html').send(html);
  });
  app.use(express.static(publicDir, { index: false }));

  // Legacy route aliases: rewrite old paths to new canonical paths in-place so the actual
  // route handlers below only know about the new layout. Removed in a future major.
  app.use(legacyRouteAlias);

  app.use(createDownloadRoutes(db, baseDir, requireAuth, requireAdmin));
  // Auth routes (no auth required)
  app.use('/api/auth', createAuthRoutes(db, requireAuth, requireAdmin, tokenHash));
  app.use('/api/admin', requireAdmin, createAdminRoutes(db));
  const announcementRoutes = createAnnouncementRoutes(db, requireAuth, requireAdmin);
  app.use('/api/announcements', announcementRoutes.userRouter);
  app.use('/api/admin/announcements', announcementRoutes.adminRouter);
  app.use('/api/stats', createStatsRoutes(db, requireAuth, requireTab));
  // 路由与自动调度必须共享同一 QualificationService，保证同机构 single-flight
  // 能跨手动 API 和 scheduler 生效。
  const qualSvc = new QualificationService(db);
  const qualRouter = createQualificationRoutes(db, requireAuth, requireAdmin, requireTab, qualSvc);
  app.use(qualRouter);
  // CMA 一单一库比对：自带 /api/cma-diff 路径前缀
  app.use(createCapLibRoutes(db, requireAuth, requireAdmin, requireTab));
  // 预览：requireAuth 在路由内部应用，挂在根上即可（端点路径里已带 /api/preview 前缀）。
  app.use(createPreviewRoutes(db, requireAuth, requireAdmin, sourceRegistry, downloadOrchestrator, pdfPreviewService));
  // labr：独立 sidebar，与 SourceRegistry 解耦；路径自带 /api/labr 前缀。
  // service 显式持有当前 app 的 db，避免测试/嵌入 app 回落到生产单例数据库。
  const labrService = new LabrService(db);
  app.use(createLabrRoutes(requireAuth, requireAdmin, requireTab, labrService));
  // 标准查新：路径自带 /api/check 前缀
  app.use(createCheckRoutes(db, sourceRegistry, requireAuth, requireAdmin, baseDir, requireTab));
  // 国家 CMA 无限期暂停：保留历史数据只读路由，生产装配使用 unavailable provider。
  const natCmaSvc = new NatCmaService(db, new NationalCmaProviderUnavailable());
  app.use(createNatCmaRoutes(natCmaSvc, requireAuth, requireAdmin, requireTab));

  app.use(createDiagnosticsRoutes(requireAdmin, sourceRegistry, appVersion));
  const backgroundRuntime = startAppBackgroundRuntime({
    db,
    sourceRegistry,
    qualificationService: qualSvc,
    previewService: pdfPreviewService,
    enabled: startBackgroundJobs,
  });
  const autoSync = backgroundRuntime.autoSync;
  app.locals.qualificationService = qualSvc;
  app.locals.autoSyncScheduler = autoSync;
  app.use(createAutoSyncRoutes(db, requireAuth, requireAdmin, autoSync, { allowScheduling: startBackgroundJobs }));
  app.use(createStandardsRoutes({ db, sourceRegistry, exportTaskStore, exportTaskService, downloadOrchestrator, requireAuth, requireAdmin, baseDir }));

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    // Multer errors
    const multerCodes = new Set(['LIMIT_FILE_SIZE', 'LIMIT_UNEXPECTED_FILE', 'LIMIT_FILE_COUNT', 'LIMIT_FIELD_KEY', 'LIMIT_FIELD_VALUE', 'LIMIT_FIELD_COUNT', 'LIMIT_PART_COUNT']);
    if (multerCodes.has((error as any)?.code)) {
      const msg = (error as any)?.code === 'LIMIT_FILE_SIZE' ? '文件大小不能超过 100MB' : (error as any).message || '上传错误';
      respondError(res, 400, 'BAD_REQUEST', msg);
      return;
    }
    // AppError instances
    if (error instanceof AppError) {
      respondError(res, error.statusCode, error.code, error.message, error.details);
      return;
    }

    const errorId = `ERR-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    console.error(`[server-error] ${errorId}`, error);
    respondError(res, 500, 'INTERNAL_SERVER_ERROR', `服务器内部错误，请查看运行日志：${errorId}`);
  });

  async function shutdown(): Promise<void> {
    // 1) 停止调度、timer、watcher，并等待预览启动阶段结束
    await backgroundRuntime.stop();
    // 2) 关闭资质 scraper (Playwright)
    await qualRouter.qualificationService.close().catch(() => {});
    // 3) 取消并等待统一下载编排器中的活跃任务，避免关闭 DB 后继续入库
    await downloadOrchestrator.close().catch(() => {});
    // 4) 取消并等待预览图片转换，避免关闭 DB 后仍回写 manifest
    await pdfPreviewService.close().catch(() => {});
    // 5) 关闭 PDF worker pool（BZ 原始 PDF 合成仍需要）
    try {
      const { closePdfMergePool } = await import('../shared/pdf-merge.js');
      await closePdfMergePool();
    } catch { /* pool may not have been initialized */ }
    // 6) 最后关闭数据库
    try { db.close(); } catch { /* may already be closed under test reset */ }
  }

  return Object.assign(app, { shutdown });
}

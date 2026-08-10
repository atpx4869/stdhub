import express, { type NextFunction, type Request, type Response } from 'express';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { unlink } from 'node:fs/promises';

import { ExportTaskStore } from '../services/export-task-store';
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
import { CheckService } from '../services/check-service';
import { createPreviewRoutes } from './preview-routes';
import { createLabrRoutes } from './labr-routes';
import { scanLibrary, startLibraryWatcher, stopLibraryWatcher, parseLibraryFilename } from '../services/library-index';
import { AutoSyncScheduler } from '../services/auto-sync-scheduler';
import { createAutoSyncRoutes } from './auto-sync-routes';
import { QualificationService } from '../services/qualification-service';
import { CapLibService } from '../services/cap-lib-service';
import { getSetting } from '../services/db';
import { AppError } from '../shared/errors';
import { respond, respondError } from '../shared/response';
import { getOcrStatus } from '../sources/shared/captcha-ocr';
import { getRecentLogs } from '../shared/log-buffer';
import { getEnvironmentReport, runEnvironmentCheck } from '../services/environment-check';
import { getHostStats } from '../shared/http';
import { getSourceSemaphoreStats } from '../shared/source-semaphore';
import { createProxyTokenGuard, getProxyTokenStatus } from './proxy-token-guard';
import { createNatCmaRoutes } from './nat-cma-routes';
import { ensureExportIndexFresh, removeExportIndex } from '../services/export-file-index';
import { NatCmaService, NationalCmaProviderUnavailable } from '../services/nat-cma-service';
import { LabrService } from '../sources/labr/labr-service';
import { resolveLibraryDir, resolveSafeLibraryFile } from '../shared/library-paths';

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
}

export function createApp(options: CreateAppOptions = {}) {
  const app = express();
  const sourceRegistry = new SourceRegistry();
  const exportTaskStore = new ExportTaskStore();
  const db = options.dbPath ? getDb(options.dbPath) : getDb();
  const downloadOrchestrator = new StandardDownloadOrchestrator(db, sourceRegistry);
  if (process.env.NODE_ENV === 'test' || process.env.VITEST) app.locals.db = db;
  const { requireAuth, requireAdmin, requireTab } = createAuthMiddleware(db);

  // 读取 package.json 版本号（启动时一次性读取）
  let appVersion = '';
  try {
    const pkgPath = path.join(options.baseDir ?? process.cwd(), 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    appVersion = pkg.version || '';
  } catch {
    // 读取失败，尝试环境变量
    appVersion = process.env.npm_package_version || process.env.BZXZ_APP_VERSION || '';
  }

  const baseDir = path.resolve(options.baseDir ?? process.cwd());
  // 显式 dbPath 通常用于测试/嵌入 app，默认不启动后台任务；生产无 dbPath 时保持开启。
  // 如果确实需要自定义 DB + 后台任务，调用方必须显式传 startBackgroundJobs:true，
  // 并承担 A2 完整 shutdown 的资源生命周期约束。
  const startBackgroundJobs = options.startBackgroundJobs ?? !options.dbPath;

  // 信任反代（nginx/caddy），让 req.ip / X-Forwarded-Proto 正确反映客户端信息
  app.set('trust proxy', true);

  // 可选：由 Lucky 等反代注入私密 Header，阻止直接暴露容器端口后的未授权访问。
  app.use(createProxyTokenGuard());
  app.use(express.json({ limit: '1mb' }));

  // 认证已禁用 — 给每个请求注入默认管理员用户
  app.use((_req, _res, next) => {
    _req.user = { id: 1, username: 'admin', display_name: '管理员', role: 'admin', allowed_tabs: null };
    next();
  });

  app.use(express.static(path.join(baseDir, 'public')));

  // Legacy route aliases: rewrite old paths to new canonical paths in-place so the actual
  // route handlers below only know about the new layout. Removed in a future major.
  app.use(legacyRouteAlias);

  // Serve index.html at root
  app.get('/', (_req, res) => {
    const indexPath = path.join(baseDir, 'public', 'index.html');
    if (existsSync(indexPath)) {
      res.sendFile(indexPath);
    } else {
      res.redirect('/index.html');
    }
  });

  // Reject any filename that contains path separators, traversal sequences, or
  // disallowed characters. Always run on the decoded basename so URL-encoded
  // separators (`%2F`, `..%2F`) can't sneak through.
  const FILENAME_ALLOWED = /^[a-zA-Z0-9一-鿿._\-\s()]+$/;
  function safeExportName(raw: string): string | null {
    let decoded: string;
    try { decoded = decodeURIComponent(raw); } catch { return null; }
    const base = path.basename(decoded);
    if (!base || base === '.' || base === '..') return null;
    if (!FILENAME_ALLOWED.test(base)) return null;
    return base;
  }

  function parseBoundedInt(value: unknown, fallback: number, min: number, max: number): number {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(n)));
  }

  function escapeLike(value: string): string {
    return value.replace(/[\\%_]/g, (m) => '\\' + m);
  }

  /**
   * 文件下载兜底（Phase 2 改造）：
   * 1. 先看 exports/（xlsx 报表、旧 PDF 残留）
   * 2. 再按 basename 查 standard_files 索引（PDF 标准入库后只在 library/ 里）
   *
   * 这样旧前端代码 `triggerDownload(fileName)` → `/api/downloads/${fileName}`
   * 仍然能解析，迁移期前后端不必同步改。
   */
  app.get('/api/downloads/:filename', requireAuth, async (req, res, next) => {
    try {
    const filename = safeExportName(String(req.params.filename));
    if (!filename) {
      respondError(res, 400, 'BAD_REQUEST', 'Invalid filename');
      return;
    }
    const exportsDir = path.resolve(baseDir, 'data', 'exports');
    const exportsPath = path.resolve(exportsDir, filename);
    if (exportsPath.startsWith(exportsDir + path.sep) && existsSync(exportsPath)) {
      if (req.query.inline === '1') res.sendFile(exportsPath);
      else res.download(exportsPath);
      return;
    }
    const match = db.prepare(
      `SELECT id, abs_path FROM standard_files WHERE file_name = ? ORDER BY indexed_at DESC LIMIT 1`
    ).get(filename) as { id: number; abs_path: string } | undefined;
    if (match) {
      const libStatus = await resolveLibraryDir(db);
      const safeFile = await resolveSafeLibraryFile(match.abs_path, libStatus.dir).catch(() => null);
      if (!safeFile) {
        db.prepare('DELETE FROM standard_files WHERE id = ?').run(match.id);
        respondError(res, 410, 'GONE', '文件已不在当前库目录');
        return;
      }
      if (req.query.inline === '1') res.sendFile(safeFile.realPath);
      else res.download(safeFile.realPath);
      return;
    }
    respondError(res, 404, 'NOT_FOUND', 'File not found');
    } catch (error) {
      next(error);
    }
  });

  /**
   * 下载列表（Phase 2 改造）：union exports/ 里的 xlsx 报表 + library 里的 PDF 标准。
   * PDF 标准走 fileId 作为 downloadUrl —— 命中预览端点既能内联看，也能 attachment=1 另存。
   * xlsx 报表 originatingExports，仍走 /api/downloads/:filename。
   */
  app.get('/api/downloads', requireAuth, async (req, res, next) => {
    try {
      const q = String(req.query.q || '').trim();
      const kind = String(req.query.kind || 'all').trim();
      const libraryOnly = kind === 'library';
      const seriesGrouped = libraryOnly && String(req.query.group || '') === 'series';
      const limit = parseBoundedInt(req.query.limit, 200, 1, 500);
      const offset = parseBoundedInt(req.query.offset, 0, 0, 100_000_000);
      const localLimit = libraryOnly ? limit : Math.min(1000, limit + offset);
      const localOffset = libraryOnly ? offset : 0;
      const like = `%${escapeLike(q)}%`;
      const exportsDir = path.resolve(baseDir, 'data', 'exports');
      let exportItems: any[] = [];
      let exportTotal = 0;
      if (!libraryOnly) {
        await ensureExportIndexFresh(db, exportsDir);
        const exportWhereSql = q
          ? `WHERE file_name LIKE ? ESCAPE '\\'
              OR standard_number LIKE ? ESCAPE '\\'
              OR source LIKE ? ESCAPE '\\'`
          : '';
        const exportWhereArgs = q ? [like, like, like] : [];
        exportTotal = (db.prepare(
          `SELECT COUNT(*) AS total FROM export_files ${exportWhereSql}`
        ).get(...exportWhereArgs) as { total: number }).total;
        exportItems = (db.prepare(
          `SELECT file_name, size, mtime, standard_number, source, abs_path
           FROM export_files ${exportWhereSql}
           ORDER BY mtime DESC
           LIMIT ? OFFSET ?`
        ).all(...exportWhereArgs, localLimit, localOffset) as Array<{
          file_name: string; size: number; mtime: number; standard_number: string; source: string; abs_path: string;
        }>).map((row) => ({
          fileName: row.file_name,
          size: row.size,
          mtime: new Date(row.mtime).toISOString(),
          standardNumber: row.standard_number,
          source: row.source,
          path: row.abs_path,
          downloadUrl: `/api/downloads/${encodeURIComponent(row.file_name)}`,
          kind: 'export' as const,
        }));
      }
      // Library PDF 索引
      const whereSql = q
        ? `WHERE file_name LIKE ? ESCAPE '\\'
            OR std_code_norm LIKE ? ESCAPE '\\'
            OR source LIKE ? ESCAPE '\\'`
        : '';
      const whereArgs = q ? [like, like, like] : [];
      type LibraryRow = {
        id: number; std_code_norm: string; year: string; source: string;
        abs_path: string; file_name: string; size: number; mtime: number; indexed_at: string;
      };
      let libraryTotal: number;
      let libraryRows: LibraryRow[];
      if (seriesGrouped) {
        libraryTotal = (db.prepare(
          `SELECT COUNT(*) AS total FROM (
             SELECT std_code_norm FROM standard_files ${whereSql} GROUP BY std_code_norm
           )`
        ).get(...whereArgs) as { total: number }).total;
        const seriesRows = db.prepare(
          `SELECT std_code_norm, MAX(indexed_at) AS latest_indexed_at
           FROM standard_files ${whereSql}
           GROUP BY std_code_norm
           ORDER BY latest_indexed_at DESC
           LIMIT ? OFFSET ?`
        ).all(...whereArgs, localLimit, localOffset) as Array<{ std_code_norm: string; latest_indexed_at: string }>;
        const seriesCodes = seriesRows.map(row => row.std_code_norm);
        if (!seriesCodes.length) {
          libraryRows = [];
        } else {
          const placeholders = seriesCodes.map(() => '?').join(', ');
          const rows = db.prepare(
            `SELECT id, std_code_norm, year, source, abs_path, file_name, size, mtime, indexed_at
             FROM standard_files
             WHERE std_code_norm IN (${placeholders})
             ORDER BY CAST(year AS INTEGER) DESC, indexed_at DESC`
          ).all(...seriesCodes) as LibraryRow[];
          const seriesOrder = new Map(seriesCodes.map((code, index) => [code, index]));
          libraryRows = rows.sort((left, right) =>
            (seriesOrder.get(left.std_code_norm) ?? 0) - (seriesOrder.get(right.std_code_norm) ?? 0));
        }
      } else {
        libraryTotal = (db.prepare(
          `SELECT COUNT(*) AS total FROM standard_files ${whereSql}`
        ).get(...whereArgs) as { total: number }).total;
        libraryRows = db.prepare(
          `SELECT id, std_code_norm, year, source, abs_path, file_name, size, mtime, indexed_at
           FROM standard_files ${whereSql}
           ORDER BY indexed_at DESC
           LIMIT ? OFFSET ?`
        ).all(...whereArgs, localLimit, localOffset) as LibraryRow[];
      }
      const libraryItems = libraryRows.map(r => {
        const fileName = r.file_name || path.basename(r.abs_path);
        // 反解 fileName 拿真正的 stdCode 形态（带 /T、大小写正确）和 title。
        // std_code_norm 经过 extractBaseCode 剥前缀大写化、不适合直接展示给用户。
        // 兜底：parse 失败（用户手放进库的不规范命名）退回归一化拼装。
        const parsed = parseLibraryFilename(fileName);
        const standardNumber = parsed
          ? (parsed.stdCodeRaw || (r.std_code_norm + (r.year ? `-${r.year}` : '')))
          : (r.std_code_norm + (r.year ? `-${r.year}` : ''));
        const title = parsed?.title || '';
        return {
          fileName,
          size: r.size,
          mtime: new Date(r.mtime).toISOString(),
          standardNumber,
          title,
          source: r.source,
          path: r.abs_path,
          // 预览端点既支持 inline（默认）也支持 attachment=1，前端按需拼参数
          downloadUrl: `/api/preview/file/${r.id}?attachment=1`,
          previewUrl: `/api/preview/file/${r.id}`,
          kind: 'library' as const,
          fileId: r.id,
        };
      });
      const items = seriesGrouped
        ? libraryItems
        : [...libraryItems, ...exportItems]
            .sort((a, b) => String(b.mtime).localeCompare(String(a.mtime)))
            .slice(libraryOnly ? 0 : offset, libraryOnly ? undefined : offset + limit);
      respond(res, {
        items,
        total: libraryTotal + exportTotal,
        libraryTotal,
        exportTotal,
        limit,
        offset,
        grouped: seriesGrouped,
      });
    } catch (error) {
      next(error);
    }
  });

  app.delete('/api/downloads/:filename', requireAuth, async (req, res, next) => {
    try {
      const filename = safeExportName(String(req.params.filename));
      if (!filename) {
        respondError(res, 400, 'BAD_REQUEST', 'Invalid filename');
        return;
      }
      const exportsDir = path.resolve(baseDir, 'data', 'exports');
      const filePath = path.resolve(exportsDir, filename);
      if (!filePath.startsWith(exportsDir + path.sep)) {
        respondError(res, 400, 'BAD_REQUEST', 'Invalid filename');
        return;
      }
      await unlink(filePath);
      removeExportIndex(db, filename);
      respond(res, { ok: true });
    } catch (error) {
      next(error);
    }
  });

  // Auth routes (no auth required)
  app.use('/api/auth', createAuthRoutes(db, requireAuth));
  app.use('/api/admin', requireAdmin, createAdminRoutes(db));
  const announcementRoutes = createAnnouncementRoutes(db, requireAuth, requireAdmin);
  app.use('/api/announcements', announcementRoutes.userRouter);
  app.use('/api/admin/announcements', announcementRoutes.adminRouter);
  app.use('/api/stats', createStatsRoutes(db, requireAuth, requireTab));
  // 路由与自动调度必须共享同一 QualificationService，保证同机构 single-flight
  // 能跨手动 API 和 scheduler 生效。
  const qualSvc = new QualificationService(db);
  const qualRouter = createQualificationRoutes(db, requireAuth, requireTab, qualSvc);
  app.use(qualRouter);
  // CMA 一单一库比对：自带 /api/cma-diff 路径前缀
  app.use(createCapLibRoutes(db, requireAuth, requireAdmin, requireTab));
  // 预览：requireAuth 在路由内部应用，挂在根上即可（端点路径里已带 /api/preview 前缀）。
  app.use(createPreviewRoutes(db, requireAuth, sourceRegistry, downloadOrchestrator));
  // labr：独立 sidebar，与 SourceRegistry 解耦；路径自带 /api/labr 前缀。
  // service 显式持有当前 app 的 db，避免测试/嵌入 app 回落到生产单例数据库。
  const labrService = new LabrService(db);
  app.use(createLabrRoutes(requireAuth, requireTab, labrService));
  // 标准查新：路径自带 /api/check 前缀
  app.use(createCheckRoutes(db, sourceRegistry, requireAuth, baseDir, requireTab));
  // 国家 CMA 无限期暂停：保留历史数据只读路由，生产装配使用 unavailable provider。
  const natCmaSvc = new NatCmaService(db, new NationalCmaProviderUnavailable());
  app.use(createNatCmaRoutes(natCmaSvc, requireAuth, requireTab));

  app.get('/api/health', (_req, res) => {
    respond(res, {
      ok: true,
      version: appVersion,
      sources: sourceRegistry.list(),
      features: { natCma: { state: 'suspended', readOnly: true } },
    });
  });

  app.get('/api/security/status', requireAuth, (_req, res) => {
    respond(res, { ...getProxyTokenStatus(), authMode: 'open_admin' });
  });

  // ─── Diagnostics ──────────────────────────────────────────────────────────
  // Surface OCR engine health and recent server logs so the user can debug
  // slow downloads without opening the Electron dev console.
  app.get('/api/diagnostics/ocr', requireAuth, (_req, res) => {
    const status = getOcrStatus();
    const avg = (n: { count: number; totalMs: number }) => (n.count === 0 ? 0 : Math.round(n.totalMs / n.count));
    respond(res, {
      ...status,
      solves: {
        ddddocr: { ...status.solves.ddddocr, avgMs: avg(status.solves.ddddocr) },
        tesseract: { ...status.solves.tesseract, avgMs: avg(status.solves.tesseract) },
      },
    });
  });
  // Admin-only — recent server logs can include upstream URLs / cookies /
  // hcno values that ordinary users have no need to see.
  app.get('/api/diagnostics/logs', requireAdmin, (req, res) => {
    const limit = Math.max(1, Math.min(Number.parseInt(String(req.query.limit ?? ''), 10) || 200, 500));
    respond(res, { items: getRecentLogs(limit) });
  });
  app.get('/api/diagnostics/environment', requireAuth, (_req, res) => {
    respond(res, getEnvironmentReport());
  });
  app.post('/api/diagnostics/environment/recheck', requireAuth, async (_req, res, next) => {
    try {
      await runEnvironmentCheck();
      respond(res, getEnvironmentReport());
    } catch (e) { next(e); }
  });
  app.get('/api/diagnostics/hosts', requireAuth, (_req, res) => {
    respond(res, { hosts: getHostStats() });
  });
  // 源级并发信号量诊断：admin 看到 active / limit / waiting 三个数；
  // waiting > 0 长期不归零 ⇒ 源端瓶颈（考虑升 limit 或检查源是否变慢）
  app.get('/api/diagnostics/sources', requireAuth, (_req, res) => {
    respond(res, { sources: getSourceSemaphoreStats() });
  });

  const checkTimers: Array<ReturnType<typeof setTimeout>> = [];
  let watcherStarted = false;

  if (startBackgroundJobs) {
    // Kick off the self-check at server boot. Fire-and-forget — the check runs
    // in parallel with normal request handling, results land in /api/diagnostics
    // /environment when ready.
    void runEnvironmentCheck();

    // 启动时增量扫描标准库一次：把磁盘新增 / 修改 / 删除的 PDF 同步进索引。
    // fire-and-forget：库目录探针 + readdir 在挂大网盘时可能阻塞，必须脱离启动主路径。
    scanLibrary(db, { full: false }).catch((e) => {
      console.error('[library] startup scan failed:', e);
    });

    // chokidar 监听：用户拖文件进库目录自动入索引。默认开（库 PDF 是主流入口），
    // 用户可在 admin 设置里关掉（OneDrive / SMB 抖动场景）。fire-and-forget：
    // start 内部解析库路径 + 建监听器，慢盘别拖启动主路径。
    if (getSetting(db, 'library_watcher_enabled', '1') === '1') {
      watcherStarted = true;
      startLibraryWatcher(db).catch((e) => {
        console.error('[library] startup watcher failed:', e);
      });
    }

    // 标准查新：自动查新调度。启动补跑一次到期的，之后每 6 小时扫一次（周期是天级，
    // 6h 粒度足够；定时器在进程存活时才跑，应用关着错过的靠启动补跑兜底）。
    // 有变动的清单写一条运行日志（console 被 log-buffer 截获 → 运行日志页可见）。
    const checkSvc = new CheckService(db, sourceRegistry);
    const runAuto = () => {
      checkSvc.runDueAutoChecks()
        .then((changed) => {
          for (const c of changed) console.warn(`[check-auto] 清单「${c.name}」检出 ${c.changedCount} 项标准变动`);
        })
        .catch((e) => console.error('[check-auto] 自动查新调度失败:', e instanceof Error ? e.message : String(e)));
    };
    checkTimers.push(setTimeout(runAuto, 30_000));            // 启动 30s 后补跑
    checkTimers.push(setInterval(runAuto, 6 * 60 * 60 * 1000)); // 每 6 小时扫一次
  }

  // 自动同步路由始终注册；测试/嵌入模式只是不启动 cron timers。
  const capLibSvc = new CapLibService(db);
  const autoSync = new AutoSyncScheduler(db, qualSvc, capLibSvc);
  // Test-only observability for verifying service ownership without exporting internals.
  app.locals.qualificationService = qualSvc;
  app.locals.autoSyncScheduler = autoSync;
  if (startBackgroundJobs) autoSync.start();
  app.use(createAutoSyncRoutes(db, requireAuth, requireAdmin, autoSync, {
    allowScheduling: startBackgroundJobs,
  }));

  app.use(createStandardsRoutes({ db, sourceRegistry, exportTaskStore, downloadOrchestrator, requireAuth, baseDir }));

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    // Multer errors
    const multerCodes = new Set(['LIMIT_FILE_SIZE', 'LIMIT_UNEXPECTED_FILE', 'LIMIT_FILE_COUNT', 'LIMIT_FIELD_KEY', 'LIMIT_FIELD_VALUE', 'LIMIT_FIELD_COUNT', 'LIMIT_PART_COUNT']);
    if (multerCodes.has((error as any)?.code)) {
      const msg = (error as any)?.code === 'LIMIT_FILE_SIZE' ? '文件大小不能超过 10MB' : (error as any).message || '上传错误';
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
    // 1) 停止定时调度
    autoSync.stop();
    // 2) 清理查新 timer
    for (const t of checkTimers) { clearTimeout(t); clearInterval(t); }
    checkTimers.length = 0;
    // 3) 关闭文件库 watcher（如果已启动）
    if (watcherStarted) await stopLibraryWatcher().catch(() => {});
    // 4) 关闭资质 scraper (Playwright)
    await qualRouter.qualificationService.close().catch(() => {});
    // 5) 取消并等待统一下载编排器中的活跃任务，避免关闭 DB 后继续入库
    await downloadOrchestrator.close().catch(() => {});
    // 6) 关闭 PDF worker pool
    try {
      const { closePdfMergePool } = await import('../shared/pdf-merge.js');
      await closePdfMergePool();
    } catch { /* pool may not have been initialized */ }
    // 7) 最后关闭数据库
    try { db.close(); } catch { /* may already be closed under test reset */ }
  }

  return Object.assign(app, { shutdown });
}

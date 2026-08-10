import { randomUUID } from 'node:crypto';
import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import type Database from 'better-sqlite3';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import multer from 'multer';

import { StandardService } from '../services/standard-service';
import { StandardResolver } from '../services/standard-resolver';
import { ExportTaskService, cancelExportTask } from '../services/export-task-service';
import type { ExportTaskStore } from '../services/export-task-store';
import type { SourceRegistry } from '../services/source-registry';
import { trackEvent, extractUsageCtx } from '../services/usage-tracker';
import { BadRequestError, NotFoundError, normalizeError } from '../shared/errors';
import { parseStandardId, VALID_SOURCES } from '../shared/id';
import type { SourceName } from '../domain/standard';
import { respond } from '../shared/response';
import { toCamelCase } from '../shared/case';
import { moveDownloadToLibrary } from '../services/download-to-library';
import { deriveStandardKind, deriveStandardNature, mapTemplateStatus } from '../shared/std-code';
import type { StandardDownloadOrchestrator } from '../services/standard-download-orchestrator';
import { highCostInFlightGuard, highCostRateLimit } from '../shared/high-cost-guard';

const SOURCES = [...VALID_SOURCES] as SourceName[];
const sourceEnum = z.enum(SOURCES as [string, ...string[]]);

function normalizeStandardNumber(value: string) {
  return value.replace(/[^A-Z0-9]/gi, '').toUpperCase();
}

function previewHasText(preview: Awaited<ReturnType<StandardService['detectPreview']>>) {
  return Boolean(
    preview.downloadUrl ||
    (preview.totalPages && preview.totalPages > 0) ||
    preview.pageUrls.length > 0 ||
    preview.meta?.hasPdf === true,
  );
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

const MAX_XLSX_COL_INDEX = 16383; // XLSX column limit (XFD = 16384, 0-indexed)

const completeBodySchema = z.object({
  sources: z.array(sourceEnum).min(1).optional(),
  inputColumn: z.string().trim().min(1).max(5).optional(),
  outputColumn: z.string().trim().min(1).max(5).optional(),
  preserveStyle: z.boolean().optional(),
  includeSource: z.boolean().optional(),
  includeStatus: z.boolean().optional(),
  includeDownloadLink: z.boolean().optional(),
  includeTextFlag: z.boolean().optional(),
  /** 模板模式：识别「标准代号/中文标准名称/…/资质备注」固定模板，原位回填可补列并保留下拉验证。 */
  templateMode: z.boolean().optional(),
});

function parseMultipartJsonArray(raw: unknown, fieldName: string): unknown {
  if (raw == null || raw === '') return undefined;
  if (Array.isArray(raw)) return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    throw new BadRequestError(`${fieldName} 不是有效 JSON`);
  }
}

function parseCompleteBody(body: Record<string, unknown>) {
  return completeBodySchema.parse({
    sources: parseMultipartJsonArray(body.sources, 'sources'),
    inputColumn: body.inputColumn,
    outputColumn: body.outputColumn,
    preserveStyle: body.preserveStyle === 'true',
    includeSource: body.includeSource !== 'false',
    includeStatus: body.includeStatus !== 'false',
    includeDownloadLink: body.includeDownloadLink === 'true',
    includeTextFlag: body.includeTextFlag === 'true',
    templateMode: body.templateMode === 'true',
  });
}

function colToIndex(value: string | undefined, fallback: number): number {
  const s = (value || '').trim().toUpperCase();
  if (!s) return fallback;
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    if (!Number.isFinite(n) || n < 1 || n > MAX_XLSX_COL_INDEX + 1) {
      throw new BadRequestError(`列号超出范围: ${value}`);
    }
    return n - 1;
  }
  if (!/^[A-Z]{1,3}$/.test(s)) {
    throw new BadRequestError(`无效的列名: ${value}`);
  }
  let index = 0;
  for (const ch of s) index = index * 26 + (ch.charCodeAt(0) - 64);
  const result = index - 1;
  if (result < 0 || result > MAX_XLSX_COL_INDEX) {
    throw new BadRequestError(`列号超出范围: ${value}`);
  }
  return result;
}

function indexToCol(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function looksLikeStandardNumber(value: string): boolean {
  return /^[A-Z]{2,4}\d{0,2}(?:\/[TZQ])?\s*\d+(?:\.\d+)*(?:\s*[–\-—]\s*\d{0,4})?$/i.test(value.trim());
}

function completeKey(value: string): string {
  return normalizeStandardNumber(value);
}

function extractCompleteRows(rows: string[][], inputCol: number) {
  const firstVal = String(rows[0]?.[inputCol] ?? '').trim();
  const skippedHeader = Boolean(firstVal && !looksLikeStandardNumber(firstVal));
  const startRow = skippedHeader ? 1 : 0;
  const entries: Array<{ rowIndex: number; value: string }> = [];
  for (let i = startRow; i < rows.length; i++) {
    const value = String(rows[i]?.[inputCol] ?? '').trim();
    if (value) entries.push({ rowIndex: i, value });
  }
  const seen = new Set<string>();
  let duplicateCount = 0;
  for (const entry of entries) {
    const key = completeKey(entry.value);
    if (seen.has(key)) duplicateCount++;
    else seen.add(key);
  }
  return {
    entries,
    lines: entries.map(entry => entry.value),
    startRow,
    skippedHeader,
    duplicateCount,
    uniqueCount: seen.size,
    previewRows: entries.slice(0, 8).map(entry => ({ rowNumber: entry.rowIndex + 1, value: entry.value })),
  };
}

// ── 模板补全（templateMode）：固定模板「标准代号/中文标准名称/…/资质备注」的识别与回填 ──

/** 模板表头列（顺序同用户模板 Sheet1）。 */
const COMPLETE_TEMPLATE_COLUMNS = [
  '标准代号', '中文标准名称', '标准状态', '标准种类', '标准性质', '发布日期',
  '发布单位', '实施或试行日期', '标准分类', '说明', '资质备注',
];

/** 模板模式可回填的列名（数据源能提供的）。 */
const COMPLETE_TEMPLATE_FILLABLE = [
  '中文标准名称', '标准状态', '标准性质', '发布日期', '实施或试行日期', '标准分类',
];

interface CompleteTemplateInfo {
  detected: boolean;
  /** 表头列名 → 0-based 列索引。 */
  columnMap: Record<string, number>;
}

function detectCompleteTemplate(rows: string[][]): CompleteTemplateInfo {
  const header = (rows[0] ?? []).map(c => String(c ?? '').replace(/\s+/g, ''));
  const columnMap: Record<string, number> = {};
  let matched = 0;
  header.forEach((cell, index) => {
    const key = COMPLETE_TEMPLATE_COLUMNS.find(c => c.replace(/\s+/g, '') === cell);
    if (key && !(key in columnMap)) {
      columnMap[key] = index;
      matched++;
    }
  });
  return { detected: matched >= 3, columnMap };
}

/** BZ 的 '2017-10-14' → 模板期望的文本格式 '2017/10/14'（模板说明：日期文本，2019/09/09）。 */
function formatTemplateDate(value: string | null | undefined): string {
  if (!value) return '';
  const m = String(value).match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (!m) return String(value);
  return `${m[1]}/${m[2]}/${m[3]}`;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.xlsx', '.xls', '.csv'].includes(ext)) {
      cb(null, true);
    } else {
      cb(new BadRequestError('仅支持 .xlsx / .xls / .csv 格式'));
    }
  },
});

interface StandardsRoutesDeps {
  db: Database.Database;
  sourceRegistry: SourceRegistry;
  exportTaskStore: ExportTaskStore;
  downloadOrchestrator: StandardDownloadOrchestrator;
  requireAuth: RequestHandler;
  baseDir: string;
}

// moveDownloadToLibrary 移到 services/download-to-library.ts，preview-routes 也要用

export function createStandardsRoutes({ db, sourceRegistry, exportTaskStore, downloadOrchestrator, requireAuth, baseDir }: StandardsRoutesDeps) {
  const router = Router();
  // Source detection: test each source with a quick search
  router.get('/api/standards/check-sources', requireAuth, async (req, res) => {
    const sources = (req.query.sources as string || '').split(',').filter(Boolean) as SourceName[];
    const targets = sources.length ? sources : sourceRegistry.list();
    const results: Record<string, { status: string; ms: number; error?: string }> = {};
    await Promise.all(targets.map(async (src) => {
      const start = Date.now();
      try {
        const adapter = sourceRegistry.get(src);
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(new Error('source detection timeout')), 5000);
        try {
          await adapter.searchStandards({ query: 'GB/T 1.1', signal: ctrl.signal, timeoutMs: 5000 });
        } finally {
          clearTimeout(timer);
        }
        results[src] = { status: 'ok', ms: Date.now() - start };
      } catch (e: any) {
        results[src] = { status: 'error', ms: Date.now() - start, error: e.name === 'AbortError' || e.message === 'source detection timeout' ? '超时' : (e.message || '连接失败') };
      }
    }));
    respond(res, { results });
  });

  // Search cache: key = "source:query", value = { items, expires }
  // Map iteration is insertion-ordered, so we use it as a simple LRU: on hit we re-insert
  // to bump recency, and on overflow we drop the oldest entry.
  const searchCache = new Map<string, { items: any[]; expires: number }>();
  const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
  const CACHE_MAX_ENTRIES = 200;

  router.get('/api/standards/search', requireAuth, async (req, res, next) => {
    try {
      const querySchema = z.object({
        q: z.string().trim().min(1, 'q is required').max(500),
        source: sourceEnum.optional(),
      });

      const { q, source } = querySchema.parse(req.query);
      const selectedSource = (source ?? 'bz') as SourceName;
      const cacheKey = `${selectedSource}:${q}`;

      // Check cache
      const cached = searchCache.get(cacheKey);
      if (cached && cached.expires > Date.now()) {
        searchCache.delete(cacheKey);
        searchCache.set(cacheKey, cached); // bump to most-recent position
        trackEvent(db, req.user!.id, 'search', selectedSource, undefined, { query: q, resultCount: cached.items.length, cached: true }, { ...extractUsageCtx(req), result: 'success' });
        respond(res, { items: cached.items, total: cached.items.length, sourceSummary: { requested: 1, succeeded: 1, failed: 0, source: selectedSource } });
        return;
      }
      if (cached) searchCache.delete(cacheKey); // expired

      const service = new StandardService(sourceRegistry.get(selectedSource));
      const results = await service.searchStandards({ query: q });
      // Store in cache; evict oldest entry if at capacity
      if (searchCache.size >= CACHE_MAX_ENTRIES) {
        const oldestKey = searchCache.keys().next().value;
        if (oldestKey !== undefined) searchCache.delete(oldestKey);
      }
      searchCache.set(cacheKey, { items: results, expires: Date.now() + CACHE_TTL_MS });
      trackEvent(db, req.user!.id, 'search', selectedSource, undefined, { query: q, resultCount: results.length }, { ...extractUsageCtx(req), result: 'success' });

      respond(res, {
        items: results,
        total: results.length,
        sourceSummary: {
          requested: 1,
          succeeded: 1,
          failed: 0,
          source: selectedSource,
        },
      });
    } catch (error) {
      // 失败也进统计（以前 catch 分支不记，失败操作完全不可见）
      try {
        const err = error instanceof Error ? error.message : String(error);
        trackEvent(db, req.user!.id, 'search', undefined, undefined, { query: (req.query.q as string) || '' }, { ...extractUsageCtx(req), result: 'fail', error: err });
      } catch { /* 记录失败不影响主流程 */ }
      next(normalizeError(error));
    }
  });

  /** Poll endpoint: returns cached GBW text availability for given source IDs */
  router.get('/api/standards/text-availability', requireAuth, (req, res) => {
    const ids = ((req.query.ids as string) || '').split(',').filter(Boolean);
    if (!ids.length) { respond(res, {}); return; }
    respond(res, sourceRegistry.getGbwTextAvailability(ids));
  });

  router.post('/api/standards/resolve', requireAuth, async (req, res, next) => {
    try {
      const bodySchema = z.object({
        lines: z.array(z.string().trim()).min(1, 'lines is required').max(200),
        sources: z.array(sourceEnum).min(1).optional(),
      });

      const { lines, sources } = bodySchema.parse(req.body);
      const selectedSources = (sources ?? sourceRegistry.list()) as SourceName[];
      const resolver = new StandardResolver(sourceRegistry);
      const result = await resolver.resolve(lines, selectedSources, { collectSourceIds: true });
      trackEvent(db, req.user!.id, 'batch_resolve', selectedSources.join(','), undefined, {
        lineCount: lines.length, resolvedCount: result.resolved.length, unmatchedCount: result.unmatched.length,
      }, { ...extractUsageCtx(req), result: 'success' });
      respond(res, toCamelCase(result));
    } catch (error) {
      try {
        trackEvent(db, req.user!.id, 'batch_resolve', undefined, undefined, undefined, { ...extractUsageCtx(req), result: 'fail', error: error instanceof Error ? error.message : String(error) });
      } catch { /* ignore */ }
      next(normalizeError(error));
    }
  });

  router.post('/api/standards/source-check', requireAuth, async (req, res, next) => {
    try {
      const bodySchema = z.object({
        standardNumber: z.string().trim().min(1, 'standardNumber is required').max(120),
        title: z.string().trim().max(1000).optional(),
        sources: z.array(sourceEnum).min(1).optional(),
      });

      const { standardNumber, sources } = bodySchema.parse(req.body);
      const selectedSources = (sources ?? sourceRegistry.list()) as SourceName[];
      const wantedNumber = normalizeStandardNumber(standardNumber);
      const results: Record<string, {
        status: 'text' | 'no_text' | 'not_found' | 'error';
        id?: string;
        standardNumber?: string;
        title?: string;
        previewAvailable?: boolean;
        message?: string;
      }> = {};

      await Promise.all(selectedSources.map(async (src) => {
        try {
          const service = new StandardService(sourceRegistry.get(src));
          const searchResults = await withTimeout(
            service.searchStandards({ query: standardNumber }),
            12000,
            '检测超时',
          );
          const match = searchResults.find(item => normalizeStandardNumber(item.standardNumber) === wantedNumber);
          if (!match) {
            results[src] = { status: 'not_found' };
            return;
          }

          if (match.previewAvailable) {
            results[src] = {
              status: 'text',
              id: match.id,
              standardNumber: match.standardNumber,
              title: match.title,
              previewAvailable: true,
            };
            return;
          }

          const preview = await withTimeout(
            service.detectPreview(match.id),
            15000,
            '文本检测超时',
          );
          const hasText = previewHasText(preview);
          results[src] = {
            status: hasText ? 'text' : 'no_text',
            id: match.id,
            standardNumber: match.standardNumber,
            title: match.title,
            previewAvailable: hasText,
          };
        } catch (e: any) {
          results[src] = {
            status: 'error',
            message: e?.message || '检测失败',
          };
        }
      }));

      respond(res, { standardNumber, results });
    } catch (error) {
      next(normalizeError(error));
    }
  });

  router.get('/api/standards/:id', requireAuth, async (req, res, next) => {
    try {
      const id = req.params.id as string;
      const parsed = parseStandardId(id);
      const service = new StandardService(sourceRegistry.get(parsed.source));
      const detail = await service.getStandardDetail(id);
      respond(res, toCamelCase(detail));
    } catch (error) {
      next(normalizeError(error));
    }
  });

  router.post('/api/standards/:id/preview/detect', requireAuth, async (req, res, next) => {
    try {
      const id = req.params.id as string;
      const parsed = parseStandardId(id);
      const service = new StandardService(sourceRegistry.get(parsed.source));
      const preview = await service.detectPreview(id);
      respond(res, toCamelCase(preview));
    } catch (error) {
      next(normalizeError(error));
    }
  });

  router.post('/api/standards/:id/export', requireAuth, async (req, res, next) => {
    try {
      const id = req.params.id as string;
      const parsed = parseStandardId(id);
      const adapter = sourceRegistry.get(parsed.source);
      const exportTaskService = new ExportTaskService(adapter, exportTaskStore, db, sourceRegistry, parsed.source);
      const task = exportTaskService.createTask(id, req.user!.id);
      trackEvent(db, req.user!.id, 'download', parsed.source, id, undefined, { ...extractUsageCtx(req), result: 'success' });
      respond(res, toCamelCase(task), 202);
    } catch (error) {
      next(normalizeError(error));
    }
  });

  router.post('/api/standards/:id/download-session', requireAuth, highCostRateLimit, highCostInFlightGuard, async (req, res, next) => {
    try {
      const id = req.params.id as string;
      const parsed = parseStandardId(id);
      const adapter = sourceRegistry.get(parsed.source);
      if (!adapter.createDownloadSession) {
        throw new BadRequestError(`Source ${parsed.source} does not support download sessions`);
      }

      const session = await adapter.createDownloadSession(id, req.user!.id);
      respond(res, toCamelCase(session), 201);
    } catch (error) {
      next(normalizeError(error));
    }
  });

  router.post('/api/standards/:id/auto-download', requireAuth, highCostRateLimit, highCostInFlightGuard, async (req, res, next) => {
    try {
      const id = req.params.id as string;
      const parsed = parseStandardId(id);
      const adapter = sourceRegistry.get(parsed.source);
      if (!adapter.autoDownload) {
        throw new BadRequestError(`Source ${parsed.source} does not support auto-download`);
      }

      const result = await adapter.autoDownload(id, req.user!.id, 3);
      trackEvent(db, req.user!.id, 'download', parsed.source, id, undefined, { ...extractUsageCtx(req), result: 'success' });
      // 成功落盘 → 立刻 move 到 library；失败也不影响响应。
      // DownloadSessionInfo 的 filePath/fileName/fileSize 落在 meta 里（gbw 适配器的约定）。
      const meta = (result.meta || {}) as { filePath?: string; fileName?: string; fileSize?: number };
      const moved = meta.filePath
        ? await moveDownloadToLibrary(db, sourceRegistry, parsed.source, id, {
            filePath: meta.filePath, fileName: meta.fileName, fileSize: meta.fileSize,
          })
        : {};
      respond(res, toCamelCase({
        ...result,
        // 入库失败：把 status 降级 + 把原因冒到 libraryError 给前端用。文件其实还在
        // exports/ 里，/api/downloads/:filename 兜底路径仍能给用户拉。
        ...(moved.error ? { status: 'library_failed', libraryError: moved.error } : {}),
        ...(moved.fileName ? { fileName: moved.fileName, filePath: moved.absPath } : {}),
        ...(moved.libraryUrl ? { downloadUrl: moved.libraryUrl, fileId: moved.fileId } : {}),
      }));
    } catch (error) {
      next(normalizeError(error));
    }
  });

  // Multi-source download with auto-fallback
  router.post('/api/standards/multi-download', requireAuth, highCostRateLimit, highCostInFlightGuard, async (req, res, next) => {
    try {
      const bodySchema = z.object({
        sourceIds: z.record(z.string(), z.string()), // { gbw: 'gbw:xxx', bz: 'bz:yyy', ... }
        sources: z.array(sourceEnum).min(1).max(SOURCES.length).refine(items => new Set(items).size === items.length, { message: 'sources 不得重复' }),
      });
      const { sourceIds, sources } = bodySchema.parse(req.body);

      const errors: Record<string, string> = {};
      for (const src of sources) {
        const standardId = sourceIds[src];
        if (!standardId) { errors[src] = '未提供此源的ID'; continue; }

        try {
          const handle = downloadOrchestrator.download(src as SourceName, standardId, {
            id: `direct:${req.user!.id}:${randomUUID()}`,
            userId: req.user!.id,
            channel: 'direct',
          });
          const unsubscribe = () => { handle.unsubscribe(); };
          req.once('aborted', unsubscribe);
          res.once('close', unsubscribe);
          let result;
          try {
            result = await handle.promise;
          } finally {
            req.removeListener('aborted', unsubscribe);
            res.removeListener('close', unsubscribe);
          }
          trackEvent(db, req.user!.id, 'download', src, standardId, { reused: handle.reused }, { ...extractUsageCtx(req), result: 'success' });
          respond(res, toCamelCase({
            ...(result.session ? { ...result.session } : {}),
            source: src,
            status: result.status,
            fileName: result.fileName,
            filePath: result.filePath,
            fileSize: result.fileSize,
            ...(result.libraryError ? { libraryError: result.libraryError } : {}),
            ...(result.downloadUrl ? { downloadUrl: result.downloadUrl, fileId: result.fileId } : {}),
            reused: handle.reused,
          }));
          return;
        } catch (e: any) {
          if (req.aborted || res.destroyed || e?.name === 'AbortError' || /subscribers remain|cancel|aborted/i.test(e?.message || '')) {
            throw e;
          }
          errors[src] = e.message || '下载失败';
        }
      }

      // 全部源失败：记一条 fail，error 写各源失败原因汇总
      const errSummary = Object.entries(errors).map(([s, m]) => `${s}:${m}`).join('; ') || '所有源均下载失败';
      trackEvent(db, req.user!.id, 'download', sources.join(','), undefined, { perSource: errors }, { ...extractUsageCtx(req), result: 'fail', error: errSummary });
      throw new NotFoundError('所有源均下载失败', { perSource: errors });
    } catch (error) {
      next(normalizeError(error));
    }
  });

  router.post('/api/download-sessions/:sessionId/verify', requireAuth, highCostRateLimit, highCostInFlightGuard, async (req, res, next) => {
    try {
      const bodySchema = z.object({
        source: z.enum(['gbw']),
        code: z.string().trim().min(4).max(4),
      });
      const { source, code } = bodySchema.parse(req.body);
      const adapter = sourceRegistry.get(source);
      if (!adapter.submitDownloadCaptcha) {
        throw new BadRequestError(`Source ${source} does not support captcha verification`);
      }

      const result = await adapter.submitDownloadCaptcha(req.params.sessionId as string, code, req.user!.id);
      respond(res, toCamelCase(result));
    } catch (error) {
      next(normalizeError(error));
    }
  });

  router.get('/api/download-sessions/:sessionId', requireAuth, async (req, res, next) => {
    try {
      const source = (req.query.source as string | undefined) ?? 'gbw';
      if (source !== 'gbw') {
        throw new BadRequestError(`Unsupported download session source: ${source}`);
      }

      const adapter = sourceRegistry.get(source as 'gbw');
      if (!adapter.getDownloadSession) {
        throw new BadRequestError('Source gbw does not support download session lookup');
      }

      const session = await adapter.getDownloadSession(req.params.sessionId as string, req.user!.id);
      respond(res, toCamelCase(session));
    } catch (error) {
      next(normalizeError(error));
    }
  });

  router.post('/api/standards/complete/preview', requireAuth, upload.single('file'), async (req, res, next) => {
    try {
      if (!req.file) {
        throw new BadRequestError('请上传文件');
      }

      const parsedBody = parseCompleteBody(req.body);
      const inputCol = colToIndex(parsedBody.inputColumn, 0);
      const outputCol = colToIndex(parsedBody.outputColumn, 1);

      const XLSX = (await import('xlsx')).default;
      const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
      const sheetName = workbook.SheetNames[0];
      if (!sheetName) throw new BadRequestError('表格为空或格式无法识别');
      const sheet = workbook.Sheets[sheetName];
      const rows: string[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
      const extracted = extractCompleteRows(rows, inputCol);
      const template = detectCompleteTemplate(rows);

      respond(res, {
        fileName: req.file.originalname,
        sheetName,
        rowCount: rows.length,
        inputColumn: indexToCol(inputCol),
        outputColumn: indexToCol(outputCol),
        skippedHeader: extracted.skippedHeader,
        startRow: extracted.startRow + 1,
        total: extracted.lines.length,
        unique: extracted.uniqueCount,
        duplicates: extracted.duplicateCount,
        previewRows: extracted.previewRows,
        template,
      });
    } catch (error) {
      next(normalizeError(error));
    }
  });

  router.post('/api/standards/complete', requireAuth, upload.single('file'), async (req, res, next) => {
    try {
      if (!req.file) {
        throw new BadRequestError('请上传文件');
      }

      const parsedBody = parseCompleteBody(req.body);
      const { sources } = parsedBody;
      const inputCol = colToIndex(parsedBody.inputColumn, 0);
      const outputCol = colToIndex(parsedBody.outputColumn, 1);

      const XLSX = (await import('xlsx')).default;
      const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
      const sheetName = workbook.SheetNames[0];
      if (!sheetName) throw new BadRequestError('表格为空或格式无法识别');
      const sheet = workbook.Sheets[sheetName];
      const rows: string[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
      const { entries, lines, startRow, skippedHeader, duplicateCount, uniqueCount } = extractCompleteRows(rows, inputCol);

      if (parsedBody.templateMode) {
        const template = detectCompleteTemplate(rows);
        if (!template.detected) {
          throw new BadRequestError('未识别到标准补全模板（需要「标准代号/中文标准名称/…/资质备注」表头）');
        }
        const stdCol = template.columnMap['标准代号'] ?? 0;
        const tpl = extractCompleteRows(rows, stdCol);
        if (tpl.lines.length === 0) throw new BadRequestError('未在「标准代号」列找到有效的标准号');

        const selectedSources = (sources ?? sourceRegistry.list()) as SourceName[];
        const resolver = new StandardResolver(sourceRegistry);
        const { resolved, unmatched } = await resolver.resolve(tpl.lines, selectedSources);
        const lookup = new Map<string, (typeof resolved)[0]>();
        for (const r of resolved) lookup.set(completeKey(r.input), r);

        const ExcelJS = (await import('exceljs')).default;
        const wb = new ExcelJS.Workbook();
        // @types/node 25 泛型 Buffer 与 exceljs 声明的 Buffer 类型不变量不兼容，运行时无差异。
        await (wb.xlsx as any).load(req.file.buffer);
        const ws = wb.worksheets.find(s => s.name === sheetName) ?? wb.worksheets[0];
        if (!ws) throw new BadRequestError('表格为空或格式无法识别');

        const colOf = (name: string) => (name in template.columnMap ? template.columnMap[name] : undefined);
        const nameCol = colOf('中文标准名称');
        const statusCol = colOf('标准状态');
        const natureCol = colOf('标准性质');
        const pubCol = colOf('发布日期');
        const implCol = colOf('实施或试行日期');
        const kindCol = colOf('标准分类');
        const filled = { name: 0, status: 0, nature: 0, publish: 0, implement: 0, kind: 0 };
        const setCell = (rowNumber: number, col: number | undefined, value: string): boolean => {
          if (col === undefined || !value) return false;
          const cell = ws.getCell(rowNumber, col + 1); // exceljs 列号 1-based
          const existing = cell.value != null && String(cell.value).trim() !== '';
          if (existing) return false; // 已有内容不覆盖（保留用户手填/示例行）
          cell.value = value;
          return true;
        };
        for (const entry of tpl.entries) {
          const match = lookup.get(completeKey(entry.value));
          if (!match) continue;
          const rowNumber = entry.rowIndex + 1; // exceljs 行号 1-based
          if (setCell(rowNumber, nameCol, match.title)) filled.name++;
          if (setCell(rowNumber, statusCol, mapTemplateStatus(match.status))) filled.status++;
          if (setCell(rowNumber, natureCol, deriveStandardNature(match.standardNumber))) filled.nature++;
          if (setCell(rowNumber, pubCol, formatTemplateDate(match.publishDate))) filled.publish++;
          if (setCell(rowNumber, implCol, formatTemplateDate(match.implementDate))) filled.implement++;
          if (setCell(rowNumber, kindCol, deriveStandardKind(match.standardNumber))) filled.kind++;
        }

        const exportsDir = path.resolve(baseDir, 'data', 'exports');
        await mkdir(exportsDir, { recursive: true });
        const outFileName = `标准补全_模板_${Date.now()}.xlsx`;
        const outPath = path.resolve(exportsDir, outFileName);
        const buf = await wb.xlsx.writeBuffer();
        await writeFile(outPath, Buffer.from(buf as unknown as Uint8Array));

        trackEvent(db, req.user!.id, 'complete', undefined, undefined, {
          fileName: outFileName,
          sheetName,
          templateMode: true,
          totalLines: tpl.lines.length,
          unique: tpl.uniqueCount,
          duplicates: tpl.duplicateCount,
          resolved: resolved.length,
          unmatched: unmatched.length,
          filled,
        }, { ...extractUsageCtx(req), result: 'success' });

        respond(res, {
          fileName: outFileName,
          downloadUrl: `/api/downloads/${encodeURIComponent(outFileName)}`,
          template: true,
          summary: {
            total: tpl.lines.length,
            unique: tpl.uniqueCount,
            duplicates: tpl.duplicateCount,
            resolved: resolved.length,
            unmatched: unmatched.length,
            skippedHeader: tpl.skippedHeader,
            sheetName,
            filled,
          },
        });
        return;
      }

      if (lines.length === 0) throw new BadRequestError(`未在${indexToCol(inputCol)}列找到有效的标准号`);

      const selectedSources = (sources ?? sourceRegistry.list()) as SourceName[];
      const resolver = new StandardResolver(sourceRegistry);
      const { resolved, unmatched } = await resolver.resolve(lines, selectedSources);

      const lookup = new Map<string, (typeof resolved)[0]>();
      for (const r of resolved) {
        const key = completeKey(r.input);
        if (!lookup.has(key)) lookup.set(key, r);
      }
      const unmatchedLookup = new Map<string, string>();
      for (const u of unmatched) {
        const key = completeKey(u.input);
        if (!unmatchedLookup.has(key)) unmatchedLookup.set(key, u.reason);
      }

      const outputHeaders = ['标准号', '标准名称'];
      if (parsedBody.includeStatus) outputHeaders.push('状态');
      if (parsedBody.includeSource) outputHeaders.push('来源');
      if (parsedBody.includeDownloadLink) outputHeaders.push('下载链接');
      if (parsedBody.includeTextFlag) outputHeaders.push('是否有文本');
      outputHeaders.push('备注');

      const rowValues = (original: string) => {
        const match = lookup.get(completeKey(original));
        if (match) {
          const values = [match.standardNumber, match.title];
          if (parsedBody.includeStatus) values.push(match.status ?? '');
          if (parsedBody.includeSource) values.push(match.source);
          if (parsedBody.includeDownloadLink) values.push(`/api/standards/${encodeURIComponent(match.standardId)}/export`);
          if (parsedBody.includeTextFlag) values.push('未检测');
          values.push('');
          return values;
        }
        const values = ['', ''];
        if (parsedBody.includeStatus) values.push('');
        if (parsedBody.includeSource) values.push('');
        if (parsedBody.includeDownloadLink) values.push('');
        if (parsedBody.includeTextFlag) values.push('');
        values.push(unmatchedLookup.get(completeKey(original)) ?? '未匹配');
        return values;
      };

      let outWorkbook: any;
      let outSheet: any;
      if (parsedBody.preserveStyle) {
        outWorkbook = workbook;
        outSheet = sheet;
        outputHeaders.forEach((header, offset) => {
          outSheet[XLSX.utils.encode_cell({ r: Math.max(0, startRow - 1), c: outputCol + offset })] = { t: 's', v: header };
        });
        for (const entry of entries) {
          rowValues(entry.value).forEach((value, offset) => {
            outSheet[XLSX.utils.encode_cell({ r: entry.rowIndex, c: outputCol + offset })] = { t: 's', v: value };
          });
        }
        const range = XLSX.utils.decode_range(outSheet['!ref'] || 'A1:A1');
        range.e.c = Math.max(range.e.c, outputCol + outputHeaders.length - 1);
        range.e.r = Math.max(range.e.r, rows.length - 1);
        outSheet['!ref'] = XLSX.utils.encode_range(range);
        outSheet['!cols'] = outSheet['!cols'] || [];
        outputHeaders.forEach((_header, offset) => {
          outSheet['!cols']![outputCol + offset] = { wch: offset === 1 ? 50 : 18 };
        });
      } else {
        const outRows: string[][] = [];
        outRows.push(['用户提供', ...outputHeaders]);
        for (const entry of entries) {
          outRows.push([entry.value, ...rowValues(entry.value)]);
        }
        outWorkbook = XLSX.utils.book_new();
        outSheet = XLSX.utils.aoa_to_sheet(outRows);
        outSheet['!cols'] = [
          { wch: 25 }, { wch: 28 }, { wch: 50 }, ...outputHeaders.slice(2).map(() => ({ wch: 18 })),
        ];
        XLSX.utils.book_append_sheet(outWorkbook, outSheet, '标准补全结果');
      }

      // Write output file
      const exportsDir = path.resolve(baseDir, 'data', 'exports');
      await mkdir(exportsDir, { recursive: true });
      const outFileName = `标准补全_${Date.now()}.xlsx`;
      const outPath = path.resolve(exportsDir, outFileName);
      const buf = XLSX.write(outWorkbook, { type: 'buffer', bookType: 'xlsx' });
      await writeFile(outPath, buf);

      trackEvent(db, req.user!.id, 'complete', undefined, undefined, {
        fileName: outFileName,
        sheetName,
        inputColumn: indexToCol(inputCol),
        outputColumn: indexToCol(outputCol),
        totalLines: lines.length,
        unique: uniqueCount,
        duplicates: duplicateCount,
        skippedHeader,
        resolved: resolved.length,
        unmatched: unmatched.length,
      }, { ...extractUsageCtx(req), result: 'success' });

      respond(res, {
        fileName: outFileName,
        downloadUrl: `/api/downloads/${encodeURIComponent(outFileName)}`,
        summary: {
          total: lines.length,
          unique: uniqueCount,
          duplicates: duplicateCount,
          resolved: resolved.length,
          unmatched: unmatched.length,
          skippedHeader,
          inputColumn: indexToCol(inputCol),
          outputColumn: indexToCol(outputCol),
          sheetName,
        },
      });
    } catch (error) {
      try {
        trackEvent(db, req.user!.id, 'complete', undefined, undefined, undefined, { ...extractUsageCtx(req), result: 'fail', error: error instanceof Error ? error.message : String(error) });
      } catch { /* ignore */ }
      next(normalizeError(error));
    }
  });

  router.get('/api/tasks/:taskId', requireAuth, async (req, res, next) => {
    try {
      const taskId = req.params.taskId as string;
      const task = exportTaskStore.get(taskId);
      // Return NOT_FOUND on cross-user access so the existence of someone
      // else's task isn't leaked through a distinct 403 response.
      // 用 isSubscriber 替代 userId === —— 跨用户去重时多个用户共享同一 taskId
      if (!task || !exportTaskStore.isSubscriber(taskId, req.user!.id)) {
        throw new NotFoundError(`Export task not found: ${taskId}`);
      }
      respond(res, toCamelCase(task));
    } catch (error) {
      next(normalizeError(error));
    }
  });

  router.post('/api/tasks/:taskId/cancel', requireAuth, (req, res, next) => {
    try {
      const taskId = req.params.taskId as string;
      if (!exportTaskStore.isSubscriber(taskId, req.user!.id)) throw new NotFoundError(`Export task not found: ${taskId}`);
      const cancelled = cancelExportTask(exportTaskStore, taskId);
      const task = exportTaskStore.get(taskId);
      respond(res, { cancelled, task: task ? toCamelCase(task) : null });
    } catch (error) { next(normalizeError(error)); }
  });

  // SSE endpoint for real-time task progress.
  // Each `data:` line is a JSON-encoded ApiResult (same envelope as JSON endpoints) so
  // the client can use one consistent unwrap path regardless of transport.
  router.get('/api/tasks/:taskId/stream', requireAuth, (req, res) => {
    const taskId = req.params.taskId as string;
    // Verify ownership before opening the SSE stream so foreign callers receive
    // a plain 404 rather than a long-lived event stream they could harvest from.
    // 跨用户去重：多个 subscriber 共享同 taskId，都能开 stream 拿进度
    const initial = exportTaskStore.get(taskId);
    if (!initial || !exportTaskStore.isSubscriber(taskId, req.user!.id)) {
      res.status(404).json({ data: null, error: { code: 'NOT_FOUND', message: 'Task not found' } });
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    // The SSE loop ends as soon as the task hits a terminal state, or the
    // client disconnects. The earlier code also bailed after 10 s wall-clock,
    // which truncated any export that legitimately ran longer.
    const interval = setInterval(() => {
      const task = exportTaskStore.get(taskId);
      if (task && exportTaskStore.isSubscriber(taskId, req.user!.id)) {
        res.write(`data: ${JSON.stringify({ data: toCamelCase(task), error: null })}\n\n`);
        if (task.status === 'success' || task.status === 'failed' || task.status === 'cancelled') {
          clearInterval(interval);
          clearTimeout(startupTimeout);
          res.end();
        }
      }
    }, 500);

    // Startup guard: if the task is gone or never existed by the time we
    // first poll, give up after a few seconds rather than streaming nothing
    // until the client times out. Only fires while still in 'queued'.
    const startupTimeout = setTimeout(() => {
      const task = exportTaskStore.get(taskId);
      if (!task || task.status === 'queued') {
        clearInterval(interval);
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify({ data: null, error: { code: 'NOT_FOUND', message: 'Task not found or expired' } })}\n\n`);
          res.end();
        }
      }
    }, 10000);

    req.on('close', () => { clearInterval(interval); clearTimeout(startupTimeout); });
  });


  return router;
}

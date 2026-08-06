// 标准 PDF 预览端点（Phase 1 of 预览功能）
//
// 两条端点：
// - POST /api/preview/request — 查本地库，命中返回 fileId + 直链；未命中返回
//   not_in_library 让前端提示用户先下载（Phase 2 才会自动触发下载）
// - GET  /api/preview/file/:id — 流式回 PDF，支持 HTTP Range、ETag、内联打开
//
// 安全要点：
// - stdCode / source 永远当 SQL 参数用，不拼路径
// - file 端点返回前用 lstat + realpath 二次校验（防扫描时跟随 symlink 出界）
// - requireAuth（含 guest），与搜索口径一致

import { Router } from 'express';
import { z } from 'zod';
import { promises as fs, createReadStream } from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { Request, Response, NextFunction } from 'express';
import { lookupFile, getFileById, bulkLookup, parseLibraryFilename } from '../services/library-index';
import { computeNormalizedName } from '../services/library-naming';
import { extractBaseCode } from '../services/qualification-service';
import { resolveLibraryDir, resolveSafeLibraryFile, resolveSafeLibraryTarget } from '../shared/library-paths';
import { respond, respondError } from '../shared/response';
import { normalizeError } from '../shared/errors';
import { getSetting } from '../services/db';
import type { SourceName } from '../domain/standard';
import type { SourceRegistry } from '../services/source-registry';
import { moveDownloadToLibrary } from '../services/download-to-library';
import { createTask, updateTask, getTask, findActiveTaskByKey } from '../services/preview-task-store';
import { trackEvent } from '../services/usage-tracker';
import { StandardService } from '../services/standard-service';
import { highCostInFlightGuard, highCostRateLimit } from '../shared/high-cost-guard';

const sourceEnum = z.enum(['gbw', 'bz', 'by', 'labr']);
const DEFAULT_SOURCE_PRIORITY: SourceName[] = ['gbw', 'bz', 'by'];
// 语义对照（很容易混）：
// - DEFAULT_SOURCE_PRIORITY / getConfiguredSourcePriority：用于 lookupFile / 自动选源 /
//   预览 priority 排序 —— labr 默认不进，避免污染主搜索精确匹配
// - ALL_LIBRARY_SOURCES：用于 library-check（"绿点 = 库里有没有"，OR 语义） —— labr
//   入库的文件也要让绿点亮，否则用户从 labr 下载后在主搜索看不到命中
const ALL_LIBRARY_SOURCES: SourceName[] = ['gbw', 'bz', 'by', 'labr'];
const SOURCE_LABELS: Record<SourceName, string> = {
  gbw: '国家标准全文公开系统',
  bz: '标准网',
  by: '标准院',
  labr: 'Labr 补给页',
};

function sourceLabel(source: SourceName): string {
  return SOURCE_LABELS[source] || source;
}

/**
 * 从 settings.library_source_priority 读全局优先级；坏数据 / 缺设置 → 用默认。
 * 请求级 sources 参数会覆盖这里读出的全局值。
 */
function getConfiguredSourcePriority(db: Database.Database): SourceName[] {
  const raw = getSetting(db, 'library_source_priority', '');
  if (!raw) return DEFAULT_SOURCE_PRIORITY;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_SOURCE_PRIORITY;
    const filtered = parsed.filter((s): s is SourceName =>
      s === 'gbw' || s === 'bz' || s === 'by' || s === 'labr');
    return filtered.length > 0 ? filtered : DEFAULT_SOURCE_PRIORITY;
  } catch {
    return DEFAULT_SOURCE_PRIORITY;
  }
}

export function createPreviewRoutes(
  db: Database.Database,
  requireAuth: (req: Request, res: Response, next: NextFunction) => void,
  sourceRegistry: SourceRegistry,
) {
  const router = Router();

  /**
   * 后台跑下载 + 入库（Phase 2 自动下载预览流）。
   *
   * 入参：preview/request 已经算好的 sources 优先级 + stdCode + 可选 year。
   * 行为：按优先级顺序找匹配 → adapter.autoDownload / exportStandard → moveDownloadToLibrary。
   * 任一源成功 → 任务标 ready，带 fileId。所有源都失败 → 任务标 failed，前端提示。
   *
   * 不阻塞 HTTP 响应：preview/request 立刻返回 taskId，前端去打 /api/preview/task/:taskId 轮询。
   * 这是单进程内存任务（preview-task-store），重启即丢失（用户重点预览即可）。
   */
  async function runAutoDownload(taskId: string, userId: number, stdCode: string, year: string | undefined, sources: SourceName[]): Promise<void> {
    updateTask(taskId, {
      status: 'pending',
      phase: 'checking_library',
      message: '本地库未命中，准备从可用来源自动入库…',
    });
    for (let index = 0; index < sources.length; index++) {
      const src = sources[index];
      const label = sourceLabel(src);
      const attempt = index + 1;
      try {
        updateTask(taskId, {
          status: 'downloading',
          phase: 'searching_source',
          source: src,
          sourceLabel: label,
          attempt,
          message: `正在 ${label} 搜索标准…`,
        });
        const adapter = sourceRegistry.get(src);
        // 1) 用标准号搜索这个源 → 拿到对应 ID
        const service = new StandardService(adapter);
        const searchResults = await service.searchStandards({ query: stdCode });
        const norm = (s: string) => s.replace(/[^A-Z0-9]/gi, '').toUpperCase();
        const wanted = norm(stdCode);
        // StandardSummary 没有独立 year 字段，从 standardNumber 末尾抽（"GB 3324-2024"）
        const extractYear = (sn: string): string | undefined => sn.match(/-\s*(\d{4})\s*$/)?.[1];
        const match = searchResults.find(item => {
          if (norm(item.standardNumber) !== wanted) return false;
          if (year) {
            const itemYear = extractYear(item.standardNumber);
            if (itemYear && itemYear !== year) return false;
          }
          return true;
        }) || searchResults.find(item => norm(item.standardNumber) === wanted);
        if (!match) {
          updateTask(taskId, {
            status: 'downloading',
            phase: 'searching_source',
            source: src,
            sourceLabel: label,
            attempt,
            message: `${label} 未找到匹配标准，继续尝试下一个来源…`,
          });
          continue;
        }

        // 2) 下载（autoDownload 优先；不支持时用 exportStandard 兜底）
        // autoDownload 返回 DownloadSessionInfo（filePath/fileName/fileSize 在 meta 里），
        // exportStandard 返回 ExportResult（顶层就有 filePath 等）。统一拍扁成下面这个形状。
        let result: { filePath?: string; fileName?: string; fileSize?: number } | null = null;
        updateTask(taskId, {
          status: 'downloading',
          phase: 'downloading',
          source: src,
          sourceLabel: label,
          attempt,
          message: `已找到匹配项，正在从 ${label} 下载 PDF…`,
        });
        if (adapter.autoDownload) {
          const r = await adapter.autoDownload(match.id, userId, 3);
          if (r.status === 'downloaded') {
            const meta = r.meta || {};
            result = {
              filePath: typeof meta.filePath === 'string' ? meta.filePath : undefined,
              fileName: typeof meta.fileName === 'string' ? meta.fileName : undefined,
              fileSize: typeof meta.fileSize === 'number' ? meta.fileSize : undefined,
            };
          }
        } else if (adapter.exportStandard) {
          const r = await adapter.exportStandard(match.id);
          result = { filePath: r.filePath, fileName: r.fileName, fileSize: r.fileSize };
        }
        if (!result || !result.filePath) {
          updateTask(taskId, {
            status: 'downloading',
            phase: 'downloading',
            source: src,
            sourceLabel: label,
            attempt,
            message: `${label} 暂未返回可用 PDF，继续尝试下一个来源…`,
          });
          continue;
        }

        // 后台自动下载（预览触发），无 req 上下文：ip/hostname 留空，client 标 system
        trackEvent(db, userId, 'download', src, match.id, { autoTriggeredBy: 'preview' }, { result: 'success', client: 'system' });

        // 3) 入库
        updateTask(taskId, {
          status: 'downloading',
          phase: 'moving_to_library',
          source: src,
          sourceLabel: label,
          attempt,
          message: '下载完成，正在保存到本地标准库…',
        });
        const moved = await moveDownloadToLibrary(db, sourceRegistry, src, match.id, result);
        if (moved.fileId) {
          updateTask(taskId, {
            status: 'ready',
            phase: 'ready',
            fileId: moved.fileId,
            source: src,
            sourceLabel: label,
            message: '已保存到本地标准库，正在打开预览…',
          });
          return;
        }
      } catch (e: any) {
        console.error(`[preview-task] ${src} 下载失败:`, e?.message || e);
        updateTask(taskId, {
          status: 'downloading',
          phase: 'downloading',
          source: src,
          sourceLabel: label,
          attempt,
          message: `${label} 下载失败，继续尝试下一个来源…`,
        });
        // 继续试下一个源
      }
    }
    updateTask(taskId, { status: 'failed', phase: 'failed', error: '所有源都未能下载到此标准', message: '所有来源都尝试完毕，未能自动入库。' });
  }

  /**
   * 批量本地命中检查（搜索结果绿点用）。
   * Body: { items: [{stdCode, year?}], sources?: SourceName[] }
   * Resp: { fileIds: Array<number|null> } —— 与 items 同长度同序，命中给 fileId、未命中给 null
   *
   * 单条 SQL（不做 fs.access），跑在 idx_standard_files_lookup 上。200 条 ≤ 5ms。
   * 平行数组返回避免前端需要镜像归一化逻辑（extractBaseCode）才能取 key。
   */
  router.post('/api/preview/library-check', requireAuth, (req, res, next) => {
    try {
      const schema = z.object({
        items: z.array(z.object({
          stdCode: z.string().trim().min(1).max(64),
          year: z.string().regex(/^\d{4}$/).optional(),
        })).max(500),
        sources: z.array(sourceEnum).optional(),
      });
      const { items, sources } = schema.parse(req.body);
      // 绿点 = "库里有没有"（OR 语义），不是"该选哪个"（priority 语义）。
      // 默认用全集 ALL_LIBRARY_SOURCES，让 labr 入库的文件也能在主搜索亮绿。
      // 显式传 sources 时仍尊重调用方意图。
      const effectiveSources = sources && sources.length > 0
        ? sources
        : ALL_LIBRARY_SOURCES;
      const map = bulkLookup(db, items, effectiveSources);
      // 重建平行数组：每个 item 重新算一次 key，去 map 查
      const fileIds = items.map((it) => {
        const norm = extractBaseCode(it.stdCode);
        if (!norm) return null;
        return map.get(`${norm}|${it.year || ''}`) ?? null;
      });
      respond(res, { fileIds });
    } catch (error) {
      next(normalizeError(error));
    }
  });

  /**
   * GET /api/preview/files?stdCode=...&year=...
   *
   * 列出库内**所有**匹配 (stdCode, year?) 的文件，按 library_source_priority 排序。
   * 给"多源 picker"用：搜索结果里同一标准号可能在 BW/BZ/BY/LB 多份都存在，前端
   * 让用户挑要看哪份。
   *
   * 与 /api/preview/request 的区别：request 只返回优先级最高的那个 (single best)，
   * 用于"点详情自动打开预览"场景；files 返回全部候选，用于"切换源"。
   *
   * 不做 fs.access（与 bulkLookup 同口径），watcher 维护表的真实存在；预览 file
   * 端点点开时再做 stat + 缺失清行。
   */
  router.get('/api/preview/files', requireAuth, (req, res, next) => {
    try {
      const schema = z.object({
        stdCode: z.string().trim().min(2).max(64),
        year: z.string().regex(/^\d{4}$/).optional(),
      });
      const { stdCode, year } = schema.parse(req.query);
      const norm = extractBaseCode(stdCode);
      if (!norm) {
        respond(res, { files: [], items: [] });
        return;
      }
      const priority = getConfiguredSourcePriority(db);
      // labr 没在默认优先级里但库里可能有 → 把所有源列出，priority 内的按其顺序，外的尾随
      const allSources: SourceName[] = ['gbw', 'bz', 'by', 'labr'];
      const ordered: SourceName[] = [
        ...priority,
        ...allSources.filter(s => !priority.includes(s)),
      ];

      const yearClause = year ? 'AND year = ?' : '';
      const args: any[] = [norm];
      if (year) args.push(year);
      const rows = db.prepare(`
        SELECT id, year, source, size, mime, indexed_at
        FROM standard_files
        WHERE std_code_norm = ? ${yearClause}
      `).all(...args) as Array<{
        id: number; year: string; source: SourceName;
        size: number; mime: string; indexed_at: string;
      }>;

      // 按 (year DESC, source 优先级) 排：跨年混查时新版优先；同年内按 priority
      const files = rows
        .map(r => ({
          fileId: r.id,
          source: r.source,
          year: r.year || null,
          size: r.size,
          mime: r.mime || 'application/pdf',
          indexedAt: r.indexed_at,
          url: `/api/preview/file/${r.id}`,
        }))
        .sort((a, b) => {
          const yearDiff = (b.year || '').localeCompare(a.year || '');
          if (yearDiff !== 0) return yearDiff;
          return ordered.indexOf(a.source) - ordered.indexOf(b.source);
        });
      respond(res, { files, items: files });
    } catch (error) {
      next(normalizeError(error));
    }
  });

  router.post('/api/preview/request', requireAuth, highCostRateLimit, highCostInFlightGuard, async (req, res, next) => {
    try {
      const schema = z.object({
        stdCode: z.string().trim().min(2).max(64),
        year: z.string().regex(/^\d{4}$/).optional(),
        sources: z.array(sourceEnum).optional(),
      });
      const { stdCode, year, sources } = schema.parse(req.body);

      const effectiveSources = sources && sources.length > 0
        ? sources
        : getConfiguredSourcePriority(db);
      const file = await lookupFile(db, {
        stdCode,
        year,
        sources: effectiveSources,
      });

      if (!file) {
        // Phase 2：未命中 → 后台触发自动下载 + 入库，前端 poll /api/preview/task/:id
        //
        // 去重：若已有同 (stdCode, year) 的活跃任务（pending / downloading）→ 直接复用。
        // 覆盖两个场景：用户连点预览 / 先点下载再点预览（如果未来下载也走这条路径）。
        const existing = findActiveTaskByKey(stdCode, year);
        if (existing) {
          const task = getTask(existing);
          respond(res, {
            status: 'downloading',
            phase: task?.phase || 'downloading',
            stdCode,
            year: year ?? null,
            tried: effectiveSources,
            taskId: existing,
            reused: true,
            source: task?.source,
            sourceLabel: task?.sourceLabel,
            message: task?.message || '已有相同标准正在自动入库，已复用任务…',
            attempt: task?.attempt,
            elapsedMs: task?.elapsedMs,
          });
          return;
        }

        const taskId = createTask(stdCode, year);
        const userId = (req as any).user?.id as number;
        // fire-and-forget：runAutoDownload 内部把状态推进 store
        runAutoDownload(taskId, userId, stdCode, year, effectiveSources).catch((e) => {
          console.error('[preview-task] runAutoDownload threw:', e);
          updateTask(taskId, { status: 'failed', error: e?.message || '下载启动失败' });
        });
        respond(res, {
          status: 'downloading',
          phase: 'checking_library',
          stdCode,
          year: year ?? null,
          tried: effectiveSources,
          taskId,
          message: '本地库未命中，已开始自动入库…',
        });
        return;
      }

      respond(res, {
        status: 'ready',
        phase: 'ready',
        fileId: file.id,
        source: file.source,
        sourceLabel: sourceLabel(file.source),
        year: file.year || null,
        size: file.size,
        url: `/api/preview/file/${file.id}`,
        message: '已命中本地标准库，正在打开预览…',
      });
    } catch (error) {
      next(normalizeError(error));
    }
  });

  /**
   * 轮询自动下载任务状态。
   * - pending / downloading：前端继续轮询（建议 1500ms 间隔，下载常 5~30s）
   * - ready：响应里带 fileId，前端切到 /api/preview/file/:id 渲染 iframe
   * - failed：响应里带 error，前端提示用户失败 / 让其手动重试
   */
  router.get('/api/preview/task/:taskId', requireAuth, (req, res) => {
    const taskId = String(req.params.taskId || '');
    const status = getTask(taskId);
    if (!status) {
      respondError(res, 404, 'NOT_FOUND', '任务不存在或已过期');
      return;
    }
    if (status.status === 'ready') {
      respond(res, {
        status: 'ready',
        phase: status.phase || 'ready',
        fileId: status.fileId,
        source: status.source,
        sourceLabel: status.sourceLabel,
        url: `/api/preview/file/${status.fileId}`,
        message: status.message,
        elapsedMs: status.elapsedMs,
      });
      return;
    }
    respond(res, status);
  });

  router.get('/api/preview/file/:id', requireAuth, async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        respondError(res, 400, 'BAD_REQUEST', 'Invalid file id');
        return;
      }

      const file = await getFileById(db, id);
      if (!file) {
        respondError(res, 404, 'NOT_FOUND', '文件不存在或已被删除');
        return;
      }

      const libStatus = await resolveLibraryDir(db);
      let safeFile;
      try { safeFile = await resolveSafeLibraryFile(file.absPath, libStatus.dir); } catch { safeFile = null; }
      if (!safeFile) {
        // 库根改了之后旧索引行残留指向库外：拒绝服务、清行，下次扫描重建
        db.prepare('DELETE FROM standard_files WHERE id = ?').run(id);
        respondError(res, 410, 'GONE', '文件已不在当前库目录');
        return;
      }

      const stat = safeFile.stat;

      // ETag 用 mtime + size，避免每次预览都跑 hash
      const etag = `W/"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;
      if (req.headers['if-none-match'] === etag) {
        res.status(304).end();
        return;
      }

      const fileName = path.basename(file.absPath);
      // RFC 5987：filename* 编码 UTF-8 支持中文；filename= 兜底纯 ASCII 客户端。
      // ASCII 名再额外 escape `"` 和 `\`，避免用户手动塞名为 `a";x=...".pdf`
      // 的文件时破坏 header 结构（buildLibraryFilename 自己写出的文件不会有，
      // 但库目录里允许人为放文件，必须按不可信处理）。
      const asciiName = fileName
        .replace(/[^\x20-\x7E]/g, '_')
        .replace(/["\\]/g, '_');
      const dispositionType = req.query.attachment === '1' ? 'attachment' : 'inline';
      res.setHeader('Content-Type', file.mime || 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `${dispositionType}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      );
      res.setHeader('ETag', etag);
      res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
      res.setHeader('Accept-Ranges', 'bytes');

      const range = req.headers.range;
      if (!range) {
        res.setHeader('Content-Length', String(stat.size));
        createReadStream(safeFile.realPath).pipe(res);
        return;
      }

      // Range: bytes=START-END，支持单 range；忽略多段（PDF.js 不需要）
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!m) {
        res.status(416).setHeader('Content-Range', `bytes */${stat.size}`).end();
        return;
      }
      const startRaw = m[1];
      const endRaw = m[2];
      let start: number;
      let end: number;
      if (startRaw === '' && endRaw !== '') {
        // suffix range: bytes=-N → 最后 N 字节
        const suffix = Number(endRaw);
        if (!Number.isFinite(suffix) || suffix <= 0) {
          res.status(416).setHeader('Content-Range', `bytes */${stat.size}`).end();
          return;
        }
        start = Math.max(0, stat.size - suffix);
        end = stat.size - 1;
      } else {
        start = Number(startRaw);
        end = endRaw === '' ? stat.size - 1 : Number(endRaw);
      }
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end >= stat.size || start > end) {
        res.status(416).setHeader('Content-Range', `bytes */${stat.size}`).end();
        return;
      }

      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
      res.setHeader('Content-Length', String(end - start + 1));
      createReadStream(safeFile.realPath, { start, end }).pipe(res);
    } catch (error) {
      next(normalizeError(error));
    }
  });

  /**
   * DELETE /api/preview/file/:id — 删除本地文件库中的标准 PDF
   *
   * 物理删 abs_path 指向的文件 + 从 standard_files 删行。库根之外的路径拒删（安全防线）。
   */
  router.delete('/api/preview/file/:id', requireAuth, async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        respondError(res, 400, 'BAD_REQUEST', 'Invalid file id');
        return;
      }
      const file = await getFileById(db, id);
      if (!file) {
        respondError(res, 404, 'NOT_FOUND', '文件不存在或已被删除');
        return;
      }
      const libStatus = await resolveLibraryDir(db);
      let safeFile;
      try { safeFile = await resolveSafeLibraryFile(file.absPath, libStatus.dir); } catch { safeFile = null; }
      if (!safeFile) {
        db.prepare('DELETE FROM standard_files WHERE id = ?').run(id);
        respondError(res, 410, 'GONE', '文件已不在当前库目录');
        return;
      }
      try { await fs.unlink(safeFile.realPath); } catch (e: any) {
        if (e && e.code !== 'ENOENT') throw e;
      }
      db.prepare('DELETE FROM standard_files WHERE id = ?').run(id);
      respond(res, { ok: true, id });
    } catch (error) {
      next(normalizeError(error));
    }
  });

  /**
   * POST /api/preview/files/batch-delete — 批量删除
   * body: { ids: number[] }
   * 返回 { deleted: number[], failed: Array<{id, message}> }
   */
  router.post('/api/preview/files/batch-delete', requireAuth, highCostRateLimit, highCostInFlightGuard, async (req, res, next) => {
    try {
      const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((n: any) => Number.isInteger(n) && n > 0) : [];
      if (!ids.length) {
        respondError(res, 400, 'BAD_REQUEST', 'ids 不能为空');
        return;
      }
      const libStatus = await resolveLibraryDir(db);
      const deleted: number[] = [];
      const failed: Array<{ id: number; message: string }> = [];
      for (const id of ids) {
        try {
          const file = await getFileById(db, id);
          if (!file) { failed.push({ id, message: '不存在' }); continue; }
          let safeFile;
          try { safeFile = await resolveSafeLibraryFile(file.absPath, libStatus.dir); } catch { safeFile = null; }
          if (!safeFile) {
            db.prepare('DELETE FROM standard_files WHERE id = ?').run(id);
            failed.push({ id, message: '库外路径' }); continue;
          }
          try { await fs.unlink(safeFile.realPath); } catch (e: any) {
            if (e && e.code !== 'ENOENT') { failed.push({ id, message: e.message || '删除失败' }); continue; }
          }
          db.prepare('DELETE FROM standard_files WHERE id = ?').run(id);
          deleted.push(id);
        } catch (e: any) {
          failed.push({ id, message: e?.message || '未知错误' });
        }
      }
      respond(res, { deleted, failed });
    } catch (error) {
      next(normalizeError(error));
    }
  });

  // 把 file row rename 为 finalName（已含扩展名，不带路径分隔符）。
  // 返回 ok / conflict / gone / unchanged 状态码语义供端点透出。
  // 复用给 PATCH（用户手输）和 normalize 端点（pattern 算出）—— rename + db abs_path 同步逻辑一致。
  async function renameLibraryFile(
    file: { id: number; absPath: string },
    finalName: string,
    libDir: string,
  ): Promise<{ ok: true; abs_path: string; changed: boolean } | { ok: false; code: 'GONE' | 'BAD_REQUEST' | 'CONFLICT'; message: string }> {
    const safeFile = await resolveSafeLibraryFile(file.absPath, libDir).catch(() => null);
    if (!safeFile) {
      return { ok: false, code: 'GONE', message: '文件已不在当前库目录' };
    }
    const newPath = path.join(path.dirname(safeFile.realPath), finalName);
    const safeTarget = await resolveSafeLibraryTarget(newPath, libDir);
    if (!safeTarget) {
      return { ok: false, code: 'BAD_REQUEST', message: '目标路径越界' };
    }
    if (newPath === safeFile.realPath) {
      return { ok: true, abs_path: newPath, changed: false };
    }
    try {
      await fs.access(newPath);
      return { ok: false, code: 'CONFLICT', message: '目标文件名已存在' };
    } catch { /* not exists → ok */ }
    await fs.rename(safeFile.realPath, newPath);
    db.prepare('UPDATE standard_files SET abs_path = ?, file_name = ? WHERE id = ?').run(newPath, path.basename(newPath), file.id);
    return { ok: true, abs_path: newPath, changed: true };
  }

  /**
   * PATCH /api/preview/file/:id — 重命名（编辑标准名称）
   *
   * body: { fileName: string }
   * 仅支持改文件名 basename；保留原扩展名；新名走 safeFileName 校验防路径穿越。
   * 同时更新 standard_files.abs_path 和（必要时）std_code_norm/year。
   * 注意：std_code_norm 是搜索/绿点的索引键，**不动**；只改物理文件名（用户视觉层标识）。
   */
  router.patch('/api/preview/file/:id', requireAuth, async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        respondError(res, 400, 'BAD_REQUEST', 'Invalid file id');
        return;
      }
      const raw = String(req.body?.fileName || '').trim();
      if (!raw) {
        respondError(res, 400, 'BAD_REQUEST', 'fileName 不能为空');
        return;
      }
      // 拒绝路径分隔符 / 控制字符 / Windows 保留字符；保留中文
      // eslint-disable-next-line no-control-regex
      if (/[\/\\:*?"<>|\x00-\x1F]/.test(raw)) {
        respondError(res, 400, 'BAD_REQUEST', '文件名含非法字符');
        return;
      }
      if (raw.length > 200) {
        respondError(res, 400, 'BAD_REQUEST', '文件名过长');
        return;
      }
      const file = await getFileById(db, id);
      if (!file) {
        respondError(res, 404, 'NOT_FOUND', '文件不存在或已被删除');
        return;
      }
      const libStatus = await resolveLibraryDir(db);
      const oldExt = path.extname(file.absPath);
      const newExt = path.extname(raw);
      // 用户没带扩展名 → 自动接旧扩展名；带了不同扩展名 → 也尊重
      const finalName = newExt ? raw : raw + oldExt;
      const result = await renameLibraryFile(file, finalName, libStatus.dir);
      if (!result.ok) {
        const status = result.code === 'GONE' ? 410 : result.code === 'CONFLICT' ? 409 : 400;
        respondError(res, status, result.code, result.message);
        return;
      }
      respond(res, { ok: true, id, fileName: finalName, abs_path: result.abs_path });
    } catch (error) {
      next(normalizeError(error));
    }
  });

  /**
   * #73 计算单个文件 row 的目标名 + 当前 pattern；封装给 normalize 端点用。
   * 返回 null 表示物理文件名 parseLibraryFilename 解析失败（应当不会发生，scanLibrary
   * 会跳过这些文件 → 不在 standard_files 表里），调用方按 error 透回。
   */
  function computeForRow(
    file: { id: number; absPath: string; source: SourceName },
    pattern: string,
  ): { id: number; from: string; to: string; willChange: boolean; error?: string } {
    const currentName = path.basename(file.absPath);
    const parsed = parseLibraryFilename(currentName);
    if (!parsed) {
      return { id: file.id, from: currentName, to: currentName, willChange: false, error: '文件名不符合命名规范，无法解析（可能是手动放进库的非规范文件）' };
    }
    const result = computeNormalizedName({
      currentName,
      source: file.source,
      stdCode: parsed.stdCodeRaw,
      year: parsed.year,
      title: parsed.title,
    }, pattern);
    return {
      id: file.id,
      from: result.currentName,
      to: result.normalizedName,
      willChange: result.willChange,
      error: result.error,
    };
  }

  /**
   * #73 POST /api/preview/file/:id/normalize — 单文件按当前 pattern 格式化
   *
   * query: ?dryRun=1 仅返回 {currentName, normalizedName, willChange}，不动文件
   *        （供 rename modal 实时显示「按内置格式将变为：xxx」）
   *
   * 行为（非 dryRun）：parse 物理名拿 stdCode/year/title → 按 library_filename_pattern
   *      重渲染 → 与现名比对，相同则 changed=false（200），不同则 fs.rename + 更新 abs_path。
   *
   * 注意：std_code_norm 不动（索引键），title 缺失（V1 老文件）→ 模板引擎自动剥占位符 →
   *      结果可能与原名一致 → unchanged，符合预期（要补 title 得跑源 detail，超出本端点范围）
   */
  router.post('/api/preview/file/:id/normalize', requireAuth, async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        respondError(res, 400, 'BAD_REQUEST', 'Invalid file id');
        return;
      }
      const dryRun = req.query.dryRun === '1' || req.query.dryRun === 'true';
      const file = await getFileById(db, id);
      if (!file) {
        respondError(res, 404, 'NOT_FOUND', '文件不存在或已被删除');
        return;
      }
      const pattern = getSetting(db, 'library_filename_pattern', '{stdCode} {title} - {source}');
      const plan = computeForRow(file, pattern);
      if (dryRun) {
        respond(res, { dryRun: true, id, currentName: plan.from, normalizedName: plan.to, willChange: plan.willChange, error: plan.error });
        return;
      }
      if (plan.error) {
        respondError(res, 422, 'UNPROCESSABLE', plan.error);
        return;
      }
      if (!plan.willChange) {
        respond(res, { ok: true, id, changed: false, fileName: plan.from });
        return;
      }
      const libStatus = await resolveLibraryDir(db);
      const result = await renameLibraryFile(file, plan.to, libStatus.dir);
      if (!result.ok) {
        const status = result.code === 'GONE' ? 410 : result.code === 'CONFLICT' ? 409 : 400;
        respondError(res, status, result.code, result.message);
        return;
      }
      respond(res, { ok: true, id, changed: result.changed, fileName: plan.to, abs_path: result.abs_path });
    } catch (error) {
      next(normalizeError(error));
    }
  });

  /**
   * #73 POST /api/preview/files/normalize — 批量按当前 pattern 格式化
   *
   * body: { ids?: number[], scope?: 'selected'|'all', dryRun?: boolean }
   * - scope='all'：忽略 ids，扫所有 library 行（提供整库格式化快捷入口）
   * - scope='selected' (默认) 或缺省：使用 ids
   * - dryRun=true（默认）：仅返回预览（preview）不动文件
   * - dryRun=false：实际执行
   *
   * 预览/执行都做 self-conflict 检测（同批两个旧文件目标名一样 → 标 conflict 跳过）。
   * 与库内已有文件冲突也标 conflict。执行时逐条 rename，单条失败不影响其它。
   */
  router.post('/api/preview/files/normalize', requireAuth, async (req, res, next) => {
    try {
      const scope: 'selected' | 'all' = req.body?.scope === 'all' ? 'all' : 'selected';
      let ids: number[];
      if (scope === 'all') {
        // 取所有 library 行 ID（已经经过 scanLibrary 过滤，都是符合命名规范的）
        const rows = db.prepare('SELECT id FROM standard_files ORDER BY id ASC').all() as Array<{ id: number }>;
        ids = rows.map(r => r.id);
      } else {
        ids = Array.isArray(req.body?.ids)
          ? req.body.ids.filter((n: any) => Number.isInteger(n) && n > 0)
          : [];
      }
      const dryRun = req.body?.dryRun !== false; // 默认 true，显式传 false 才执行
      if (!ids.length) {
        respondError(res, 400, 'BAD_REQUEST', scope === 'all' ? '文件库为空' : 'ids 不能为空');
        return;
      }
      const pattern = getSetting(db, 'library_filename_pattern', '{stdCode} {title} - {source}');
      const libStatus = await resolveLibraryDir(db);

      // 第一遍：算所有目标名 + parse 失败 / 不变 分类
      type Plan = { id: number; from: string; to: string; willChange: boolean; error?: string; conflictReason?: string };
      const plans: Plan[] = [];
      for (const id of ids) {
        const file = await getFileById(db, id);
        if (!file) {
          plans.push({ id, from: '', to: '', willChange: false, error: '文件不存在或已被删除' });
          continue;
        }
        plans.push(computeForRow(file, pattern));
      }

      // 第二遍：self-conflict 检测 —— 同批多个 plan 渲染出相同 to（且都 willChange）
      const targetMap = new Map<string, number[]>();
      for (const p of plans) {
        if (!p.willChange || p.error) continue;
        const key = p.to.toLowerCase(); // Windows 大小写不敏感
        if (!targetMap.has(key)) targetMap.set(key, []);
        targetMap.get(key)!.push(p.id);
      }
      for (const [, idList] of targetMap) {
        if (idList.length > 1) {
          for (const id of idList) {
            const p = plans.find(x => x.id === id);
            if (p) p.conflictReason = `本批内多项目标名相同（#${idList.join(', #')}）`;
          }
        }
      }

      // 第三遍（dryRun=true 时仅这一遍）：预检每个目标名是否与库内已有文件冲突
      // 注：库内文件如果就是自己本身的旧路径则不算冲突，by-id 也涵盖这一点（rename 到自己 = unchanged）
      for (const p of plans) {
        if (!p.willChange || p.error || p.conflictReason) continue;
        // 检测同目录下是否已存在目标名的物理文件（且不是自身）
        try {
          const file = await getFileById(db, p.id);
          if (!file) continue;
          const targetPath = path.join(path.dirname(file.absPath), p.to);
          if (targetPath === file.absPath) continue;
          try {
            await fs.access(targetPath);
            p.conflictReason = '目标文件名已被同目录其它文件占用';
          } catch { /* not exists → ok */ }
        } catch { /* 忽略 */ }
      }

      if (dryRun) {
        // libraryTotal 供前端「整库」chip 显示总数
        const total = (db.prepare('SELECT COUNT(*) AS c FROM standard_files').get() as { c: number }).c;
        respond(res, { dryRun: true, scope, preview: plans, libraryTotal: total });
        return;
      }

      // dryRun=false：实际执行
      const renamed: Array<{ id: number; from: string; to: string }> = [];
      const unchanged: number[] = [];
      const failed: Array<{ id: number; message: string }> = [];
      for (const p of plans) {
        if (p.error) { failed.push({ id: p.id, message: p.error }); continue; }
        if (!p.willChange) { unchanged.push(p.id); continue; }
        if (p.conflictReason) { failed.push({ id: p.id, message: p.conflictReason }); continue; }
        try {
          const file = await getFileById(db, p.id);
          if (!file) { failed.push({ id: p.id, message: '文件不存在或已被删除' }); continue; }
          const result = await renameLibraryFile(file, p.to, libStatus.dir);
          if (!result.ok) {
            failed.push({ id: p.id, message: result.message });
            continue;
          }
          if (result.changed) renamed.push({ id: p.id, from: p.from, to: p.to });
          else unchanged.push(p.id);
        } catch (e: any) {
          failed.push({ id: p.id, message: e?.message || '未知错误' });
        }
      }
      respond(res, { dryRun: false, renamed, unchanged, failed });
    } catch (error) {
      next(normalizeError(error));
    }
  });

  return router;
}

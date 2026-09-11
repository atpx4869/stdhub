import path from 'node:path';
import { existsSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { Router, type RequestHandler } from 'express';
import type Database from 'better-sqlite3';
import { respond, respondError } from '../shared/response';
import { resolveLibraryDir, resolveSafeLibraryFile } from '../shared/library-paths';
import { parseLibraryFilename } from '../services/library-index';
import { publishLibraryFileRemoval } from '../services/library-events';
import { ensureExportIndexFresh, removeExportIndex } from '../services/export-file-index';

const FILENAME_ALLOWED = /^[a-zA-Z0-9一-鿿._\-\s()]+$/;

function safeExportName(raw: string): string | null {
  let decoded: string;
  try { decoded = decodeURIComponent(raw); } catch { return null; }
  const base = path.basename(decoded);
  return base && base !== '.' && base !== '..' && FILENAME_ALLOWED.test(base) ? base : null;
}

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.floor(parsed))) : fallback;
}

function escapeLike(value: string): string { return value.replace(/[\\%_]/g, match => `\\${match}`); }

export function createDownloadRoutes(db: Database.Database, baseDir: string, requireAdmin: RequestHandler) {
  const router = Router();

  router.get('/api/downloads/:filename', requireAdmin, async (req, res, next) => {
    try {
      const filename = safeExportName(String(req.params.filename));
      if (!filename) { respondError(res, 400, 'BAD_REQUEST', 'Invalid filename'); return; }
      const exportsDir = path.resolve(baseDir, 'data', 'exports');
      const exportsPath = path.resolve(exportsDir, filename);
      if (exportsPath.startsWith(exportsDir + path.sep) && existsSync(exportsPath)) {
        if (req.query.inline === '1') res.sendFile(exportsPath); else res.download(exportsPath);
        return;
      }
      const match = db.prepare('SELECT id, abs_path FROM standard_files WHERE file_name = ? ORDER BY indexed_at DESC LIMIT 1')
        .get(filename) as { id: number; abs_path: string } | undefined;
      if (!match) { respondError(res, 404, 'NOT_FOUND', 'File not found'); return; }
      const libStatus = await resolveLibraryDir(db);
      const safeFile = await resolveSafeLibraryFile(match.abs_path, libStatus.dir).catch(() => null);
      if (!safeFile) {
        db.prepare('DELETE FROM standard_files WHERE id = ?').run(match.id);
        publishLibraryFileRemoval(match.id);
        respondError(res, 410, 'GONE', '文件已不在当前库目录');
        return;
      }
      if (req.query.inline === '1') res.sendFile(safeFile.realPath); else res.download(safeFile.realPath);
    } catch (error) { next(error); }
  });

  router.get('/api/downloads', requireAdmin, async (req, res, next) => {
    try {
      const q = String(req.query.q || '').trim();
      const libraryOnly = String(req.query.kind || 'all').trim() === 'library';
      const seriesGrouped = libraryOnly && String(req.query.group || '') === 'series';
      const limit = boundedInt(req.query.limit, 200, 1, 500);
      const offset = boundedInt(req.query.offset, 0, 0, 100_000_000);
      const localLimit = libraryOnly ? limit : Math.min(1000, limit + offset);
      const localOffset = libraryOnly ? offset : 0;
      const like = `%${escapeLike(q)}%`;
      const exportsDir = path.resolve(baseDir, 'data', 'exports');
      let exportItems: any[] = [];
      let exportTotal = 0;
      if (!libraryOnly) {
        await ensureExportIndexFresh(db, exportsDir);
        const where = q ? "WHERE file_name LIKE ? ESCAPE '\\' OR standard_number LIKE ? ESCAPE '\\' OR source LIKE ? ESCAPE '\\'" : '';
        const args = q ? [like, like, like] : [];
        exportTotal = (db.prepare(`SELECT COUNT(*) AS total FROM export_files ${where}`).get(...args) as { total: number }).total;
        exportItems = (db.prepare(`SELECT file_name, size, mtime, standard_number, source, abs_path FROM export_files ${where} ORDER BY mtime DESC LIMIT ? OFFSET ?`)
          .all(...args, localLimit, localOffset) as any[]).map(row => ({
            fileName: row.file_name, size: row.size, mtime: new Date(row.mtime).toISOString(),
            standardNumber: row.standard_number, source: row.source, path: row.abs_path,
            downloadUrl: `/api/downloads/${encodeURIComponent(row.file_name)}`, kind: 'export' as const,
          }));
      }
      const where = q ? "WHERE file_name LIKE ? ESCAPE '\\' OR std_code_norm LIKE ? ESCAPE '\\' OR source LIKE ? ESCAPE '\\'" : '';
      const args = q ? [like, like, like] : [];
      type Row = { id: number; std_code_norm: string; year: string; source: string; abs_path: string; file_name: string; size: number; mtime: number; indexed_at: string };
      let libraryTotal: number;
      let rows: Row[];
      if (seriesGrouped) {
        libraryTotal = (db.prepare(`SELECT COUNT(*) AS total FROM (SELECT std_code_norm FROM standard_files ${where} GROUP BY std_code_norm)`).get(...args) as { total: number }).total;
        const series = db.prepare(`SELECT std_code_norm, MAX(indexed_at) AS latest FROM standard_files ${where} GROUP BY std_code_norm ORDER BY latest DESC LIMIT ? OFFSET ?`)
          .all(...args, localLimit, localOffset) as Array<{ std_code_norm: string }>;
        const codes = series.map(row => row.std_code_norm);
        if (!codes.length) rows = [];
        else {
          rows = db.prepare(`SELECT id, std_code_norm, year, source, abs_path, file_name, size, mtime, indexed_at FROM standard_files WHERE std_code_norm IN (${codes.map(() => '?').join(', ')}) ORDER BY CAST(year AS INTEGER) DESC, indexed_at DESC`).all(...codes) as Row[];
          const order = new Map(codes.map((code, index) => [code, index]));
          rows.sort((a, b) => (order.get(a.std_code_norm) ?? 0) - (order.get(b.std_code_norm) ?? 0));
        }
      } else {
        libraryTotal = (db.prepare(`SELECT COUNT(*) AS total FROM standard_files ${where}`).get(...args) as { total: number }).total;
        rows = db.prepare(`SELECT id, std_code_norm, year, source, abs_path, file_name, size, mtime, indexed_at FROM standard_files ${where} ORDER BY indexed_at DESC LIMIT ? OFFSET ?`).all(...args, localLimit, localOffset) as Row[];
      }
      const libraryItems = rows.map(row => {
        const fileName = row.file_name || path.basename(row.abs_path);
        const parsed = parseLibraryFilename(fileName);
        return {
          fileName, size: row.size, mtime: new Date(row.mtime).toISOString(),
          standardNumber: parsed?.stdCodeRaw || row.std_code_norm + (row.year ? `-${row.year}` : ''),
          title: parsed?.title || '', source: row.source, path: row.abs_path,
          downloadUrl: `/api/files/${row.id}/pdf/download`, previewUrl: `/api/files/${row.id}/preview/manifest`,
          kind: 'library' as const, fileId: row.id,
        };
      });
      const items = seriesGrouped ? libraryItems : [...libraryItems, ...exportItems]
        .sort((a, b) => String(b.mtime).localeCompare(String(a.mtime))).slice(libraryOnly ? 0 : offset, libraryOnly ? undefined : offset + limit);
      respond(res, { items, total: libraryTotal + exportTotal, libraryTotal, exportTotal, limit, offset, grouped: seriesGrouped });
    } catch (error) { next(error); }
  });

  router.delete('/api/downloads/:filename', requireAdmin, async (req, res, next) => {
    try {
      const filename = safeExportName(String(req.params.filename));
      if (!filename) { respondError(res, 400, 'BAD_REQUEST', 'Invalid filename'); return; }
      const exportsDir = path.resolve(baseDir, 'data', 'exports');
      const filePath = path.resolve(exportsDir, filename);
      if (!filePath.startsWith(exportsDir + path.sep)) { respondError(res, 400, 'BAD_REQUEST', 'Invalid filename'); return; }
      await unlink(filePath);
      removeExportIndex(db, filename);
      respond(res, { ok: true });
    } catch (error) { next(error); }
  });

  return router;
}

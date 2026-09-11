import { Router } from 'express';
import { z } from 'zod';
import type Database from 'better-sqlite3';
import { getSetting, setSettings } from '../services/db';
import { normalizeError } from '../shared/errors';
import { respond, respondError } from '../shared/response';
import { resolveLibraryDir, validateLibraryDir, invalidateLibraryPathCache } from '../shared/library-paths';
import { scanLibrary, scanLibraryAfterCurrent, getIndexStats, startLibraryWatcher, stopLibraryWatcher } from '../services/library-index';
import { extractBaseCode, extractFullCode, buildFuzzyLikePattern } from '../services/qualification-service';
import { listBackupInfo, backupDbAsync } from '../services/db-backup';
import { highCostInFlightGuard, highCostRateLimit } from '../shared/high-cost-guard';

const sourceEnum = z.enum(['gbw', 'bz', 'by']);
const DEFAULT_SOURCE_PRIORITY = ['gbw', 'bz', 'by'] as const;

function parseSourcePriority(raw: string): Array<'gbw' | 'bz' | 'by'> {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [...DEFAULT_SOURCE_PRIORITY];
    const filtered = parsed.filter((s): s is 'gbw' | 'bz' | 'by' =>
      s === 'gbw' || s === 'bz' || s === 'by');
    return filtered.length > 0 ? filtered : [...DEFAULT_SOURCE_PRIORITY];
  } catch {
    return [...DEFAULT_SOURCE_PRIORITY];
  }
}

function readAdminSettings(db: Database.Database) {
  return {
    accessMode: 'guest_and_single_admin' as const,
    standardsLibraryDir: getSetting(db, 'standards_library_dir', ''),
    libraryFilenamePattern: getSetting(db, 'library_filename_pattern', '{stdCode} {title} - {source}'),
    librarySourcePriority: parseSourcePriority(
      getSetting(db, 'library_source_priority', JSON.stringify(DEFAULT_SOURCE_PRIORITY)),
    ),
    libraryWatcherEnabled: getSetting(db, 'library_watcher_enabled', '1') === '1',
    // 下载短路：搜索结果命中本地库时跳过源拉取，直接给用户那份 standards/ 的本地文件。
    // 默认开（用户原话「本地有就优先本地」）。极少数想强刷源版本的场景可关。
    downloadPreferLocal: getSetting(db, 'download_prefer_local', '1') === '1',
  };
}

/**
 * 把库实时状态附到 settings：每次 GET 都跑一次 resolveLibraryDir（带缓存）
 * 与一次 getIndexStats（一条 SQL）。不缓存到 readAdminSettings 是因为
 * fallbackUsed / writable 受用户挪文件夹影响，需要每请求都是最新。
 */
async function readAdminSettingsWithLibrary(db: Database.Database) {
  const base = readAdminSettings(db);
  const libStatus = await resolveLibraryDir(db);
  const stats = getIndexStats(db);
  return {
    ...base,
    library: {
      dir: libStatus.dir,
      writable: libStatus.writable,
      fallbackUsed: libStatus.fallbackUsed,
      fallbackReason: libStatus.fallbackReason,
      configuredDir: libStatus.configuredDir,
      indexCount: stats.count,
      lastIndexedAt: stats.lastIndexedAt,
    },
  };
}

export function createAdminRoutes(db: Database.Database) {
  const router = Router();

  // GET /api/admin/settings
  router.get('/settings', async (_req, res, next) => {
    try {
      respond(res, await readAdminSettingsWithLibrary(db));
    } catch (error) {
      next(normalizeError(error));
    }
  });

  // PUT /api/admin/settings
  router.put('/settings', async (req, res, next) => {
    try {
      const schema = z.object({
        standardsLibraryDir: z.string().max(500).optional(),
        // 模板必须含 {stdCode}，否则不同标准会落同一个文件名互相覆盖。
        // {source} 也建议要求（多源同号场景），但只软提示——少数用户单源场景可以省略。
        libraryFilenamePattern: z.string().trim().min(1).max(200).refine(
          (v) => v.includes('{stdCode}'),
          { message: '文件名模板必须包含 {stdCode} 占位符' },
        ).optional(),
        librarySourcePriority: z.array(sourceEnum).min(1).max(3).optional(),
        // chokidar 监听：用户把 PDF 拖到库目录后自动入索引。
        // 默认开启，少数 OneDrive/NAS/网盘场景手抖才需要关。
        libraryWatcherEnabled: z.boolean().optional(),
        // 下载短路开关（详见 readAdminSettings）
        downloadPreferLocal: z.boolean().optional(),
      });
      const updates = schema.parse(req.body);
      const settings: Array<readonly [string, string]> = [];
      if (updates.libraryFilenamePattern !== undefined) settings.push(['library_filename_pattern', updates.libraryFilenamePattern]);
      if (updates.librarySourcePriority !== undefined) {
        settings.push(['library_source_priority', JSON.stringify(Array.from(new Set(updates.librarySourcePriority)))]);
      }
      if (updates.downloadPreferLocal !== undefined) settings.push(['download_prefer_local', updates.downloadPreferLocal ? '1' : '0']);
      if (updates.libraryWatcherEnabled !== undefined) settings.push(['library_watcher_enabled', updates.libraryWatcherEnabled ? '1' : '0']);

      let validatedLibraryDir: string | undefined;
      if (updates.standardsLibraryDir !== undefined) {
        try {
          validatedLibraryDir = await validateLibraryDir(updates.standardsLibraryDir);
        } catch (e: any) {
          respondError(res, 400, 'BAD_REQUEST', e?.message || '设置库目录失败');
          return;
        }
        settings.push(['standards_library_dir', validatedLibraryDir]);
      }

      // 所有字段和路径先验证完，再一次事务写入；副作用只能发生在 commit 后。
      setSettings(db, settings);
      if (validatedLibraryDir !== undefined) invalidateLibraryPathCache();

      if (updates.libraryWatcherEnabled !== undefined || validatedLibraryDir !== undefined) {
        await stopLibraryWatcher();
        if (getSetting(db, 'library_watcher_enabled', '1') === '1') {
          startLibraryWatcher(db).catch(e => console.error('[admin] startLibraryWatcher 失败:', e));
        }
      }
      if (validatedLibraryDir !== undefined) {
        scanLibraryAfterCurrent(db, { full: true }).catch(() => { /* 扫描失败容忍：用户可再点重扫 */ });
      }
      respond(res, await readAdminSettingsWithLibrary(db));
    } catch (error) {
      next(normalizeError(error));
    }
  });

  // POST /api/admin/library/rescan — 强制全量重扫，返回扫描计数
  router.post('/library/rescan', highCostRateLimit, highCostInFlightGuard, async (req, res, next) => {
    try {
      const schema = z.object({ full: z.boolean().optional() });
      const { full } = schema.parse(req.body || {});
      const result = await scanLibrary(db, { full: full !== false });
      // 重扫往往因为用户手动改了库内容，watcher 也最好重建一次（dir 变了的边缘情况）
      if (getSetting(db, 'library_watcher_enabled', '1') === '1') {
        await stopLibraryWatcher();
        startLibraryWatcher(db).catch(e => console.error('[admin] startLibraryWatcher 失败:', e));
      }
      const stats = getIndexStats(db);
      respond(res, { ok: true, result, stats });
    } catch (error) {
      next(normalizeError(error));
    }
  });

  // GET /api/admin/qual/diagnose?code=GB/T 3325-2024
  //
  // 资质匹配漏命中诊断专用：给一个标准号或片段，把 DB 里所有相关 std_code 全捞回来，
  // 同时算出每行的 extractBaseCode 结果 + 与输入 base 是否相等 + Phase 1 / Phase 2
  // 命中状态，一目了然到底是哪条路径漏了。临时排查工具，定位完根因后可保留作回归
  // 用（不公开到 UI，仅 admin 通过 URL 直接拿）。
  router.get('/qual/diagnose', (req, res, next) => {
    try {
      const schema = z.object({ code: z.string().min(1).max(100) });
      const { code } = schema.parse({ code: req.query.code });

      const inputBase = extractBaseCode(code);
      const inputFull = extractFullCode(code);
      const inputPattern = buildFuzzyLikePattern(inputBase);

      // 粗筛：所有 std_code 含 code 任意子串、或 std_code 走当前 fuzzy pattern、或 base/norm 列等值命中
      // 同时输出 raw bytes（hex 头 20 字节）方便排查全角 / 不可见字符。
      const broadLike = `%${code.replace(/[%_]/g, '')}%`;
      const cnasRows = db.prepare(`
        SELECT std_code, std_code_norm, std_code_base, lab_no, COUNT(*) AS n
        FROM cnas_qualifications
        WHERE std_code LIKE ?
           ${inputPattern ? 'OR std_code LIKE ?' : ''}
           OR std_code_base = ?
           OR std_code_norm = ?
        GROUP BY std_code, lab_no
        ORDER BY std_code
        LIMIT 200
      `).all(...(inputPattern ? [broadLike, inputPattern, inputBase, inputFull] : [broadLike, inputBase, inputFull])) as Array<{ std_code: string; std_code_norm: string; std_code_base: string; lab_no: string; n: number }>;

      const cmaRows = db.prepare(`
        SELECT std_code, std_code_norm, std_code_base, cert_number, COUNT(*) AS n
        FROM cma_qualifications
        WHERE std_code LIKE ?
           ${inputPattern ? 'OR std_code LIKE ?' : ''}
           OR std_code_base = ?
           OR std_code_norm = ?
        GROUP BY std_code, cert_number
        ORDER BY std_code
        LIMIT 200
      `).all(...(inputPattern ? [broadLike, inputPattern, inputBase, inputFull] : [broadLike, inputBase, inputFull])) as Array<{ std_code: string; std_code_norm: string; std_code_base: string; cert_number: string; n: number }>;

      const annotate = (rows: Array<{ std_code: string; std_code_norm?: string; std_code_base?: string; n: number; lab_no?: string; cert_number?: string }>) =>
        rows.map(r => {
          const rowBase = extractBaseCode(r.std_code);
          const rowFull = extractFullCode(r.std_code);
          // raw bytes 头 20 字符的 hex，揪全角 / 不可见
          const hex = Array.from(r.std_code).slice(0, 20)
            .map(ch => ch.charCodeAt(0).toString(16).padStart(4, '0')).join(' ');
          return {
            stdCode: r.std_code,
            stdCodeHex: hex,
            stdCodeNormInDb: r.std_code_norm ?? '',     // 列里实际落盘的值（旧行回填前可能为空）
            stdCodeBaseInDb: r.std_code_base ?? '',
            owner: r.lab_no ?? r.cert_number ?? '',
            rowCount: r.n,
            rowBase,
            rowFull,
            baseEqualsInput: rowBase === inputBase,
            fullEqualsInput: rowFull === inputFull,
            normColumnHit: r.std_code_norm === inputFull,    // Step 2-3 索引等值匹配是否命中
            baseColumnHit: r.std_code_base === inputBase,    // Step 2-3 跨年索引匹配是否命中
            phase1ExactMatch: r.std_code === code,
            phase2LikeMatch: inputPattern
              ? new RegExp('^' + inputPattern.replace(/%/g, '.*') + '$', 'i').test(r.std_code)
              : false,
          };
        });

      respond(res, {
        input: code,
        inputBase,
        inputFull,
        inputPattern,
        cnas: { totalRows: cnasRows.length, rows: annotate(cnasRows) },
        cma: { totalRows: cmaRows.length, rows: annotate(cmaRows) },
      });
    } catch (error) {
      next(normalizeError(error));
    }
  });

  // GET /api/admin/db/backups
  // 列出所有 db 备份（userData/bzxz-db-backups/*）。管理员设置页可以展示用于
  // 验证「升级保护链路是否生效」。
  router.get('/db/backups', (_req, res, next) => {
    try {
      respond(res, { backups: listBackupInfo() });
    } catch (error) {
      next(normalizeError(error));
    }
  });

  // POST /api/admin/db/backups
  // 手动触发一次备份。打补丁前 / 大改之前管理员可以主动留一份。
  router.post('/db/backups', highCostRateLimit, highCostInFlightGuard, async (_req, res, next) => {
    try {
      await backupDbAsync(db);
      respond(res, { backups: listBackupInfo() });
    } catch (error) {
      next(normalizeError(error));
    }
  });

  return router;
}

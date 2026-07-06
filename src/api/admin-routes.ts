import { Router } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import type Database from 'better-sqlite3';
import { getSetting, setSetting, GUEST_USERNAME } from '../services/db';
import { normalizeError } from '../shared/errors';
import { respond, respondError } from '../shared/response';
import { toCamelCase } from '../shared/case';
import { resolveLibraryDir, setLibraryDir } from '../shared/library-paths';
import { scanLibrary, getIndexStats, startLibraryWatcher, stopLibraryWatcher } from '../services/library-index';
import { extractBaseCode, extractFullCode, buildFuzzyLikePattern } from '../services/qualification-service';
import { listBackupInfo, backupDbAsync } from '../services/db-backup';

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

const SALT_ROUNDS = 10;

// 注:zod enum 字面量必须就地展开,无法 spread const tuple,所以下方三处
// `z.enum([...])` 是字面量重复。任何 tab 增删时三处必须一起改 + 同步 ALL_TABS。
// 前端 TAB_ITEMS (public/js/app-auth-admin.js) 是 UI source of truth,长度需对齐
const ALL_TABS = ['search', 'tools', 'local', 'history', 'qual', 'cma-diff', 'logs', 'stats', 'settings'] as const;
export { ALL_TABS };

// New users default to the three core read/download features. Admins can grant
// extra tabs per-user from the user management UI, or change the default from
// the admin settings panel. Stored as JSON in `settings.default_allowed_tabs`.
const DEFAULT_USER_ALLOWED_TABS: readonly string[] = ['search', 'batch', 'complete'];
export { DEFAULT_USER_ALLOWED_TABS };

/**
 * Resolve the default `allowed_tabs` to apply when creating a new user.
 * Returns null when the admin has explicitly chosen "all tabs"; an array
 * (possibly empty) when restricted; or the hardcoded core-three default when
 * the setting has never been touched.
 */
export function resolveDefaultAllowedTabs(db: Database.Database): string[] | null {
  const raw = getSetting(db, 'default_allowed_tabs', '__unset__');
  if (raw === '__unset__') return [...DEFAULT_USER_ALLOWED_TABS];
  if (!raw) return null;
  return parseAllowedTabs(raw);
}

function parseAllowedTabs(raw: string | null): string[] | null {
  if (!raw) return null; // null = all tabs allowed
  try { return JSON.parse(raw); } catch { return null; }
}

function safeParseJson(raw: string): unknown {
  try { return JSON.parse(raw); } catch { return raw; }
}

function readAdminSettings(db: Database.Database) {
  return {
    registrationEnabled: getSetting(db, 'registration_enabled', '1') === '1',
    loginRequired: getSetting(db, 'login_required', '0') === '1',
    // 默认 '0' = 仅 loopback 可获 guest 回退；'1' = LAN 客户端（手机/同事 PC）也可。
    // 开启即"任何人扫到 5937 端口都能用"，账号体系失效，仅在内网完全可信场景启用。
    lanGuestAllowed: getSetting(db, 'lan_guest_allowed', '0') === '1',
    defaultAllowedTabs: resolveDefaultAllowedTabs(db),
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
        registrationEnabled: z.boolean().optional(),
        loginRequired: z.boolean().optional(),
        lanGuestAllowed: z.boolean().optional(),
        defaultAllowedTabs: z.array(z.enum(['search', 'tools', 'local', 'history', 'qual', 'cma-diff', 'logs', 'stats', 'settings'])).nullable().optional(),
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
      if (updates.registrationEnabled !== undefined) {
        setSetting(db, 'registration_enabled', updates.registrationEnabled ? '1' : '0');
      }
      if (updates.loginRequired !== undefined) {
        setSetting(db, 'login_required', updates.loginRequired ? '1' : '0');
      }
      if (updates.lanGuestAllowed !== undefined) {
        setSetting(db, 'lan_guest_allowed', updates.lanGuestAllowed ? '1' : '0');
      }
      if (updates.defaultAllowedTabs !== undefined) {
        setSetting(db, 'default_allowed_tabs', updates.defaultAllowedTabs ? JSON.stringify(updates.defaultAllowedTabs) : '');
      }
      if (updates.libraryFilenamePattern !== undefined) {
        setSetting(db, 'library_filename_pattern', updates.libraryFilenamePattern);
      }
      if (updates.librarySourcePriority !== undefined) {
        // 去重保序：用户传 ['bz','gbw','bz'] 时退化为 ['bz','gbw']
        const dedup = Array.from(new Set(updates.librarySourcePriority));
        setSetting(db, 'library_source_priority', JSON.stringify(dedup));
      }
      if (updates.downloadPreferLocal !== undefined) {
        setSetting(db, 'download_prefer_local', updates.downloadPreferLocal ? '1' : '0');
      }
      if (updates.libraryWatcherEnabled !== undefined) {
        setSetting(db, 'library_watcher_enabled', updates.libraryWatcherEnabled ? '1' : '0');
        // 切换 watcher 状态：先 stop（幂等），开启时再 start。
        // start 内部已会 resolveLibraryDir，路径变化也能跟上。
        await stopLibraryWatcher();
        if (updates.libraryWatcherEnabled) {
          startLibraryWatcher(db).catch(e => console.error('[admin] startLibraryWatcher 失败:', e));
        }
      }
      // 路径放最后处理：写完才触发 setLibraryDir + 重扫，
      // 其它配置失败时不至于先把路径改了再 rollback。
      if (updates.standardsLibraryDir !== undefined) {
        try {
          await setLibraryDir(db, updates.standardsLibraryDir);
        } catch (e: any) {
          respondError(res, 400, 'BAD_REQUEST', e?.message || '设置库目录失败');
          return;
        }
        // 路径变更后异步全量重扫；不阻塞响应，前端通过下次 GET settings 查看 indexCount
        scanLibrary(db, { full: true }).catch(() => { /* 扫描失败容忍：用户可再点重扫 */ });
        // 同步重启 watcher 让它跟上新路径
        if (getSetting(db, 'library_watcher_enabled', '1') === '1') {
          await stopLibraryWatcher();
          startLibraryWatcher(db).catch(e => console.error('[admin] startLibraryWatcher 失败:', e));
        }
      }
      respond(res, await readAdminSettingsWithLibrary(db));
    } catch (error) {
      next(normalizeError(error));
    }
  });

  // POST /api/admin/library/rescan — 强制全量重扫，返回扫描计数
  router.post('/library/rescan', async (req, res, next) => {
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
  router.post('/db/backups', async (_req, res, next) => {
    try {
      await backupDbAsync(db);
      respond(res, { backups: listBackupInfo() });
    } catch (error) {
      next(normalizeError(error));
    }
  });

  // GET /api/admin/users
  router.get('/users', (_req, res) => {
    const users = db.prepare(
      `SELECT u.id, u.username, u.display_name, u.role, u.is_active, u.allowed_tabs, u.created_at, u.updated_at,
        COALESCE(s.cnt, 0) as search_count, COALESCE(d.cnt, 0) as download_count
       FROM users u
       LEFT JOIN (SELECT user_id, COUNT(*) as cnt FROM usage_events WHERE event_type = 'search' GROUP BY user_id) s ON s.user_id = u.id
       LEFT JOIN (SELECT user_id, COUNT(*) as cnt FROM usage_events WHERE event_type = 'download' GROUP BY user_id) d ON d.user_id = u.id
       ORDER BY u.id`
    ).all() as any[];
    respond(res, {
      users: toCamelCase(users.map(u => ({ ...u, allowed_tabs: parseAllowedTabs(u.allowed_tabs) }))),
    });
  });

  // GET /api/admin/users/:id/events — user usage details
  router.get('/users/:id/events', (req, res) => {
    const userId = parseInt(req.params.id as string, 10);
    if (isNaN(userId)) {
      respondError(res, 400, 'BAD_REQUEST', '无效用户 ID');
      return;
    }

    const user = db.prepare('SELECT id, username, display_name FROM users WHERE id = ?').get(userId) as { id: number; username: string; display_name: string } | undefined;
    if (!user) {
      respondError(res, 404, 'NOT_FOUND', '用户不存在');
      return;
    }

    const limit = Math.max(1, Math.min(parseInt((req.query.limit as string) ?? '50', 10) || 50, 200));

    const summary = db.prepare(
      `SELECT event_type, COUNT(*) as count FROM usage_events WHERE user_id = ? GROUP BY event_type`
    ).all(userId) as { event_type: string; count: number }[];

    const bySource = db.prepare(
      `SELECT source, COUNT(*) as count FROM usage_events WHERE user_id = ? AND source IS NOT NULL GROUP BY source ORDER BY count DESC`
    ).all(userId) as { source: string; count: number }[];

    const recent = db.prepare(
      `SELECT id, event_type, source, standard_id, metadata, created_at FROM usage_events WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`
    ).all(userId, limit) as { id: number; event_type: string; source: string | null; standard_id: string | null; metadata: string | null; created_at: string }[];

    respond(res, {
      user: toCamelCase(user),
      summary: toCamelCase(summary),
      bySource: toCamelCase(bySource),
      recent: toCamelCase(recent.map(r => ({
        ...r,
        // A single malformed metadata row shouldn't 500 the whole endpoint —
        // fall back to the raw string so the admin can still see the event.
        metadata: r.metadata ? safeParseJson(r.metadata) : null,
      }))),
    });
  });

  // POST /api/admin/users
  router.post('/users', async (req, res, next) => {
    try {
      const schema = z.object({
        username: z.string().trim().min(2).max(32).regex(/^[a-zA-Z0-9_.\-]+$/, '用户名仅支持字母、数字、下划线、点和连字符'),
        password: z.string().min(6).max(128),
        displayName: z.string().trim().max(64).optional(),
        role: z.enum(['user', 'admin']).optional(),
        allowedTabs: z.array(z.enum(['search', 'tools', 'local', 'history', 'qual', 'cma-diff', 'logs', 'stats', 'settings'])).nullable().optional(),
      });
      const { username, password, displayName, role, allowedTabs } = schema.parse(req.body);
      if (username.toLowerCase() === GUEST_USERNAME) {
        respondError(res, 400, 'BAD_REQUEST', 'Guest username is reserved');
        return;
      }

      const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
      if (existing) {
        respondError(res, 409, 'CONFLICT', '用户名已存在');
        return;
      }

      const hash = await bcrypt.hash(password, SALT_ROUNDS);
      const tabsJson = allowedTabs ? JSON.stringify(allowedTabs) : null;
      const result = db.prepare(
        'INSERT INTO users (username, password, display_name, role, allowed_tabs) VALUES (?, ?, ?, ?, ?)'
      ).run(username, hash, displayName || '', role || 'user', tabsJson);

      respond(res, {
        user: { id: result.lastInsertRowid, username, displayName: displayName || '', role: role || 'user', allowedTabs: allowedTabs ?? null },
      }, 201);
    } catch (error) {
      next(normalizeError(error));
    }
  });

  // PUT /api/admin/users/:id
  router.put('/users/:id', async (req, res, next) => {
    try {
      const userId = parseInt(req.params.id, 10);
      if (isNaN(userId)) {
        respondError(res, 400, 'BAD_REQUEST', '无效用户 ID');
        return;
      }

      const schema = z.object({
        displayName: z.string().trim().max(64).optional(),
        role: z.enum(['user', 'admin']).optional(),
        isActive: z.boolean().optional(),
        password: z.string().min(6).max(128).optional(),
        allowedTabs: z.array(z.enum(['search', 'tools', 'local', 'history', 'qual', 'cma-diff', 'logs', 'stats', 'settings'])).nullable().optional(),
      });
      const updates = schema.parse(req.body);

      const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(userId) as { id: number; username: string } | undefined;
      if (!user) {
        respondError(res, 404, 'NOT_FOUND', '用户不存在');
        return;
      }
      if (user.username === GUEST_USERNAME && (updates.role !== undefined || updates.isActive !== undefined || updates.password !== undefined)) {
        respondError(res, 400, 'BAD_REQUEST', 'Guest user must remain a normal active user');
        return;
      }

      const sets: string[] = [];
      const values: unknown[] = [];

      if (updates.displayName !== undefined) { sets.push('display_name = ?'); values.push(updates.displayName); }
      if (updates.role !== undefined) { sets.push('role = ?'); values.push(updates.role); }
      if (updates.isActive !== undefined) { sets.push('is_active = ?'); values.push(updates.isActive ? 1 : 0); }
      if (updates.password !== undefined) {
        const hash = await bcrypt.hash(updates.password, SALT_ROUNDS);
        sets.push('password = ?'); values.push(hash);
      }
      if (updates.allowedTabs !== undefined) {
        sets.push('allowed_tabs = ?');
        values.push(updates.allowedTabs ? JSON.stringify(updates.allowedTabs) : null);
      }

      if (sets.length === 0) {
        respondError(res, 400, 'BAD_REQUEST', '没有要更新的字段');
        return;
      }

      sets.push("updated_at = ?");
      values.push(new Date().toISOString());
      values.push(userId);

      db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...values);

      // If deactivating user, delete all their sessions
      if (updates.isActive === false) {
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
      }

      const updated = db.prepare(
        'SELECT id, username, display_name, role, is_active, allowed_tabs, created_at, updated_at FROM users WHERE id = ?'
      ).get(userId) as any;

      respond(res, { user: toCamelCase({ ...updated, allowed_tabs: parseAllowedTabs(updated.allowed_tabs) }) });
    } catch (error) {
      next(normalizeError(error));
    }
  });

  // DELETE /api/admin/users/:id
  router.delete('/users/:id', (req, res) => {
    const userId = parseInt(req.params.id, 10);
    if (isNaN(userId)) {
      respondError(res, 400, 'BAD_REQUEST', '无效用户 ID');
      return;
    }

    const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(userId) as { id: number; username: string } | undefined;
    if (!user) {
      respondError(res, 404, 'NOT_FOUND', '用户不存在');
      return;
    }
    if (user.username === GUEST_USERNAME) {
      respondError(res, 400, 'BAD_REQUEST', 'Guest user cannot be deleted');
      return;
    }

    // Prevent deleting self
    if (userId === (req as any).user?.id) {
      respondError(res, 400, 'BAD_REQUEST', '不能删除自己');
      return;
    }

    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    respond(res, { ok: true });
  });

  return router;
}

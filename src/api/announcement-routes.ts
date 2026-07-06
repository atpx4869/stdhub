import { Router } from 'express';
import { z } from 'zod';
import type Database from 'better-sqlite3';
import type { Request, Response, NextFunction } from 'express';
import { normalizeError } from '../shared/errors';
import { respond, respondError } from '../shared/response';
import { toCamelCase } from '../shared/case';

interface AnnouncementRow {
  id: number;
  title: string;
  content_md: string;
  created_by: number | null;
  is_active: number;
  created_at: string;
  updated_at: string;
  created_by_name?: string | null;
  read_at?: string | null;
}

const GITHUB_RELEASE_API = 'https://api.github.com/repos/atpx4869/bzxz/releases/tags/v';
const GITHUB_LATEST_API = 'https://api.github.com/repos/atpx4869/bzxz/releases/latest';
const GITHUB_COMMITS_API = 'https://api.github.com/repos/atpx4869/bzxz/commits';

// Commits 缓存：最多 10 条结果，10 分钟内不重复请求 GitHub。
let commitsCache: { fetchedAt: number; body: Array<{ sha: string; shortSha: string; title: string; body: string; author: string; date: string; htmlUrl: string }> | null } | null = null;
const COMMITS_CACHE_MS = 10 * 60 * 1000;

async function fetchRecentCommits(limit = 10): Promise<Array<{ sha: string; shortSha: string; title: string; body: string; author: string; date: string; htmlUrl: string }> | null> {
  if (commitsCache && Date.now() - commitsCache.fetchedAt < COMMITS_CACHE_MS) return commitsCache.body;
  try {
    const res = await fetch(`${GITHUB_COMMITS_API}?per_page=${Math.min(Math.max(1, limit), 30)}`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'bzxz/announcements' },
    });
    if (!res.ok) { commitsCache = { fetchedAt: Date.now(), body: null }; return null; }
    const arr = await res.json() as Array<{ sha: string; html_url: string; commit: { message: string; author: { name: string; date: string } } }>;
    const out = arr.map(c => {
      const msg = String(c.commit?.message || '').trim();
      const firstNl = msg.indexOf('\n');
      const title = firstNl === -1 ? msg : msg.slice(0, firstNl).trim();
      const body = firstNl === -1 ? '' : msg.slice(firstNl + 1).trim();
      return {
        sha: c.sha,
        shortSha: c.sha.slice(0, 7),
        title,
        body,
        author: c.commit?.author?.name || '',
        date: c.commit?.author?.date || '',
        htmlUrl: c.html_url || '',
      };
    });
    commitsCache = { fetchedAt: Date.now(), body: out };
    return out;
  } catch {
    commitsCache = { fetchedAt: Date.now(), body: null };
    return null;
  }
}

// In-memory cache: keyed by version string, value lives ~30 min.
const releaseCache = new Map<string, { fetchedAt: number; body: { tag: string; name: string; bodyMd: string; htmlUrl: string; publishedAt: string } | null }>();
const RELEASE_CACHE_MS = 30 * 60 * 1000;

async function fetchReleaseNotes(version: string): Promise<{ tag: string; name: string; bodyMd: string; htmlUrl: string; publishedAt: string } | null> {
  const key = version || 'latest';
  const cached = releaseCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < RELEASE_CACHE_MS) return cached.body;

  const url = version ? GITHUB_RELEASE_API + encodeURIComponent(version) : GITHUB_LATEST_API;
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `bzxz/${version || 'dev'}` },
    });
    if (!res.ok) {
      releaseCache.set(key, { fetchedAt: Date.now(), body: null });
      return null;
    }
    const data = await res.json() as { tag_name?: string; name?: string; body?: string; html_url?: string; published_at?: string };
    const body = {
      tag: data.tag_name || '',
      name: data.name || data.tag_name || '',
      bodyMd: data.body || '',
      htmlUrl: data.html_url || '',
      publishedAt: data.published_at || '',
    };
    releaseCache.set(key, { fetchedAt: Date.now(), body });
    return body;
  } catch {
    releaseCache.set(key, { fetchedAt: Date.now(), body: null });
    return null;
  }
}

function listAnnouncementsForUser(db: Database.Database, userId: number, onlyUnread: boolean): AnnouncementRow[] {
  const sql = `
    SELECT a.id, a.title, a.content_md, a.created_by, a.is_active,
           a.created_at, a.updated_at,
           u.display_name AS created_by_name,
           r.read_at AS read_at
    FROM announcements a
    LEFT JOIN users u ON u.id = a.created_by
    LEFT JOIN announcement_reads r ON r.announcement_id = a.id AND r.user_id = ?
    WHERE a.is_active = 1${onlyUnread ? ' AND r.read_at IS NULL' : ''}
    ORDER BY a.created_at DESC
  `;
  return db.prepare(sql).all(userId) as AnnouncementRow[];
}

export function createAnnouncementRoutes(
  db: Database.Database,
  requireAuth: (req: Request, res: Response, next: NextFunction) => void,
  requireAdmin: (req: Request, res: Response, next: NextFunction) => void,
) {
  const router = Router();

  // GET /api/announcements — all active announcements with read state for current user
  router.get('/', requireAuth, (req, res, next) => {
    try {
      const userId = req.user!.id;
      const rows = listAnnouncementsForUser(db, userId, false);
      respond(res, { announcements: toCamelCase(rows) });
    } catch (error) { next(normalizeError(error)); }
  });

  // GET /api/announcements/unread — active announcements the user hasn't dismissed
  router.get('/unread', requireAuth, (req, res, next) => {
    try {
      const userId = req.user!.id;
      const rows = listAnnouncementsForUser(db, userId, true);
      respond(res, { announcements: toCamelCase(rows) });
    } catch (error) { next(normalizeError(error)); }
  });

  // POST /api/announcements/:id/read — mark as read for current user
  router.post('/:id/read', requireAuth, (req, res, next) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      if (isNaN(id)) { respondError(res, 400, 'BAD_REQUEST', '无效公告 ID'); return; }
      const exists = db.prepare('SELECT id FROM announcements WHERE id = ? AND is_active = 1').get(id);
      if (!exists) { respondError(res, 404, 'NOT_FOUND', '公告不存在'); return; }
      db.prepare(
        'INSERT INTO announcement_reads (announcement_id, user_id) VALUES (?, ?) ON CONFLICT(announcement_id, user_id) DO NOTHING'
      ).run(id, req.user!.id);
      respond(res, { ok: true });
    } catch (error) { next(normalizeError(error)); }
  });

  // GET /api/announcements/release-notes?version=1.2.3
  // First-launch / post-upgrade dialog content from GitHub Release notes.
  router.get('/release-notes', requireAuth, async (req, res, next) => {
    try {
      const version = String(req.query.version || '').trim().replace(/^v/i, '');
      const notes = await fetchReleaseNotes(version);
      if (!notes) { respond(res, { available: false }); return; }
      respond(res, { available: true, ...notes });
    } catch (error) { next(normalizeError(error)); }
  });

  // GET /api/announcements/recent-commits?limit=10
  // Returns the last N commits on the default branch — used as the post-upgrade
  // announcement body so users see *exactly* what changed since they last opened
  // the app, without needing a Release to be cut on GitHub.
  router.get('/recent-commits', requireAuth, async (req, res, next) => {
    try {
      const limit = Math.min(Math.max(parseInt(String(req.query.limit || '10'), 10) || 10, 1), 30);
      const commits = await fetchRecentCommits(limit);
      if (!commits) { respond(res, { available: false, commits: [] }); return; }
      respond(res, { available: true, commits });
    } catch (error) { next(normalizeError(error)); }
  });

  // ─── Admin CRUD ────────────────────────────────────────────────────────────
  const adminRouter = Router();
  adminRouter.use(requireAdmin);

  adminRouter.get('/', (_req, res, next) => {
    try {
      const rows = db.prepare(`
        SELECT a.id, a.title, a.content_md, a.created_by, a.is_active,
               a.created_at, a.updated_at,
               u.display_name AS created_by_name,
               (SELECT COUNT(*) FROM announcement_reads r WHERE r.announcement_id = a.id) AS read_count
        FROM announcements a
        LEFT JOIN users u ON u.id = a.created_by
        ORDER BY a.created_at DESC
      `).all();
      respond(res, { announcements: toCamelCase(rows) });
    } catch (error) { next(normalizeError(error)); }
  });

  adminRouter.post('/', (req, res, next) => {
    try {
      const schema = z.object({
        title: z.string().trim().min(1).max(120),
        contentMd: z.string().max(20000).default(''),
        isActive: z.boolean().optional().default(true),
      });
      const { title, contentMd, isActive } = schema.parse(req.body);
      const result = db.prepare(
        'INSERT INTO announcements (title, content_md, created_by, is_active) VALUES (?, ?, ?, ?)'
      ).run(title, contentMd, req.user!.id, isActive ? 1 : 0);
      respond(res, { id: result.lastInsertRowid }, 201);
    } catch (error) { next(normalizeError(error)); }
  });

  adminRouter.put('/:id', (req, res, next) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      if (isNaN(id)) { respondError(res, 400, 'BAD_REQUEST', '无效公告 ID'); return; }
      const schema = z.object({
        title: z.string().trim().min(1).max(120).optional(),
        contentMd: z.string().max(20000).optional(),
        isActive: z.boolean().optional(),
        resetReads: z.boolean().optional(),
      });
      const updates = schema.parse(req.body);
      const sets: string[] = [];
      const values: unknown[] = [];
      if (updates.title !== undefined) { sets.push('title = ?'); values.push(updates.title); }
      if (updates.contentMd !== undefined) { sets.push('content_md = ?'); values.push(updates.contentMd); }
      if (updates.isActive !== undefined) { sets.push('is_active = ?'); values.push(updates.isActive ? 1 : 0); }
      if (sets.length === 0 && !updates.resetReads) {
        respondError(res, 400, 'BAD_REQUEST', '没有可更新字段');
        return;
      }
      if (sets.length > 0) {
        sets.push("updated_at = datetime('now')");
        values.push(id);
        db.prepare(`UPDATE announcements SET ${sets.join(', ')} WHERE id = ?`).run(...values);
      }
      // Optional: drop all read marks so users see the updated announcement again.
      if (updates.resetReads) {
        db.prepare('DELETE FROM announcement_reads WHERE announcement_id = ?').run(id);
      }
      respond(res, { ok: true });
    } catch (error) { next(normalizeError(error)); }
  });

  adminRouter.delete('/:id', (req, res, next) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      if (isNaN(id)) { respondError(res, 400, 'BAD_REQUEST', '无效公告 ID'); return; }
      db.prepare('DELETE FROM announcements WHERE id = ?').run(id);
      respond(res, { ok: true });
    } catch (error) { next(normalizeError(error)); }
  });

  return { userRouter: router, adminRouter };
}

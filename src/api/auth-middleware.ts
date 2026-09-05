import type { Request, Response, NextFunction } from 'express';
import type Database from 'better-sqlite3';
import crypto from 'node:crypto';
import { getSetting } from '../services/db';
import { SESSION_MAX_AGE_MS, SESSION_RENEW_THRESHOLD_MS, cookieOpts } from './session-cookie';
import { respondError } from '../shared/response';

export type RequireTab = (...tabKeys: string[]) => (req: Request, res: Response, next: NextFunction) => void;

export interface AuthUser {
  id: number;
  username: string;
  display_name: string;
  role: string;
  allowed_tabs: string[] | null;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export function createAuthMiddleware(_db: Database.Database) {
  const publicTabs = new Set(['search', 'qual', 'cma-diff', 'tools']);
  const guestFallback = () => {
    const row = _db.prepare("SELECT id, username, display_name, role, allowed_tabs FROM users WHERE username = '_guest' LIMIT 1").get() as any;
    return { id: Number(row?.id || 0), username: 'guest', display_name: '游客', role: 'guest', allowed_tabs: [...publicTabs] } as AuthUser;
  };
  function parseCookie(header: string | undefined, name: string): string {
    const match = String(header || '').split(';').map(v => v.trim()).find(v => v.startsWith(`${name}=`));
    if (!match) return '';
    try { return decodeURIComponent(match.slice(name.length + 1)); } catch { return ''; }
  }
  function tokenHash(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }
  function attachUser(req: Request, res: Response, next: NextFunction): void {
    const token = parseCookie(req.headers.cookie, 'bzxz_session');
    const guest = guestFallback();
    if (!token) { req.user = guest; next(); return; }
    const row = _db.prepare(`
      SELECT u.id, u.username, u.display_name, u.role, u.allowed_tabs, s.expires_at
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = ? AND u.is_active = 1
    `).get(tokenHash(token)) as any;
    if (row && (!Number.isFinite(Date.parse(row.expires_at)) || Date.parse(row.expires_at) <= Date.now())) {
      _db.prepare('DELETE FROM sessions WHERE token = ?').run(tokenHash(token));
      req.user = guest; next(); return;
    }
    if (!row || row.role !== 'admin') { req.user = guest; next(); return; }
    req.user = { id: row.id, username: row.username, display_name: row.display_name, role: row.role, allowed_tabs: row.allowed_tabs ? JSON.parse(row.allowed_tabs) : null };
    const expires = Date.parse(row.expires_at);
    if (Number.isFinite(expires) && expires - Date.now() < SESSION_RENEW_THRESHOLD_MS) {
      const nextExpiry = new Date(Date.now() + SESSION_MAX_AGE_MS).toISOString();
      _db.prepare('UPDATE sessions SET expires_at = ? WHERE token = ?').run(nextExpiry, tokenHash(token));
      res.setHeader('Set-Cookie', cookieOpts(token));
    }
    next();
  }
  function requireAuth(req: Request, res: Response, next: NextFunction): void {
    if (!req.user) attachUser(req, res, next); else next();
  }

  function requireAdmin(req: Request, res: Response, next: NextFunction): void {
    if (req.user?.role === 'admin') { next(); return; }
    respondError(res, 403, 'ADMIN_REQUIRED', '需要管理员权限');
  }

  function requireTab(...tabKeys: string[]) {
    return (req: Request, res: Response, next: NextFunction): void => {
      if (req.user?.role === 'admin' || tabKeys.some(key => publicTabs.has(key))) { next(); return; }
      respondError(res, 403, 'TAB_FORBIDDEN', '当前身份无权访问此功能');
    };
  }

  function isLoginRequired(): boolean {
    return getSetting(_db, 'login_required', '0') === '1';
  }
  function requireSameOrigin(req: Request, res: Response, next: NextFunction): void {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) { next(); return; }
    const origin = req.get('origin');
    const referer = req.get('referer');
    const source = origin || referer;
    if (source) {
      try {
        const expected = `${req.protocol}://${req.get('host')}`;
        const actual = new URL(source).origin;
        if (actual !== expected) { respondError(res, 403, 'CSRF_ORIGIN_MISMATCH', '请求来源校验失败'); return; }
      } catch { respondError(res, 403, 'CSRF_ORIGIN_MISMATCH', '请求来源校验失败'); return; }
    }
    const authPath = req.path.startsWith('/api/auth/');
    const csrfExempt = authPath && (req.path === '/api/auth/login' || req.path === '/api/auth/setup');
    if (req.user?.role === 'admin' && !csrfExempt) {
      const cookieToken = parseCookie(req.headers.cookie, 'bzxz_csrf');
      const headerToken = req.get('x-csrf-token') || '';
      if (!cookieToken || !headerToken || cookieToken !== headerToken) {
        respondError(res, 403, 'CSRF_TOKEN_MISSING', '请求安全令牌缺失或已失效'); return;
      }
    }
    next();
  }

  return { requireAuth, requireAdmin, requireTab, isLoginRequired, attachUser, tokenHash, requireSameOrigin };
}

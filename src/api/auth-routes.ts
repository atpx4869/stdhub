import { Router } from 'express';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import type Database from 'better-sqlite3';
import type { RequestHandler } from 'express';
import { respond, respondError } from '../shared/response';
import { clearCookieHeader, clearCsrfCookieHeader, cookieOpts, csrfCookieOpts, SESSION_MAX_AGE_MS } from './session-cookie';

const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILURES = 5;
const failures = new Map<string, { count: number; until: number }>();
function clientKey(req: any): string { return String(req.ip || req.socket?.remoteAddress || 'unknown'); }
function isLoopback(req: any): boolean {
  const ip = String(req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
  return ip === '127.0.0.1' || ip === '::1';
}

export function createAuthRoutes(db: Database.Database, requireAuth: RequestHandler, requireAdmin: RequestHandler, tokenHash: (token: string) => string) {
  const router = Router();

  router.get('/status', (req, res) => {
    const user = req.user?.role === 'admin'
      ? { id: req.user.id, username: req.user.username, displayName: req.user.display_name, role: 'admin', allowedTabs: req.user.allowed_tabs }
      : { id: 0, username: 'guest', displayName: '游客', role: 'guest', allowedTabs: ['search', 'qual', 'cma-diff', 'tools'] };
    const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' AND is_active = 1 LIMIT 1").get();
    respond(res, {
      needsSetup: !admin, user,
      registrationEnabled: false,
      loginRequired: false,
      publicSettings: { downloadPreferLocal: true },
    });
  });

  router.post('/login', (req, res) => {
    const key = clientKey(req);
    const state = failures.get(key);
    if (state && state.until > Date.now()) { respondError(res, 429, 'LOGIN_RATE_LIMITED', '登录尝试过于频繁，请稍后再试'); return; }
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const admin = db.prepare("SELECT id, username, password, display_name, allowed_tabs FROM users WHERE role = 'admin' AND is_active = 1 ORDER BY id LIMIT 1").get() as any;
    if (!admin || !password || !bcrypt.compareSync(password, admin.password)) {
      const next = state && state.until <= Date.now() ? { count: 0, until: 0 } : (state || { count: 0, until: 0 });
      next.count += 1; if (next.count >= MAX_FAILURES) { next.count = 0; next.until = Date.now() + LOGIN_WINDOW_MS; }
      failures.set(key, next); respondError(res, 401, 'INVALID_CREDENTIALS', '管理员密码错误'); return;
    }
    failures.delete(key);
    const rawToken = crypto.randomBytes(32).toString('base64url');
    const csrfToken = crypto.randomBytes(24).toString('base64url');
    db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(tokenHash(rawToken), admin.id, new Date(Date.now() + SESSION_MAX_AGE_MS).toISOString());
    res.setHeader('Set-Cookie', cookieOpts(rawToken));
    res.append('Set-Cookie', csrfCookieOpts(csrfToken));
    respond(res, { ok: true, user: { id: admin.id, username: admin.username, displayName: admin.display_name, role: 'admin', allowedTabs: admin.allowed_tabs ? JSON.parse(admin.allowed_tabs) : null } });
  });

  router.post('/setup', (req, res) => {
    if (!isLoopback(req) && process.env.STDHUB_ADMIN_SETUP_TOKEN !== String(req.body?.setupToken || '')) {
      respondError(res, 403, 'SETUP_FORBIDDEN', '管理员初始化仅允许本机或配置初始化令牌');
      return;
    }
    const existing = db.prepare("SELECT id FROM users WHERE role = 'admin' AND is_active = 1 LIMIT 1").get();
    if (existing) { respondError(res, 409, 'ALREADY_CONFIGURED', '管理员已完成初始化'); return; }
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (password.length < 8 || password.length > 128) { respondError(res, 400, 'BAD_REQUEST', '管理员密码长度必须为 8 至 128 位'); return; }
    const hash = bcrypt.hashSync(password, 10);
    const result = db.prepare(
      "INSERT INTO users (username, password, display_name, role, is_active, allowed_tabs) VALUES ('admin', ?, '管理员', 'admin', 1, NULL)"
    ).run(hash);
    const rawToken = crypto.randomBytes(32).toString('base64url');
    const csrfToken = crypto.randomBytes(24).toString('base64url');
    db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(tokenHash(rawToken), result.lastInsertRowid, new Date(Date.now() + SESSION_MAX_AGE_MS).toISOString());
    res.setHeader('Set-Cookie', cookieOpts(rawToken));
    res.append('Set-Cookie', csrfCookieOpts(csrfToken));
    respond(res, { ok: true, user: { id: Number(result.lastInsertRowid), username: 'admin', displayName: '管理员', role: 'admin', allowedTabs: null } });
  });

  router.post('/logout', requireAuth, (req, res) => {
    const token = String(req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith('bzxz_session='))?.slice('bzxz_session='.length);
    if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(tokenHash(decodeURIComponent(token)));
    res.setHeader('Set-Cookie', [clearCookieHeader(), clearCsrfCookieHeader()]); respond(res, { ok: true });
  });

  router.put('/password', requireAdmin, (req, res) => {
    const oldPassword = typeof req.body?.oldPassword === 'string' ? req.body.oldPassword : '';
    const newPassword = typeof req.body?.newPassword === 'string' ? req.body.newPassword : '';
    const admin = db.prepare("SELECT id, password FROM users WHERE role = 'admin' AND is_active = 1 ORDER BY id LIMIT 1").get() as any;
    if (!admin || !bcrypt.compareSync(oldPassword, admin.password)) { respondError(res, 401, 'INVALID_CREDENTIALS', '原管理员密码错误'); return; }
    if (newPassword.length < 8 || newPassword.length > 128) { respondError(res, 400, 'BAD_REQUEST', '新密码长度必须为 8 至 128 位'); return; }
    db.prepare("UPDATE users SET password = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(bcrypt.hashSync(newPassword, 10), admin.id);
    respond(res, { ok: true });
  });

  return router;
}

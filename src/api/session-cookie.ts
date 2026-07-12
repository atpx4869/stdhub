// Single source of truth for session lifetime + Set-Cookie formatting.
// Imported by both auth-routes (login/register/logout) and auth-middleware
// (sliding renewal). Keeping it in its own file avoids a circular dep —
// auth-routes already imports from auth-middleware.

export const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 天

// 续期阈值：剩余时间小于此值时，访问会触发滑窗续期（DB + Cookie 同时刷新）。
// 设为半个周期 = 15 天，意味着用户只要每 15 天上线一次就永远在线；
// 比"剩 1 小时才续"宽松得多，避免长期访客 Cookie 自己到期。
export const SESSION_RENEW_THRESHOLD_MS = SESSION_MAX_AGE_MS / 2;

// SameSite=Strict blocks the cookie from being sent on cross-site navigations
// (mitigating CSRF on state-changing endpoints). `Secure` would prevent the
// cookie from being sent over plain HTTP, which is the normal LAN deployment
// mode for this app — gate it behind an env opt-in for HTTPS deployments.
const COOKIE_SECURE = process.env.BZXZ_COOKIE_SECURE === '1';

export function cookieOpts(token: string): string {
  const expires = new Date(Date.now() + SESSION_MAX_AGE_MS).toUTCString();
  const flags = ['HttpOnly', 'SameSite=Strict', 'Path=/', `Max-Age=${SESSION_MAX_AGE_MS / 1000}`, `Expires=${expires}`];
  if (COOKIE_SECURE) flags.push('Secure');
  return `bzxz_session=${token}; ${flags.join('; ')}`;
}

export function clearCookieHeader(): string {
  const flags = ['HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=0'];
  if (COOKIE_SECURE) flags.push('Secure');
  return `bzxz_session=; ${flags.join('; ')}`;
}

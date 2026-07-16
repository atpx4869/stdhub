import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { respondError } from '../shared/response';

const PROXY_TOKEN_HEADER = 'x-stdhub-proxy-token';

function matchesToken(expected: string, actual: string): boolean {
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(actual);
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}

function readPresentedToken(req: Request): string {
  const header = req.get(PROXY_TOKEN_HEADER);
  if (header) return header.trim();
  const authorization = req.get('authorization') || '';
  return authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
}

export function getProxyTokenStatus(): { enabled: boolean; header: string } {
  return { enabled: Boolean(process.env.STDHUB_PROXY_TOKEN?.trim()), header: PROXY_TOKEN_HEADER };
}

/**
 * 可选的反向代理共享令牌。
 * 未配置时不改变现有部署；配置后要求 Lucky/其他反代为每个请求注入同一个私密 Header。
 */
export function createProxyTokenGuard() {
  const expected = process.env.STDHUB_PROXY_TOKEN?.trim() || '';
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!expected || matchesToken(expected, readPresentedToken(req))) {
      next();
      return;
    }
    if (!req.path.startsWith('/api/') && req.accepts('html')) {
      res.status(403).type('text/plain; charset=utf-8').send('访问被反向代理保护策略拒绝');
      return;
    }
    respondError(res, 403, 'PROXY_TOKEN_REQUIRED', '访问需要反向代理令牌');
  };
}

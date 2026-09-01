import type { Request, Response, NextFunction } from 'express';
import { respondError } from './response';

interface Bucket {
  hits: number[]; // timestamps in ms, ascending
}

export interface RateLimiterOptions {
  windowMs: number;
  max: number;
  keyFn: (req: Request) => string;
  message?: string;
}

/**
 * Sliding-window rate limiter, in-memory per process. Suitable for the desktop
 * app's single-node deployment — restart clears state, which is acceptable for
 * brute-force defense. Each unique key gets at most `max` hits per `windowMs`.
 */
export function createRateLimiter(opts: RateLimiterOptions) {
  const buckets = new Map<string, Bucket>();
  const { windowMs, max, keyFn, message = '请求过于频繁，请稍后再试' } = opts;

  // Periodic cleanup: drop fully-expired buckets every minute to bound memory.
  const cleanupTimer: ReturnType<typeof setInterval> = setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [key, bucket] of buckets) {
      while (bucket.hits.length && bucket.hits[0] < cutoff) bucket.hits.shift();
      if (bucket.hits.length === 0) buckets.delete(key);
    }
  }, 60_000);
  cleanupTimer.unref?.();

  return function rateLimit(req: Request, res: Response, next: NextFunction) {
    const key = keyFn(req);
    if (!key) { next(); return; }

    const now = Date.now();
    const cutoff = now - windowMs;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { hits: [] };
      buckets.set(key, bucket);
    }
    while (bucket.hits.length && bucket.hits[0] < cutoff) bucket.hits.shift();

    if (bucket.hits.length >= max) {
      const retryAfterSec = Math.ceil((bucket.hits[0] + windowMs - now) / 1000);
      res.setHeader('Retry-After', String(Math.max(1, retryAfterSec)));
      respondError(res, 429, 'TOO_MANY_REQUESTS', message);
      return;
    }
    bucket.hits.push(now);
    next();
  };
}

export function clientIp(req: Request): string {
  // req.ip 已按 Express 的 trust proxy 配置解析；反代部署不能优先使用 socket 地址，
  // 否则所有客户端都会共享代理服务器的同一个限流桶。
  return (req.ip || req.socket.remoteAddress || 'unknown').replace(/^::ffff:/, '');
}

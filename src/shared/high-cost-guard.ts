import type { NextFunction, Request, Response } from 'express';
import { clientIp, createRateLimiter } from './rate-limit';
import { respondError } from './response';

export const highCostRateLimit = createRateLimiter({
  windowMs: 60_000,
  max: Number(process.env.STDHUB_HIGH_COST_RATE_PER_MINUTE || 30),
  keyFn: (req) => `${clientIp(req)}:${req.method}:${req.path}`,
  message: '操作过于频繁，请稍后再试',
});

export const heavySyncRateLimit = createRateLimiter({
  windowMs: 10 * 60_000,
  max: Number(process.env.STDHUB_HEAVY_SYNC_RATE_PER_10_MINUTES || 8),
  keyFn: (req) => `${clientIp(req)}:${req.method}:${req.path}`,
  message: '同步任务触发过于频繁，请稍后再试',
});

interface InFlightOptions {
  maxActive: number;
  maxQueue: number;
  timeoutMs: number;
  message?: string;
}

export function createInFlightGuard(opts: InFlightOptions) {
  let active = 0;
  const queue: Array<() => void> = [];
  const message = opts.message || '服务器正忙，请稍后再试';

  function release(): void {
    active = Math.max(0, active - 1);
    const next = queue.shift();
    if (next) next();
  }

  function attachRelease(res: Response): void {
    let released = false;
    const releaseOnce = () => {
      if (released) return;
      released = true;
      release();
    };
    res.once('finish', releaseOnce);
    res.once('close', releaseOnce);
  }

  return function inFlightGuard(_req: Request, res: Response, next: NextFunction) {
    if (active < opts.maxActive) {
      active++;
      attachRelease(res);
      next();
      return;
    }

    if (queue.length >= opts.maxQueue) {
      respondError(res, 429, 'TOO_MANY_REQUESTS', message);
      return;
    }

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const index = queue.indexOf(run);
      if (index >= 0) queue.splice(index, 1);
      respondError(res, 429, 'TOO_MANY_REQUESTS', message);
    }, opts.timeoutMs);

    const run = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      active++;
      attachRelease(res);
      next();
    };
    queue.push(run);
  };
}

export const highCostInFlightGuard = createInFlightGuard({
  maxActive: Number(process.env.STDHUB_HIGH_COST_ACTIVE_LIMIT || 4),
  maxQueue: Number(process.env.STDHUB_HIGH_COST_QUEUE_LIMIT || 12),
  timeoutMs: Number(process.env.STDHUB_HIGH_COST_QUEUE_TIMEOUT_MS || 15_000),
});

export const heavySyncInFlightGuard = createInFlightGuard({
  maxActive: Number(process.env.STDHUB_HEAVY_SYNC_ACTIVE_LIMIT || 2),
  maxQueue: Number(process.env.STDHUB_HEAVY_SYNC_QUEUE_LIMIT || 4),
  timeoutMs: Number(process.env.STDHUB_HEAVY_SYNC_QUEUE_TIMEOUT_MS || 10_000),
  message: '同步任务队列已满，请稍后再试',
});

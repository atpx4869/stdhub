import { z } from 'zod';

export function normalizeError(e: unknown): Error {
  if (e instanceof z.ZodError) return new BadRequestError('Invalid request', e.flatten());
  return e instanceof Error ? e : new Error(String(e));
}

export function parseCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match?.[1];
}

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export class BadRequestError extends AppError {
  constructor(message: string, details?: unknown) {
    super(400, 'BAD_REQUEST', message, details);
    this.name = 'BadRequestError';
  }
}

export class NotFoundError extends AppError {
  constructor(message: string, details?: unknown) {
    super(404, 'NOT_FOUND', message, details);
    this.name = 'NotFoundError';
  }
}

export class UpstreamError extends AppError {
  constructor(message: string, details?: unknown) {
    super(502, 'UPSTREAM_ERROR', message, details);
    this.name = 'UpstreamError';
  }
}

/**
 * 把 Playwright / 浏览器类错误信息压缩成可读摘要。
 * 浏览器 launch 失败时 err.message 会把整条命令行参数串进去（几 KB），
 * 直接存 DB 会让「状态: error」hover 时刷屏。这里只保留首行 + 关键信号。
 */
export function summarizeSyncError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);

  // Playwright 会把浏览器启动命令行塞进 message。无论它换不换行，都优先截取
  // 「Browser logs:」/「Call log:」这些分段标记之前的内容，去掉命令行垃圾。
  let head = raw;
  const segmentMarkers = ['Browser logs:', 'Call log:', '<launching>', '<launched>'];
  for (const marker of segmentMarkers) {
    const idx = head.indexOf(marker);
    if (idx >= 0) head = head.slice(0, idx);
  }
  head = head.trim();

  // 再取首个换行符之前的内容作为主错误行
  const firstLine = head.split('\n')[0].trim();
  if (!firstLine) return raw.slice(0, 200);

  // 提炼已知关键信号，帮助快速定位根因
  const signals: string[] = [];
  const pairs: Array<[RegExp, string]> = [
    [/chrome_crashpad_handler/i, 'chrome_crashpad_handler'],
    [/SIGTRAP/i, 'SIGTRAP'],
    [/SIGSEGV/i, 'SIGSEGV'],
    [/--database is required/i, 'crashpad_database_missing'],
    [/Connection reset by peer/i, 'connection_reset'],
    [/Target (page, context or browser has been closed|closed)/i, 'target_closed'],
    [/browser has been closed/i, 'browser_closed'],
    [/anti-bot/i, 'anti_bot'],
    [/__jsl/i, 'anti_bot_challenge'],
    [/timeout/i, 'timeout'],
  ];
  for (const [re, label] of pairs) {
    if (re.test(raw) && !signals.includes(label)) signals.push(label);
  }

  const signalPart = signals.length ? ` [${signals.join(', ')}]` : '';
  const line = firstLine.length > 180 ? firstLine.slice(0, 180) + '…' : firstLine;
  return line + signalPart;
}

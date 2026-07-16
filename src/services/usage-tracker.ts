import type Database from 'better-sqlite3';
import type { Request } from 'express';

// 客户端上下文 + 操作结果。从请求注入（见 extractUsageCtx）。
export interface UsageCtx {
  ip?: string | null;
  hostname?: string | null;
  client?: string | null;     // 'web' | 'mobile'
  result?: 'success' | 'fail';
  error?: string | null;
}

// 从请求里解析 ip / hostname / client。
// client 由自定义头优先、否则按 UA 粗判（移动 UA → mobile，其余 → web）。
export function extractUsageCtx(req: Request): UsageCtx {
  const hostname = (req.get('x-client-host') || '').trim() || null;
  let client = (req.get('x-client-type') || '').trim().toLowerCase();
  if (client !== 'web' && client !== 'mobile') {
    const ua = (req.get('user-agent') || '').toLowerCase();
    if (/android|iphone|ipad|mobile/.test(ua)) client = 'mobile';
    else client = 'web';
  }
  // req.ip 受 app.set('trust proxy') 影响；局域网部署下即客户端内网 IP。
  const ip = (req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/, '') || null;
  return { ip, hostname, client };
}

export function trackEvent(
  db: Database.Database,
  userId: number,
  eventType: string,
  source?: string,
  standardId?: string,
  metadata?: Record<string, unknown>,
  ctx?: UsageCtx,
): void {
  db.prepare(
    `INSERT INTO usage_events
       (user_id, event_type, source, standard_id, metadata, ip, hostname, client, result, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    userId,
    eventType,
    source ?? null,
    standardId ?? null,
    metadata ? JSON.stringify(metadata) : null,
    ctx?.ip ?? null,
    ctx?.hostname ?? null,
    ctx?.client ?? null,
    ctx?.result ?? null,
    ctx?.error ?? null,
  );
}

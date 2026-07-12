import type { NextFunction, Request, Response } from 'express';

function configuredOrigins(): Set<string> {
  return new Set(
    String(process.env.BZXZ_CORS_ORIGINS || '')
      .split(',')
      .map(origin => origin.trim())
      .filter(Boolean),
  );
}

function isSameOriginRequest(req: Request, origin: string): boolean {
  const host = req.get('host');
  return Boolean(host) && origin === req.protocol + '://' + host;
}

/**
 * Allows explicitly configured native/web clients to call /api with credentials.
 * With no BZXZ_CORS_ORIGINS configured, this is a no-op for existing same-origin
 * deployments and rejects cross-origin API calls instead of reflecting origins.
 */
export function createApiCorsMiddleware() {
  const allowedOrigins = configuredOrigins();

  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.path.startsWith('/api/')) {
      next();
      return;
    }

    const origin = req.get('origin');
    if (!origin || isSameOriginRequest(req, origin)) {
      next();
      return;
    }

    if (!allowedOrigins.has(origin)) {
      res.status(403).json({ data: null, error: { code: 'CORS_ORIGIN_DENIED', message: 'Origin is not allowed' } });
      return;
    }

    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', req.get('access-control-request-headers') || 'Content-Type, Authorization');
    res.setHeader('Access-Control-Max-Age', '600');
    res.append('Vary', 'Origin');

    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }

    next();
  };
}

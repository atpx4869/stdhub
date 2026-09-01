import type { Request, Response, NextFunction } from 'express';
import type Database from 'better-sqlite3';

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
  // 单用户开放管理员模式：路由守卫保留签名，实际边界由 bind host / proxy token 负责。
  function requireAuth(_req: Request, _res: Response, next: NextFunction): void {
    next();
  }

  function requireAdmin(_req: Request, _res: Response, next: NextFunction): void {
    next();
  }

  function requireTab(..._tabKeys: string[]) {
    return (_req: Request, _res: Response, next: NextFunction): void => {
      next();
    };
  }

  function isLoginRequired(): boolean {
    return false;
  }

  return { requireAuth, requireAdmin, requireTab, isLoginRequired };
}

import type { Response } from 'express';
import { AppError } from './errors';

export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
}

export type ApiResult<T> =
  | { data: T; error: null }
  | { data: null; error: ApiError };

export function ok<T>(data: T): ApiResult<T> {
  return { data, error: null };
}

export function err(code: string, message: string, details?: unknown): ApiResult<never> {
  return { data: null, error: details === undefined ? { code, message } : { code, message, details } };
}

export function respond<T>(res: Response, data: T, status = 200): void {
  res.status(status).json(ok(data));
}

export function respondError(res: Response, status: number, code: string, message: string, details?: unknown): void {
  res.status(status).json(err(code, message, details));
}

export function fromAppError(e: AppError): ApiResult<never> {
  return err(e.code, e.message, e.details);
}

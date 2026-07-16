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

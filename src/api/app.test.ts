import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createApp } from './app';

// 认证已禁用 — 所有请求注入默认 admin 用户

describe('createApp', () => {
  const app = () => createApp();

  it('returns health status', async () => {
    const response = await request(app()).get('/api/health');
    expect(response.status).toBe(200);
    expect(response.body.error).toBeNull();
    expect(response.body.data.ok).toBe(true);
  });

  it('auth status returns default admin user', async () => {
    const response = await request(app()).get('/api/auth/status');
    expect(response.status).toBe(200);
    expect(response.body.data?.user).toMatchObject({
      username: 'admin',
      role: 'admin',
    });
  });

  it('all routes are accessible without auth', async () => {
    const response = await request(app()).get('/api/admin/users');
    expect(response.status).toBe(200);
  });

  it('validates search query', async () => {
    const response = await request(app()).get('/api/standards/search');
    expect(response.status).toBe(400);
    expect(response.body.error?.code).toBe('BAD_REQUEST');
  });

  it('returns not found for unknown export task', async () => {
    const response = await request(app()).get('/api/tasks/unknown-task');
    expect(response.status).toBe(404);
    expect(response.body.error?.code).toBe('NOT_FOUND');
  });

  it('allows an explicitly configured Capacitor API origin', async () => {
    const previous = process.env.BZXZ_CORS_ORIGINS;
    process.env.BZXZ_CORS_ORIGINS = 'capacitor://localhost';
    try {
      const response = await request(app())
        .options('/api/health')
        .set('Origin', 'capacitor://localhost')
        .set('Access-Control-Request-Headers', 'content-type');
      expect(response.status).toBe(204);
      expect(response.headers['access-control-allow-origin']).toBe('capacitor://localhost');
      expect(response.headers['access-control-allow-credentials']).toBe('true');
    } finally {
      if (previous === undefined) delete process.env.BZXZ_CORS_ORIGINS;
      else process.env.BZXZ_CORS_ORIGINS = previous;
    }
  });

  it('rejects an unconfigured cross-origin API request', async () => {
    const previous = process.env.BZXZ_CORS_ORIGINS;
    delete process.env.BZXZ_CORS_ORIGINS;
    try {
      const response = await request(app())
        .get('/api/health')
        .set('Origin', 'capacitor://localhost');
      expect(response.status).toBe(403);
      expect(response.body.error?.code).toBe('CORS_ORIGIN_DENIED');
    } finally {
      if (previous === undefined) delete process.env.BZXZ_CORS_ORIGINS;
      else process.env.BZXZ_CORS_ORIGINS = previous;
    }
  });
});

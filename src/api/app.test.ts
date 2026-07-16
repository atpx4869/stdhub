import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from './app';
import { resetDbForTesting } from '../services/db';

// 认证已禁用 — 所有请求注入默认 admin 用户

const testDataDir = path.join(process.cwd(), 'data');

describe('createApp', () => {
  beforeAll(() => {
    mkdirSync(testDataDir, { recursive: true });
  });

  afterAll(() => {
    resetDbForTesting();
    rmSync(testDataDir, { recursive: true, force: true });
  });

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

  it('requires the configured proxy token', async () => {
    const previous = process.env.STDHUB_PROXY_TOKEN;
    process.env.STDHUB_PROXY_TOKEN = 'test-proxy-token';
    try {
      const protectedApp = createApp();
      const denied = await request(protectedApp).get('/api/health');
      expect(denied.status).toBe(403);
      expect(denied.body.error?.code).toBe('PROXY_TOKEN_REQUIRED');

      const allowed = await request(protectedApp)
        .get('/api/health')
        .set('X-StdHub-Proxy-Token', 'test-proxy-token');
      expect(allowed.status).toBe(200);
    } finally {
      if (previous === undefined) delete process.env.STDHUB_PROXY_TOKEN;
      else process.env.STDHUB_PROXY_TOKEN = previous;
    }
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
});

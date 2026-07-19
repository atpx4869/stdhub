import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from './app';

// 认证已禁用 — 所有请求注入默认 admin 用户

describe('createApp', () => {
  let testRoot: string;
  let testDbPath: string;
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    testRoot = mkdtempSync(path.join(tmpdir(), 'stdhub-app-test-'));
    testDbPath = path.join(testRoot, 'data', 'bzxz.db');
    mkdirSync(path.dirname(testDbPath), { recursive: true });
    app = createApp({
      baseDir: testRoot,
      dbPath: testDbPath,
      startBackgroundJobs: false,
    });
  });

  afterAll(async () => {
    await app.shutdown();
    rmSync(testRoot, { recursive: true, force: true });
  });

  it('returns health status', async () => {
    const response = await request(app).get('/api/health');
    expect(response.status).toBe(200);
    expect(response.body.error).toBeNull();
    expect(response.body.data.ok).toBe(true);
  });

  it('auth status returns default admin user', async () => {
    const response = await request(app).get('/api/auth/status');
    expect(response.status).toBe(200);
    expect(response.body.data?.user).toMatchObject({
      username: 'admin',
      role: 'admin',
    });
  });

  it('requires the configured proxy token', async () => {
    const previous = process.env.STDHUB_PROXY_TOKEN;
    process.env.STDHUB_PROXY_TOKEN = 'test-proxy-token';
    let protectedApp: ReturnType<typeof createApp> | null = null;
    try {
      protectedApp = createApp({
        baseDir: testRoot,
        dbPath: testDbPath,
        startBackgroundJobs: false,
      });
      const denied = await request(protectedApp).get('/api/health');
      expect(denied.status).toBe(403);
      expect(denied.body.error?.code).toBe('PROXY_TOKEN_REQUIRED');

      const allowed = await request(protectedApp)
        .get('/api/health')
        .set('X-StdHub-Proxy-Token', 'test-proxy-token');
      expect(allowed.status).toBe(200);
    } finally {
      if (protectedApp) await protectedApp.shutdown();
      if (previous === undefined) delete process.env.STDHUB_PROXY_TOKEN;
      else process.env.STDHUB_PROXY_TOKEN = previous;
    }
  });

  it('keeps labr and auto-sync state inside the isolated app', async () => {
    const labrHealth = await request(app).get('/api/labr/health');
    expect(labrHealth.status).toBe(200);

    const update = await request(app)
      .put('/api/auto-sync/settings')
      .send({ autosyncEnabled: true, autosyncQualEnabled: true, autosyncCaplibEnabled: true });
    expect(update.status).toBe(200);

    const status = await request(app).get('/api/auto-sync/status');
    expect(status.status).toBe(200);
    expect(status.body.data.nextQualRunAt).toBeNull();
    expect(status.body.data.nextCapLibRunAt).toBeNull();
  });

  it('all routes are accessible without auth', async () => {
    const response = await request(app).get('/api/admin/users');
    expect(response.status).toBe(200);
  });

  it('validates search query', async () => {
    const response = await request(app).get('/api/standards/search');
    expect(response.status).toBe(400);
    expect(response.body.error?.code).toBe('BAD_REQUEST');
  });

  it('returns not found for unknown export task', async () => {
    const response = await request(app).get('/api/tasks/unknown-task');
    expect(response.status).toBe(404);
    expect(response.body.error?.code).toBe('NOT_FOUND');
  });
});

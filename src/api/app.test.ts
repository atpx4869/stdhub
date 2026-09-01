import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createApp } from './app';
import { getSetting, setSettings } from '../services/db';

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

  it('trusts only the nearest proxy hop by default', () => {
    expect(app.get('trust proxy')).toBe(1);
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

  it('rejects invalid auto-sync settings without partial writes', async () => {
    const db = app.locals.db;
    const beforeEnabled = getSetting(db, 'autosync_enabled', '0');
    const beforeCron = getSetting(db, 'autosync_qual_cron', '0 3 * * 0');
    const response = await request(app)
      .put('/api/auto-sync/settings')
      .send({ autosyncEnabled: !Boolean(beforeEnabled === '1'), autosyncQualCron: 'invalid cron' });
    expect(response.status).toBe(400);
    expect(getSetting(db, 'autosync_enabled', '0')).toBe(beforeEnabled);
    expect(getSetting(db, 'autosync_qual_cron', '0 3 * * 0')).toBe(beforeCron);
  });

  it('rejects out-of-range cron values without partial writes', async () => {
    const db = app.locals.db;
    const beforeEnabled = getSetting(db, 'autosync_enabled', '0');
    const beforeCron = getSetting(db, 'autosync_qual_cron', '0 3 * * 0');
    const response = await request(app)
      .put('/api/auto-sync/settings')
      .send({ autosyncEnabled: beforeEnabled !== '1', autosyncQualCron: '99 * * * *' });
    expect(response.status).toBe(400);
    expect(getSetting(db, 'autosync_enabled', '0')).toBe(beforeEnabled);
    expect(getSetting(db, 'autosync_qual_cron', '0 3 * * 0')).toBe(beforeCron);
  });

  it('rejects malformed cron tokens without partial writes', async () => {
    const db = app.locals.db;
    const before = getSetting(db, 'autosync_qual_cron', '0 3 * * 0');
    for (const cron of ['1junk * * * *', '1/2 * * * *', '1.5 * * * *']) {
      const response = await request(app).put('/api/auto-sync/settings').send({ autosyncQualCron: cron });
      expect(response.status).toBe(400);
      expect(getSetting(db, 'autosync_qual_cron', '0 3 * * 0')).toBe(before);
    }
  });

  it('does not reload auto-sync for an empty settings update', async () => {
    const scheduler = app.locals.autoSyncScheduler as any;
    const before = scheduler.getState();
    const response = await request(app).put('/api/auto-sync/settings').send({});
    expect(response.status).toBe(200);
    expect(scheduler.getState()).toEqual(before);
  });

  it('rejects an invalid library path without changing other admin settings', async () => {
    const db = app.locals.db;
    const beforeLogin = getSetting(db, 'login_required', '0');
    const invalidPath = path.join(testRoot, 'not-a-directory');
    mkdirSync(path.dirname(invalidPath), { recursive: true });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(invalidPath, 'file blocks directory creation');
    const response = await request(app)
      .put('/api/admin/settings')
      .send({ loginRequired: beforeLogin !== '1', standardsLibraryDir: path.join(invalidPath, 'child') });
    expect(response.status).toBe(400);
    expect(getSetting(db, 'login_required', '0')).toBe(beforeLogin);
  });

  it('rejects invalid qualification keys without partial writes', async () => {
    const db = app.locals.db;
    const before = getSetting(db, 'qual_sync_concurrency', '1');
    const response = await request(app)
      .put('/api/qualifications/settings')
      .send({ qual_sync_concurrency: '4', invalid_key: 'written-first-before-D3' });
    expect(response.status).toBe(400);
    expect(getSetting(db, 'qual_sync_concurrency', '1')).toBe(before);
    expect(getSetting(db, 'invalid_key', '')).toBe('');
  });

  it('rolls back auto-sync endpoint writes and skips scheduler side effects on DB failure', async () => {
    const db = app.locals.db;
    const scheduler = app.locals.autoSyncScheduler as any;
    const stopSpy = vi.spyOn(scheduler, 'stop');
    const beforeEnabled = getSetting(db, 'autosync_enabled', '0');
    const beforeCron = getSetting(db, 'autosync_qual_cron', '0 3 * * 0');
    db.exec(`CREATE TRIGGER fail_d3_autosync BEFORE INSERT ON settings WHEN NEW.key = 'autosync_qual_cron' BEGIN SELECT RAISE(ABORT, 'injected auto-sync settings failure'); END;`);
    try {
      const response = await request(app).put('/api/auto-sync/settings').send({
        autosyncEnabled: beforeEnabled !== '1',
        autosyncQualCron: '5 4 * * 1',
      });
      expect(response.status).toBe(500);
      expect(getSetting(db, 'autosync_enabled', '0')).toBe(beforeEnabled);
      expect(getSetting(db, 'autosync_qual_cron', '0 3 * * 0')).toBe(beforeCron);
      expect(stopSpy).not.toHaveBeenCalled();
    } finally {
      stopSpy.mockRestore();
      db.exec('DROP TRIGGER fail_d3_autosync');
    }
  });

  it('rolls back admin endpoint writes before watcher and scan side effects on DB failure', async () => {
    const db = app.locals.db;
    const beforeLogin = getSetting(db, 'login_required', '0');
    const beforeDir = getSetting(db, 'standards_library_dir', '');
    const validDir = path.join(testRoot, 'atomic-library');
    db.exec(`CREATE TRIGGER fail_d3_admin BEFORE INSERT ON settings WHEN NEW.key = 'standards_library_dir' BEGIN SELECT RAISE(ABORT, 'injected admin settings failure'); END;`);
    try {
      const response = await request(app).put('/api/admin/settings').send({
        loginRequired: beforeLogin !== '1',
        standardsLibraryDir: validDir,
      });
      expect(response.status).toBe(500);
      expect(getSetting(db, 'login_required', '0')).toBe(beforeLogin);
      expect(getSetting(db, 'standards_library_dir', '')).toBe(beforeDir);
    } finally {
      db.exec('DROP TRIGGER fail_d3_admin');
    }
  });

  it('rolls back qualification endpoint writes on a later DB failure', async () => {
    const db = app.locals.db;
    const beforeConcurrency = getSetting(db, 'qual_sync_concurrency', '1');
    const beforeExtra = getSetting(db, 'qual_test_extra', '');
    db.exec(`CREATE TRIGGER fail_d3_qual BEFORE INSERT ON settings WHEN NEW.key = 'qual_test_extra' BEGIN SELECT RAISE(ABORT, 'injected qualification settings failure'); END;`);
    try {
      const response = await request(app).put('/api/qualifications/settings').send({
        qual_sync_concurrency: '4',
        qual_test_extra: 'boom',
      });
      expect(response.status).toBe(500);
      expect(getSetting(db, 'qual_sync_concurrency', '1')).toBe(beforeConcurrency);
      expect(getSetting(db, 'qual_test_extra', '')).toBe(beforeExtra);
    } finally {
      db.exec('DROP TRIGGER fail_d3_qual');
    }
  });

  it('rolls back a batch when a later settings write fails', () => {
    const db = app.locals.db;
    const before = getSetting(db, 'd3_atomic_first', 'before');
    db.prepare("INSERT INTO settings (key, value) VALUES ('d3_atomic_first', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(before);
    db.exec(`CREATE TRIGGER fail_d3_setting BEFORE INSERT ON settings WHEN NEW.key = 'd3_atomic_fail' BEGIN SELECT RAISE(ABORT, 'injected settings failure'); END;`);
    try {
      expect(() => setSettings(db, [
        ['d3_atomic_first', 'changed'],
        ['d3_atomic_fail', 'boom'],
      ])).toThrow('injected settings failure');
      expect(getSetting(db, 'd3_atomic_first', '')).toBe(before);
      expect(getSetting(db, 'd3_atomic_fail', '')).toBe('');
    } finally {
      db.exec('DROP TRIGGER fail_d3_setting');
    }
  });

  it('shares one qualification service between routes and auto-sync', () => {
    const shared = app.locals.qualificationService;
    const scheduler = app.locals.autoSyncScheduler as any;
    expect(shared).toBeDefined();
    expect(scheduler.qualSvc).toBe(shared);
  });

  it('hard-suspends national CMA while keeping status readable', async () => {
    const health = await request(app).get('/api/health');
    expect(health.status).toBe(200);
    expect(health.body.data.features.natCma).toEqual({ state: 'suspended', readOnly: true });

    const status = await request(app).get('/api/nat-cma/status');
    expect(status.status).toBe(200);
    expect(status.body.data.suspended).toBe(true);
    expect(status.body.data.readOnly).toBe(true);

    const historySearch = await request(app).get('/api/nat-cma/search?q=GB%2FT');
    expect(historySearch.status).toBe(200);
    expect(historySearch.body.data.suspended).toBe(true);
    expect(historySearch.body.data.readOnly).toBe(true);

    for (const call of [
      request(app).post('/api/nat-cma/subscribe').send({ certCode: 'x', placeId: 'y' }),
      request(app).delete('/api/nat-cma/subscribe/y?certCode=x'),
      request(app).post('/api/nat-cma/sync/y').send({}),
      request(app).post('/api/nat-cma/sync-all').send({}),
      request(app).post('/api/nat-cma/batch-match').send({ stdCodes: ['GB/T 1-2020'] }),
    ]) {
      const response = await call;
      expect(response.status).toBe(503);
      expect(response.body.error.code).toBe('NAT_CMA_SUSPENDED');
    }
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

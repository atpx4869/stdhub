import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import ExcelJS from 'exceljs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import supertestRequest from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createApp } from './app';
import { getSetting, setSettings } from '../services/db';

// 游客 + 单管理员 NAS 模式；测试 agent 登录后执行写操作。

describe('createApp', () => {
  let testRoot: string;
  let testDbPath: string;
  let app: ReturnType<typeof createApp>;
  let appAgent: any;
  let adminCookie = '';
  let csrfToken = '';
  const previousAdminPassword = process.env.STDHUB_ADMIN_PASSWORD;
  function request(target: any): any {
    if (target !== app) return supertestRequest(target);
    const wrap = (method: string) => (path: string) => {
      const call = appAgent[method](path);
      return ['post', 'put', 'patch', 'delete'].includes(method) && csrfToken ? call.set('X-CSRF-Token', csrfToken) : call;
    };
    return { get: wrap('get'), post: wrap('post'), put: wrap('put'), patch: wrap('patch'), delete: wrap('delete') };
  }

  beforeAll(async () => {
    process.env.STDHUB_ADMIN_PASSWORD = 'test-admin-password';
    testRoot = mkdtempSync(path.join(tmpdir(), 'stdhub-app-test-'));
    testDbPath = path.join(testRoot, 'data', 'bzxz.db');
    mkdirSync(path.dirname(testDbPath), { recursive: true });
    mkdirSync(path.join(testRoot, 'public'), { recursive: true });
    writeFileSync(path.join(testRoot, 'public', 'index.html'), '<script src="/app.js?v=__STDHUB_ASSET_VERSION__"></script>');
    app = createApp({
      baseDir: testRoot,
      dbPath: testDbPath,
      startBackgroundJobs: false,
    });
    appAgent = supertestRequest.agent(app);
    const login = await appAgent.post('/api/auth/login').send({ password: 'test-admin-password' });
    expect(login.status).toBe(200);
    adminCookie = String(login.headers['set-cookie']?.[0] || '');
    const csrfCookie = (login.headers['set-cookie'] || []).find((value: string) => value.includes('bzxz_csrf='));
    csrfToken = decodeURIComponent(String(csrfCookie || '').match(/bzxz_csrf=([^;]+)/)?.[1] || '');
    adminCookie = `${adminCookie.split(';')[0]}; ${String(csrfCookie || '').split(';')[0]}`;
  });

  afterAll(async () => {
    await app.shutdown();
    if (previousAdminPassword === undefined) delete process.env.STDHUB_ADMIN_PASSWORD;
    else process.env.STDHUB_ADMIN_PASSWORD = previousAdminPassword;
    rmSync(testRoot, { recursive: true, force: true });
  });

  it('returns health status', async () => {
    const response = await request(app).get('/api/health');
    expect(response.status).toBe(200);
    expect(response.body.error).toBeNull();
    expect(response.body.data.ok).toBe(true);
  });

  it('returns camelCase fields for statistics consumed by the frontend', async () => {
    const db = app.locals.db;
    const standardId = 'GB/T V3-STATS-2099';
    db.prepare(`
      INSERT INTO usage_events (user_id, event_type, source, standard_id, result, created_at)
      VALUES ((SELECT id FROM users WHERE username = 'admin'), 'download', 'bz', ?, 'success', '2099-06-01T00:00:00.000Z')
    `).run(standardId);
    try {
      const sourceResponse = await request(app).get('/api/stats/by-source?from=2099-01-01&to=2099-12-31');
      expect(sourceResponse.status).toBe(200);
      expect(sourceResponse.body.data.items).toContainEqual({ source: 'bz', count: 1, successCount: 1, failCount: 0 });
      expect(sourceResponse.body.data.items[0]).not.toHaveProperty('success_count');

      const popularResponse = await request(app).get('/api/stats/popular-standards?from=2099-01-01&to=2099-12-31');
      expect(popularResponse.status).toBe(200);
      expect(popularResponse.body.data.items).toContainEqual(expect.objectContaining({ standardId, source: 'bz', successCount: 1, failCount: 0 }));
      expect(popularResponse.body.data.items[0]).not.toHaveProperty('standard_id');
    } finally {
      db.prepare('DELETE FROM usage_events WHERE standard_id = ?').run(standardId);
    }
  });

  it('filters grouped library downloads by an exact file ID', async () => {
    const db = app.locals.db;
    const insert = db.prepare(`INSERT INTO standard_files (std_code_norm, year, source, abs_path, file_name, size, mtime, indexed_at, mime) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'application/pdf')`);
    const first = insert.run('GB28007', '2011', 'bz', path.join(testRoot, 'data', 'library', 'old.pdf'), 'GB 28007-2011.pdf', 10, Date.now(), '2099-01-01T00:00:00.000Z');
    const second = insert.run('GB28007', '2024', 'gbw', path.join(testRoot, 'data', 'library', 'new.pdf'), 'GB 28007-2024.pdf', 20, Date.now(), '2099-01-02T00:00:00.000Z');
    try {
      const response = await request(app).get(`/api/downloads?fileId=${second.lastInsertRowid}`);
      expect(response.status).toBe(200);
      expect(response.body.data.items).toHaveLength(1);
      expect(response.body.data.items[0]).toMatchObject({ fileId: Number(second.lastInsertRowid), fileName: 'GB 28007-2024.pdf', kind: 'library' });
      const conflicting = await request(app).get(`/api/downloads?kind=all&group=series&q=no-match&offset=99&fileId=${second.lastInsertRowid}`);
      expect(conflicting.status).toBe(200);
      expect(conflicting.body.data.items).toHaveLength(1);
      expect(conflicting.body.data.items[0].fileId).toBe(Number(second.lastInsertRowid));
      const missing = await request(app).get('/api/downloads?kind=library&group=series&fileId=99999999');
      expect(missing.status).toBe(200);
      expect(missing.body.data.items).toEqual([]);
      for (const invalid of ['', 'abc', '0', '-1', '1.5', ' 1', '1 ', '\t1', '1\t', '1e2', '1x', '+1', '01']) {
        const invalidResponse = await request(app).get(`/api/downloads?fileId=${encodeURIComponent(invalid)}`);
        expect(invalidResponse.status, invalid).toBe(400);
        expect(invalidResponse.body.error?.code, invalid).toBe('BAD_REQUEST');
      }
      const guest = await supertestRequest(app).get(`/api/downloads?fileId=${second.lastInsertRowid}`);
      expect(guest.status).toBe(200);
      expect(guest.body.data.items).toHaveLength(1);
    } finally {
      db.prepare('DELETE FROM standard_files WHERE id IN (?, ?)').run(first.lastInsertRowid, second.lastInsertRowid);
    }
  });

  it('auth status returns default admin user', async () => {
    const response = await request(app).get('/api/auth/status');
    expect(response.status).toBe(200);
    expect(response.body.data?.user).toMatchObject({
      username: 'admin',
      role: 'admin',
    });
  });

  it('returns guest status and blocks admin routes without a session', async () => {
    const guest = await supertestRequest(app).get('/api/auth/status');
    expect(guest.body.data?.user).toMatchObject({ username: 'guest', role: 'guest' });
    const denied = await supertestRequest(app).get('/api/admin/users');
    expect(denied.status).toBe(403);
    expect(denied.body.error?.code).toBe('ADMIN_REQUIRED');
    const completionDenied = await supertestRequest(app).get('/api/standards/complete/fields');
    expect(completionDenied.status).toBe(403);
    expect(completionDenied.body.error?.code).toBe('ADMIN_REQUIRED');
  });

  it('serves the completion registry and executes without a preview token', async () => {
    const fields = await request(app).get('/api/standards/complete/fields?registryVersion=1');
    expect(fields.status).toBe(200);
    expect(fields.body.data.registryVersion).toBe(1);
    expect(fields.body.data.fields).toContainEqual(expect.objectContaining({ fieldId: 'match.state', enabled: true }));

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Data');
    sheet.addRow(['标准号']);
    sheet.addRow(['INVALID']);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer() as unknown as Uint8Array);
    const options = {
      apiVersion: 2, registryVersion: 1, sheetName: 'Data', headerRow: 1, inputColumn: 'A', outputColumn: 'B',
      fieldIds: ['match.state'], sources: ['bz'], detectionPolicy: 'none', previewLimit: 8,
    };
    const mojibakeName = Buffer.from('标准查新_2026.xlsx', 'utf8').toString('latin1');
    const inspectedName = await request(app).post('/api/standards/complete/inspect')
      .field('options', JSON.stringify(options))
      .attach('file', buffer, { filename: mojibakeName, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    expect(inspectedName.status).toBe(200);
    expect(inspectedName.body.data.fileName).toBe('标准查新_2026.xlsx');

    const preview = await request(app).post('/api/standards/complete/preview')
      .field('options', JSON.stringify(options))
      .attach('file', buffer, { filename: 'input.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    expect(preview.status).toBe(200);
    expect(preview.body.data.counts).toMatchObject({ total: 1, invalid: 1 });
    expect(preview.body.data.previewToken).toHaveLength(64);
    expect(preview.body.data.sampleRows[0].values).toMatchObject({ 'match.state': '输入无效' });

    const invalidJson = await request(app).post('/api/standards/complete/preview')
      .field('options', '{bad')
      .attach('file', buffer, { filename: 'input.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    expect(invalidJson.status).toBe(400);
    expect(invalidJson.body.error?.code).toBe('BAD_REQUEST');

    const detectionUnavailable = await request(app).post('/api/standards/complete/preview')
      .field('options', JSON.stringify({ ...options, detectionPolicy: 'text_layer' }))
      .attach('file', buffer, { filename: 'input.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    expect(detectionUnavailable.status).toBe(400);
    expect(detectionUnavailable.body.error?.code).toBe('COMPLETE_DETECTION_UNAVAILABLE');

    const corrupt = await request(app).post('/api/standards/complete/inspect')
      .field('options', JSON.stringify(options))
      .attach('file', Buffer.from('not an xlsx'), { filename: 'broken.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    expect(corrupt.status).toBe(400);
    expect(corrupt.body.error?.code).toBe('BAD_REQUEST');

    const execute = await request(app).post('/api/standards/complete')
      .field('options', JSON.stringify(options))
      .attach('file', buffer, { filename: 'input.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    expect(execute.status).toBe(202);
    expect(execute.body.data).toMatchObject({ status: 'queued' });

    const conflictOptions = { ...options, outputColumn: 'A' };
    const conflict = await request(app).post('/api/standards/complete')
      .field('options', JSON.stringify(conflictOptions))
      .attach('file', buffer, { filename: 'input.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toMatchObject({ code: 'COMPLETE_OUTPUT_CONFLICT' });
  });

  it('logs in and logs out the single administrator', async () => {
    const agent = supertestRequest.agent(app);
    const login = await agent.post('/api/auth/login').send({ password: 'test-admin-password' });
    expect(login.status).toBe(200);
    expect((await agent.get('/api/auth/status')).body.data?.user.role).toBe('admin');
    const agentCookies = Array.isArray(login.headers['set-cookie']) ? login.headers['set-cookie'] : [];
    const agentCsrfCookie = agentCookies.find((value: string) => value.includes('bzxz_csrf='));
    const agentCsrf = decodeURIComponent(String(agentCsrfCookie || '').match(/bzxz_csrf=([^;]+)/)?.[1] || '');
    expect((await agent.post('/api/auth/logout').set('X-CSRF-Token', agentCsrf)).status).toBe(200);
    expect((await agent.get('/api/auth/status')).body.data?.user.role).toBe('guest');
    const relogin = await appAgent.post('/api/auth/login').send({ password: 'test-admin-password' });
    expect(relogin.status).toBe(200);
    const refreshedCsrf = (relogin.headers['set-cookie'] || []).find((value: string) => value.includes('bzxz_csrf='));
    csrfToken = decodeURIComponent(String(refreshedCsrf || '').match(/bzxz_csrf=([^;]+)/)?.[1] || csrfToken);
  });

  it('injects one cache version into the application shell', async () => {
    const response = await request(app).get('/');
    expect(response.status).toBe(200);
    expect(response.text).toMatch(/\/app\.js\?v=(?:dev|\d+\.\d+\.\d+)/);
    expect(response.text).not.toContain('__STDHUB_ASSET_VERSION__');
    expect(response.headers['content-security-policy']).toContain("script-src-attr 'none'");
  });

  it('allows a fresh deployment to log in with the documented default credentials', async () => {
    const configuredPassword = process.env.STDHUB_ADMIN_PASSWORD;
    const defaultRoot = mkdtempSync(path.join(tmpdir(), 'stdhub-default-admin-test-'));
    let defaultApp: ReturnType<typeof createApp> | null = null;
    try {
      delete process.env.STDHUB_ADMIN_PASSWORD;
      mkdirSync(path.join(defaultRoot, 'data'), { recursive: true });
      defaultApp = createApp({
        baseDir: defaultRoot,
        dbPath: path.join(defaultRoot, 'data', 'bzxz.db'),
        startBackgroundJobs: false,
      });
      const login = await supertestRequest.agent(defaultApp)
        .post('/api/auth/login')
        .send({ username: 'admin', password: 'adminadmin' });
      expect(login.status).toBe(200);
      expect(login.body.data?.user).toMatchObject({ username: 'admin', role: 'admin' });
    } finally {
      if (defaultApp) await defaultApp.shutdown();
      if (configuredPassword === undefined) delete process.env.STDHUB_ADMIN_PASSWORD;
      else process.env.STDHUB_ADMIN_PASSWORD = configuredPassword;
      rmSync(defaultRoot, { recursive: true, force: true });
    }
  });

  it('allows token-protected remote recovery when the administrator record is missing', async () => {
    const previousSetupToken = process.env.STDHUB_ADMIN_SETUP_TOKEN;
    const setupRoot = mkdtempSync(path.join(tmpdir(), 'stdhub-admin-setup-test-'));
    let setupApp: ReturnType<typeof createApp> | null = null;
    try {
      process.env.STDHUB_ADMIN_SETUP_TOKEN = 'remote-recovery-token';
      mkdirSync(path.join(setupRoot, 'data'), { recursive: true });
      setupApp = createApp({
        baseDir: setupRoot,
        dbPath: path.join(setupRoot, 'data', 'bzxz.db'),
        startBackgroundJobs: false,
      });
      const setupDb = setupApp.locals.db;
      setupDb.prepare('DELETE FROM sessions').run();
      setupDb.prepare("DELETE FROM users WHERE role = 'admin'").run();

      const remote = (method: 'get' | 'post', route: string) =>
        supertestRequest(setupApp!)[method](route).set('X-Forwarded-For', '203.0.113.10');
      const status = await remote('get', '/api/auth/status');
      expect(status.body.data).toMatchObject({
        needsSetup: true,
        setupRequiresToken: true,
        setupAvailable: true,
      });

      const denied = await remote('post', '/api/auth/setup').send({
        password: 'replacement-password',
        setupToken: 'wrong-token',
      });
      expect(denied.status).toBe(403);
      expect(denied.body.error?.code).toBe('SETUP_TOKEN_INVALID');

      const recovered = await remote('post', '/api/auth/setup').send({
        password: 'replacement-password',
        setupToken: 'remote-recovery-token',
      });
      expect(recovered.status).toBe(200);
      expect(recovered.body.data?.user).toMatchObject({ username: 'admin', role: 'admin' });
    } finally {
      if (setupApp) await setupApp.shutdown();
      if (previousSetupToken === undefined) delete process.env.STDHUB_ADMIN_SETUP_TOKEN;
      else process.env.STDHUB_ADMIN_SETUP_TOKEN = previousSetupToken;
      rmSync(setupRoot, { recursive: true, force: true });
    }
  });

  it('reports the single-user open-admin security posture', async () => {
    const response = await request(app).get('/api/security/status');
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      authMode: 'open_admin',
      enabled: false,
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

  it('drops the obsolete qualification link table and keeps a migration archive', () => {
    const db = app.locals.db;
    const linkTable = db.prepare(`
      SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'qualification_lab_links'
    `).get();
    const archiveTable = db.prepare(`
      SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'legacy_qualification_lab_links_archive'
    `).get();
    expect(linkTable).toBeUndefined();
    expect(archiveTable).toBeDefined();
  });

  it('exposes the fixed Hubei qualification profile from local metadata', async () => {
    const response = await request(app).get('/api/qualifications/profile');
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      displayName: '湖北省产品质量监督检验研究院',
      totalRecords: 0,
      cnas: { source: 'CNAS', institutionId: 'L0290', snapshotAvailable: false },
      cma: { source: 'CMA', institutionId: '221700110366', snapshotAvailable: false },
    });
  });

  it('rejects fixed qualification administration for guests', async () => {
    const guest = supertestRequest(app);
    expect((await guest.get('/api/qualifications/profile')).status).toBe(403);
    expect((await guest.post('/api/qualifications/sync/cnas')).status).toBe(403);
    expect((await guest.get('/api/qualifications/settings')).status).toBe(403);
  });

  it('removes multi-institution management routes and legacy aliases', async () => {
    expect((await request(app).get('/api/qualifications/labs/cnas')).status).toBe(404);
    expect((await request(app).post('/api/qualifications/labs/cma').send({ publicDetailId: 'legacy' })).status).toBe(404);
    expect((await request(app).get('/api/qualifications/presets/cnas')).status).toBe(404);
    expect((await request(app).post('/api/qualifications/links').send({ displayName: 'legacy' })).status).toBe(404);
    expect((await request(app).get('/api/cnas/labs')).status).toBe(404);
    expect((await request(app).get('/api/cma/labs')).status).toBe(404);
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

    const calls = [
      () => request(app).post('/api/nat-cma/subscribe').send({ certCode: 'x', placeId: 'y' }),
      () => request(app).delete('/api/nat-cma/subscribe/y?certCode=x'),
      () => request(app).post('/api/nat-cma/sync/y').send({}),
      () => request(app).post('/api/nat-cma/sync-all').send({}),
      () => request(app).post('/api/nat-cma/batch-match').send({ stdCodes: ['GB/T 1-2020'] }),
    ];
    for (const makeCall of calls) {
      const response = await makeCall();
      expect(response.status).toBe(503);
      expect(response.body.error.code).toBe('NAT_CMA_SUSPENDED');
    }
  });

  it('admin routes are blocked without auth', async () => {
    const guestAgent = supertestRequest.agent(app);
    const response = await guestAgent.get('/api/admin/users').set('Cookie', '');
    expect(response.status).toBe(403);
    expect(response.body.error?.code).toBe('ADMIN_REQUIRED');
  });

  it('guest can download public standards but cannot reach management surfaces', async () => {
    const guest = supertestRequest.agent(app);
    expect((await guest.get('/api/auth/status')).body.data?.user.role).toBe('guest');
    expect((await guest.get('/api/cma-diff/search?q=GB')).status).toBe(200);

    // Public single-standard download routes must pass authentication and reach
    // request validation. A malformed id therefore returns 400, not ADMIN_REQUIRED.
    const exportResponse = await guest.post('/api/standards/invalid/export').send({});
    expect(exportResponse.status).toBe(400);
    expect(exportResponse.body.error?.code).toBe('BAD_REQUEST');
    const autoDownloadResponse = await guest.post('/api/standards/invalid/auto-download').send({});
    expect(autoDownloadResponse.status).toBe(400);
    expect(autoDownloadResponse.body.error?.code).toBe('BAD_REQUEST');
    expect((await guest.get('/api/tasks/unknown-task')).status).toBe(404);
    expect((await guest.post('/api/tasks/unknown-task/cancel').send({})).status).toBe(404);

    // Bulk download and all management surfaces remain administrator-only.
    expect((await guest.post('/api/standards/multi-download').send({ sourceIds: {}, sources: ['bz'] })).status).toBe(403);
    expect((await guest.post('/api/standards/bz:test/download-session').send({})).status).toBe(403);
    expect((await guest.get('/api/labr/health')).status).toBe(403);
    expect((await guest.get('/api/cma-diff/domains')).status).toBe(403);
    expect((await guest.get('/api/qualifications/profile')).status).toBe(403);
    expect((await guest.post('/api/standards/complete').send({})).status).toBe(403);
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

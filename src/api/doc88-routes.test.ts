import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from './app';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

async function makeApp() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'stdhub-doc88-api-'));
  roots.push(root);
  const app = createApp({ baseDir: process.cwd(), dbPath: path.join(root, 'test.db'), startBackgroundJobs: false });
  return app;
}

describe('Doc88 API authorization contract', () => {
  it('keeps search, health and task creation admin-only', async () => {
    const app = await makeApp();
    expect((await request(app).get('/api/doc88/health')).status).toBe(403);
    expect((await request(app).get('/api/doc88/search').query({ keyword: 'GB/T 3325-2024' })).status).toBe(403);
    expect((await request(app).post('/api/doc88/tasks').send({ pcode: '123456789012', standardNumber: 'GB/T 3325-2024', title: '', cleanTitle: '' })).status).toBe(403);
    await app.shutdown();
  });
});

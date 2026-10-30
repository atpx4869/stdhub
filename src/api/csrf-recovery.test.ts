import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from './app';
import { DEFAULT_ADMIN_PASSWORD } from '../services/db';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function cookieValue(headers: string | string[] | undefined, name: string): string {
  const list = Array.isArray(headers) ? headers : headers ? [headers] : [];
  const raw = list.find(value => value.startsWith(`${name}=`));
  return raw ? decodeURIComponent(raw.split(';')[0].slice(name.length + 1)) : '';
}

async function makeApp() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'stdhub-csrf-'));
  roots.push(root);
  return createApp({ baseDir: process.cwd(), dbPath: path.join(root, 'test.db'), startBackgroundJobs: false });
}

describe('CSRF recovery for legacy administrator sessions', () => {
  it('rejects a mutation without a token, then repairs the cookie in place', async () => {
    const app = await makeApp();
    const login = await request(app).post('/api/auth/login').send({ password: DEFAULT_ADMIN_PASSWORD });
    expect(login.status).toBe(200);
    const session = cookieValue(login.headers['set-cookie'], 'bzxz_session');
    expect(session).not.toBe('');

    // Simulate a session created before CSRF shipped: session cookie only.
    const blocked = await request(app)
      .post('/api/qualifications/visual')
      .set('Cookie', `bzxz_session=${session}`)
      .send({ queries: ['GB 5009.9'] });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('CSRF_TOKEN_MISSING');
    // attachUser must hand back a fresh token on that same response.
    const repaired = cookieValue(blocked.headers['set-cookie'], 'bzxz_csrf');
    expect(repaired).not.toBe('');

    const healed = await request(app)
      .post('/api/qualifications/visual')
      .set('Cookie', `bzxz_session=${session}; bzxz_csrf=${encodeURIComponent(repaired)}`)
      .set('X-CSRF-Token', repaired)
      .send({ queries: ['GB 5009.9'] });
    expect(healed.status).toBe(200);
    await app.shutdown();
  });

  it('exposes an explicit token bootstrap for the frontend retry path', async () => {
    const app = await makeApp();
    const login = await request(app).post('/api/auth/login').send({ password: DEFAULT_ADMIN_PASSWORD });
    const session = cookieValue(login.headers['set-cookie'], 'bzxz_session');

    const anonymous = await request(app).get('/api/auth/csrf');
    expect(anonymous.status).toBe(403);

    const bootstrap = await request(app).get('/api/auth/csrf').set('Cookie', `bzxz_session=${session}`);
    expect(bootstrap.status).toBe(200);
    const token = cookieValue(bootstrap.headers['set-cookie'], 'bzxz_csrf');
    expect(token).not.toBe('');

    const allowed = await request(app)
      .post('/api/qualifications/visual')
      .set('Cookie', `bzxz_session=${session}; bzxz_csrf=${encodeURIComponent(token)}`)
      .set('X-CSRF-Token', token)
      .send({ queries: ['食品安全'] });
    expect(allowed.status).toBe(200);
    await app.shutdown();
  });
});

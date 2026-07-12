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
});

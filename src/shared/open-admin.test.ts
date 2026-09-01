import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkOpenAdminBoundary, isLoopbackHost } from './open-admin';

describe('open-admin boundary', () => {
  const originalToken = process.env.STDHUB_PROXY_TOKEN;
  const originalAllow = process.env.STDHUB_ALLOW_OPEN_ADMIN;

  afterEach(() => {
    if (originalToken === undefined) delete process.env.STDHUB_PROXY_TOKEN;
    else process.env.STDHUB_PROXY_TOKEN = originalToken;
    if (originalAllow === undefined) delete process.env.STDHUB_ALLOW_OPEN_ADMIN;
    else process.env.STDHUB_ALLOW_OPEN_ADMIN = originalAllow;
    vi.restoreAllMocks();
  });

  it('treats loopback hosts as local', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
  });

  it('allows loopback without a proxy token', () => {
    delete process.env.STDHUB_PROXY_TOKEN;
    delete process.env.STDHUB_ALLOW_OPEN_ADMIN;
    expect(() => checkOpenAdminBoundary('127.0.0.1')).not.toThrow();
  });

  it('refuses non-loopback listen without a proxy token', () => {
    delete process.env.STDHUB_PROXY_TOKEN;
    delete process.env.STDHUB_ALLOW_OPEN_ADMIN;
    expect(() => checkOpenAdminBoundary('0.0.0.0')).toThrow(/拒绝启动/);
  });

  it('allows non-loopback listen when a proxy token is set', () => {
    process.env.STDHUB_PROXY_TOKEN = 'secret';
    delete process.env.STDHUB_ALLOW_OPEN_ADMIN;
    expect(() => checkOpenAdminBoundary('0.0.0.0')).not.toThrow();
  });

  it('allows an explicit open-admin escape hatch with a warning', () => {
    delete process.env.STDHUB_PROXY_TOKEN;
    process.env.STDHUB_ALLOW_OPEN_ADMIN = '1';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => checkOpenAdminBoundary('0.0.0.0')).not.toThrow();
    expect(warn).toHaveBeenCalledOnce();
  });
});

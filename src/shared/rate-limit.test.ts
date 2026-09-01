import type { Request } from 'express';
import { describe, expect, it } from 'vitest';
import { clientIp } from './rate-limit';

describe('clientIp', () => {
  it('uses the Express-resolved client address before the proxy socket address', () => {
    const req = {
      ip: '203.0.113.9',
      socket: { remoteAddress: '127.0.0.1' },
    } as Request;

    expect(clientIp(req)).toBe('203.0.113.9');
  });

  it('normalizes IPv4-mapped IPv6 addresses', () => {
    const req = {
      ip: '::ffff:192.0.2.20',
      socket: { remoteAddress: '127.0.0.1' },
    } as Request;

    expect(clientIp(req)).toBe('192.0.2.20');
  });
});

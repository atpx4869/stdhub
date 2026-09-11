import { describe, expect, it } from 'vitest';
import { readConfig } from './config';

describe('readConfig', () => {
  it('applies safe deployment defaults', () => {
    expect(readConfig({})).toMatchObject({ port: 3000, bindHost: '127.0.0.1', trustProxy: 1 });
  });

  it('parses bounded numeric and boolean values', () => {
    expect(readConfig({ PORT: '8080', STDHUB_ALLOW_OPEN_ADMIN: '1', STDHUB_TRUST_PROXY: '2' }))
      .toMatchObject({ port: 8080, allowOpenAdmin: true, trustProxy: 2 });
  });

  it('rejects malformed or out-of-range values', () => {
    expect(() => readConfig({ PORT: '70000' })).toThrow(/PORT/);
    expect(() => readConfig({ STDHUB_HIGH_COST_ACTIVE_LIMIT: 'zero' })).toThrow(/STDHUB_HIGH_COST_ACTIVE_LIMIT/);
    expect(() => readConfig({ BZXZ_COOKIE_SECURE: 'sometimes' })).toThrow(/BZXZ_COOKIE_SECURE/);
  });
});

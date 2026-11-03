import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TextAvailability, TextAvailabilityState } from './text-availability';

// No application data directory or live filesystem is read or written by these tests.
const disk = vi.hoisted(() => ({ exists: false, contents: '', mkdir: vi.fn(), writeFile: vi.fn() }));
vi.mock('node:fs', () => ({ existsSync: () => disk.exists, readFileSync: () => disk.contents }));
vi.mock('node:fs/promises', () => ({ mkdir: disk.mkdir, writeFile: disk.writeFile }));
vi.mock('./fs', () => ({ getRootDir: () => '/virtual-availability-test' }));

const evidence = (state: TextAvailabilityState = 'available'): TextAvailability => ({ state, reason: 'fixture', checkedAt: new Date().toISOString() });
const loadCache = () => import('./text-availability-cache.js');
const flushSaves = () => new Promise<void>(resolve => setImmediate(resolve));

describe('versioned text availability cache', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-03T00:00:00Z'));
    disk.exists = false;
    disk.contents = '';
    disk.mkdir.mockReset().mockResolvedValue(undefined);
    disk.writeFile.mockReset().mockResolvedValue(undefined);
  });
  afterEach(async () => { await flushSaves(); vi.useRealTimers(); });

  it('returns null for missing entries and does not persist negative hcno lookups', async () => {
    const cache = await loadCache();
    expect(cache.getCachedTextAvailability('missing')).toBeNull();
    expect(cache.getCachedHcno('missing')).toBeUndefined();
    cache.setCachedHcno('missing', null);
    await flushSaves();
    expect(disk.writeFile).not.toHaveBeenCalled();
  });

  it.each([['available', 86_400_000], ['unavailable', 21_600_000], ['unknown', 30_000]] as const)('applies the %s TTL to in-memory entries', async (state, ttl) => {
    const cache = await loadCache();
    const result = evidence(state);
    cache.setCachedTextAvailability('standard', 'hcno-123', result);
    expect(cache.getCachedTextAvailability('standard')).toEqual({ ...result, version: 2, hcno: 'hcno-123' });
    vi.setSystemTime(Date.now() + ttl - 1);
    expect(cache.getCachedTextAvailability('standard')).not.toBeNull();
    vi.setSystemTime(Date.now() + 1);
    expect(cache.getCachedTextAvailability('standard')).toBeNull();
    // The lookup token remains reusable even when availability must be re-probed.
    expect(cache.getCachedHcno('standard')).toBe('hcno-123');
  });

  it('loads fresh v2 evidence while ignoring boolean and legacy-shaped entries', async () => {
    disk.exists = true;
    const valid = { ...evidence(), version: 2, hcno: 'valid-hcno' };
    disk.contents = JSON.stringify({ valid, boolean: true, negative: false, legacy: { available: true, hcno: 'old-hcno', checkedAt: valid.checkedAt }, version1: { ...valid, version: 1 }, invalidState: { ...valid, state: 'yes' }, missingReason: { ...valid, reason: null } });
    const cache = await loadCache();
    expect(cache.getCachedTextAvailability('valid')).toEqual(valid);
    for (const id of ['boolean', 'negative', 'legacy', 'version1', 'invalidState', 'missingReason']) {
      expect(cache.getCachedTextAvailability(id)).toBeNull();
      expect(cache.getCachedHcno(id)).toBeUndefined();
    }
  });

  it.each(['{broken-json', 'null', 'true'])('treats malformed or non-cache JSON as a cache miss: %s', async contents => {
    disk.exists = true;
    disk.contents = contents;
    const cache = await loadCache();
    expect(cache.getCachedTextAvailability('standard')).toBeNull();
    expect(cache.getCachedHcno('standard')).toBeUndefined();
  });

  it.each(['invalid-date', '2026-11-03T00:00:01Z', '2026-11-01T00:00:00Z'])('rejects invalid, future or expired persisted timestamps: %s', async checkedAt => {
    disk.exists = true;
    disk.contents = JSON.stringify({ standard: { ...evidence(), checkedAt, version: 2, hcno: null } });
    expect((await loadCache()).getCachedTextAvailability('standard')).toBeNull();
  });

  it('stores hcno-only entries as unchecked, not fresh negative evidence', async () => {
    const cache = await loadCache();
    cache.setCachedHcno('standard', 'token');
    expect(cache.getCachedHcno('standard')).toBe('token');
    expect(cache.getCachedTextAvailability('standard')).toBeNull();
    await flushSaves();
    expect(JSON.parse(disk.writeFile.mock.calls[0][1]).standard).toMatchObject({ version: 2, state: 'unknown', reason: 'not_checked', hcno: 'token' });
  });

  it('changes hcno without destroying existing evidence and ignores null updates', async () => {
    const cache = await loadCache();
    const result = evidence('unavailable');
    cache.setCachedTextAvailability('standard', null, result);
    cache.setCachedHcno('standard', 'new-token');
    cache.setCachedHcno('standard', null);
    expect(cache.getCachedTextAvailability('standard')).toEqual({ ...result, version: 2, hcno: 'new-token' });
  });

  it('serializes versioned snapshots in update order', async () => {
    const cache = await loadCache();
    cache.setCachedTextAvailability('first', 'one', evidence());
    cache.setCachedTextAvailability('second', null, evidence('unknown'));
    await flushSaves();
    expect(disk.writeFile).toHaveBeenCalledTimes(2);
    const [first, second] = disk.writeFile.mock.calls.map(call => JSON.parse(call[1]));
    expect(Object.keys(first)).toEqual(['first']);
    expect(Object.keys(second)).toEqual(['first', 'second']);
    expect(second.second).toMatchObject({ version: 2, state: 'unknown', hcno: null });
  });
});

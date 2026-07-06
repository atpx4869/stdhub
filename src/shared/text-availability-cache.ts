// gbw text-availability cache — persisted to disk so it survives restarts.
// Stores sourceId -> { hcno, hasText, updatedAt } so subsequent searches can
// skip the two-step HTTP probe (gbDetailed + openstd newGbInfo).
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getRootDir } from './fs';

export interface TextAvailabilityEntry {
  hcno: string | null;
  hasText: boolean;
  updatedAt: string;
}

interface CacheData {
  [sourceId: string]: TextAvailabilityEntry;
}

const CACHE_FILE = path.join(getRootDir(), 'data', '.text-availability-cache.json');
// 30 days: text availability is extremely stable once a standard is published.
const TTL_MS = 30 * 24 * 60 * 60 * 1000;

let memoryCache: CacheData | null = null;

function load(): CacheData {
  if (memoryCache) return memoryCache;
  try {
    if (existsSync(CACHE_FILE)) {
      memoryCache = JSON.parse(readFileSync(CACHE_FILE, 'utf-8'));
      return memoryCache!;
    }
  } catch {}
  memoryCache = {};
  return memoryCache!;
}

async function save(data: CacheData): Promise<void> {
  memoryCache = data;
  try {
    const dir = path.dirname(CACHE_FILE);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
    await writeFile(CACHE_FILE, JSON.stringify(data));
  } catch {}
}

export function getCachedTextAvailability(sourceId: string): TextAvailabilityEntry | null {
  const data = load();
  const entry = data[sourceId];
  if (!entry) return null;
  if (Date.now() - new Date(entry.updatedAt).getTime() > TTL_MS) return null;
  return entry;
}

/**
 * Returns the cached hcno regardless of TTL — hcno is the server's permanent
 * primary key for a standard's full-text record and never changes once
 * resolved. Used to skip the `gbDetailed` HTTP call on TTL-expired entries.
 *
 * Returns:
 * - `undefined` — no cache entry at all for this sourceId
 * - `null`      — entry exists but hcno was null (standard has no published text)
 * - `string`    — the 32-hex hcno
 */
export function getCachedHcno(sourceId: string): string | null | undefined {
  const data = load();
  const entry = data[sourceId];
  if (!entry) return undefined;
  return entry.hcno;
}

export function setCachedTextAvailability(sourceId: string, hcno: string | null, hasText: boolean): void {
  const data = load();
  data[sourceId] = { hcno, hasText, updatedAt: new Date().toISOString() };
  void save(data); // fire-and-forget: cache misses are re-creatable
}

/**
 * Write just the hcno without touching hasText / updatedAt. Use this right
 * after extracting hcno from a detail page, before checking openstd — so a
 * subsequent openstd failure doesn't make us re-resolve the hcno next time.
 *
 * If an entry already exists, preserves its hasText and updatedAt so the
 * TTL window doesn't get accidentally reset by a partial write.
 *
 * If no entry exists yet, creates a placeholder with hasText=false and a
 * sentinel updatedAt of 0 (epoch) so TTL appears immediately stale — the
 * placeholder exists only to carry the hcno, not to claim a hasText answer.
 */
export function setCachedHcno(sourceId: string, hcno: string | null): void {
  const data = load();
  const existing = data[sourceId];
  if (existing) {
    if (existing.hcno === hcno) return; // no-op, avoid disk write churn
    data[sourceId] = { ...existing, hcno };
  } else {
    data[sourceId] = { hcno, hasText: false, updatedAt: new Date(0).toISOString() };
  }
  void save(data);
}

// Versioned BW availability cache. Legacy boolean answers are deliberately ignored.
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getRootDir } from './fs';
import { availabilityIsFresh, type TextAvailability } from './text-availability';

export interface TextAvailabilityEntry extends TextAvailability {
  version: 2;
  hcno: string | null;
}
type CacheData = Record<string, TextAvailabilityEntry>;
const CACHE_FILE = path.join(getRootDir(), 'data', '.text-availability-cache.json');
let memoryCache: CacheData | null = null;
let pendingSave: Promise<void> = Promise.resolve();
function load(): CacheData {
  if (memoryCache) return memoryCache;
  try {
    if (existsSync(CACHE_FILE)) {
      const raw = JSON.parse(readFileSync(CACHE_FILE, 'utf-8'));
      memoryCache = Object.fromEntries(Object.entries(raw).filter(([, value]) => {
        const e = value as TextAvailabilityEntry;
        return e?.version === 2 && ['available', 'unavailable', 'unknown'].includes(e.state) && typeof e.reason === 'string';
      })) as CacheData;
      return memoryCache;
    }
  } catch { /* Re-probe corrupt or legacy cache. */ }
  return memoryCache = {};
}
function save(): void {
  const snapshot = JSON.stringify(load());
  pendingSave = pendingSave.catch(() => {}).then(async () => {
    await mkdir(path.dirname(CACHE_FILE), { recursive: true });
    await writeFile(CACHE_FILE, snapshot);
  }).catch(() => {});
}
export function getCachedTextAvailability(sourceId: string): TextAvailabilityEntry | null {
  const entry = load()[sourceId];
  return entry && availabilityIsFresh(entry) ? entry : null;
}
export function getCachedHcno(sourceId: string): string | undefined {
  // A missing hcno is not permanent: the official site can publish text later.
  return load()[sourceId]?.hcno || undefined;
}
export function setCachedTextAvailability(sourceId: string, hcno: string | null, result: TextAvailability): void {
  load()[sourceId] = { ...result, version: 2, hcno };
  save();
}
export function setCachedHcno(sourceId: string, hcno: string | null): void {
  if (!hcno) return;
  const existing = load()[sourceId];
  if (existing?.hcno === hcno) return;
  load()[sourceId] = existing ? { ...existing, hcno } : {
    version: 2, hcno, state: 'unknown', reason: 'not_checked', checkedAt: new Date(0).toISOString(),
  };
  save();
}

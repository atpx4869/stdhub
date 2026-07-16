// Page count cache — persisted to file so survives restarts
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getRootDir } from './fs';

interface CacheData {
  [standardNo: string]: { count: number; updatedAt: string };
}

const CACHE_FILE = path.join(getRootDir(), 'data', '.page-cache.json');
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

export function getCachedPageCount(standardNo: string): number | null {
  const data = load();
  const entry = data[standardNo];
  if (!entry) return null;
  // Cache for 30 days
  if (Date.now() - new Date(entry.updatedAt).getTime() > 30 * 24 * 60 * 60 * 1000) return null;
  return entry.count;
}

export function setCachedPageCount(standardNo: string, count: number): void {
  const data = load();
  data[standardNo] = { count, updatedAt: new Date().toISOString() };
  void save(data); // fire-and-forget: page counts are re-creatable
}

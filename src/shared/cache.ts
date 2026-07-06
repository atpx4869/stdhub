// Simple in-memory cache with TTL and LRU eviction
const DEFAULT_TTL = 5 * 60 * 1000; // 5 minutes
const MAX_ENTRIES = 1000;

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class SearchCache {
  private cache = new Map<string, CacheEntry<unknown>>();

  get<T>(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }
    // LRU: move to end
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.value as T;
  }

  set<T>(key: string, value: T, ttlMs = DEFAULT_TTL): void {
    if (this.cache.has(key)) this.cache.delete(key);
    this.cache.set(key, { value, expiresAt: Date.now() + ttlMs });
    // Evict oldest if over limit
    while (this.cache.size > MAX_ENTRIES) {
      const firstKey = this.cache.keys().next().value!;
      this.cache.delete(firstKey);
    }
  }

  clear(): void {
    this.cache.clear();
  }
}

export const searchCache = new SearchCache();

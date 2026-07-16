/**
 * snake_case ↔ camelCase converters for API DTOs.
 *
 * The DB layer stores snake_case (lab_no, cert_number, created_at). The API contract
 * uses camelCase (labNo, certNumber, createdAt). Routes pipe DB rows through toCamelCase
 * before responding; request bodies arrive as camelCase and use the existing zod schemas.
 *
 * These converters walk plain objects and arrays recursively. They DO NOT touch:
 * - non-plain objects (Date, Buffer, Map, Set, class instances) — passed through as-is
 * - keys that are already camelCase — left untouched
 * - null/undefined/primitive values — returned as-is
 */

function snakeToCamel(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

function camelToSnake(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function toCamelCase<T = unknown>(input: unknown): T {
  if (Array.isArray(input)) {
    return input.map((item) => toCamelCase(item)) as T;
  }
  if (isPlainObject(input)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input)) {
      out[snakeToCamel(k)] = toCamelCase(v);
    }
    return out as T;
  }
  return input as T;
}

export function toSnakeCase<T = unknown>(input: unknown): T {
  if (Array.isArray(input)) {
    return input.map((item) => toSnakeCase(item)) as T;
  }
  if (isPlainObject(input)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input)) {
      out[camelToSnake(k)] = toSnakeCase(v);
    }
    return out as T;
  }
  return input as T;
}

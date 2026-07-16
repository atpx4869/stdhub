import path from 'node:path';
import { existsSync } from 'node:fs';

let loaded = false;

export function loadDotEnvLocal(): { loaded: boolean; path?: string } {
  if (loaded) return { loaded: true };
  loaded = true;

  const envPath = path.resolve(process.cwd(), '.env.local');
  if (!existsSync(envPath)) return { loaded: false };

  try {
    const dotenv = require('dotenv');
    const result = dotenv.config({ path: envPath, override: false });
    if (result.error) {
      console.warn('[env] .env.local parse error:', result.error.message);
      return { loaded: false };
    }
    console.log('[env] loaded .env.local from:', envPath);
    return { loaded: true, path: envPath };
  } catch (e) {
    console.warn('[env] dotenv not installed, skipped .env.local:', e instanceof Error ? e.message : String(e));
    return { loaded: false };
  }
}

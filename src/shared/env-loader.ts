import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

let loadResult: { loaded: boolean; path?: string } | undefined;

interface DotEnvModule {
  parse: (input: string) => Record<string, string>;
}

/**
 * 判断错误是否属于「文件存在但当前用户读不到」。
 * 容器以非 root 用户运行时，宿主机私有文件的权限/ACL 不匹配就会走到这里。
 */
function isPermissionDenied(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'EACCES'
    || code === 'EPERM'
    || /\b(?:EACCES|EPERM)\b/.test(error.message);
}

/**
 * 读取仓库根目录的 .env.local 并注入 process.env。
 *
 * 这里刻意不使用 dotenv 的 config()：它把「读不到文件」和「内容解析失败」
 * 合并进同一个 error 返回，于是容器里的 EACCES 会被打印成
 * 「.env.local parse error」，把排查方向带偏。改为自己读取、再交给
 * dotenv.parse() 解析，三类失败（读不到 / 缺依赖 / 解析失败）即可分别提示。
 */
export function loadDotEnvLocal(): { loaded: boolean; path?: string } {
  if (loadResult) return loadResult;

  // Docker Compose 已用 env_file 注入变量，容器内无需（也不应）再打开该文件。
  if (process.env.STDHUB_SKIP_DOTENV_LOCAL === '1') {
    console.log(
      '[env] .env.local not read: STDHUB_SKIP_DOTENV_LOCAL=1 '
      + '(expected under Docker Compose, which injects variables via env_file).',
    );
    loadResult = { loaded: false };
    return loadResult;
  }

  const envPath = path.resolve(process.cwd(), '.env.local');
  if (!existsSync(envPath)) {
    loadResult = { loaded: false };
    return loadResult;
  }

  let source: string;
  try {
    source = readFileSync(envPath, 'utf8');
  } catch (error) {
    if (isPermissionDenied(error)) {
      // 不回显原始错误：其中可能带路径等信息，给出可执行的修复方向即可。
      console.warn(
        '[env] .env.local exists but is not readable by the current user; skipped it. '
        + 'For Docker Compose, inject it via env_file instead of bind-mounting it into /app.',
      );
    } else {
      console.warn(
        '[env] .env.local could not be read:',
        error instanceof Error ? error.message : String(error),
      );
    }
    loadResult = { loaded: false };
    return loadResult;
  }

  let dotenv: DotEnvModule;
  try {
    dotenv = require('dotenv') as DotEnvModule;
  } catch (error) {
    console.warn(
      '[env] dotenv not installed, skipped .env.local:',
      error instanceof Error ? error.message : String(error),
    );
    loadResult = { loaded: false };
    return loadResult;
  }

  try {
    const parsed = dotenv.parse(source);
    // 与 dotenv.config({ override: false }) 语义一致：真实环境变量优先，
    // 因此 Compose 的 env_file / environment 注入不会被文件内容覆盖。
    for (const [key, value] of Object.entries(parsed)) {
      if (!Object.prototype.hasOwnProperty.call(process.env, key)) {
        process.env[key] = value;
      }
    }
  } catch (error) {
    console.warn(
      '[env] .env.local parse error:',
      error instanceof Error ? error.message : String(error),
    );
    loadResult = { loaded: false };
    return loadResult;
  }

  loadResult = { loaded: true, path: envPath };
  console.log('[env] loaded .env.local from:', envPath);
  return loadResult;
}

// 标准库路径解析与可写性探针
//
// 默认路径放在项目根 /standards/。用户可在设置里手动改路径覆盖默认值。

import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { Stats } from 'node:fs';
import type Database from 'better-sqlite3';
import { getRootDir } from './fs';
import { getSetting, setSetting } from '../services/db';

export interface LibraryStatus {
  dir: string;
  writable: boolean;
  fallbackUsed: boolean;
  fallbackReason: string;
  configuredDir: string;
}

let cachedStatus: LibraryStatus | null = null;

function getDefaultLibraryDir(): string {
  return path.join(getRootDir(), 'standards');
}

async function probeWritable(dir: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await fs.mkdir(dir, { recursive: true });
    const probe = path.join(dir, `.stdhub-write-probe-${Date.now()}.tmp`);
    await fs.writeFile(probe, '.', { flag: 'w' });
    await fs.unlink(probe).catch(() => {});
    return { ok: true };
  } catch (e: any) {
    const code = e?.code || 'UNKNOWN';
    return { ok: false, reason: `${code}: ${e?.message || '未知错误'}` };
  }
}

export async function resolveLibraryDir(db: Database.Database): Promise<LibraryStatus> {
  if (cachedStatus) return cachedStatus;

  const configured = getSetting(db, 'standards_library_dir', '').trim();
  const preferred = configured || getDefaultLibraryDir();
  const preferredAbs = path.resolve(preferred);

  const preferredProbe = await probeWritable(preferredAbs);
  if (preferredProbe.ok) {
    cachedStatus = {
      dir: preferredAbs,
      writable: true,
      fallbackUsed: false,
      fallbackReason: '',
      configuredDir: configured,
    };
    return cachedStatus;
  }

  // 回退到 data/standards-fallback
  const fallback = path.join(getRootDir(), 'data', 'standards-fallback');
  const fallbackAbs = path.resolve(fallback);
  const fallbackProbe = await probeWritable(fallbackAbs);
  cachedStatus = {
    dir: fallbackProbe.ok ? fallbackAbs : preferredAbs,
    writable: fallbackProbe.ok,
    fallbackUsed: true,
    fallbackReason: `首选路径 "${preferredAbs}" 不可写（${preferredProbe.reason}），${fallbackProbe.ok ? `已临时使用 "${fallbackAbs}"` : `回退路径也不可写（${fallbackProbe.reason}）`}`,
    configuredDir: configured,
  };
  return cachedStatus;
}

export async function validateLibraryDir(newDir: string): Promise<string> {
  const trimmed = newDir.trim();
  if (trimmed) {
    const abs = path.resolve(trimmed);
    const probe = await probeWritable(abs);
    if (!probe.ok) throw new Error(`目录不可写：${probe.reason}`);
  }
  return trimmed;
}

export function invalidateLibraryPathCache(): void {
  cachedStatus = null;
}

export async function setLibraryDir(db: Database.Database, newDir: string): Promise<LibraryStatus> {
  const trimmed = await validateLibraryDir(newDir);
  setSetting(db, 'standards_library_dir', trimmed);
  invalidateLibraryPathCache();
  return resolveLibraryDir(db);
}

export function _resetLibraryPathCacheForTesting(): void {
  invalidateLibraryPathCache();
}

export function isInsideLibrary(absPath: string, libraryDir: string): boolean {
  const resolvedPath = path.resolve(absPath);
  const resolvedRoot = path.resolve(libraryDir);
  return resolvedPath === resolvedRoot || resolvedPath.startsWith(resolvedRoot + path.sep);
}

export function isInsideRealRoot(realPath: string, realRoot: string): boolean {
  const relative = path.relative(realRoot, realPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export interface SafeLibraryFile {
  realRoot: string;
  realPath: string;
  stat: Stats;
}

/**
 * 校验标准库文件的真实磁盘边界。
 *
 * `path.resolve().startsWith()` 只能挡住普通 `../`，挡不住库内 symlink
 * 指向库外文件。这里先对候选路径做 `lstat()` 拒绝 symlink，再用
 * `realpath()` + `path.relative()` 确认真实文件仍在真实库根下。
 */
export async function resolveSafeLibraryFile(absPath: string, libraryDir: string): Promise<SafeLibraryFile | null> {
  if (!isInsideLibrary(absPath, libraryDir)) return null;

  const realRoot = await fs.realpath(libraryDir);
  const lst = await fs.lstat(absPath);
  if (lst.isSymbolicLink()) return null;
  if (!lst.isFile()) return null;

  const realPath = await fs.realpath(absPath);
  if (!isInsideRealRoot(realPath, realRoot)) return null;

  const stat = await fs.stat(realPath);
  if (!stat.isFile()) return null;
  return { realRoot, realPath, stat };
}

export async function resolveSafeLibraryTarget(absPath: string, libraryDir: string): Promise<{ realRoot: string; targetPath: string } | null> {
  if (!isInsideLibrary(absPath, libraryDir)) return null;
  const realRoot = await fs.realpath(libraryDir);
  const parentReal = await fs.realpath(path.dirname(absPath));
  if (!isInsideRealRoot(parentReal, realRoot)) return null;
  return { realRoot, targetPath: absPath };
}

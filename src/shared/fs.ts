import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export function buildFileName(standardNumber: string, title: string, ext = 'pdf'): string {
  const safeNum = standardNumber.replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim();
  const safeTitle = title.replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim();
  const joined = [safeNum, safeTitle].filter(Boolean).join(' ');
  const suffix = `${Date.now().toString(36)}-${randomBytes(2).toString('hex')}`;
  return `${joined || 'standard'}_${suffix}.${ext}`;
}

export function getRootDir(): string {
  return process.cwd();
}

export function getExportsDir(): string {
  return path.join(getRootDir(), 'data', 'exports');
}

/**
 * 确保 exports 目录存在（递归创建）。各源 adapter 在写入导出文件前必须调用，
 * 否则在非标准启动路径（测试/嵌入调用，未走 src/index.ts 的 ensureDataDirs）下
 * writeFile 会因目录不存在抛 ENOENT。幂等，可重复调用。
 */
export async function ensureExportsDir(): Promise<void> {
  await mkdir(getExportsDir(), { recursive: true });
}

export async function ensureDataDirs(): Promise<void> {
  await mkdir(getExportsDir(), { recursive: true });
}

export async function safeWriteExportFile(fileName: string, data: Buffer | string): Promise<string> {
  const exportsDir = getExportsDir();
  await mkdir(exportsDir, { recursive: true });
  const resolved = path.resolve(exportsDir, await uniqueExportFileName(fileName));
  if (!resolved.startsWith(exportsDir + path.sep)) {
    throw new Error(`Path traversal detected: ${fileName}`);
  }
  await writeFile(resolved, data);
  return resolved;
}

async function uniqueExportFileName(fileName: string): Promise<string> {
  const exportsDir = getExportsDir();
  const parsed = path.parse(fileName);
  let candidate = fileName;
  let index = 1;

  while (await exists(path.join(exportsDir, candidate))) {
    candidate = `${parsed.name}_${Date.now().toString(36)}-${index}${parsed.ext}`;
    index++;
  }
  return candidate;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

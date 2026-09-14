import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import type Database from 'better-sqlite3';

const RETRYABLE_RENAME_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);
const RETRY_DELAYS_MS = [50, 150, 400, 800];
const DELETE_TOMBSTONE_RE = /^\.stdhub-delete-\d+-[0-9a-f-]+\.pending$/i;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function renameFileWithRetry(sourcePath: string, targetPath: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      await fs.rename(sourcePath, targetPath);
      return;
    } catch (error: any) {
      lastError = error;
      if (!RETRYABLE_RENAME_CODES.has(error?.code) || attempt === RETRY_DELAYS_MS.length) throw error;
      await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }
  throw lastError;
}

/** Restore a file to its exact original path, including cross-volume moves. */
export async function restoreMovedFile(currentPath: string, originalPath: string): Promise<void> {
  try {
    await renameFileWithRetry(currentPath, originalPath);
    return;
  } catch (error: any) {
    if (error?.code !== 'EXDEV') throw error;
  }

  const partPath = `${originalPath}.restore-${randomUUID()}.part`;
  try {
    await fs.copyFile(currentPath, partPath);
    await renameFileWithRetry(partPath, originalPath);
    await fs.unlink(currentPath);
  } catch (error) {
    await fs.rm(partPath, { force: true }).catch(() => {});
    throw error;
  }
}

/** Rename the file and its index row as one compensated operation. */
export async function renameIndexedLibraryFile(
  db: Database.Database,
  fileId: number,
  sourcePath: string,
  targetPath: string,
): Promise<void> {
  await renameFileWithRetry(sourcePath, targetPath);
  try {
    const result = db.prepare(
      "UPDATE standard_files SET abs_path = ?, file_name = ?, indexed_at = datetime('now') WHERE id = ?"
    ).run(targetPath, path.basename(targetPath), fileId);
    if (result.changes !== 1) throw new Error(`标准库索引行不存在：${fileId}`);
  } catch (databaseError) {
    try {
      await restoreMovedFile(targetPath, sourcePath);
    } catch (rollbackError) {
      throw new AggregateError(
        [databaseError, rollbackError],
        `重命名索引失败，且文件回滚失败：${path.basename(sourcePath)}`,
      );
    }
    throw databaseError;
  }
}

/** Delete through a reversible tombstone so an index failure can restore the file. */
export async function deleteIndexedLibraryFile(
  db: Database.Database,
  fileId: number,
  sourcePath: string,
): Promise<void> {
  const tombstonePath = path.join(
    path.dirname(sourcePath),
    `.stdhub-delete-${fileId}-${randomUUID()}.pending`,
  );
  await renameFileWithRetry(sourcePath, tombstonePath);
  try {
    db.prepare('DELETE FROM standard_files WHERE id = ?').run(fileId);
  } catch (databaseError) {
    try {
      await restoreMovedFile(tombstonePath, sourcePath);
    } catch (rollbackError) {
      throw new AggregateError(
        [databaseError, rollbackError],
        `删除索引失败，且文件回滚失败：${path.basename(sourcePath)}`,
      );
    }
    throw databaseError;
  }

  try {
    await fs.unlink(tombstonePath);
  } catch (error) {
    console.error(`[library] pending delete cleanup failed: ${tombstonePath}`, error);
  }
}

/** Remove only tombstones created by deleteIndexedLibraryFile. */
export async function cleanupLibraryMutationArtifacts(libraryDir: string, minAgeMs = 5 * 60 * 1000): Promise<number> {
  const entries = await fs.readdir(libraryDir, { withFileTypes: true }).catch(() => []);
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !DELETE_TOMBSTONE_RE.test(entry.name)) continue;
    try {
      const artifactPath = path.join(libraryDir, entry.name);
      const stat = await fs.stat(artifactPath);
      // minAgeMs=0 explicitly means “remove immediately”. On Windows, a newly
      // created file's mtime can be a few milliseconds ahead of Date.now()
      // because the filesystem and JS clocks have different precision.
      if (minAgeMs > 0 && Date.now() - stat.mtimeMs < minAgeMs) continue;
      await fs.unlink(artifactPath);
      removed++;
    } catch { /* retry on the next scan */ }
  }
  return removed;
}

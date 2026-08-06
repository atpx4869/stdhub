import path from 'node:path';
import { promises as fs } from 'node:fs';
import type Database from 'better-sqlite3';

const FILENAME_ALLOWED = /^[^\\/]+$/;
const REFRESH_TTL_MS = 10_000;
const CHUNK_SIZE = 1000;

const refreshState = new WeakMap<Database.Database, { lastAt: number; running?: Promise<void> }>();

function parseExportMeta(fileName: string): { standardNumber: string; source: string } {
  const standardNumber = fileName.match(/((?:GB|GB\/T|YY\/T|YY|JJG|DB\d+\/T|ISO)[\w./ -]*?\d{1,5}(?:[-—]\d{4})?)/i)?.[1]?.trim() ?? '';
  const source = fileName.match(/_(gbw|by|bz)_/i)?.[1] ?? '';
  return { standardNumber, source };
}

export async function ensureExportIndexFresh(
  db: Database.Database,
  exportsDir: string,
  options: { force?: boolean } = {},
): Promise<void> {
  const state = refreshState.get(db) ?? { lastAt: 0 };
  refreshState.set(db, state);

  const now = Date.now();
  if (!options.force && now - state.lastAt < REFRESH_TTL_MS) return;
  if (state.running) return state.running;

  state.running = refreshExportIndex(db, exportsDir)
    .then(() => { state.lastAt = Date.now(); })
    .finally(() => { state.running = undefined; });
  return state.running;
}

export function removeExportIndex(db: Database.Database, fileName: string): void {
  db.prepare('DELETE FROM export_files WHERE file_name = ?').run(fileName);
}

async function refreshExportIndex(db: Database.Database, exportsDir: string): Promise<void> {
  await fs.mkdir(exportsDir, { recursive: true }).catch(() => { /* ignore */ });
  let names: string[];
  try {
    names = await fs.readdir(exportsDir);
  } catch {
    return;
  }

  const validNames = names.filter((name) => FILENAME_ALLOWED.test(name));
  const seenNames = new Set<string>();
  const indexedRows = db.prepare('SELECT file_name, size, mtime FROM export_files').all() as Array<{
    file_name: string; size: number; mtime: number;
  }>;
  const indexedByName = new Map(indexedRows.map((row) => [row.file_name, row]));

  const changes: Array<{
    fileName: string; size: number; mtime: number; standardNumber: string; source: string; absPath: string;
  }> = [];

  for (const name of validNames) {
    const absPath = path.resolve(exportsDir, name);
    if (!absPath.startsWith(exportsDir + path.sep)) continue;
    let stat;
    try { stat = await fs.stat(absPath); } catch { continue; }
    if (!stat.isFile()) continue;

    const mtime = Math.floor(stat.mtimeMs);
    seenNames.add(name);
    const indexed = indexedByName.get(name);
    if (indexed && indexed.size === stat.size && indexed.mtime === mtime) continue;

    const meta = parseExportMeta(name);
    changes.push({ fileName: name, size: stat.size, mtime, absPath, ...meta });
  }

  const removedNames = indexedRows
    .map((row) => row.file_name)
    .filter((name) => !seenNames.has(name));

  const upsert = db.prepare(`
    INSERT INTO export_files (file_name, size, mtime, standard_number, source, abs_path)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(file_name) DO UPDATE SET
      size = excluded.size,
      mtime = excluded.mtime,
      standard_number = excluded.standard_number,
      source = excluded.source,
      abs_path = excluded.abs_path,
      indexed_at = datetime('now')
  `);
  const remove = db.prepare('DELETE FROM export_files WHERE file_name = ?');
  const txn = db.transaction((chunk: typeof changes, deleted: string[]) => {
    for (const item of chunk) {
      upsert.run(item.fileName, item.size, item.mtime, item.standardNumber, item.source, item.absPath);
    }
    for (const name of deleted) remove.run(name);
  });

  const maxLength = Math.max(changes.length, removedNames.length);
  for (let i = 0; i < maxLength; i += CHUNK_SIZE) {
    txn(changes.slice(i, i + CHUNK_SIZE), removedNames.slice(i, i + CHUNK_SIZE));
  }
}

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  cleanupLibraryMutationArtifacts,
  deleteIndexedLibraryFile,
  renameIndexedLibraryFile,
  restoreMovedFile,
} from './library-file-mutations';

describe('library file mutations', () => {
  let root: string;
  let db: Database.Database;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'stdhub-library-mutation-'));
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE standard_files (
        id INTEGER PRIMARY KEY,
        abs_path TEXT NOT NULL,
        file_name TEXT NOT NULL,
        indexed_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  function seed(name = 'old.pdf'): { id: number; filePath: string } {
    const filePath = path.join(root, name);
    writeFileSync(filePath, 'pdf-data');
    db.prepare('INSERT INTO standard_files (id, abs_path, file_name) VALUES (1, ?, ?)').run(filePath, name);
    return { id: 1, filePath };
  }

  it('renames the file and index together', async () => {
    const seeded = seed();
    const target = path.join(root, 'new.pdf');
    await renameIndexedLibraryFile(db, seeded.id, seeded.filePath, target);
    expect(existsSync(seeded.filePath)).toBe(false);
    expect(readFileSync(target, 'utf8')).toBe('pdf-data');
    expect(db.prepare('SELECT abs_path FROM standard_files WHERE id = 1').pluck().get()).toBe(target);
  });

  it('restores the original file when a rename index update fails', async () => {
    const seeded = seed();
    const target = path.join(root, 'new.pdf');
    db.exec("CREATE TRIGGER fail_rename BEFORE UPDATE ON standard_files BEGIN SELECT RAISE(ABORT, 'injected'); END");
    await expect(renameIndexedLibraryFile(db, seeded.id, seeded.filePath, target)).rejects.toThrow('injected');
    expect(readFileSync(seeded.filePath, 'utf8')).toBe('pdf-data');
    expect(existsSync(target)).toBe(false);
    expect(db.prepare('SELECT abs_path FROM standard_files WHERE id = 1').pluck().get()).toBe(seeded.filePath);
  });

  it('deletes the physical file only after the index delete succeeds', async () => {
    const seeded = seed();
    await deleteIndexedLibraryFile(db, seeded.id, seeded.filePath);
    expect(existsSync(seeded.filePath)).toBe(false);
    expect(db.prepare('SELECT COUNT(*) FROM standard_files').pluck().get()).toBe(0);
  });

  it('restores the original file when an index delete fails', async () => {
    const seeded = seed();
    db.exec("CREATE TRIGGER fail_delete BEFORE DELETE ON standard_files BEGIN SELECT RAISE(ABORT, 'injected'); END");
    await expect(deleteIndexedLibraryFile(db, seeded.id, seeded.filePath)).rejects.toThrow('injected');
    expect(readFileSync(seeded.filePath, 'utf8')).toBe('pdf-data');
    expect(db.prepare('SELECT COUNT(*) FROM standard_files').pluck().get()).toBe(1);
    expect(readdirSync(root).some((name) => name.endsWith('.pending'))).toBe(false);
  });

  it('restores a moved file and cleans only owned delete tombstones', async () => {
    const moved = path.join(root, 'moved.pdf');
    const original = path.join(root, 'original.pdf');
    writeFileSync(moved, 'pdf-data');
    await restoreMovedFile(moved, original);
    expect(readFileSync(original, 'utf8')).toBe('pdf-data');

    writeFileSync(path.join(root, '.stdhub-delete-7-123e4567-e89b-12d3-a456-426614174000.pending'), 'stale');
    writeFileSync(path.join(root, '.keep.pending'), 'keep');
    expect(await cleanupLibraryMutationArtifacts(root, 0)).toBe(1);
    expect(existsSync(path.join(root, '.keep.pending'))).toBe(true);
  });
});

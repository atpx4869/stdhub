import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { addFileToLibrary, parseLibraryFilename } from './library-index';
import { _resetLibraryPathCacheForTesting } from '../shared/library-paths';

// 注意：这套测试只 cover 纯函数 parseLibraryFilename。
// scanLibrary / addFileToLibrary / watcher 需要真 DB + fs，留到 e2e 层。
//
// labr 接入的关键回归点：新格式 `{stdCode} {title} - {LABEL}.pdf` 必须能正确切出
// stdCode 头部 / year / title，旧格式 `{stdCode} - {LABEL}.pdf` 不能回归。

describe('parseLibraryFilename — old format (backward compat)', () => {
  it('parses BW with year', () => {
    expect(parseLibraryFilename('GB_T 3324-2024 - BW.pdf')).toEqual({
      stdCodeRaw: 'GB/T 3324-2024',
      stdCodeNorm: 'GB3324',
      year: '2024',
      source: 'gbw',
      title: '',
    });
  });

  it('parses BZ', () => {
    expect(parseLibraryFilename('JJG 196-2006 - BZ.pdf')).toEqual({
      stdCodeRaw: 'JJG 196-2006',
      stdCodeNorm: 'JJG196',
      year: '2006',
      source: 'bz',
      title: '',
    });
  });

  it('parses BY', () => {
    expect(parseLibraryFilename('GB 3324-2008 - BY.pdf')).toEqual({
      stdCodeRaw: 'GB 3324-2008',
      stdCodeNorm: 'GB3324',
      year: '2008',
      source: 'by',
      title: '',
    });
  });

  it('accepts GBW alias for BW', () => {
    const parsed = parseLibraryFilename('GB_T 3324-2024 - GBW.pdf');
    expect(parsed?.source).toBe('gbw');
  });

  it('is case-insensitive on the label', () => {
    expect(parseLibraryFilename('GB_T 3324-2024 - bw.pdf')?.source).toBe('gbw');
    expect(parseLibraryFilename('GB_T 3324-2024 - Bz.pdf')?.source).toBe('bz');
  });

  it('handles em-dash separator', () => {
    expect(parseLibraryFilename('GB_T 3324-2024 — BW.pdf')?.source).toBe('gbw');
  });

  it('parses locally imported BD files', () => {
    const parsed = parseLibraryFilename('GB_T 3324-2024 木家具 - BD.pdf');
    expect(parsed?.source).toBe('bd');
    expect(parsed?.title).toBe('木家具');
  });
});

describe('parseLibraryFilename — new format with title', () => {
  it('parses BW with Chinese title', () => {
    expect(parseLibraryFilename('GB_T 3324-2024 木家具通用技术条件 - BW.pdf')).toEqual({
      stdCodeRaw: 'GB/T 3324-2024',
      stdCodeNorm: 'GB3324',
      year: '2024',
      source: 'gbw',
      title: '木家具通用技术条件',
    });
  });

  it('parses BZ with title — year still extracted correctly (regression: V1 anchored year at $)', () => {
    const parsed = parseLibraryFilename('JJG 196-2006 燃气表检定规程 - BZ.pdf');
    expect(parsed?.year).toBe('2006');
    expect(parsed?.title).toBe('燃气表检定规程');
    expect(parsed?.stdCodeNorm).toBe('JJG196');
  });

  it('parses BY with title containing spaces and punctuation', () => {
    const parsed = parseLibraryFilename('GB 3324-2008 木质家具 第1部分：通用要求 - BY.pdf');
    expect(parsed?.year).toBe('2008');
    expect(parsed?.title).toBe('木质家具 第1部分：通用要求');
  });

  it('does not confuse a title-internal " - " for the source separator', () => {
    // 严格锚定结尾的 ` - LABEL` 匹配；中段的 " - " 不会误判
    const parsed = parseLibraryFilename('GB_T 3324-2024 通用 - 技术条件 - BW.pdf');
    expect(parsed?.source).toBe('gbw');
    expect(parsed?.title).toBe('通用 - 技术条件');
  });
});

describe('parseLibraryFilename — stdCode shape coverage', () => {
  it('DB44/T with digit-bearing prefix', () => {
    const parsed = parseLibraryFilename('DB44_T 2107-2018 - BW.pdf');
    expect(parsed?.stdCodeRaw).toBe('DB44/T 2107-2018');
    expect(parsed?.year).toBe('2018');
    expect(parsed?.stdCodeNorm).toBe('DB442107');
  });

  it('JB/T with sub-part number (4730.5)', () => {
    const parsed = parseLibraryFilename('JB_T 4730.5-2005 - BY.pdf');
    expect(parsed?.stdCodeRaw).toBe('JB/T 4730.5-2005');
    expect(parsed?.year).toBe('2005');
  });

  it('GB/T with revision letter (2010A)', () => {
    const parsed = parseLibraryFilename('GB_T 3836-2010A - BW.pdf');
    expect(parsed?.stdCodeRaw).toBe('GB/T 3836-2010A');
    expect(parsed?.year).toBe('2010');
  });

  it('ISO standard', () => {
    const parsed = parseLibraryFilename('ISO 4287-1997 - BW.pdf');
    expect(parsed?.year).toBe('1997');
    expect(parsed?.source).toBe('gbw');
  });

  it('standard without year', () => {
    const parsed = parseLibraryFilename('GB 3324 - BW.pdf');
    expect(parsed?.year).toBe('');
    expect(parsed?.stdCodeNorm).toBe('GB3324');
    expect(parsed?.title).toBe('');
  });

  it('no-year standard with title', () => {
    const parsed = parseLibraryFilename('GB 3324 木家具 - BW.pdf');
    expect(parsed?.year).toBe('');
    expect(parsed?.title).toBe('木家具');
  });
});

describe('parseLibraryFilename — rejection cases', () => {
  it('rejects non-pdf', () => {
    expect(parseLibraryFilename('GB_T 3324-2024 - BW.docx')).toBeNull();
  });

  it('rejects unknown source label', () => {
    expect(parseLibraryFilename('GB_T 3324-2024 - XX.pdf')).toBeNull();
  });

  it('rejects filename without source label', () => {
    expect(parseLibraryFilename('GB_T 3324-2024.pdf')).toBeNull();
  });

  it('rejects filename starting with non-stdCode chars', () => {
    expect(parseLibraryFilename('某某标准 - BW.pdf')).toBeNull();
  });

  it('rejects empty body before separator', () => {
    expect(parseLibraryFilename(' - BW.pdf')).toBeNull();
  });
});

describe('addFileToLibrary compensation', () => {
  it('restores the downloaded source file when indexing fails after the move', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'stdhub-library-add-'));
    const libraryDir = path.join(root, 'library');
    const sourcePath = path.join(root, 'download.pdf');
    const db = new Database(':memory:');
    try {
      writeFileSync(sourcePath, Buffer.alloc(2048, 1));
      db.exec(`
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE standard_files (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          std_code_norm TEXT NOT NULL,
          year TEXT NOT NULL DEFAULT '',
          source TEXT NOT NULL,
          abs_path TEXT NOT NULL,
          file_name TEXT NOT NULL DEFAULT '',
          size INTEGER NOT NULL DEFAULT 0,
          mtime INTEGER NOT NULL DEFAULT 0,
          mime TEXT NOT NULL DEFAULT 'application/pdf',
          etag TEXT,
          indexed_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE (std_code_norm, year, source)
        );
        CREATE TRIGGER fail_library_insert BEFORE INSERT ON standard_files
        BEGIN SELECT RAISE(ABORT, 'injected index failure'); END;
      `);
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('standards_library_dir', libraryDir);
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('library_filename_pattern', '{stdCode} - {source}');
      _resetLibraryPathCacheForTesting();

      await expect(addFileToLibrary(db, {
        srcPath: sourcePath,
        stdCode: 'GB/T 3324-2024',
        source: 'bz',
      })).rejects.toThrow('injected index failure');

      expect(existsSync(sourcePath)).toBe(true);
      expect(readFileSync(sourcePath)).toHaveLength(2048);
      expect(db.prepare('SELECT COUNT(*) FROM standard_files').pluck().get()).toBe(0);
    } finally {
      _resetLibraryPathCacheForTesting();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

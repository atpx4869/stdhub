import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');
const library = readFileSync(path.join(root, 'public/js/app-file-library.js'), 'utf8');
const single = readFileSync(path.join(root, 'public/js/app-download-single.js'), 'utf8');
const batch = readFileSync(path.join(root, 'public/js/app-download-batch.js'), 'utf8');
const css = readFileSync(path.join(root, 'public/css/workspace.css'), 'utf8');
const routes = readFileSync(path.join(root, 'src/api/download-routes.ts'), 'utf8');
const html = readFileSync(path.join(root, 'public/index.html'), 'utf8');

describe('download history locate contract', () => {
  it('persists stable library file IDs from every successful download path', () => {
    expect(library).toContain('function recordDownload(source, fileName, standardNumber, fileId)');
    expect(single).toContain('recordDownload(sourceForHistory, fileName, r.standardNumber, fileId)');
    expect(single).toContain('recordDownload(result.source, result.fileName, label, result.fileId)');
    expect(batch).toContain('recordDownload(winner.source, winner.fileName, item.standardNumber, winner.fileId)');
    expect(batch).toContain('recordDownload(data.source, data.fileName, item.standardNumber, data.fileId)');
  });

  it('locates by file ID, highlights and degrades explicitly when missing', () => {
    expect(library).toContain('data-history-file-id=');
    expect(library).toContain('async function locateDownloadHistoryEntry(entry)');
    expect(library).toContain('await refreshFileLibrary({ page: 1, fileId, waitForIdle: true, throwOnError: true })');
    expect(library).toContain("if (search) search.value = fileId ? '' : query");
    expect(library).toContain('legacyChoice.ambiguous');
    expect(library).toContain('找到多个同名文件');
    expect(library).toContain('fileLibraryLocatedId = Number(located.dataset.fileId)');
    expect(library).toContain("Number(f.fileId) === fileLibraryLocatedId ? ' is-history-located' : ''");
    expect(library).toContain('可能已移动或删除');
    expect(css).toContain('.local-row.is-history-located');
    expect(routes).toContain("? 'WHERE id = ?'");
    expect(routes).toContain("fileId must be a canonical positive safe integer");
    expect(routes).toContain("const fileIdText = typeof fileIdRaw === 'string' ? fileIdRaw : ''");
    expect(routes).not.toContain('String(fileIdRaw).trim()');
    expect(routes).toContain("const libraryOnly = requestedFileId > 0");
    expect(html.indexOf('/js/history-locate.js')).toBeLessThan(html.indexOf('/js/app-file-library.js'));
  });
});

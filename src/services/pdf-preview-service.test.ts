import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../api/app';
import { getDb, setSetting } from './db';
import { PdfPreviewService, type PdfPreviewManifest, type PreviewServiceOptions } from './pdf-preview-service';
import { _resetLibraryPathCacheForTesting } from '../shared/library-paths';

const roots: string[] = [];

async function makeRoot(): Promise<{ root: string; library: string; dbPath: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'stdhub-preview-test-'));
  roots.push(root);
  const library = path.join(root, 'standards');
  const dbPath = path.join(root, 'data', 'test.db');
  await mkdir(library, { recursive: true });
  await mkdir(path.dirname(dbPath), { recursive: true });
  return { root, library, dbPath };
}

function insertPdf(db: ReturnType<typeof getDb>, filePath: string, size: number, mtime: number, source = 'bz'): number {
  setSetting(db, 'standards_library_dir', path.dirname(filePath));
  _resetLibraryPathCacheForTesting();
  return Number(db.prepare(`
    INSERT INTO standard_files (std_code_norm, year, source, abs_path, file_name, size, mtime, mime, etag)
    VALUES ('GB1234', '2026', ?, ?, ?, ?, ?, 'application/pdf', ?)
  `).run(source, filePath, path.basename(filePath), size, mtime, `"${size}-${mtime}"`).lastInsertRowid);
}

async function waitForManifest(
  service: PdfPreviewService,
  fileId: number,
  status: PdfPreviewManifest['status'],
  predicate: (manifest: PdfPreviewManifest) => boolean = () => true,
): Promise<PdfPreviewManifest> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const manifest = await service.getManifest(fileId, false);
    if (manifest?.status === status && predicate(manifest)) return manifest;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`preview did not reach ${status}`);
}

afterEach(async () => {
  _resetLibraryPathCacheForTesting();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('PdfPreviewService', () => {
  it('reuses BZ page bytes, deduplicates work, persists WebP pages, and invalidates by content hash', async () => {
    const { root, library, dbPath } = await makeRoot();
    const db = getDb(dbPath);
    const pdfPath = path.join(library, 'GB 1234-2026 - BZ.pdf');
    await writeFile(pdfPath, '%PDF-1.4 first source');
    const pdfStat = await stat(pdfPath);
    const fileId = insertPdf(db, pdfPath, pdfStat.size, pdfStat.mtimeMs);
    const jpeg = await sharp({ create: { width: 80, height: 120, channels: 3, background: '#f4ead5' } }).jpeg().toBuffer();
    const service = new PdfPreviewService(db, root, { minFreeBytes: 0, width: 800, maxHeight: 1200 });
    await service.start(false);
    await service.getManifest(fileId, false);

    expect(service.enqueue(fileId, [jpeg, jpeg])).toBe(true);
    expect(service.enqueue(fileId, [jpeg, jpeg])).toBe(false);
    const first = await waitForManifest(service, fileId, 'ready');
    expect(first).toMatchObject({ pageCount: 2, completedPages: 2, format: 'webp', error: null });
    expect(first.sourceHash).toBe(createHash('sha256').update('%PDF-1.4 first source').digest('hex'));
    expect((await readFile(path.join(service.cacheRoot, String(fileId), '0001.webp'))).subarray(0, 4).toString('hex')).toBe('52494646');

    await writeFile(pdfPath, '%PDF-1.4 replaced source with new bytes');
    const replaced = await stat(pdfPath);
    db.prepare('UPDATE standard_files SET size = ?, mtime = ?, etag = ? WHERE id = ?')
      .run(replaced.size, replaced.mtimeMs, `"${replaced.size}-${replaced.mtimeMs}"`, fileId);
    service.enqueue(fileId, [jpeg]);
    const second = await waitForManifest(service, fileId, 'ready', manifest => manifest.sourceHash !== first.sourceHash);
    expect(second.pageCount).toBe(1);
    expect(second.sourceHash).not.toBe(first.sourceHash);

    await service.remove(fileId);
    await expect(stat(path.join(service.cacheRoot, String(fileId)))).rejects.toThrow();
    await service.close();
    db.close();
  }, 15_000);

  it('records converter failures and successfully retries an interrupted preview', async () => {
    const { root, library, dbPath } = await makeRoot();
    const db = getDb(dbPath);
    const pdfPath = path.join(library, 'GB 1234-2026 - BW.pdf');
    await writeFile(pdfPath, '%PDF-1.4 converter fixture');
    const pdfStat = await stat(pdfPath);
    const fileId = insertPdf(db, pdfPath, pdfStat.size, pdfStat.mtimeMs, 'gbw');
    const png = await sharp({ create: { width: 60, height: 90, channels: 3, background: '#ffffff' } }).png().toBuffer();
    let fail = true;
    const runCommand: NonNullable<PreviewServiceOptions['runCommand']> = vi.fn(async (command, args) => {
      if (fail) throw new Error('PDF is encrypted and requires a password');
      if (command === 'pdfinfo') return 'Pages: 1\nEncrypted: no\n';
      const outputBase = args.at(-1)!;
      await writeFile(`${outputBase}.png`, png);
      return '';
    });
    const service = new PdfPreviewService(db, root, { minFreeBytes: 0, width: 800, maxHeight: 1200, runCommand });
    await service.start(false);
    service.enqueue(fileId);
    const failed = await waitForManifest(service, fileId, 'failed');
    expect(failed.error?.code).toBe('PDF_ENCRYPTED');

    fail = false;
    await service.retry(fileId);
    const recovered = await waitForManifest(service, fileId, 'ready');
    expect(recovered.completedPages).toBe(1);
    await service.close();
    db.close();
  });

  it('finishes a 101-page image-native document without expanding queue concurrency', async () => {
    const { root, library, dbPath } = await makeRoot();
    const db = getDb(dbPath);
    const pdfPath = path.join(library, 'GB 1234-2026 - BZ.pdf');
    await writeFile(pdfPath, '%PDF-1.4 long-image-document');
    const pdfStat = await stat(pdfPath);
    const fileId = insertPdf(db, pdfPath, pdfStat.size, pdfStat.mtimeMs);
    const scannedPage = await sharp(Buffer.from(`
      <svg width="48" height="68" xmlns="http://www.w3.org/2000/svg">
        <rect width="48" height="68" fill="#f7f1df"/><path d="M4 9h40M4 15h35M4 21h39M4 40h34M4 46h40" stroke="#5d5a54"/>
        <rect x="5" y="26" width="38" height="9" fill="#c7d5df"/>
      </svg>`)).jpeg({ quality: 72 }).toBuffer();
    const service = new PdfPreviewService(db, root, { minFreeBytes: 0, width: 800, maxHeight: 1200, concurrency: 1 });
    await service.start(false);
    service.enqueue(fileId, Array.from({ length: 101 }, () => scannedPage));
    const manifest = await waitForManifest(service, fileId, 'ready');
    expect(manifest).toMatchObject({ pageCount: 101, completedPages: 101 });
    expect(manifest.pages.at(-1)?.page).toBe(101);
    await service.close();
    db.close();
  }, 30_000);
});

describe('preview HTTP contract', () => {
  it('serves a manifest/page and keeps original PDF view/download Range-safe', async () => {
    const previousAdminPassword = process.env.STDHUB_ADMIN_PASSWORD;
    process.env.STDHUB_ADMIN_PASSWORD = 'preview-test-password';
    const { root, library, dbPath } = await makeRoot();
    const pdfPath = path.join(library, 'GB 1234-2026 - BW.pdf');
    const pdfBytes = Buffer.from('%PDF-1.4 range-test-content');
    await writeFile(pdfPath, pdfBytes);
    const png = await sharp({ create: { width: 40, height: 60, channels: 3, background: '#ddeeff' } }).png().toBuffer();
    const runCommand: NonNullable<PreviewServiceOptions['runCommand']> = async (command, args) => {
      if (command === 'pdfinfo') return 'Pages: 1\nEncrypted: no\n';
      await writeFile(`${args.at(-1)}.png`, png);
      return '';
    };
    const app = createApp({ baseDir: root, dbPath, startBackgroundJobs: false, previewServiceOptions: { minFreeBytes: 0, width: 800, maxHeight: 1200, runCommand } });
    const admin = request.agent(app);
    const login = await admin.post('/api/auth/login').send({ password: 'preview-test-password' });
    expect(login.status).toBe(200);
    const db = app.locals.db as ReturnType<typeof getDb>;
    const pdfStat = await stat(pdfPath);
    const fileId = insertPdf(db, pdfPath, pdfStat.size, pdfStat.mtimeMs, 'gbw');

    const initial = await admin.get(`/api/files/${fileId}/preview/manifest`);
    expect(initial.status).toBe(200);
    expect(initial.body.data).toMatchObject({ fileId, format: 'webp', viewUrl: `/api/files/${fileId}/pdf/view`, downloadUrl: `/api/files/${fileId}/pdf/download` });
    const service = app.locals.pdfPreviewService as PdfPreviewService;
    await waitForManifest(service, fileId, 'ready');

    const page = await admin.get(`/api/files/${fileId}/preview/pages/1`);
    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toMatch(/^image\/webp/);
    expect((await admin.get(`/api/files/${fileId}/preview/pages/0`)).status).toBe(400);
    expect((await admin.get(`/api/files/${fileId}/preview/pages/2`)).status).toBe(416);

    const range = await admin.get(`/api/files/${fileId}/pdf/view`).set('Range', 'bytes=0-7');
    expect(range.status).toBe(206);
    expect(range.headers['accept-ranges']).toBe('bytes');
    expect(range.headers['content-range']).toBe(`bytes 0-7/${pdfBytes.length}`);
    expect(range.body).toEqual(pdfBytes.subarray(0, 8));
    const download = await admin.get(`/api/files/${fileId}/pdf/download`);
    expect(download.headers['content-disposition']).toMatch(/^attachment;/);
    const head = await admin.head(`/api/files/${fileId}/pdf/download`);
    expect(head.status).toBe(200);
    expect(head.headers['content-length']).toBe(String(pdfBytes.length));
    expect(head.body).toEqual({});

    await app.shutdown();
    if (previousAdminPassword === undefined) delete process.env.STDHUB_ADMIN_PASSWORD;
    else process.env.STDHUB_ADMIN_PASSWORD = previousAdminPassword;
  });
});

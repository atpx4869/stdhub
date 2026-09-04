import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import type Database from 'better-sqlite3';
import sharp from 'sharp';
import { resolveLibraryDir, resolveSafeLibraryFile } from '../shared/library-paths';
import { subscribeLibraryFileEvents } from './library-events';

export type PdfPreviewStatus = 'pending' | 'processing' | 'ready' | 'failed';

export interface PdfPreviewPage {
  page: number;
  width: number;
  height: number;
  url: string;
}

export interface PdfPreviewManifest {
  sourceHash: string | null;
  sourceFingerprint: string;
  status: PdfPreviewStatus;
  pageCount: number;
  completedPages: number;
  format: 'webp';
  width: number;
  quality: number;
  generatorVersion: number;
  pages: PdfPreviewPage[];
  error: { code: string; message: string } | null;
  updatedAt: string;
}

interface StandardFileRecord {
  id: number;
  abs_path: string;
  file_name: string;
  source: string;
  size: number;
  mtime: number;
  mime: string;
  etag: string;
}

interface PendingJob {
  fileId: number;
  previewPages?: Uint8Array[];
}

export interface PreviewServiceOptions {
  cacheRoot?: string;
  concurrency?: number;
  width?: number;
  maxHeight?: number;
  quality?: number;
  commandTimeoutMs?: number;
  minFreeBytes?: number;
  runCommand?: typeof runCommand;
}

const GENERATOR_VERSION = 1;
const DEFAULT_WIDTH = 1800;
const DEFAULT_MAX_HEIGHT = 2600;
const DEFAULT_QUALITY = 88;
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const DEFAULT_MIN_FREE_BYTES = 256 * 1024 * 1024;

function boundedInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value!)));
}

function envInt(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function pageFileName(page: number): string {
  return `${String(page).padStart(4, '0')}.webp`;
}

function classifyError(error: unknown): { code: string; message: string } {
  const raw = error instanceof Error ? error.message : String(error);
  if (/ENOENT|not recognized|not found/i.test(raw) && /pdfinfo|pdftoppm/i.test(raw)) {
    return { code: 'CONVERTER_NOT_FOUND', message: 'PDF 转换工具不可用，请安装 Poppler（pdfinfo / pdftoppm）' };
  }
  if (/password|encrypted|Incorrect password/i.test(raw)) {
    return { code: 'PDF_ENCRYPTED', message: 'PDF 已加密或需要密码，无法生成图片预览' };
  }
  if (/timeout/i.test(raw)) return { code: 'CONVERSION_TIMEOUT', message: 'PDF 转换超时' };
  if (/ENOSPC|disk space/i.test(raw)) return { code: 'DISK_FULL', message: '磁盘空间不足，无法生成预览' };
  if (/deleted|不存在|ENOENT/i.test(raw)) return { code: 'SOURCE_GONE', message: '原始 PDF 已被删除' };
  if (/page size|pixel|Input image exceeds/i.test(raw)) return { code: 'PAGE_TOO_LARGE', message: 'PDF 页面尺寸异常，已停止转换' };
  return { code: 'CONVERSION_FAILED', message: raw.slice(0, 500) || 'PDF 转换失败' };
}

async function runCommand(command: string, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, signal });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill('SIGKILL');
      reject(new Error(`${command} timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', (error) => {
      settled = true;
      clearTimeout(timer);
      reject(new Error(`${command}: ${error.message}`));
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const out = Buffer.concat(stdout).toString('utf8');
      const err = Buffer.concat(stderr).toString('utf8').trim();
      if (code === 0) resolve(out);
      else reject(new Error(`${command} exited ${code}: ${err || out}`));
    });
  });
}

export class PdfPreviewService {
  readonly cacheRoot: string;
  private readonly concurrency: number;
  private readonly width: number;
  private readonly maxHeight: number;
  private readonly quality: number;
  private readonly commandTimeoutMs: number;
  private readonly minFreeBytes: number;
  private readonly executeCommand: typeof runCommand;
  private readonly queued = new Map<number, PendingJob>();
  private readonly active = new Map<number, AbortController>();
  private readonly running = new Set<Promise<void>>();
  private readonly manifestWrites = new Map<number, Promise<void>>();
  private unsubscribeEvents: (() => void) | null = null;
  private closed = false;

  constructor(private readonly db: Database.Database, baseDir: string, options: PreviewServiceOptions = {}) {
    this.cacheRoot = path.resolve(options.cacheRoot || path.join(baseDir, 'data', 'preview-cache'));
    this.concurrency = boundedInt(options.concurrency ?? envInt('STDHUB_PREVIEW_CONCURRENCY', 1), 1, 1, 4);
    this.width = boundedInt(options.width ?? envInt('STDHUB_PREVIEW_WIDTH', DEFAULT_WIDTH), DEFAULT_WIDTH, 800, 2400);
    this.maxHeight = boundedInt(options.maxHeight ?? envInt('STDHUB_PREVIEW_MAX_HEIGHT', DEFAULT_MAX_HEIGHT), DEFAULT_MAX_HEIGHT, 1200, 5000);
    this.quality = boundedInt(options.quality ?? envInt('STDHUB_PREVIEW_QUALITY', DEFAULT_QUALITY), DEFAULT_QUALITY, 50, 100);
    this.commandTimeoutMs = boundedInt(options.commandTimeoutMs ?? envInt('STDHUB_PREVIEW_TIMEOUT_MS', DEFAULT_COMMAND_TIMEOUT_MS), DEFAULT_COMMAND_TIMEOUT_MS, 5_000, 600_000);
    const configuredMinFreeBytes = options.minFreeBytes
      ?? envInt('STDHUB_PREVIEW_MIN_FREE_MB', DEFAULT_MIN_FREE_BYTES / 1024 / 1024) * 1024 * 1024;
    this.minFreeBytes = Math.max(0, configuredMinFreeBytes);
    this.executeCommand = options.runCommand || runCommand;
  }

  async start(enqueueExisting = true): Promise<void> {
    if (this.closed || this.unsubscribeEvents) return;
    await fs.mkdir(this.cacheRoot, { recursive: true });
    await this.cleanup();
    if (this.closed) return;
    this.unsubscribeEvents = subscribeLibraryFileEvents((event) => {
      if (event.type === 'remove') void this.remove(event.fileId);
      else this.enqueue(event.file.fileId, event.file.previewPages);
    });
    if (enqueueExisting) {
      const rows = this.db.prepare("SELECT id FROM standard_files WHERE mime = 'application/pdf' ORDER BY id").all() as Array<{ id: number }>;
      for (const row of rows) this.enqueue(row.id);
    }
  }

  enqueue(fileId: number, previewPages?: Uint8Array[]): boolean {
    if (this.closed || !Number.isInteger(fileId) || fileId <= 0) return false;
    const existing = this.queued.get(fileId);
    if (existing) {
      if (previewPages?.length) existing.previewPages = previewPages;
      return false;
    }
    if (this.active.has(fileId)) {
      this.queued.set(fileId, { fileId, previewPages });
      return false;
    }
    this.queued.set(fileId, { fileId, previewPages });
    this.pump();
    return true;
  }

  async retry(fileId: number): Promise<PdfPreviewManifest> {
    await this.remove(fileId);
    await this.writeManifest(fileId, this.emptyManifest(this.getRecord(fileId)));
    this.queued.set(fileId, { fileId });
    this.pump();
    return (await this.readManifest(fileId))!;
  }

  async getManifest(fileId: number, ensureGeneration = true): Promise<PdfPreviewManifest | null> {
    const record = this.getRecord(fileId);
    if (!record || record.mime !== 'application/pdf') return null;
    let manifest = await this.readManifest(fileId);
    if (!manifest || manifest.sourceFingerprint !== this.fingerprint(record) || manifest.generatorVersion !== GENERATOR_VERSION) {
      // A library event may already be rebuilding this file. Do not abort that fresh job
      // merely because a polling request observed the previous manifest between updates.
      if (this.active.has(fileId) || this.queued.has(fileId)) return manifest || this.emptyManifest(record);
      if (manifest) await this.remove(fileId);
      manifest = this.emptyManifest(record);
      await this.writeManifest(fileId, manifest);
      if (ensureGeneration) {
        this.queued.set(fileId, { fileId });
        this.pump();
      }
    } else if (ensureGeneration && (manifest.status === 'pending' || manifest.status === 'processing')) {
      this.enqueue(fileId);
    }
    return manifest;
  }

  async getPage(fileId: number, page: number): Promise<{ path: string; manifest: PdfPreviewManifest } | null> {
    const manifest = await this.getManifest(fileId, false);
    if (!manifest || page < 1 || page > manifest.pageCount || page > manifest.completedPages) return null;
    const pagePath = path.join(this.cacheDir(fileId), pageFileName(page));
    try {
      const stat = await fs.stat(pagePath);
      if (!stat.isFile()) return null;
      return { path: pagePath, manifest };
    } catch {
      return null;
    }
  }

  async remove(fileId: number): Promise<void> {
    this.queued.delete(fileId);
    this.active.get(fileId)?.abort(new Error('Preview source removed'));
    const dir = this.cacheDir(fileId);
    if (!this.isInsideCache(dir)) return;
    await this.manifestWrites.get(fileId)?.catch(() => {});
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }

  async cleanup(): Promise<void> {
    await fs.mkdir(this.cacheRoot, { recursive: true });
    const validIds = new Set((this.db.prepare('SELECT id FROM standard_files').all() as Array<{ id: number }>).map(row => String(row.id)));
    const entries = await fs.readdir(this.cacheRoot, { withFileTypes: true }).catch(() => []);
    const tempCutoff = Date.now() - 24 * 60 * 60 * 1000;
    const failedCutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    for (const entry of entries) {
      const entryPath = path.join(this.cacheRoot, entry.name);
      if (!this.isInsideCache(entryPath)) continue;
      if (entry.isDirectory() && /^\d+$/.test(entry.name) && !validIds.has(entry.name)) {
        await fs.rm(entryPath, { recursive: true, force: true }).catch(() => {});
        continue;
      }
      if (entry.isDirectory() && /^\d+$/.test(entry.name)) {
        const manifest = await this.readManifest(Number(entry.name));
        const updatedAt = manifest ? Date.parse(manifest.updatedAt) : Number.NaN;
        if (manifest?.status === 'failed' && Number.isFinite(updatedAt) && updatedAt < failedCutoff) {
          await fs.rm(entryPath, { recursive: true, force: true }).catch(() => {});
          continue;
        }
        const cacheFiles = await fs.readdir(entryPath, { withFileTypes: true }).catch(() => []);
        for (const cacheFile of cacheFiles) {
          if (!cacheFile.name.includes('.tmp-') && !cacheFile.name.startsWith('.page-')) continue;
          const tempPath = path.join(entryPath, cacheFile.name);
          const stat = await fs.stat(tempPath).catch(() => null);
          if (stat && stat.mtimeMs < tempCutoff) await fs.rm(tempPath, { recursive: true, force: true }).catch(() => {});
        }
      }
      if (entry.name.includes('.tmp-')) {
        const stat = await fs.stat(entryPath).catch(() => null);
        if (stat && stat.mtimeMs < tempCutoff) await fs.rm(entryPath, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.unsubscribeEvents?.();
    this.unsubscribeEvents = null;
    this.queued.clear();
    for (const controller of this.active.values()) controller.abort(new Error('Application shutting down'));
    await Promise.allSettled(Array.from(this.running));
    this.active.clear();
  }

  private pump(): void {
    while (!this.closed && this.active.size < this.concurrency && this.queued.size > 0) {
      const next = this.queued.entries().next().value as [number, PendingJob] | undefined;
      if (!next) return;
      const [fileId, job] = next;
      this.queued.delete(fileId);
      const controller = new AbortController();
      this.active.set(fileId, controller);
      const running = this.generate(job, controller.signal)
        .catch(() => {})
        .finally(() => {
          this.active.delete(fileId);
          this.running.delete(running);
          this.pump();
        });
      this.running.add(running);
    }
  }

  private async generate(job: PendingJob, signal: AbortSignal): Promise<void> {
    const record = this.getRecord(job.fileId);
    if (!record || record.mime !== 'application/pdf') return;
    const library = await resolveLibraryDir(this.db);
    const safe = await resolveSafeLibraryFile(record.abs_path, library.dir).catch(() => null);
    if (!safe) {
      await this.fail(job.fileId, this.emptyManifest(record), new Error('原始 PDF 不存在或已被删除'));
      return;
    }

    let manifest = this.emptyManifest(record);
    try {
      await this.assertDiskSpace();
      const sourceHash = await this.hashFile(safe.realPath, signal);
      const current = await this.readManifest(job.fileId);
      if (current?.status === 'ready' && current.sourceHash === sourceHash && current.generatorVersion === GENERATOR_VERSION) return;

      await this.resetCacheDir(job.fileId);
      manifest = { ...manifest, sourceHash, status: 'processing', updatedAt: new Date().toISOString() };
      await this.writeManifest(job.fileId, manifest);

      const pageCount = job.previewPages?.length || await this.readPageCount(safe.realPath, signal);
      if (pageCount < 1 || pageCount > 20_000) throw new Error(`Invalid PDF page count: ${pageCount}`);
      manifest.pageCount = pageCount;
      await this.writeManifest(job.fileId, manifest);

      for (let page = 1; page <= pageCount; page++) {
        if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Preview generation cancelled');
        await this.assertDiskSpace();
        const output = path.join(this.cacheDir(job.fileId), pageFileName(page));
        const tempOutput = `${output}.tmp-${randomUUID()}`;
        let metadata: sharp.OutputInfo;
        if (job.previewPages?.[page - 1]) {
          metadata = await this.encodeImage(job.previewPages[page - 1], tempOutput);
        } else {
          const rasterBase = path.join(this.cacheDir(job.fileId), `.page-${page}-${randomUUID()}`);
          const rasterPath = `${rasterBase}.png`;
          try {
            await this.executeCommand('pdftoppm', [
              '-f', String(page), '-l', String(page), '-singlefile', '-png',
              '-scale-to', String(this.maxHeight), safe.realPath, rasterBase,
            ], this.commandTimeoutMs, signal);
            metadata = await this.encodeImage(rasterPath, tempOutput);
          } finally {
            await fs.rm(rasterPath, { force: true }).catch(() => {});
          }
        }
        await fs.rename(tempOutput, output);
        manifest.completedPages = page;
        manifest.pages.push({
          page,
          width: metadata.width,
          height: metadata.height,
          url: `/api/files/${job.fileId}/preview/pages/${page}?v=${sourceHash.slice(0, 16)}`,
        });
        manifest.updatedAt = new Date().toISOString();
        await this.writeManifest(job.fileId, manifest);
      }
      manifest.status = 'ready';
      manifest.updatedAt = new Date().toISOString();
      await this.writeManifest(job.fileId, manifest);
    } catch (error) {
      if (this.closed || signal.aborted) return;
      await this.fail(job.fileId, manifest, error);
    }
  }

  private async encodeImage(input: string | Uint8Array, output: string): Promise<sharp.OutputInfo> {
    return sharp(input, { limitInputPixels: this.width * this.maxHeight * 4 })
      .flatten({ background: '#ffffff' })
      .resize({ width: this.width, height: this.maxHeight, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: this.quality, effort: 4 })
      .toFile(output);
  }

  private async readPageCount(pdfPath: string, signal: AbortSignal): Promise<number> {
    const output = await this.executeCommand('pdfinfo', [pdfPath], Math.min(this.commandTimeoutMs, 30_000), signal);
    const encrypted = /^Encrypted:\s+yes/im.test(output);
    if (encrypted) throw new Error('PDF is encrypted and requires a password');
    const match = /^Pages:\s+(\d+)/im.exec(output);
    if (!match) throw new Error('PDF is damaged: page count is unavailable');
    return Number(match[1]);
  }

  private async hashFile(filePath: string, signal: AbortSignal): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const hash = createHash('sha256');
      const stream = createReadStream(filePath);
      const abort = () => stream.destroy(signal.reason instanceof Error ? signal.reason : new Error('Hash cancelled'));
      signal.addEventListener('abort', abort, { once: true });
      stream.on('data', chunk => hash.update(chunk));
      stream.once('error', reject);
      stream.once('end', () => resolve(hash.digest('hex')));
      stream.once('close', () => signal.removeEventListener('abort', abort));
    });
  }

  private async assertDiskSpace(): Promise<void> {
    if (!this.minFreeBytes) return;
    const stats = await fs.statfs(this.cacheRoot).catch(() => null);
    if (stats && Number(stats.bavail) * Number(stats.bsize) < this.minFreeBytes) {
      throw new Error('disk space is below the configured preview safety threshold');
    }
  }

  private async fail(fileId: number, manifest: PdfPreviewManifest, error: unknown): Promise<void> {
    const classified = classifyError(error);
    console.error(`[pdf-preview] file=${fileId} ${classified.code}: ${classified.message}`);
    await this.writeManifest(fileId, {
      ...manifest,
      status: 'failed',
      error: classified,
      updatedAt: new Date().toISOString(),
    }).catch(() => {});
  }

  private getRecord(fileId: number): StandardFileRecord | null {
    return (this.db.prepare(`
      SELECT id, abs_path, file_name, source, size, mtime, mime, COALESCE(etag, '') AS etag
      FROM standard_files WHERE id = ?
    `).get(fileId) as StandardFileRecord | undefined) || null;
  }

  private emptyManifest(record: StandardFileRecord | null): PdfPreviewManifest {
    return {
      sourceHash: null,
      sourceFingerprint: record ? this.fingerprint(record) : '',
      status: 'pending',
      pageCount: 0,
      completedPages: 0,
      format: 'webp',
      width: this.width,
      quality: this.quality,
      generatorVersion: GENERATOR_VERSION,
      pages: [],
      error: null,
      updatedAt: new Date().toISOString(),
    };
  }

  private fingerprint(record: StandardFileRecord): string {
    return record.etag || `${record.size}:${record.mtime}`;
  }

  private cacheDir(fileId: number): string {
    return path.join(this.cacheRoot, String(fileId));
  }

  private manifestPath(fileId: number): string {
    return path.join(this.cacheDir(fileId), 'manifest.json');
  }

  private isInsideCache(target: string): boolean {
    const relative = path.relative(this.cacheRoot, path.resolve(target));
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
  }

  private async resetCacheDir(fileId: number): Promise<void> {
    const dir = this.cacheDir(fileId);
    if (!this.isInsideCache(dir)) throw new Error('Invalid preview cache path');
    await this.manifestWrites.get(fileId)?.catch(() => {});
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(dir, { recursive: true });
  }

  private async readManifest(fileId: number): Promise<PdfPreviewManifest | null> {
    try {
      return JSON.parse(await fs.readFile(this.manifestPath(fileId), 'utf8')) as PdfPreviewManifest;
    } catch {
      return null;
    }
  }

  private async writeManifest(fileId: number, manifest: PdfPreviewManifest): Promise<void> {
    const previous = this.manifestWrites.get(fileId) || Promise.resolve();
    const current = previous.catch(() => {}).then(async () => {
      const dir = this.cacheDir(fileId);
      if (!this.isInsideCache(dir)) throw new Error('Invalid preview cache path');
      await fs.mkdir(dir, { recursive: true });
      const target = this.manifestPath(fileId);
      const temp = `${target}.tmp-${randomUUID()}`;
      await fs.writeFile(temp, JSON.stringify(manifest, null, 2), 'utf8');
      try {
        await fs.rename(temp, target);
      } catch (error: any) {
        if (error?.code !== 'EPERM' && error?.code !== 'EEXIST') throw error;
        await fs.rm(target, { force: true });
        await fs.rename(temp, target);
      }
    });
    this.manifestWrites.set(fileId, current);
    try {
      await current;
    } finally {
      if (this.manifestWrites.get(fileId) === current) this.manifestWrites.delete(fileId);
    }
  }
}

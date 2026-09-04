import path from 'node:path';
import { createReadStream } from 'node:fs';
import type { Request, Response } from 'express';

export interface PdfStreamFile {
  realPath: string;
  size: number;
  mtimeMs: number;
  fileName?: string;
  etag?: string;
}

function contentDisposition(type: 'inline' | 'attachment', fileName: string): string {
  const normalized = fileName.toLowerCase().endsWith('.pdf') ? fileName : `${fileName}.pdf`;
  const asciiName = normalized.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  return `${type}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(normalized)}`;
}

export function streamPdf(
  req: Request,
  res: Response,
  file: PdfStreamFile,
  disposition: 'inline' | 'attachment',
): void {
  const fileName = path.basename(file.fileName || file.realPath);
  const etag = file.etag || `W/"${file.size.toString(16)}-${file.mtimeMs.toString(16)}"`;
  if (req.headers['if-none-match'] === etag) {
    res.status(304).end();
    return;
  }
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', contentDisposition(disposition, fileName));
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
  res.setHeader('Accept-Ranges', 'bytes');

  if (req.method === 'HEAD') {
    res.setHeader('Content-Length', String(file.size));
    res.end();
    return;
  }

  const range = req.headers.range;
  if (!range) {
    res.setHeader('Content-Length', String(file.size));
    const stream = createReadStream(file.realPath);
    stream.once('error', () => res.destroy());
    stream.pipe(res);
    return;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) {
    res.status(416).setHeader('Content-Range', `bytes */${file.size}`).end();
    return;
  }
  let start: number;
  let end: number;
  if (match[1] === '' && match[2] !== '') {
    const suffix = Number(match[2]);
    if (!Number.isFinite(suffix) || suffix <= 0) {
      res.status(416).setHeader('Content-Range', `bytes */${file.size}`).end();
      return;
    }
    start = Math.max(0, file.size - suffix);
    end = file.size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? file.size - 1 : Number(match[2]);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end >= file.size || start > end) {
    res.status(416).setHeader('Content-Range', `bytes */${file.size}`).end();
    return;
  }
  res.status(206);
  res.setHeader('Content-Range', `bytes ${start}-${end}/${file.size}`);
  res.setHeader('Content-Length', String(end - start + 1));
  const stream = createReadStream(file.realPath, { start, end });
  stream.once('error', () => res.destroy());
  stream.pipe(res);
}

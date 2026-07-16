import { describe, expect, it } from 'vitest';

import {
  MIN_PDF_BYTES,
  assertDownloadedPdf,
  assertNonEmptyDownload,
} from './download-integrity';
import { UpstreamError } from './errors';

const PDF_HEAD = Buffer.from('%PDF-1.4\n');

function pad(buf: Buffer, total: number): Buffer {
  if (buf.length >= total) return buf;
  return Buffer.concat([buf, Buffer.alloc(total - buf.length)]);
}

describe('download-integrity', () => {
  it('MIN_PDF_BYTES 定为 1024', () => {
    expect(MIN_PDF_BYTES).toBe(1024);
  });

  describe('assertDownloadedPdf', () => {
    it('0 字节直接拒', () => {
      expect(() => assertDownloadedPdf(Buffer.alloc(0), 'test')).toThrow(UpstreamError);
    });

    it('100B 远小于阈值，拒', () => {
      const buf = pad(PDF_HEAD, 100);
      expect(() => assertDownloadedPdf(buf, 'test')).toThrow(/100B < 1024B/);
    });

    it('1024B 且 magic 正确，通过', () => {
      const buf = pad(PDF_HEAD, 1024);
      expect(() => assertDownloadedPdf(buf, 'test')).not.toThrow();
    });

    it('1024B 但非 PDF magic（如错误页 HTML），拒', () => {
      const html = Buffer.from('<html><body>error</body></html>');
      const buf = pad(html, 1024);
      expect(() => assertDownloadedPdf(buf, 'test')).toThrow(/非 PDF magic/);
    });

    it('大尺寸 + 正确 magic 通过', () => {
      const buf = pad(PDF_HEAD, 1024 * 1024);
      expect(() => assertDownloadedPdf(buf, 'test')).not.toThrow();
    });

    it('错误信息带上 label 帮诊断', () => {
      try {
        assertDownloadedPdf(Buffer.alloc(0), 'gbw hcno=ABC123');
      } catch (e) {
        expect((e as Error).message).toContain('gbw hcno=ABC123');
        return;
      }
      throw new Error('应该抛错');
    });
  });

  describe('assertNonEmptyDownload', () => {
    it('1024B 通过（不查 magic，labr 可能是 doc/docx）', () => {
      // DOCX magic 是 PK\x03\x04，不是 %PDF-，宽校验应当通过
      const docx = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
      const buf = pad(docx, 1024);
      expect(() => assertNonEmptyDownload(buf, 'labr')).not.toThrow();
    });

    it('500B 仍然拒', () => {
      const buf = Buffer.alloc(500);
      expect(() => assertNonEmptyDownload(buf, 'labr did=1')).toThrow(/500B < 1024B/);
    });
  });
});

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('paginated preview frontend contract', () => {
  it('uses viewport loading and releases reader resources on close', async () => {
    const source = await readFile(path.resolve('public/js/app-preview.js'), 'utf8');
    expect(source).toContain('new IntersectionObserver');
    expect(source).toContain("rootMargin: '150% 0px'");
    expect(source).toContain('candidate = Math.max(1, page - 2)');
    expect(source).toContain("image.decoding = 'async'");
    expect(source).toContain('this.fetchController.abort()');
    expect(source).toContain("this.container.removeEventListener('click', this.onClick)");
    expect(source).not.toMatch(/pdfh5|pdfjsLib|PDFViewer/);
  });

  it('opens original PDFs explicitly in a separate browsing context', async () => {
    const html = await readFile(path.resolve('public/index.html'), 'utf8');
    const source = await readFile(path.resolve('public/js/app-preview.js'), 'utf8');
    const labr = await readFile(path.resolve('public/js/app-labr.js'), 'utf8');
    expect(html).not.toMatch(/pdfh5|app-pdf-viewer|pdf\.worker/);
    expect(source).toContain('target="_blank" rel="noopener noreferrer"');
    expect(source).toContain('/preview/pages/${page}');
    expect(labr).not.toContain('/api/preview/file/');
  });

  it('presents one accessible document toolbar across desktop and mobile', async () => {
    const html = await readFile(path.resolve('public/index.html'), 'utf8');
    const source = await readFile(path.resolve('public/js/app-preview.js'), 'utf8');
    const css = await readFile(path.resolve('public/css/preview-reader.css'), 'utf8');
    expect(html).toContain('role="dialog" aria-modal="true" aria-labelledby="previewTitle"');
    expect(html).toContain('id="previewPageInput"');
    expect(html).toContain('id="previewActionMenu"');
    expect(html).toContain('id="previewActionSourceButtons"');
    expect(html.match(/id="previewOpenNewBtn"/g)).toHaveLength(1);
    expect(html.match(/id="previewDownloadBtn"/g)).toHaveLength(1);
    expect(source).toContain('jumpToPage(value)');
    expect(source).toContain('_previewReturnFocus');
    expect(source).toContain("image.classList.add('is-ready')");
    expect(source).not.toContain('image-reader-toolbar');
    expect(css).toContain('100dvh');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
  });
});

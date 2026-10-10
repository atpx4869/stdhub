import { describe, expect, it } from 'vitest';
import { DOC88_UA, parseDoc88SearchHtml } from './doc88-search';

describe('Doc88 search contract', () => {
  it('keeps the reader Chrome 71 user-agent invariant', () => {
    expect(DOC88_UA).toContain('Chrome/71.0.3578.98');
  });

  it('parses only PDF entries and derives standard metadata from evidence', () => {
    const html = `
      <a href="https://www.doc88.com/p-123456789012.html?format=PDF" class="sd-title" title="GB/T 3325-2024 包装用纸和纸板"></a>
      <div>页数： 27　上传时间：2026-01-02</div>
      <a href="https://www.doc88.com/p-223456789012.html?format=DOC" class="sd-title" title="忽略 DOC"></a>
      <a href="https://www.doc88.com/p-323456789012.html?format=PDF" class="sd-title" title="没有标准号的年度总结"></a>
      <div>页数： 8　上传时间：2026-02-03</div>`;
    expect(parseDoc88SearchHtml(html, 20)).toEqual([
      { pcode: '123456789012', title: 'GB/T 3325-2024 包装用纸和纸板', pages: 27, date: '2026-01-02', standardNumber: 'GB/T 3325-2024', cleanTitle: '包装用纸和纸板' },
      { pcode: '323456789012', title: '没有标准号的年度总结', pages: 8, date: '2026-02-03', standardNumber: '', cleanTitle: '没有标准号的年度总结' },
    ]);
  });
});

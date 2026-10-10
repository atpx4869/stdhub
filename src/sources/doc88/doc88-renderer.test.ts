import { describe, expect, it } from 'vitest';
import { DOC88_RENDER_INVARIANTS } from './doc88-renderer';

describe('Doc88 renderer protected invariants', () => {
  it('keeps the proven canvas rendering contract', () => {
    expect(DOC88_RENDER_INVARIANTS).toMatchObject({
      minPngBytes: 35_000,
      jobs: 1,
      cookieFlags: ['cdb_IMGR', 'cdb_H5R'],
      preferCssPageSize: true,
    });
    expect(DOC88_RENDER_INVARIANTS.userAgent).toContain('Chrome/71.0.3578.98');
  });
});

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('mobile navigation and file library frontend contract', () => {
  it('keeps every desktop file-library field on one grid row', async () => {
    const css = await readFile(path.resolve('public/css/pages.css'), 'utf8');
    expect(css).toContain('.local-col-check { grid-column: 1; grid-row: 1; }');
    expect(css).toContain('.local-col-std { grid-column: 2; grid-row: 1; flex-wrap: nowrap; }');
    expect(css).toMatch(/\.local-col-name \{[\s\S]*?grid-column: 3;[\s\S]*?grid-row: 1;/);
    expect(css).toContain('.local-col-actions { grid-column: 7; grid-row: 1; }');
  });

  it('supports deliberate left-edge swipe back on mobile', async () => {
    const source = await readFile(path.resolve('public/js/app-mobile.js'), 'utf8');
    expect(source).toContain('touch.clientX <= 28');
    expect(source).toContain('dx >= 84');
    expect(source).toContain("document.addEventListener('touchmove'");
    expect(source).toContain('{ passive: false }');
    expect(source).toContain('closeTopMobileLayer()');
    expect(source).toContain('mobileTabHistory.pop()');
    expect(source).toContain('window.history.back()');
  });
});

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('mobile navigation and file library frontend contract', () => {
  it('keeps the task center in the mobile topbar without a persistent bottom dock', async () => {
    const [html, css, source] = await Promise.all([
      readFile(path.resolve('public/index.html'), 'utf8'),
      readFile(path.resolve('public/css/mobile.css'), 'utf8'),
      readFile(path.resolve('public/js/app-download-center.js'), 'utf8'),
    ]);
    expect(html).toContain('class="topbar-btn download-center-toggle"');
    expect(html).toContain('ti ti-list-check');
    expect(html).toMatch(/id="downloadCenterToggle"[\s\S]*?id="topbarThemeToggle"/);
    expect(html).not.toContain('id="mobileTaskDock"');
    expect(css).toContain('body:not(.force-desktop) .download-center-toggle');
    expect(css).not.toContain('.mobile-task-dock');
    expect(source).not.toContain('renderMobileTaskDock');
    expect(source).toContain("downloadTasks.filter(t => t.status === 'running')");
  });

  it('keeps every desktop file-library field on one grid row', async () => {
    const css = await readFile(path.resolve('public/css/pages.css'), 'utf8');
    expect(css).toContain('.local-col-check { grid-column: 1; grid-row: 1; }');
    expect(css).toContain('.local-col-std { grid-column: 2; grid-row: 1; flex-wrap: nowrap; }');
    expect(css).toMatch(/\.local-col-name \{[\s\S]*?grid-column: 3;[\s\S]*?grid-row: 1;/);
    expect(css).toContain('.local-col-actions { grid-column: 7; grid-row: 1; }');
    expect(css).toContain('grid-template-columns: 40px minmax(320px, 400px) minmax(180px, 1fr) 72px 140px 64px 100px;');
    expect(css).toContain('.local-std-code { flex: 0 0 auto; }');
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

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('mobile navigation and file library frontend contract', () => {
  it('offers only Paper and legacy themes and keeps the V3 search guidance', async () => {
    const [html, themeSource, palette] = await Promise.all([
      readFile(path.resolve('public/index.html'), 'utf8'),
      readFile(path.resolve('public/js/app-theme.js'), 'utf8'),
      readFile(path.resolve('public/js/app-command-palette.js'), 'utf8'),
    ]);
    expect(themeSource).toContain("var VALID = ['paper', 'legacy']");
    expect(html).not.toContain('data-theme="dark"');
    expect(html).not.toContain('data-theme="light"');
    expect(palette).not.toContain("id: 'theme-dark'");
    expect(palette).not.toContain("id: 'theme-light'");
    expect(html).toContain('placeholder="输入标准号或关键词…"');
    expect(html).toContain('data-search-example="GB/T 3324-2024"');
  });

  it('removes the task center UI while retaining download task helpers', async () => {
    const [html, source, palette] = await Promise.all([
      readFile(path.resolve('public/index.html'), 'utf8'),
      readFile(path.resolve('public/js/app-download-center.js'), 'utf8'),
      readFile(path.resolve('public/js/app-command-palette.js'), 'utf8'),
    ]);
    expect(html).not.toContain('id="downloadCenterToggle"');
    expect(html).not.toContain('id="downloadCenterPanel"');
    expect(html).not.toContain('打开下载中心');
    expect(palette).not.toContain("id: 'task-center'");
    expect(source).toContain('function createDownloadTask');
    expect(source).toContain('function createTaskCenterTask');
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

  it('keeps pull-to-refresh for the file library but not search results', async () => {
    const [mobileSource, gestureSource] = await Promise.all([
      readFile(path.resolve('public/js/app-mobile.js'), 'utf8'),
      readFile(path.resolve('public/js/ui-enhance-gesture.js'), 'utf8'),
    ]);
    expect(mobileSource).toContain("enablePullRefresh('#fileLibraryList'");
    expect(mobileSource).not.toContain("enablePullRefresh('#results'");
    expect(gestureSource).not.toContain('initPullToRefresh');
  });
});

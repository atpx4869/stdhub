import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('frontend foundation contract', () => {
  it('loads the StdHub foundation before feature scripts with one asset version token', async () => {
    const html = await readFile(path.resolve('public/index.html'), 'utf8');
    expect(html.indexOf('/js/app-foundation.js')).toBeGreaterThan(-1);
    expect(html.indexOf('/js/app-foundation.js')).toBeLessThan(html.indexOf('/js/app-core.js'));
    const localAssetTags = html.match(/(?:src|href)="\/(?:js|css|vendor)\/[^"?]+(?:\?[^"#]*)?"/g) || [];
    expect(localAssetTags.length).toBeGreaterThan(20);
    expect(localAssetTags.every((tag) => tag.includes('v=__STDHUB_ASSET_VERSION__'))).toBe(true);
    expect(html).not.toMatch(/\son(?:click|change|input|keydown)=/i);
    expect(html).toContain('data-stdhub-click=');
  });

  it('keeps the Paper sidebar icon rail consistent and semantically distinct', async () => {
    const [html, workspace] = await Promise.all([
      readFile(path.resolve('public/index.html'), 'utf8'),
      readFile(path.resolve('public/css/workspace.css'), 'utf8'),
    ]);
    expect(html).toContain('sidebar-icon ti ti-file-search');
    expect(html).toContain('sidebar-icon ti ti-certificate');
    expect(html).toContain('sidebar-icon ti ti-database-search');
    expect(html).toContain('sidebar-icon ti ti-folder-open');
    expect(html).toContain('sidebar-icon ti ti-list-details');
    expect(html).toContain('sidebar-icon ti ti-chart-bar');
    expect(workspace).toMatch(/\.sidebar-item \.sidebar-icon \{[\s\S]*?width: 28px;[\s\S]*?height: 28px;/);
    expect(workspace).toContain('.sidebar-item.active .sidebar-icon');
  });

  it('renders the user access entry as a centered accessible dialog', async () => {
    const [html, authCore, pages] = await Promise.all([
      readFile(path.resolve('public/index.html'), 'utf8'),
      readFile(path.resolve('public/js/app-auth-core.js'), 'utf8'),
      readFile(path.resolve('public/css/components-pages.css'), 'utf8'),
    ]);
    expect(html).toContain('id="userDropdown" role="dialog" aria-modal="true"');
    expect(html).toContain('class="user-dialog-card"');
    expect(authCore).toContain('function closeUserDropdown()');
    expect(authCore).toContain("event.target === dialog");
    expect(pages).toMatch(/\.user-dropdown \{[\s\S]*?inset: 0;[\s\S]*?place-items: center;/);
    expect(pages).toContain('.user-dialog-action { width: 100%;');
  });

  it('keeps guest downloads available in search results and standard details', async () => {
    const [singleDownload, batchDownload, detail] = await Promise.all([
      readFile(path.resolve('public/js/app-download-single.js'), 'utf8'),
      readFile(path.resolve('public/js/app-download-batch.js'), 'utf8'),
      readFile(path.resolve('public/js/app-detail-utils.js'), 'utf8'),
    ]);
    expect(singleDownload).toContain("currentUser?.role !== 'admin' && winner.fileId");
    expect(singleDownload).toContain('downloadLocalFile(winner.fileId');
    expect(singleDownload).toContain("currentUser?.role !== 'admin' && result.fileId");
    expect(batchDownload).toContain("currentUser?.role !== 'admin' && winner.fileId");
    expect(detail).toContain("const isGuestDownload = currentUser?.role !== 'admin'");
    expect(detail).toContain("isGuestDownload ? '下载 PDF' : '按默认策略下载'");
  });

  it('allows every standard with confirmed text to download regardless of lifecycle status', async () => {
    const searchRender = await readFile(path.resolve('public/js/app-search-render.js'), 'utf8');
    const textStateStart = searchRender.indexOf('function resolveTextState');
    const downloadStart = searchRender.indexOf('function isDownloadable');
    const previewStart = searchRender.indexOf('function isPreviewable');
    const textStateSource = searchRender.slice(textStateStart, downloadStart);
    const downloadSource = searchRender.slice(downloadStart, previewStart);
    expect(textStateSource).not.toContain("status.includes('废止')");
    expect(downloadSource).not.toContain("status.includes('废止')");
    expect(downloadSource).toContain('if (r.previewAvailable) return true;');
  });

  it('routes search, qualification, and library requests through the shared client', async () => {
    const files = await Promise.all([
      'public/js/app-search-core.js',
      'public/js/app-qual-search.js',
      'public/js/app-file-library.js',
    ].map((file) => readFile(path.resolve(file), 'utf8')));
    for (const source of files) {
      expect(source).toContain('window.StdHub.api.fetch(');
      expect(source).not.toMatch(/(?<!StdHub\.api\.)\bfetch\(/);
    }
  });

  it('provides API, DOM, UI, modal, and lifecycle compatibility surfaces', async () => {
    const [foundation, components] = await Promise.all([
      readFile(path.resolve('public/js/app-foundation.js'), 'utf8'),
      readFile(path.resolve('public/js/app-ui-components.js'), 'utf8'),
    ]);
    expect(foundation).toContain('root.api =');
    expect(foundation).toContain('root.dom =');
    expect(foundation).toContain('root.ui =');
    expect(foundation).toContain('root.lifecycle =');
    expect(foundation).toContain('root.actions =');
    expect(foundation).toContain('root.assets =');
    expect(components).toContain('window.StdHub.modal =');
  });

  it('keeps administrator actions CSP-safe and submits the remote setup token', async () => {
    const [authCore, settings, qualificationLabs] = await Promise.all([
      readFile(path.resolve('public/js/app-auth-core.js'), 'utf8'),
      readFile(path.resolve('public/js/app-settings.js'), 'utf8'),
      readFile(path.resolve('public/js/app-qual-lab.js'), 'utf8'),
    ]);
    expect(authCore).not.toMatch(/\sonclick=/i);
    expect(authCore).toContain('data-stdhub-click=');
    expect(authCore).toContain('setupToken');
    expect(authCore).toContain('authSetupRequiresToken');
    expect(settings).not.toMatch(/\son(?:click|change|input|keydown)=/i);
    expect(settings).toContain('data-stdhub-click=');
    expect(settings).toContain('<h2>资质数据</h2>');
    expect(settings).toContain('hubeiQualSources');
    expect(settings).not.toContain('id="qualCnasInput"');
    expect(settings).not.toContain('id="qualCmaInput"');
    expect(settings).not.toContain('关联CNAS');
    expect(qualificationLabs).toContain('/api/qualifications/profile');
    expect(qualificationLabs).toContain('/api/qualifications/sync/');
    expect(qualificationLabs).not.toContain('function loadQualLabs(');
    expect(qualificationLabs).not.toContain('function addQualLab(');
    expect(qualificationLabs).not.toContain('function linkQualLab(');
    expect(qualificationLabs).not.toContain('function deleteQualLab(');
    expect(qualificationLabs.slice(0, qualificationLabs.indexOf('let _natCmaSyncPollTimer'))).not.toMatch(/\son(?:click|change|input|keydown)=/i);
  });
});

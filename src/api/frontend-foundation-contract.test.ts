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
});

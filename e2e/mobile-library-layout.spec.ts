import { expect, test } from 'playwright/test';

const items = [
  { fileId: 1, kind: 'library', standardNumber: 'GB/T 3324-2024', title: '木家具通用技术条件', fileName: 'GB_T 3324-2024 木家具通用技术条件.pdf', size: 587776, indexedAt: '2026-07-07T00:28:00Z', source: 'gbw', previewUrl: '/mock.pdf', path: '/mock/a.pdf' },
  { fileId: 2, kind: 'library', standardNumber: 'GB/T 3324-2016', title: '木家具通用技术条件', fileName: 'GB_T 3324-2016 木家具通用技术条件.pdf', size: 9751757, indexedAt: '2026-09-17T14:51:00Z', source: 'bd', previewUrl: '/mock.pdf', path: '/mock/b.pdf' },
  { fileId: 3, kind: 'library', standardNumber: 'GB/T 3324-2016', title: '木家具通用技术条件', fileName: 'GB_T 3324-2016 木家具通用技术条件副本.pdf', size: 9751757, indexedAt: '2026-09-17T14:51:00Z', source: 'bd', previewUrl: '/mock.pdf', path: '/mock/c.pdf' },
];

async function mockAdmin(page: import('playwright/test').Page) {
  await page.route('**/api/auth/status', route => route.fulfill({ json: { data: { user: { id: 1, username: 'admin', displayName: '管理员', role: 'admin', allowedTabs: null }, loginRequired: true, needsSetup: false }, error: null } }));
  await page.route('**/api/downloads?**', route => route.fulfill({ json: { data: { items, total: 4, libraryTotal: 3, limit: 30, offset: 0 }, error: null } }));
  await page.route('**/api/qualifications/badges**', route => route.fulfill({ json: { data: {}, error: null } }));
  await page.route('**/api/check/saved/codes', route => route.fulfill({ json: { data: { codes: [] }, error: null } }));
  await page.route('**/api/check/saved/meta', route => route.fulfill({ json: { data: { items: [] }, error: null } }));
  await page.route('**/api/announcements/unread', route => route.fulfill({ json: { data: { announcements: [] }, error: null } }));
  await page.route('**/api/diagnostics/environment', route => route.fulfill({ json: { data: { checks: {} }, error: null } }));
}

test('mobile file library remains compact and clear of fixed chrome', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockAdmin(page);
  await page.goto('/');
  await page.waitForFunction("typeof currentUser !== 'undefined' && currentUser.role === 'admin'");
  await page.locator('.mobile-tab[data-tab="local"]').click();
  const pageLocal = page.locator('#page-local');
  const topbar = page.locator('.topbar');
  const tabbar = page.locator('.mobile-tabbar');
  const series = page.locator('.local-series-card').first();
  const children = series.locator('.local-series-child');

  await expect(page.locator('.topbar-title')).toHaveText('本地文件库');
  await expect(page.locator('#page-local .set-page-head-main')).toBeHidden();
  await expect(series).toBeVisible();
  await expect(children).toHaveCount(3);

  const topbarBox = await topbar.boundingBox();
  const actionBox = await page.locator('#page-local .set-page-head-actions').boundingBox();
  const tabbarBox = await tabbar.boundingBox();
  const documentWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(topbarBox).not.toBeNull(); expect(actionBox).not.toBeNull(); expect(tabbarBox).not.toBeNull();
  expect(actionBox!.y).toBeGreaterThanOrEqual(topbarBox!.y + topbarBox!.height - 1);
  expect(documentWidth).toBeLessThanOrEqual(390);

  for (const child of await children.all()) {
    const box = await child.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeLessThan(110);
    await expect(child.locator('.local-col-std')).toBeVisible();
    await expect(child.locator('.local-col-name')).toBeVisible();
    await expect(child.locator('.local-col-size')).toBeHidden();
    await expect(child.locator('.local-col-time')).toBeHidden();
    await expect(child.locator('.local-col-src')).toBeHidden();
  }

  await children.first().locator('input[data-local-check]').check();
  const selection = page.locator('#fileLibrarySelectionBar');
  await expect(selection).toBeVisible();
  const selectionBox = await selection.boundingBox();
  expect(selectionBox).not.toBeNull();
  expect(selectionBox!.y + selectionBox!.height).toBeLessThanOrEqual(tabbarBox!.y - 4);
});

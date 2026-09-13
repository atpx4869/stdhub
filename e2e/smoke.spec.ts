import { expect, test } from 'playwright/test';

test('guest shell is usable and administrator routes stay protected', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.locator('#searchInput')).toBeVisible();
  await expect(page.locator('[data-tab="search"]').first()).toBeVisible();
  const status = await request.get('/api/auth/status');
  expect((await status.json()).data.user.role).toBe('guest');
  expect((await request.get('/api/admin/users')).status()).toBe(403);
});

test('documented default administrator credentials unlock the app', async ({ request }) => {
  const response = await request.post('/api/auth/login', { data: { username: 'admin', password: 'adminadmin' } });
  expect(response.status()).toBe(200);
  expect((await response.json()).data.user).toMatchObject({ username: 'admin', role: 'admin' });
});

test('mobile guest can reach public qualification navigation', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/');
  const qualificationTab = page.locator('.mobile-tab[data-tab="qual"]');
  await expect(qualificationTab).toBeVisible();
  await qualificationTab.click();
  await expect(page.locator('#page-qual')).toBeVisible();
});

test('mobile search follows the V3 single-frame workbench and two-theme contract', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const input = page.locator('#searchInput');
  await input.focus();
  await expect(page.locator('#sourceTags')).toHaveCSS('justify-content', 'center');
  const sourceBox = await page.locator('#sourceTags').boundingBox();
  const searchBox = await page.locator('#searchRow').boundingBox();
  expect(sourceBox).not.toBeNull();
  expect(searchBox).not.toBeNull();
  expect(sourceBox!.y + sourceBox!.height).toBeLessThanOrEqual(searchBox!.y);
  await expect(input).toHaveCSS('border-top-width', '0px');
  await expect(input).toHaveCSS('box-shadow', 'none');
  await page.locator('#topbarThemeToggle').click();
  await expect(page.locator('#topbarThemePicker [data-theme]')).toHaveCount(2);
  await expect(page.locator('#topbarThemePicker [data-theme="paper"]')).toBeVisible();
  await expect(page.locator('#topbarThemePicker [data-theme="legacy"]')).toBeVisible();
});

test('administrator can reach file library and settings while national CMA stays suspended', async ({ page }) => {
  expect((await page.request.post('/api/auth/login', { data: { password: 'adminadmin' } })).status()).toBe(200);
  await page.goto('/');
  await page.locator('.sidebar-item[data-tab="local"]').click();
  await expect(page.locator('#page-local')).toBeVisible();
  await page.locator('.sidebar-item[data-tab="settings"]').click();
  await expect(page.locator('#page-settings')).toBeVisible();
  const health = await page.request.get('/api/health');
  expect((await health.json()).data.features.natCma).toEqual({ state: 'suspended', readOnly: true });
});

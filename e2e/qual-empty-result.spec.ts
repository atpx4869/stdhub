import { test, expect } from 'playwright/test';

// Regression: a source that succeeds with ZERO rows must stop its spinner.
// (Previously the loading state was inferred from "has items", so an empty
// CNAS result spun forever.)
test('qualification search clears spinners when a source returns no rows', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/api/qualifications/search?**', route => route.fulfill({ json: { data: { items: [] }, error: null } }));
  await page.goto('/');
  await page.waitForFunction("typeof currentUser !== 'undefined' && currentUser.role === 'admin'");
  await page.locator('.mobile-tab[data-tab="qual"]').click();
  await page.locator('#qualSearchInput').fill('4371');
  await page.locator('#qualSearchBtn').click();
  await expect(page.locator('.qual-async-loading')).toHaveCount(0, { timeout: 5000 });
  await expect(page.locator('#qualResults')).toContainText('未找到匹配资质');
});

test('qualification search renders rows and stops spinner', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/api/qualifications/search?**', route => {
    const source = new URL(route.request().url()).searchParams.get('source');
    const items = source === 'CNAS'
      ? [{ stdCode: 'GB 5009.9-2023', stdName: '食品安全国家标准', source: 'CNAS', labName: '湖北省产品质量监督检验研究院', certNumber: '221700110366', scopeStatus: '有效' }]
      : [];
    return route.fulfill({ json: { data: { items }, error: null } });
  });
  await page.goto('/');
  await page.waitForFunction("typeof currentUser !== 'undefined' && currentUser.role === 'admin'");
  await page.locator('.mobile-tab[data-tab="qual"]').click();
  await page.locator('#qualSearchInput').fill('GB 5009.9');
  await page.locator('#qualSearchBtn').click();
  await expect(page.locator('.qual-async-loading')).toHaveCount(0, { timeout: 5000 });
  await expect(page.locator('#qualResults')).toContainText('1 条');
  await expect(page.locator('#qualResults')).toContainText('无匹配');
});

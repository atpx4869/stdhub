import { test, expect } from 'playwright/test';

const items = [
  { pcode: '123456789012', title: 'GB/T 3325-2024 包装用纸和纸板', standardNumber: 'GB/T 3325-2024', cleanTitle: '包装用纸和纸板', pages: 27, date: '2026-01-01' },
  { pcode: '223456789012', title: '测试文档', standardNumber: '', cleanTitle: '测试文档', pages: 2, date: '2026-02-01', localFileId: 9, localFileName: 'GB_T 3324-2024 木家具 - D88.pdf' },
];

for (const width of [390, 1440]) {
  test(`Doc88 ${width}px: search, paginate, name, generate, download and rename`, async ({ page }) => {
    let persistedTask: any = null;
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({ width, height: 900 });
    await page.route('**/api/doc88/health', route => route.fulfill({ json: { data: { configured: true, busy: false, queueLength: 0 }, error: null } }));
    await page.route('**/api/doc88/tasks', route => {
      if (route.request().method() === 'GET') return route.fulfill({ json: { data: { items: persistedTask ? [persistedTask] : [] }, error: null } });
      const input = route.request().postDataJSON();
      expect(input.standardNumber).toBe('GB/T 3325-2024');
      expect(input.cleanTitle).toBe('用户确认的名称');
      return route.fulfill({ status: 202, json: { data: { id: 'd88_test', ...input, status: 'queued', phase: 'queued', message: '等待执行', current: 0, total: 27 }, error: null } });
    });
    await page.route('**/api/doc88/tasks/d88_test/stream', route => {
      persistedTask = { id: 'd88_test', pcode: items[0].pcode, standardNumber: items[0].standardNumber, title: items[0].title, status: 'success', phase: 'complete', message: '生成并入库完成', current: 27, total: 27, fileId: 7, fileName: 'GB_T 3325-2024 用户确认的名称 - D88.pdf' };
      return route.fulfill({ contentType: 'text/event-stream', body: 'data: ' + JSON.stringify({ data: persistedTask, error: null }) + '\n\n' });
    });
    await page.route('**/api/doc88/search?**', route => route.fulfill({ json: { data: { items, hasMore: true, page: Number(new URL(route.request().url()).searchParams.get('page')) }, error: null } }));
    await page.goto('/');
    await page.waitForFunction("typeof currentUser !== 'undefined' && currentUser.role === 'admin'");
    await page.locator('[data-search-mode="doc88"]').click();
    await expect(page.locator('#searchModeLabr')).toBeHidden();
    await page.locator('#doc88SearchInput').fill('3325');
    await page.locator('#doc88SearchBtn').click();
    await expect(page.locator('.doc88-result-item')).toHaveCount(2);
    await page.locator('[data-doc88-page="2"]').click();
    await expect(page.locator('#doc88Pager')).toContainText('第 2 页');
    const first = page.locator('.doc88-result-item').first();
    await first.locator('[data-doc88-action="generate"]').click();
    await page.locator('#doc88NamingTitle').fill('用户确认的名称');
    await page.locator('[data-confirm-action="confirm"]').click();
    await expect(first.locator('[data-doc88-action="download"]')).toBeVisible();
    await expect(first.locator('[data-doc88-action="rename"]')).toHaveAttribute('data-file-name', /用户确认的名称/);
    await page.evaluate(() => {
      (window as any).downloadLocalFile = (id: number) => { (window as any).__downloaded = id; };
      (window as any).renameLocalFile = async (id: number, fileName: string) => { (window as any).__renamed = { id, fileName }; };
      (window as any).openLocalPreview = (id: number) => { (window as any).__previewed = id; };
    });
    await first.locator('[data-doc88-action="download"]').click();
    await first.locator('[data-doc88-action="preview"]').click();
    await first.locator('[data-doc88-action="rename"]').click();
    expect(await page.evaluate(() => (window as any).__downloaded)).toBe(7);
    expect(await page.evaluate(() => (window as any).__previewed)).toBe(7);
    expect(await page.evaluate(() => (window as any).__renamed.id)).toBe(7);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
    await page.screenshot({ path: `test-results/doc88-${width}.png`, fullPage: true });
    await page.reload();
    await page.waitForFunction("typeof currentUser !== 'undefined' && currentUser.role === 'admin'");
    await page.locator('[data-search-mode="doc88"]').click();
    await expect(page.locator('#doc88TaskHistory')).toBeVisible();
    await page.locator('#doc88TaskHistory summary').click();
    await expect(page.locator('#doc88TaskHistory [data-doc88-action="download"]')).toBeVisible();
  });
}

import { expect, test } from 'playwright/test';

const libraryItems = [
  { fileId: 1, kind: 'library', standardNumber: 'GB 28007-2011', title: '儿童家具通用技术条件（超长中文名称测试）', fileName: 'GB 28007-2011 儿童家具通用技术条件超长文件名称.pdf', size: 102400, indexedAt: '2026-09-16T08:00:00Z', source: 'bz', previewUrl: '/mock.pdf', path: '/mock/a.pdf' },
  { fileId: 2, kind: 'library', standardNumber: 'GB 28007-2024', title: '儿童家具通用技术条件（最新版）', fileName: 'GB 28007-2024 儿童家具通用技术条件最新版.pdf', size: 204800, indexedAt: '2026-09-17T08:00:00Z', source: 'gbw', previewUrl: '/mock.pdf', path: '/mock/b.pdf' },
  { fileId: 3, kind: 'library', standardNumber: 'GB/T 3324-2024', title: '木家具通用技术条件', fileName: 'GB_T 3324-2024 木家具通用技术条件.pdf', size: 409600, indexedAt: '2026-09-17T09:00:00Z', source: 'by', previewUrl: '/mock.pdf', path: '/mock/c.pdf' },
];

async function openAsAdmin(page: import('playwright/test').Page) {
  page.on('pageerror', error => console.error(`FRONTEND_PAGEERROR: ${error.message}`));
  page.on('requestfailed', request => console.error(`FRONTEND_REQUEST_FAILED: ${request.url()} ${request.failure()?.errorText || ''}`));
  page.on('response', response => {
    if (response.status() >= 400 && /\.(js|css)(\?|$)/.test(response.url())) console.error(`FRONTEND_ASSET_FAILED: ${response.status()} ${response.url()}`);
  });
  await page.route('**/api/auth/status', route => route.fulfill({ json: { data: { user: { id: 1, username: 'admin', displayName: '隔离测试管理员', role: 'admin', allowedTabs: null }, loginRequired: true, needsSetup: false }, error: null } }));
  await page.route('**/api/downloads?**', route => {
    const url = new URL(route.request().url());
    const fileId = Number(url.searchParams.get('fileId') || 0);
    const query = String(url.searchParams.get('q') || '').toLowerCase();
    const items = fileId
      ? libraryItems.filter(item => item.fileId === fileId)
      : libraryItems.filter(item => !query || [item.fileName, item.standardNumber, item.source].some(value => String(value || '').toLowerCase().includes(query)));
    return route.fulfill({ json: { data: { items, total: fileId ? items.length : 2, libraryTotal: items.length, limit: 30, offset: 0 }, error: null } });
  });
  await page.route('**/api/qualifications/badges**', route => route.fulfill({ json: { data: {}, error: null } }));
  await page.route('**/api/check/saved/codes', route => route.fulfill({ json: { data: { codes: [] }, error: null } }));
  await page.route('**/api/check/saved/meta', route => route.fulfill({ json: { data: { items: [] }, error: null } }));
  await page.route('**/api/announcements/unread', route => route.fulfill({ json: { data: { announcements: [] }, error: null } }));
  await page.route('**/api/diagnostics/environment', route => route.fulfill({ json: { data: { startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), checks: {} }, error: null } }));
  await page.goto('http://127.0.0.1:4174/');
  await page.waitForFunction("typeof currentUser !== 'undefined' && currentUser.role === 'admin'");
  await expect(page.locator('#mobileLocalTab')).not.toHaveAttribute('hidden', '');
}

for (const theme of ['paper', 'legacy']) {
  test(`${theme}: library versions align and preserve manual collapse`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openAsAdmin(page);
    await page.evaluate(value => (window as Window & { bzxzTheme: { set: (theme: string) => void } }).bzxzTheme.set(value), theme);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.locator('.sidebar-item[data-tab="local"]').click();
    const card = page.locator('.local-series-card').first();
    await expect(card).toHaveClass(/is-expanded/);
    await expect(card.locator('.local-series-child')).toHaveCount(2);
    const children = card.locator('.local-series-child');
    const first = children.first();
    const second = children.nth(1);
    const geometry = await page.evaluate(() => {
      const head = document.querySelector('.local-thead');
      const child = document.querySelector('.local-series-child');
      if (!head || !child) return null;
      const inspect = (element: Element) => { const rect = element.getBoundingClientRect(); const style = getComputedStyle(element); return { left: rect.left, right: rect.right, width: rect.width, columns: style.gridTemplateColumns, gap: style.columnGap, paddingLeft: style.paddingLeft, paddingRight: style.paddingRight }; };
      return { head: inspect(head), child: inspect(child) };
    });
    expect(geometry).not.toBeNull();
    expect(Math.abs(geometry!.head.left - geometry!.child.left)).toBeLessThanOrEqual(2);
    expect(Math.abs(geometry!.head.right - geometry!.child.right)).toBeLessThanOrEqual(2);
    const headColumns = geometry!.head.columns.split(' ').map(parseFloat);
    const childColumns = geometry!.child.columns.split(' ').map(parseFloat);
    expect(childColumns).toHaveLength(headColumns.length);
    headColumns.forEach((width, index) => expect(Math.abs(width - childColumns[index])).toBeLessThanOrEqual(1));
    expect(geometry!.head.gap).toBe(geometry!.child.gap);
    expect(geometry!.head.paddingLeft).toBe(geometry!.child.paddingLeft);
    expect(geometry!.head.paddingRight).toBe(geometry!.child.paddingRight);
    const rowBoxes = await first.locator('.local-col-check, .local-col-std, .local-col-name, .local-col-size, .local-col-time, .local-col-src, .local-col-actions').evaluateAll(nodes => nodes.map(node => { const rect = node.getBoundingClientRect(); const style = getComputedStyle(node); return { top: rect.top, bottom: rect.bottom, center: rect.top + rect.height / 2, justifySelf: style.justifySelf, textAlign: style.textAlign }; }));
    expect(Math.max(...rowBoxes.map(box => box.center)) - Math.min(...rowBoxes.map(box => box.center))).toBeLessThanOrEqual(4);
    for (const selector of ['.local-col-check', '.local-col-std', '.local-col-name', '.local-col-size', '.local-col-time', '.local-col-src', '.local-col-actions']) {
      const head = await page.locator(`.local-thead ${selector}`).boundingBox();
      const a = await first.locator(selector).boundingBox(); const b = await second.locator(selector).boundingBox();
      expect(head).not.toBeNull(); expect(a).not.toBeNull(); expect(b).not.toBeNull();
      expect(Math.abs(a!.x - b!.x)).toBeLessThanOrEqual(2);
      expect(Math.abs(a!.x - head!.x)).toBeLessThanOrEqual(14);
    }
    await first.locator('input[data-local-check]').check();
    await expect(first.locator('input[data-local-check]')).toBeChecked();
    await first.locator('.local-row-menu summary').click();
    await expect(first.locator('.local-row-menu-popover')).toBeVisible();
    await page.screenshot({ path: `test-results/library-${theme}-1440-expanded.png`, fullPage: true });
    await first.locator('.local-row-menu summary').click();
    await card.locator('.local-series-summary').click();
    await expect(card.locator('.local-series-children')).toBeHidden();
    await page.locator('#fileLibrarySearch').fill('GB');
    await page.waitForTimeout(350);
    await expect(page.locator('.local-series-card').first().locator('.local-series-children')).toBeHidden();
    await page.screenshot({ path: `test-results/library-${theme}-1440-collapsed.png`, fullPage: true });
    await card.locator('.local-series-summary').click();
    await expect(card.locator('.local-series-children')).toBeVisible();
  });
}

test('375px library stays contained and supports selection and row menu', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await openAsAdmin(page);
  await page.locator('.mobile-tab[data-tab="local"]').click();
  const child = page.locator('.local-series-child').first();
  await expect(child).toBeVisible();
  await child.locator('input[data-local-check]').check();
  await child.locator('.local-row-menu summary').click();
  await expect(child.locator('.local-row-menu-popover')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/library-mobile-375.png', fullPage: true });
});

test('history locate survives rename by using ID and warns when the target is missing', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openAsAdmin(page);
  await page.evaluate(() => localStorage.setItem('bzxz_dl_history', JSON.stringify([
    { standardNumber: 'GB 28007-2024', fileName: '下载时的旧 文件 名.pdf', fileId: 2, source: 'gbw', status: 'success', time: '2026-09-17 12:30:00' },
    { standardNumber: 'GB/T 9999-2099', fileName: '已删除 中文 空格 文件.pdf', fileId: 9999, source: 'bz', status: 'success', time: '2026-09-17 12:31:00' },
  ])));
  await page.reload();
  await page.waitForFunction("typeof currentUser !== 'undefined' && currentUser.role === 'admin'");
  await page.locator('.sidebar-item[data-tab="history"]').click();
  await page.unroute('**/api/qualifications/badges**');
  await page.route('**/api/qualifications/badges**', async route => {
    await new Promise(resolve => setTimeout(resolve, 250));
    await route.fulfill({ json: { data: {}, error: null } });
  });
  const exactRequest = page.waitForRequest(request => {
    const url = new URL(request.url());
    return url.pathname === '/api/downloads' && url.searchParams.get('fileId') === '2';
  });
  await page.locator('[data-history-file-id="2"]').click();
  const requestUrl = new URL((await exactRequest).url());
  expect(requestUrl.searchParams.get('q')).toBeNull();
  const locatedRow = page.locator('#fileLibraryList .local-row[data-file-id="2"]');
  await expect(locatedRow).toHaveClass(/is-history-located/);
  await page.waitForTimeout(400);
  await expect(locatedRow).toHaveClass(/is-history-located/);
  await expect(locatedRow).not.toHaveClass(/is-history-located/, { timeout: 3_500 });
  await page.locator('.sidebar-item[data-tab="history"]').click();
  await page.locator('[data-history-file-id="9999"]').click();
  await expect(page.locator('.toast', { hasText: '可能已移动或删除' }).first()).toBeVisible();

  await page.route('**/api/downloads?**', route => route.fulfill({ status: 500, json: { data: null, error: { code: 'MOCK_FAILURE', message: '文件库暂时不可用' } } }));
  await page.locator('.sidebar-item[data-tab="history"]').click();
  await page.locator('[data-history-file-id="2"]').click();
  await expect(page.locator('.toast', { hasText: '定位失败' }).first()).toBeVisible();
});

test('legacy history fallback requires a unique filename and standard match', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const duplicate = { ...libraryItems[0], fileId: 4, standardNumber: 'GB 28007-2011', source: 'gbw' };
  await openAsAdmin(page);
  await page.unroute('**/api/downloads?**');
  await page.route('**/api/downloads?**', route => {
    const url = new URL(route.request().url());
    const query = String(url.searchParams.get('q') || '').toLowerCase();
    const all = [...libraryItems, duplicate];
    const items = all.filter(item => !query || [item.fileName, item.standardNumber].some(value => value.toLowerCase().includes(query)));
    return route.fulfill({ json: { data: { items, total: items.length, libraryTotal: items.length, limit: 30, offset: 0 }, error: null } });
  });
  await page.evaluate(() => localStorage.setItem('bzxz_dl_history', JSON.stringify([
    { standardNumber: 'GB/T 3324-2024', fileName: 'GB_T 3324-2024 木家具通用技术条件.pdf', source: 'by', status: 'success', time: '2026-09-17 12:30:00' },
    { fileName: 'GB 28007-2011 儿童家具通用技术条件超长文件名称.pdf', source: 'bz', status: 'success', time: '2026-09-17 12:31:00' },
  ])));
  await page.reload();
  await page.waitForFunction("typeof currentUser !== 'undefined' && currentUser.role === 'admin'");
  await page.locator('.sidebar-item[data-tab="history"]').click();
  await page.locator('[data-history-standard="GB/T 3324-2024"]').click();
  const uniqueRow = page.locator('#fileLibraryList .local-row[data-file-id="3"]');
  await expect(uniqueRow).toHaveClass(/is-history-located/);
  await expect(uniqueRow).not.toHaveClass(/is-history-located/, { timeout: 3_500 });
  await page.locator('.sidebar-item[data-tab="history"]').click();
  await page.locator('[data-history-standard=""]').click();
  await expect(page.locator('.toast', { hasText: '多个同名文件' }).first()).toBeVisible();
  await expect(page.locator('#fileLibraryList .is-history-located')).toHaveCount(0);
});

test('history locate reports an inflight loading timeout as failure', async ({ page }) => {
  test.setTimeout(18_000);
  await openAsAdmin(page);
  await page.evaluate(() => localStorage.setItem('bzxz_dl_history', JSON.stringify([
    { standardNumber: 'GB 28007-2024', fileName: '旧名.pdf', fileId: 2, source: 'gbw', status: 'success', time: '2026-09-17 12:30:00' },
  ])));
  await page.reload();
  await page.waitForFunction("typeof currentUser !== 'undefined' && currentUser.role === 'admin'");
  await page.unroute('**/api/downloads?**');
  await page.route('**/api/downloads?**', () => new Promise(() => {}));
  await page.locator('.sidebar-item[data-tab="local"]').click();
  await page.waitForTimeout(50);
  await page.evaluate(() => switchTab('history'));
  await page.locator('[data-history-file-id="2"]').click();
  await expect(page.locator('.toast', { hasText: '定位失败' }).first()).toBeVisible({ timeout: 12_000 });
  await expect(page.locator('.toast', { hasText: '加载超时' }).first()).toBeVisible();
});

test('history actions stay in one horizontal action area on desktop and mobile', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openAsAdmin(page);
  await page.evaluate(() => localStorage.setItem('bzxz_dl_history', JSON.stringify([
    { standardNumber: 'GB 28007-2024', name: '儿童家具通用技术条件超长中文名称', fileName: 'GB 28007-2024 儿童家具通用技术条件超长文件名称.pdf', source: 'bz', status: 'success', time: '2026-09-17 12:30:00' },
  ])));
  await page.reload();
  await page.locator('.sidebar-item[data-tab="history"]').click();
  const actions = page.locator('.history-row-actions').first();
  await expect(actions).toBeVisible();
  const buttons = actions.locator('button');
  expect(await buttons.count()).toBe(2);
  let boxes = await buttons.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect()));
  expect(Math.abs(boxes[0].top - boxes[1].top)).toBeLessThanOrEqual(2);
  await page.screenshot({ path: 'test-results/history-desktop-1440.png', fullPage: true });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.locator('.mobile-tab[data-tab="me"]').click();
  await page.locator('[data-me-tab="history"]').click();
  await expect(page.locator('#page-history')).toBeVisible();
  boxes = await buttons.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect()));
  expect(Math.abs(boxes[0].top - boxes[1].top)).toBeLessThanOrEqual(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/history-mobile-375.png', fullPage: true });
});

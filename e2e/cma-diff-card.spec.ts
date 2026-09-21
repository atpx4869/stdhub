import { expect, test } from 'playwright/test';

/**
 * cma-diff 机构维度比对卡片渲染冒烟。
 *
 * 目的：兜住 app-cma-diff-labs.js renderLabs() 这类「动态拼接 HTML 时的变量作用域错误」
 * （如误用未定义的 certNumber），这类错误 node --check 查不出、必须真实渲染才暴露。
 * 同时验证五档状态卡 + 近 90 天变动区 + 点击状态卡定位明细分组。
 */

const mockLabs = {
  items: [{
    certNumber: '221700110366',
    labName: '湖北省产品质量监督检验研究院',
    total: 9570,
    byStatus: { in_lib: 9412, cite_only: 96, abolished: 21, series_only: 28, not_in_lib: 13 },
    changes: {
      windowDays: 90,
      totalEvents: 3,
      deltaByStatus: { in_lib: -1, cite_only: 0, abolished: 1, series_only: 1, not_in_lib: 1 },
      events: [
        { stdCode: 'GB/T 17657-2022', stdName: '人造板及饰面人造板理化性能试验方法', changeType: 'status_changed', fromStatus: 'in_lib', toStatus: 'series_only', changedAt: '2026-09-12 10:00' },
        { stdCode: 'GB 18580-2025', stdName: '室内装饰装修材料 人造板及其制品中甲醛释放限量', changeType: 'status_changed', fromStatus: 'in_lib', toStatus: 'abolished', changedAt: '2026-09-08 10:00' },
        { stdCode: 'GB/T 35601-2024', stdName: '绿色产品评价 人造板和木质地板', changeType: 'added', fromStatus: '', toStatus: 'in_lib', changedAt: '2026-09-02 10:00' },
      ],
    },
  }],
};

async function openAsAdmin(page: import('playwright/test').Page) {
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.route('**/api/cma-diff/labs', route => route.fulfill({ json: { data: mockLabs, error: null } }));
  await page.route('**/api/cma-diff/domains', route => route.fulfill({ json: { data: { items: [], all: [] }, error: null } }));
  await page.route('**/api/cma-diff/labs/*/changes**', route => route.fulfill({ json: { data: { changes: mockLabs.items[0].changes }, error: null } }));
  // 详情表（点击状态卡后展开）返回空 rows，够渲染分组结构即可
  await page.route('**/api/cma-diff/labs/221700110366', route => route.fulfill({
    json: {
      data: {
        total: 3,
        rows: [
          { qualId: 1, stdCode: 'GB/T 17657-2022', stdName: '人造板及饰面人造板理化性能试验方法', diffStatus: 'series_only' },
          { qualId: 2, stdCode: 'GB 18580-2025', stdName: '室内装饰装修材料 人造板及其制品中甲醛释放限量', diffStatus: 'abolished' },
          { qualId: 3, stdCode: 'GB/T 35601-2024', stdName: '绿色产品评价 人造板和木质地板', diffStatus: 'in_lib' },
        ],
      },
      error: null,
    },
  }));
  await page.route('**/api/announcements/unread', route => route.fulfill({ json: { data: { announcements: [] }, error: null } }));
  await page.route('**/api/check/saved/codes', route => route.fulfill({ json: { data: { codes: [] }, error: null } }));
  await page.route('**/api/check/saved/meta', route => route.fulfill({ json: { data: { items: [] }, error: null } }));
  await page.route('**/api/downloads**', route => route.fulfill({ json: { data: { items: [], total: 0, libraryTotal: 0, limit: 30, offset: 0 }, error: null } }));
  await page.route('**/api/diagnostics/environment', route => route.fulfill({ json: { data: { startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), checks: {} }, error: null } }));
  await page.goto('http://127.0.0.1:4174/');
  await page.waitForFunction("typeof currentUser !== 'undefined' && currentUser.role === 'admin'");
  // 把 pageErrors 暴露给测试断言
  return pageErrors;
}

test('cma-diff 机构卡片渲染五档状态卡与变动区，且无前端运行时错误', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const pageErrors = await openAsAdmin(page);

  await page.locator('.sidebar-item[data-tab="cma-diff"]').click();
  await expect(page.locator('#page-cma-diff')).toBeVisible();
  // cma-diff 页默认激活「能力项目库搜索」子 tab，需切到「机构维度比对」
  await page.locator('.cap-lib-tab[data-cap-lib-tab="labs"]').click();

  // 五档状态卡常驻五格
  await expect(page.locator('.cap-lib-stat-card')).toHaveCount(5);

  // 待关注档（年版过期/未入库）有警示标记
  await expect(page.locator('.cap-lib-stat-card.is-warn')).toHaveCount(2);

  // 机构名 + 证书号 + 总数
  await expect(page.locator('.cap-lib-lab-name')).toContainText('湖北省产品质量监督检验研究院');
  await expect(page.locator('.cap-lib-lab-foot-total')).toContainText('9,570');

  // 变动区：标题 + 摘要 + 明细行
  await expect(page.locator('.cap-lib-change-title')).toContainText('近90天变动');
  await expect(page.locator('.cap-lib-change-row')).toHaveCount(3);

  // 无前端运行时错误（关键：捕获 certNumber is not defined 之类）
  expect(pageErrors).toEqual([]);
});

test('点击状态卡展开明细并定位到对应分组', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const pageErrors = await openAsAdmin(page);

  await page.locator('.sidebar-item[data-tab="cma-diff"]').click();
  await expect(page.locator('#page-cma-diff')).toBeVisible();
  await page.locator('.cap-lib-tab[data-cap-lib-tab="labs"]').click();
  await expect(page.locator('.cap-lib-stat-card')).toHaveCount(5);

  // 点击「未入库」状态卡（not_in_lib）
  await page.locator('.cap-lib-stat-card[data-status="not_in_lib"]').click();

  // 明细表应展开
  await expect(page.locator('.cap-lib-lab-body')).toBeVisible();
  await expect(page.locator('.cap-lib-stgroup').first()).toBeVisible();

  expect(pageErrors).toEqual([]);
});

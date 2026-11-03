import { expect, test } from 'playwright/test';
import ExcelJS from 'exceljs';

async function workbook(year: string) {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('已批准能力表');
  sheet.getCell('A2').value = '大类序号';
  sheet.getCell('H3').value = '编号（含年号）';
  sheet.getRow(4).values = ['十九', '家具', '407', '塑料家具', '407.1', '部分参数', '塑料家具通用技术条件', 'GB/T 32487-' + year, '不测：阻燃性能', '已批准测试备注'];
  return Buffer.from(await book.xlsx.writeBuffer());
}

test('国CMA管理仅在设置，预览确认、历史回退及同年版只读查询', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  expect((await page.request.post('/api/auth/login', { data: { password: 'adminadmin' } })).status()).toBe(200);
  await page.goto('/');
  await page.locator('.sidebar-item[data-tab="qual"]').click();
  await expect(page.locator('#page-qual #natCmaTableFile')).toHaveCount(0);
  await expect(page.locator('#page-qual #natCmaTableAdmin')).toHaveCount(0);
  await page.locator('.sidebar-item[data-tab="settings"]').click();
  await page.locator('#settingsNav').getByText('资质数据', { exact: true }).click();
  await expect(page.locator('#set-sec-qual #natCmaTableFile')).toBeVisible();

  const importVersion = async (year: string) => {
    const before = (await (await page.request.get('/api/nat-cma/table/status')).json()).data.batch;
    await page.locator('#natCmaTableBatchName').fill('浏览器回归-' + year);
    await page.locator('#natCmaTableFile').setInputFiles({ name: 'approved-' + year + '.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: await workbook(year) });
    await page.locator('#natCmaTablePreviewButton').click();
    await expect(page.locator('#natCmaTableConfirm')).toBeVisible();
    await expect(page.locator('#natCmaTablePreview')).toContainText('不测：阻燃性能');
    expect((await (await page.request.get('/api/nat-cma/table/status')).json()).data.batch?.id ?? null).toBe(before?.id ?? null);
    await page.locator('#natCmaTableConfirm').click();
    await page.locator('#confirmOverlay [data-confirm-action="cancel"]').click();
    expect((await (await page.request.get('/api/nat-cma/table/status')).json()).data.batch?.id ?? null).toBe(before?.id ?? null);
    await page.locator('#natCmaTableConfirm').click();
    await page.locator('#confirmOverlay [data-confirm-action="confirm"]').click();
    await expect(page.locator('#natCmaTablePreview')).toContainText('导入成功');
    await expect(page.locator('#natCmaTableAdminStatus')).toContainText('浏览器回归-' + year);
    return (await (await page.request.get('/api/nat-cma/table/status')).json()).data.batch.id;
  };
  const first = await importVersion('2016');
  await importVersion('2024');
  await page.locator('[data-nat-cma-activate="' + first + '"]').click();
  await page.locator('#confirmOverlay [data-confirm-action="confirm"]').click();
  await expect(page.locator('#natCmaTableAdminStatus')).toContainText('浏览器回归-2016');

  await page.locator('.sidebar-item[data-tab="qual"]').click();
  await page.locator('#natCmaSearchInput').fill('GB/T 32487-2016');
  await page.locator('#natCmaTableSearch').click();
  await expect(page.locator('#natCmaSearchResults')).toContainText('GB/T 32487-2016');
  await page.locator('#natCmaSearchResults summary').first().click();
  await expect(page.locator('#natCmaSearchResults')).toContainText('不测：阻燃性能');
  await expect(page.locator('#natCmaSearchResults')).toContainText('已批准测试备注');
  await expect(page.locator('#natCmaSearchResults')).toContainText('原表第 4 行');
  await page.locator('#natCmaSearchInput').fill('GB/T 32487-2015');
  await page.locator('#natCmaTableSearch').click();
  await expect(page.locator('#natCmaSearchResults .nat-cma-standard')).toHaveCount(0);
  expect(errors).toEqual([]);
});

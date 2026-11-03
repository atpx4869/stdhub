import { expect, test } from 'playwright/test';

for (const theme of ['paper', 'legacy']) {
  test('approved-table badges preserve other badges and open exact source details: ' + theme, async ({ page }) => {
    const code = 'GB/T 32487-2016';
    const otherYear = 'GB/T 32487-2024';
    const errors: string[] = [];
    const lookups: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({ width: theme === 'legacy' ? 390 : 1440, height: 900 });
    await page.addInitScript(value => localStorage.setItem('bzxz.theme', value), theme);
    await page.route('**/api/auth/status', route => route.fulfill({ json: { data: { user: { id: 0, username: 'guest', displayName: '本地库只读用户', role: 'guest', allowedTabs: ['local'] }, loginRequired: false, needsSetup: false }, error: null } }));
    const items = [code, otherYear].map((standardNumber, index) => ({ fileId: index + 1, kind: 'library', standardNumber, title: '塑料家具通用技术条件', fileName: standardNumber + '.pdf', size: 1024, indexedAt: '2026-11-03T00:00:00Z', source: 'bd', previewUrl: '/unused.pdf' }));
    await page.route('**/api/downloads?**', route => route.fulfill({ json: { data: { items, total: 2, libraryTotal: 2, limit: 30, offset: 0 }, error: null } }));
    await page.route('**/api/qualifications/batch-query', route => route.fulfill({ json: { data: { [code]: [{ source: 'CNAS', orgName: '测试CNAS' }, { source: 'CMA', orgName: '测试CMA' }] }, error: null } }));
    await page.route('**/api/cma-diff/batch-status', route => route.fulfill({ json: { data: { [code]: { status: 'in_lib', libDomain: '家具' } }, error: null } }));
    await page.route('**/api/nat-cma/table/batch-match', route => route.fulfill({ json: { data: { [code]: { abilityCount: 1, limited: true, summary: '部分参数，须查看限制', batchId: 7 }, [otherYear]: { abilityCount: 0, batchId: 7 } }, error: null } }));
    await page.route('**/api/nat-cma/table/abilities?**', route => {
      lookups.push(new URL(route.request().url()).searchParams.get('stdCode') || '');
      return route.fulfill({ json: { data: { orgName: '湖北省产品质量监督检验研究院', batch: { id: 7, name: '批准能力表测试批次', filename: 'approved-fixture.xlsx', importedAt: '2026-11-03T00:00:00Z' }, entries: [{ category: '塑料家具', parameterName: '部分参数', stdName: '塑料家具通用技术条件', stdCode: code, limitDesc: '不测：阻燃性能', note: '<script>不执行</script>仅限测试备注', sheetName: '批准能力', rowNumber: 42 }] }, error: null } });
    });
    await page.goto('/');
    await page.waitForFunction("typeof currentUser !== 'undefined' && currentUser.allowedTabs?.length === 1");
    await page.evaluate(() => (window as any).switchTab('local'));
    const row = page.locator('#fileLibraryList .local-row').filter({ has: page.locator('[data-nat-cma="' + code + '"]') });
    const badge = row.locator('.nat-cma-badge');
    await expect(badge).toBeVisible();
    await expect(row.locator('.qual-badge-cnas')).toBeVisible();
    await expect(row.locator('.qual-badge-cma:not(.nat-cma-badge)')).toBeVisible();
    await expect(row.locator('.cap-lib-badge')).toBeVisible();
    await expect(page.locator('[data-nat-cma="' + otherYear + '"].nat-cma-badge')).toHaveCount(0);
    for (const activation of ['Enter', 'Space', 'click']) {
      await badge.focus();
      if (activation === 'click') await badge.click(); else await badge.press(activation);
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText('不测：阻燃性能');
      await expect(dialog).toContainText('仅限测试备注');
      await expect(dialog).toContainText('approved-fixture.xlsx');
      await expect(dialog).toContainText('批准能力');
      await expect(dialog).toContainText('42');
      await expect(dialog.locator('script')).toHaveCount(0);
      await expect(page.locator('#page-local')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(badge).toBeFocused();
    }
    expect(lookups).toEqual([code, code, code]);
    expect(errors).toEqual([]);
  });
}

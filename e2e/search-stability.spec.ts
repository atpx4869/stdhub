import { expect, test, type Page } from 'playwright/test';

const code = 'GB/T 12345678901234567890.123456789-2024';
const title = '超长标准名称用于紧凑检索表格和独立资质列布局回归验证'.repeat(5);
const rowSelector = '#results .result-card';

function rows(count = 1) {
  return Array.from({ length: count }, (_, i) => ({
    id: 'bw-' + i, sourceId: 'bw-' + i, _source: 'gbw',
    standardNumber: i === 0 ? code : 'GB/T ' + (1000 + i) + '-2024',
    title: i === 0 ? title : '测试标准 ' + i, status: i % 2 ? '废止' : '现行',
    textAvailability: { state: 'unknown', reason: 'not_checked' }, previewAvailable: false,
  }));
}

async function shell(page: Page) {
  await page.route('https://fonts.googleapis.com/**', route => route.abort());
  await page.route('https://fonts.gstatic.com/**', route => route.abort());
  await page.route('**/api/auth/status', route => route.fulfill({ json: { data: {
    user: { id: 1, username: 'admin', displayName: '测试管理员', role: 'admin', allowedTabs: null },
    loginRequired: true, needsSetup: false,
  }, error: null } }));
  await page.route('**/api/check/saved/codes', route => route.fulfill({ json: { data: { codes: [] }, error: null } }));
  await page.route('**/api/check/saved/meta', route => route.fulfill({ json: { data: { items: [] }, error: null } }));
  await page.route('**/api/qualifications/batch-query', route => {
    const codes = route.request().postDataJSON().stdCodes as string[];
    return route.fulfill({ json: { data: Object.fromEntries(codes.map(c => [c, [
      { source: 'CNAS', orgName: '测试CNAS机构' }, { source: 'CMA', orgName: '测试CMA机构' },
    ]])), error: null } });
  });
  await page.route('**/api/cma-diff/batch-status', route => {
    const codes = route.request().postDataJSON().stdCodes as string[];
    return route.fulfill({ json: { data: Object.fromEntries(codes.map(c => [c, { status: 'in_lib', libDomain: '测试领域' }])), error: null } });
  });
  await page.route('**/api/nat-cma/table/batch-match', route => {
    const codes = route.request().postDataJSON().stdCodes as string[];
    return route.fulfill({ json: { data: Object.fromEntries(codes.map(c => [c, { abilityCount: 2, limited: true, batchId: 7 }])), error: null } });
  });
  await page.route('**/api/standards/text-availability?**', route => {
    const ids = new URL(route.request().url()).searchParams.get('ids')!.split(',');
    return route.fulfill({ json: { data: Object.fromEntries(ids.map(id => [id, { state: 'available', reason: 'probe' }])), error: null } });
  });
  await page.goto('/');
  await page.waitForFunction("typeof currentUser !== 'undefined' && currentUser?.role === 'admin'");
  await expect(page.locator('#searchInput')).toBeVisible();
}

async function seed(page: Page, count = 1) {
  // Feed source fixtures through the real dedupe/render path. Polling and badge
  // completion below still execute the shipped asynchronous frontend code.
  await page.evaluate(
    'results = dedupeResults(' + JSON.stringify(rows(count)) + ');' +
    "selectedIds.clear(); qualData = {}; setSearchStage('search', 'active'); renderResults();"
  );
  await expect(page.locator(rowSelector).first()).toBeVisible();
}

async function finishBadges(page: Page) {
  await page.evaluate(
    '(async () => { const codes = results.map(r => r.standardNumber);' +
    'await fetchQualBadges(codes); scheduleResultsRender({ filterBar: true });' +
    'await Promise.all([fetchNatCmaBadges(codes), fetchCapLibBadges(codes)]);' +
    'await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); })()'
  );
}

test('BW background completion and badges preserve rows, controls, focus, expansion and shown batches', async ({ page }) => {
  await shell(page); await seed(page, 140);
  await page.locator('#resultsLoadMoreBtn').click();
  await expect(page.locator(rowSelector)).toHaveCount(140);
  const expired = page.locator('.status-group[data-group-cat="废止"]');
  if ((await expired.getAttribute('class'))?.includes('collapsed')) await expired.locator('[data-group-toggle]').click();
  await expect(expired).not.toHaveClass(/collapsed/);
  const first = page.locator(rowSelector).filter({ has: page.locator('.card-number', { hasText: code }) });
  await first.locator('input[type="checkbox"]').check();
  await page.evaluate("_setActiveRow(document.querySelector('#results .result-card'))");
  const moreMenu = first.locator('details');
  if (await moreMenu.count()) await moreMenu.locator('summary').click();
  await first.locator('[data-action="detail"]').focus();
  await expect(first.locator('[data-action="detail"]')).toBeFocused();
  await page.waitForFunction(() => [...document.querySelectorAll('#results .result-card')]
    .every(row => row.getAnimations().every(animation => animation.playState !== 'running')));
  await page.evaluate(() => {
    const w = window as any;
    w.__stableRows = [...document.querySelectorAll('#results .result-card')];
    w.__stableControls = w.__stableRows.map((row: Element) => [...row.querySelectorAll('input, button, details, summary')]);
    w.__stableFocus = document.activeElement;
    w.__stableGroups = [...document.querySelectorAll('#results .status-group')];
    w.__replayed = 0;
    document.getElementById('results')!.addEventListener('animationstart', event => {
      if ((event.target as Element).matches('.result-card')) w.__replayed++;
    });
  });
  await page.evaluate('pollGbwTextAvailability()');
  await expect(first.locator('.has-text-badge').first()).toBeVisible();
  await finishBadges(page);
  await expect(first.locator('.qual-badge-cnas')).toBeVisible();
  await expect(first.locator('.nat-cma-badge')).toBeVisible();
  const state = await page.evaluate(() => {
    const w = window as any;
    return {
      rows: w.__stableRows.every((row: Element, index: number) => row.isConnected && row === document.querySelectorAll('#results .result-card')[index]),
      controls: w.__stableControls.flat().every((node: Element) => node.isConnected),
      focus: document.activeElement === w.__stableFocus,
      groups: w.__stableGroups.every((group: Element) => group.isConnected), replayed: w.__replayed,
    };
  });
  expect(state).toEqual({ rows: true, controls: true, focus: true, groups: true, replayed: 0 });
  await expect(first.locator('input[type="checkbox"]')).toBeChecked();
  await expect(first).toHaveClass(/row-active/);
  await expect(expired).not.toHaveClass(/collapsed/);
  if (await moreMenu.count()) await expect(moreMenu).toHaveAttribute('open', '');
  await expect(page.locator(rowSelector)).toHaveCount(140);
  await expect(page.locator('#resultsLoadMoreBtn')).toHaveCount(0);
});

test('late source merges into existing rows and appends only genuinely new standards', async ({ page }) => {
  await shell(page);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/standards/search?**', async route => {
    const source = new URL(route.request().url()).searchParams.get('source');
    if (source === 'by') await gate;
    const items = source === 'by'
      ? [{ ...rows()[0], id: 'by-duplicate', previewAvailable: true }, { ...rows()[0], id: 'by-new', standardNumber: 'GB/T 999-2024' }]
      : [{ ...rows()[0], textAvailability: { state: 'available', reason: 'probe' }, previewAvailable: true }];
    await route.fulfill({ json: { data: { items }, error: null } });
  });
  await page.evaluate("selectedSources = new Set(['gbw', 'by'])");
  await page.locator('#searchInput').fill('GB/T 123456789');
  await page.locator('#searchBtn').click();
  try {
    await expect(page.locator(rowSelector)).toHaveCount(1);
    const oldRow = await page.locator(rowSelector).first().elementHandle();
    const oldCheckbox = await page.locator(rowSelector).first().locator('input').elementHandle();
    await page.locator(rowSelector).first().locator('input').check();
    release();
    await expect(page.locator(rowSelector)).toHaveCount(2);
    expect(await oldRow!.evaluate(node => node.isConnected)).toBe(true);
    expect(await oldCheckbox!.evaluate(node => node.isConnected)).toBe(true);
    await expect(page.locator(rowSelector).first().locator('input')).toBeChecked();
    await expect(page.locator(rowSelector).first().locator('.card-source-line .source-by')).toHaveCount(1);
    await expect(page.locator(rowSelector).first().locator('.card-number')).toHaveText(code);
    await expect(page.locator(rowSelector).last().locator('.qual-badge-cnas')).toBeVisible();
    await expect(page.locator(rowSelector).last().locator('.nat-cma-badge')).toBeVisible();
  } finally { release(); }
});

for (const width of [1440, 1280, 1024, 768, 390, 360]) {
  test('long standard and four independent qualification badges fit at ' + width + 'px', async ({ page }) => {
    await page.setViewportSize({ width, height: 960 });
    await shell(page); await seed(page); await finishBadges(page);
    const row = page.locator(rowSelector).first();
    const badges = row.locator('.qual-badge-cnas, .qual-badge-cma, .nat-cma-badge, .cap-lib-badge:not(.cap-lib-badge-pending)');
    await expect(badges).toHaveCount(4);
    for (const badge of await badges.all()) await expect(badge).toBeVisible();
    const layout = await row.evaluate(element => {
      const number = element.querySelector('.card-number')!;
      const badges = [...element.querySelectorAll('.qual-badge-cnas, .qual-badge-cma, .nat-cma-badge, .cap-lib-badge:not(.cap-lib-badge-pending)')];
      const parents = badges.map(badge => badge.closest('.card-qualifications'));
      return {
        documentWidth: document.documentElement.scrollWidth,
        rowWidth: element.scrollWidth, boxWidth: element.getBoundingClientRect().width,
        overflowing: [...element.querySelectorAll('*')].filter(node => { const b = node.getBoundingClientRect(); const style = getComputedStyle(node); return b.width > 0 && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0' && b.right > element.getBoundingClientRect().right + 1; }).map(node => ({ className: node.className, width: node.getBoundingClientRect().width, right: node.getBoundingClientRect().right })),
        // A qualification column must not put the badges back inside the number.
        independent: parents.every(parent => parent !== null && !parent.contains(number)),
        order: badges.map(badge => badge.matches('.nat-cma-badge') ? '国CMA' : badge.matches('.qual-badge-cnas') ? 'CNAS' : badge.matches('.qual-badge-cma') ? 'CMA' : '国家库'),
        boxes: badges.map(badge => { const b = badge.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom }; }),
      };
    });
    expect(layout.order).toEqual(['CNAS', 'CMA', '国CMA', '国家库']);
    expect(layout.independent).toBe(true);
    expect(layout.documentWidth).toBeLessThanOrEqual(width);
    expect(layout.rowWidth).toBeLessThanOrEqual(Math.ceil(layout.boxWidth));
    expect(layout.overflowing).toEqual([]);
    for (const box of layout.boxes) { expect(box.left).toBeGreaterThanOrEqual(0); expect(box.right).toBeLessThanOrEqual(width); }
    // Parked tooltips stay hidden, but the existing body portal still opens them.
    await expect(row.locator('.qual-badge-cnas .qual-tooltip')).toBeHidden();
    await row.locator('.qual-badge-cnas').hover();
    await expect(page.locator('body > .qual-tooltip-floating')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    if (width >= 1024) {
      await expect(page.locator('.results-table-head')).toContainText('资质');
      // All four badges are one readable desktop qualification cell, not overlapping.
      for (let i = 1; i < layout.boxes.length; i++) {
        const previous = layout.boxes[i - 1], current = layout.boxes[i];
        expect(current.top >= previous.bottom - 1 || current.left >= previous.right - 1).toBe(true);
      }
    }
  });
}

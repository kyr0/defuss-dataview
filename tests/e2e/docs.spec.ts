/** The website (docs/) in Chromium: the landing page, the descriptor explorer and every tab of the Big Data demo.
 * scripts/serve.mjs serves docs/ as static files, as GitHub Pages does, and the pages load defuss-shadcn and
 * defuss-dataview from jsDelivr over the real network; vendoring them would hide a broken pin or integrity hash.
 * Every test fails on console errors, page errors, failed requests and HTTP errors.
 * HYPOTHESIS: an offline run fails rather than passing; falsified by a green run without network. */
import { readFileSync } from 'node:fs';
import { expect, test as base, type Page } from '@playwright/test';
import { logs, orders, places, units } from '../../docs/demo/data.js';

const test = base.extend<{ problems: string[] }>({
  problems: [async ({ page }, use) => {
    const problems: string[] = [];
    page.on('console', (message) => { if (message.type() === 'error') problems.push(`console: ${message.text()}`); });
    page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
    page.on('requestfailed', (request) => problems.push(`failed: ${request.url()} ${request.failure()?.errorText}`));
    page.on('response', (response) => { if (response.status() >= 400) problems.push(`${response.status()} ${response.url()}`); });
    await use(problems);
    expect(problems).toEqual([]);
  }, { auto: true }],
});

const count = (value: number) => value.toLocaleString('en');
const statistic = (page: Page, title: string) => page.locator('#ins-stats .statistic').filter({ hasText: title }).locator('.statistic-value');
const explorerCount = (page: Page, name: string) => page.locator(`#ex-counts [data-count="${name}"] .statistic-value`);

test.describe('landing page', () => {
  test.beforeEach(async ({ page }) => { await page.emulateMedia({ reducedMotion: 'reduce' }); });

  test('pins the newest published release and shows its published sizes', async ({ page, request }) => {
    const latest = (await (await request.get('https://registry.npmjs.org/defuss-dataview/latest')).json()).version as string;
    await page.goto('/docs/');
    const pinned = await page.evaluate(() => {
      const map = JSON.parse(document.querySelector('script[type="importmap"]')!.textContent!);
      return /@(\d+\.\d+\.\d+)\//.exec(map.imports['defuss-dataview'])![1];
    });
    expect(pinned, 'the site pins npm\'s latest defuss-dataview; bump the pin and its integrity hash').toBe(latest);
    await expect(page.locator('.mk-hero-pill .badge')).toHaveText(`v${pinned}`);
    const stats = await (await request.get(`https://cdn.jsdelivr.net/npm/defuss-dataview@${pinned}/dist/stats.json`)).json();
    await expect(page.locator('#stat-gzip .mk-stat-value')).toContainText(`${count(stats.browserGzipBytes)} B`);
    await expect(page.locator('#stat-gzip .mk-stat-label')).toContainText(`${count(stats.browserMinifiedBytes)} B minified`);
    for (const [id, key] of [['stats-esm', 'esmBytes'], ['stats-cjs', 'commonjsBytes'], ['stats-min', 'browserMinifiedBytes'], ['stats-gzip', 'browserGzipBytes']]) {
      await expect(page.locator(`#${id}`)).toContainText(`"${key}": ${stats[key]}`);
    }
    await expect(page.locator('.mk-hero-pill')).toContainText(`${(stats.browserGzipBytes / 1000).toFixed(1)} kB gzip`);
  });

  test('header links reach their sections without adding history entries', async ({ page }) => {
    await page.goto('/docs/');
    const before = await page.evaluate(() => history.length);
    for (const id of ['demo', 'how', 'explorer', 'api', 'install']) {
      await page.locator(`.mk-header-nav a[href="#${id}"]`).click();
      await expect.poll(() => page.evaluate((id) => {
        const section = document.getElementById(id)!;
        return Math.abs(section.getBoundingClientRect().top - parseFloat(getComputedStyle(section).scrollMarginTop));
      }, id), `#${id} lands at its scroll margin`).toBeLessThan(4);
    }
    expect(await page.evaluate(() => history.length)).toBe(before);
    expect(page.url()).toMatch(/#install$/);
    await expect(page.getByRole('link', { name: 'defuss-dataview on npm' })).toHaveAttribute('href', 'https://www.npmjs.com/package/defuss-dataview');
  });

  test('the theme switch repaints the page and the demo frame, and survives a reload', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
    await page.goto('/docs/');
    const frame = page.frameLocator('#playground iframe');
    await expect(frame.locator('#orders .data-grid-status')).toContainText('100,000 rows');
    await expect(page.locator('html')).not.toHaveClass(/dark/);
    await page.locator('label.swap:has(#theme-toggle)').click();
    await expect(page.locator('html')).toHaveClass(/dark/);
    await expect(frame.locator('html')).toHaveClass(/dark/);
    await page.reload();
    await expect(page.locator('html')).toHaveClass(/dark/);
    await expect(page.locator('#theme-toggle')).toBeChecked();
  });

  test('the flow diagram walks from loaded rows to a view the app owns', async ({ page }) => {
    await page.goto('/docs/');
    const flow = page.locator('#dv-flow');
    await flow.scrollIntoViewIfNeeded();
    await flow.getByRole('button', { name: 'Show all' }).click();
    await expect(flow.locator('.diagram-node')).toHaveCount(13);
    await expect(flow.locator('[data-node="view"]')).toBeVisible();
    await expect(flow.locator('[data-node="view"]')).toHaveAttribute('data-tone', 'external');
    await flow.locator('[data-node="view"]').click();
    await expect(page.locator('.dv-flow-detail')).toContainText('defuss-dataview never reaches it');
  });

  test('the explorer queries 10,000 editable rows and pages through the result', async ({ page }) => {
    await page.goto('/docs/');
    const rows = units(10_000);
    const entries = () => page.evaluate(() => df$.shadcn.dataGrid.rows(document.getElementById('ex-grid')) as unknown as Array<Record<string, unknown>>);
    const names = async () => (await entries()).map((entry) => entry.name);
    const example = (label: string) => page.locator('.dv-examples button', { hasText: label }).click();
    const cell = (index: number, field: string) => page.locator(`#ex-rows [data-index="${index}"] input[data-field="${field}"]`);

    // filter, sort, page runs on load over the seeded rows; the oracle is plain JavaScript, not defuss-dataview
    const high = rows.filter((row) => row.score >= 80).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    await expect(explorerCount(page, 'totalRows')).toHaveText('10000');
    await expect(explorerCount(page, 'matchedRows')).toHaveText(String(high.length));
    await expect(explorerCount(page, 'pageCount')).toHaveText(String(Math.ceil(high.length / 20)));
    expect(await names()).toEqual(high.slice(0, 20).map((row) => row.name));
    expect(await page.locator('#ex-rows input').count(), 'only the rows on screen exist as inputs').toBeLessThan(200);
    await page.locator('#explorer summary', { hasText: 'Normalized state' }).click();
    await expect(page.locator('#ex-state .mk-code-block-k').first()).toHaveText('"filters"'); // highlighted, like the request
    await expect(page.locator('#ex-state')).toContainText('"pageSize": 20');

    // the pager writes the page into the request and applies it
    await page.locator('#ex-pager .pagination-next').click();
    await expect(page.locator('#ex-query')).toHaveValue(/"page": 1/);
    await expect(page.locator('#ex-page-note')).toContainText(`page 2 of ${Math.ceil(high.length / 20)}`);
    expect(await names()).toEqual(high.slice(20, 40).map((row) => row.name));
    await page.locator('#ex-pager .pagination-link[data-page="4"]').click();
    await expect(explorerCount(page, 'hasPreviousPage')).toHaveText('true');
    expect(await names()).toEqual(high.slice(60, 80).map((row) => row.name));

    await example('explicit expandedIds: []');
    await expect(explorerCount(page, 'visibleRows')).toHaveText(String(rows.filter((row) => row.parentId === null).length));
    await expect(page.locator('#ex-pages')).toBeHidden(); // no pageSize, no pager
    await example('a match keeps its ancestors');
    const storage = rows.filter((row) => row.name.includes('Storage')).length;
    await expect(explorerCount(page, 'matchedRows')).toHaveText(String(storage));
    expect(Number(await explorerCount(page, 'visibleRows').textContent())).toBeGreaterThan(storage);
    await example('case-sensitive contains');
    await expect(explorerCount(page, 'matchedRows')).toHaveText('0');
    await expect(page.locator('#ex-grid')).toHaveAttribute('data-state', 'empty'); // the empty text is drawn by CSS
    await example('page past the end');
    await expect(explorerCount(page, 'hasPreviousPage')).toHaveText('true');
    await expect(page.locator('#ex-page-note')).toContainText('past the last page');

    // edits change the array Apply runs on: rename row 1, add a row, remove row 1 again
    await page.locator('#ex-query').fill('{ "filters": [{ "field": "name", "op": "eq", "value": "Needle" }] }');
    await cell(0, 'name').fill('Needle');
    await expect(page.locator('#ex-stale')).toContainText('press Apply');
    await page.locator('#ex-apply').click();
    await expect(page.locator('#ex-stale')).toHaveText('');
    await expect(explorerCount(page, 'matchedRows')).toHaveText('1');
    await page.locator('#ex-add-row').click();
    await expect(page.locator('#ex-row-count')).toHaveText('10,001');
    await expect(cell(10_000, 'name')).toBeFocused();
    await cell(10_000, 'name').fill('Needle');
    await page.locator('#ex-query').press('Control+Enter');
    await expect(explorerCount(page, 'matchedRows')).toHaveText('2');
    expect((await entries()).map((entry) => entry.id)).toEqual([1, 10_001]);
    await page.evaluate(() => { document.getElementById('ex-rows')!.scrollTop = 0; });
    await page.locator('#ex-rows [data-index="0"] .dv-remove').click();
    await expect(page.locator('#ex-row-count')).toHaveText('10,000');
    await page.locator('#ex-apply').click();
    await expect(explorerCount(page, 'matchedRows')).toHaveText('1');
    await page.locator('#ex-random-rows').click();
    await page.locator('#ex-apply').click();
    await expect(explorerCount(page, 'totalRows')).toHaveText('10000');
    await expect(explorerCount(page, 'matchedRows')).toHaveText('0');

    // the editor: highlighted JSON, Format, parse and validation errors, the cycle example's own rows
    await page.locator('#ex-query').fill('{"pageSize":4}');
    await expect(page.locator('#ex-highlight .mk-code-block-k')).toHaveText('"pageSize"');
    await expect(page.locator('#ex-highlight .dv-json-literal')).toHaveText('4');
    await page.locator('#ex-format').click();
    await expect(page.locator('#ex-query')).toHaveValue('{\n  "pageSize": 4\n}');
    await page.locator('#ex-query').fill('{ "pageSize": ');
    await page.locator('#ex-apply').click();
    await expect(page.locator('#ex-error-title')).toHaveText('The JSON does not parse');
    await example('unsafe path');
    await expect(page.locator('#ex-error-title')).toHaveText('createDataview() threw');
    await expect(page.locator('#ex-error-message')).toContainText('__proto__.polluted');
    await example('a cycle terminates');
    await expect(page.locator('#ex-error')).toBeHidden();
    await expect(page.locator('#ex-row-count')).toHaveText('5');
    expect(await names()).toEqual(['Loop A', 'Loop B', 'Loop C', 'Root', 'Child']);
    expect((await entries())[0].parentId).toBe(3);
  });

  test('the measurements show metrics.json: coverage, tests, both charts and every timing', async ({ page }) => {
    const metrics = JSON.parse(readFileSync('docs/assets/metrics.json', 'utf8'));
    await page.goto('/docs/');
    await expect(page.locator('#stat-coverage .mk-stat-value')).toHaveText(`${metrics.coverage.lines}%`);
    await expect(page.locator('#stat-tests .mk-stat-value')).toHaveText(String(metrics.tests.unit.passed + metrics.tests.browser.passed));
    await expect(page.locator('#metrics-source')).toContainText(`commit ${metrics.commit}`);
    await page.locator('#perf').scrollIntoViewIfNeeded();
    await page.waitForFunction(() => ['perf-lists', 'perf-depth'].every((id) => df$.shadcn.chart.instance(document.getElementById(id))));
    const points = (id: string) => page.evaluate((id) => df$.shadcn.chart.instance(document.getElementById(id))!.getOption().series.map((series) => series.data.length), id);
    const count = (group: string, scenario: string) => metrics.benchmarks[group].filter((row: { scenario: string }) => row.scenario === scenario).length;
    expect(await points('perf-lists')).toEqual([count('lists', 'filter + page'), count('lists', 'filter + sort + page')]);
    expect(await points('perf-depth')).toEqual([count('depth', 'all open + page'), count('size', 'all open + page')]);
    await page.locator('#perf summary').click();
    await expect(page.locator('#perf-table tr')).toHaveCount(Object.values(metrics.benchmarks).flat().length);
  });

  test('API tabs and copy buttons', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('/docs/');
    for (const tab of ['request', 'filters', 'tree', 'result', 'identity', 'functions']) {
      await page.locator(`#tab-${tab}`).click();
      await expect(page.locator(`#api-${tab}`)).toBeVisible();
      await expect(page.locator('.dv-api .tab-content:visible')).toHaveCount(1);
    }
    await page.locator('#api-functions').getByText('setParent(rows').waitFor();
    const install = page.locator('#install .mk-code-block').first();
    await install.locator('.mk-code-block-copy').click();
    await expect(install.locator('.mk-code-block-status')).toHaveText('Copied');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('npm install defuss-dataview');
    await install.locator('label', { hasText: 'pnpm' }).click();
    await install.locator('.mk-code-block-copy').click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('pnpm add defuss-dataview');
    await page.locator('#copy-prompt').click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/^Use defuss-dataview for this app's tables and trees/);
  });

  test('at phone width the menu sheet navigates and nothing scrolls sideways', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/docs/');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await page.locator('.mk-header-menu').click();
    await expect(page.locator('#dv-menu')).toBeVisible();
    await page.locator('#dv-menu a[href="#api"]').click();
    await expect(page.locator('#dv-menu')).toBeHidden();
    await expect(page).toHaveURL(/#api$/);
  });
});

test.describe('Big Data demo', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/docs/demo/');
    await expect(page.locator('#orders .data-grid-status')).toContainText('100,000 rows');
  });

  test('Orders: sort, filter, lock, select, resize and page the Data Grid', async ({ page }) => {
    const grid = page.locator('#orders');
    const amount = grid.locator('.data-grid-header[data-field="amount"]');
    await amount.click({ position: { x: 8, y: 8 } });
    await expect(amount).toHaveAttribute('aria-sort', 'ascending');
    await amount.click({ position: { x: 8, y: 8 } });
    await expect(amount).toHaveAttribute('aria-sort', 'descending');
    const rows = orders(100_000);
    const largest = Math.max(...rows.map((row) => row.amount));
    expect(await page.evaluate(() => df$.shadcn.dataGrid.rows(document.getElementById('orders'))[0].amount)).toBe(largest);
    await expect(page.locator('#ins-query')).toContainText('"direction": "desc"');
    // the query box keeps at least 12rem however full the inspector is
    expect(await page.locator('.dv-query pre').evaluate((el) => el.getBoundingClientRect().height)).toBeGreaterThanOrEqual(192);
    await expect(page.locator('#ins-query .mk-code-block-k').first()).toHaveText('"filters"'); // highlighted keys

    await grid.locator('.data-grid-filter[data-field="amount"]').fill('> 4000');
    await expect(grid.locator('.data-grid-status')).toContainText(`${count(rows.filter((row) => row.amount > 4000).length)} of 100,000 rows match`);
    await grid.locator('.data-grid-filter[data-field="amount"]').fill('');
    await expect(grid.locator('.data-grid-status')).toContainText('100,000 rows');

    await grid.locator('.data-grid-pin[data-field="customer"]').click();
    expect(await page.evaluate(() => document.getElementById('orders')!.api.getState().config.locked)).toEqual(['id', 'customer']);

    await grid.locator('.data-grid-row[data-index="0"] .data-grid-cell[data-field="product"]').click();
    await grid.locator('.data-grid-row[data-index="3"] .data-grid-cell[data-field="product"]').click({ modifiers: ['Shift'] });
    await expect(statistic(page, 'Selected')).toHaveText('4');
    await expect(page.locator('#ins-record')).toContainText(String(rows.slice().sort((a, b) => b.amount - a.amount)[3].customer));

    await page.locator('#ins-presets button', { hasText: 'EU over €1,000' }).click();
    await expect(grid.locator('.data-grid-status')).toContainText(`${count(rows.filter((row) => row.region === 'EU' && row.amount > 1000).length)} of 100,000 rows match`);
    await expect(page.locator('#ins-ms')).toHaveText(/^\d[\d,.]* ms$/);

    await page.locator('#orders-size .toggle[value="10000"]').click();
    await expect(grid.locator('.data-grid-status')).toContainText(`${count(orders(10_000).filter((row) => row.region === 'EU' && row.amount > 1000).length)} of 10,000 rows match`);
    await expect(statistic(page, 'Orders')).toHaveText('10,000');

    await page.locator('#orders-paging').selectOption('pages');
    await expect(grid.locator('.data-grid-footer button').first()).toBeVisible();

    // the component keeps its view in session storage: a reload keeps the sort and the filters
    await page.locator('#reload').click();
    await expect(page.locator('#orders .data-grid-header[data-field="amount"]')).toHaveAttribute('aria-sort', 'descending');
    await expect(page.locator('#ins-query')).toContainText('"value": "EU"');
  });

  test('Files: the tree grid expands, collapses and filters', async ({ page }) => {
    await page.locator('#tab-files').click();
    const grid = page.locator('#files');
    await expect(grid).toHaveAttribute('role', 'treegrid');
    await expect(grid).toHaveAttribute('aria-rowcount', '10'); // 8 collapsed roots + header and filter rows
    await page.locator('#files-expand').click();
    await expect(grid).toHaveAttribute('aria-rowcount', String(50_000 + 2));
    await page.locator('#files-collapse').click();
    await expect(grid).toHaveAttribute('aria-rowcount', '10');
    await grid.locator('.data-grid-filter[data-field="name"]').fill('.json');
    await expect.poll(async () => Number(await grid.getAttribute('aria-rowcount'))).toBeGreaterThan(10);
    await expect(page.locator('#ins-component')).toHaveText('Data Grid (tree grid)');
  });

  test('Taxonomy: the Data Tree filters, opens with the keyboard and reports its selection', async ({ page }) => {
    await page.locator('#tab-taxonomy').click();
    const items = page.locator('#taxonomy [role="treeitem"]');
    await expect(items).toHaveCount(8);
    await page.locator('[data-tree-filter="taxonomy"]').fill('steel');
    await expect(page.locator('#ins-query')).toContainText('"value": "steel"');
    await page.locator('[data-tree-filter="taxonomy"]').fill('');
    await expect(items).toHaveCount(8);
    await page.locator('#taxonomy').focus();
    await page.keyboard.press('ArrowRight');
    await expect(items.first()).toHaveAttribute('aria-expanded', 'true');
    await items.nth(1).click();
    await expect(page.locator('#ins-record')).toContainText(await items.nth(1).innerText());
  });

  test('Logs: the Virtual List filters and sorts 250,000 lines', async ({ page }) => {
    await page.locator('#tab-logs').click();
    await expect(statistic(page, 'Shown')).toHaveText('250,000');
    const lines = logs(250_000);
    await page.locator('[data-virtual-list-filter="logs"][data-field="message"]').fill('/login');
    await expect(statistic(page, 'Shown')).toHaveText(count(lines.filter((line) => line.message.toLowerCase().includes('/login')).length));
    await page.locator('[data-virtual-list-sort="logs"]').selectOption('ms:desc');
    const slowest = Math.max(...lines.filter((line) => line.message.includes('/login')).map((line) => line.ms));
    await expect.poll(() => page.evaluate(() => df$.shadcn.virtualList.rows(document.getElementById('logs'))[0].ms)).toBe(slowest);
    await page.locator('#logs [data-id]').first().click();
    await expect(page.locator('#ins-record')).toContainText(`${slowest}`);
  });

  test('Search: the Autocomplete asks the worker for pages of matches', async ({ page }) => {
    await page.locator('#tab-search').click();
    await page.locator('#place-input').fill('ber');
    await expect(page.locator('#place [role="option"]').first()).toBeVisible();
    await expect(page.locator('#place [role="option"]')).toHaveCount(20);
    await expect(page.locator('#ins-query')).toContainText('"pageSize": 20');
    const matches = places(100_000).filter((place) => place.search.includes('ber'));
    await expect(statistic(page, 'Matches')).toHaveText(count(matches.length));
    const top = matches.slice().sort((a, b) => b.population - a.population)[0];
    await page.locator('#place [role="option"]').first().click();
    await expect(page.locator('#place .autocomplete-value')).toHaveValue(String(top.id));
    await expect(page.locator('#ins-record')).toContainText(top.name);
    await page.locator('#place-input').fill('xyz');
    await expect(page.locator('#place')).toContainText('No place like that.');
  });

  test('at phone width the inspector folds and nothing scrolls sideways', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(page.locator('#orders .data-grid-status')).toContainText('rows');
    expect(await page.evaluate(() => document.getElementById('inspector')!.api.getState().name)).toBe('minimized');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });
});

declare global {
  // The defuss-shadcn runtime the pages load from jsDelivr; only the members these tests call.
  const df$: { shadcn: { dataGrid: { rows(el: HTMLElement | null): Array<Record<string, number>> }; virtualList: { rows(el: HTMLElement | null): Array<Record<string, number>> };
    chart: { instance(el: HTMLElement | null): { getOption(): { series: Array<{ data: unknown[] }> } } | undefined } } };
  interface HTMLElement { api: { getState(): { name: string; config: Record<string, unknown> } } }
}

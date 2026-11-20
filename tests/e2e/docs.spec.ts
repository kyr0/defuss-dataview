/** The website (docs/) in Chromium: the landing page, the descriptor explorer and every tab of the Big Data demo.
 * scripts/serve.mjs serves docs/ as static files, as GitHub Pages does, and the pages load defuss-shadcn and
 * the local built defuss-dataview; CDN shadcn assets retain their real network/integrity checks.
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

  test('uses this local build and shows its measured sizes', async ({ page, request }) => {
    const latest = JSON.parse(readFileSync('package.json', 'utf8')).version as string;
    await page.goto('/docs/');
    const pinned = await page.evaluate(() => {
      const map = JSON.parse(document.querySelector('script[type="importmap"]')!.textContent!);
      return /@(\d+\.\d+\.\d+)\//.exec(map.imports['defuss-dataview'])![1];
    });
    expect(pinned, 'the site must use the build under test').toBe(latest);
    await expect(page.locator('.mk-hero-pill .badge')).toHaveText(`v${pinned}`);
    const stats = await (await request.get(`/docs/assets/defuss-dataview@${pinned}/stats.json`)).json();
    await expect(page.locator('#stat-gzip .mk-stat-value')).toContainText(`${count(stats.browserGzipBytes)} B`);
    await expect(page.locator('#stat-gzip .mk-stat-label')).toContainText(`${count(stats.browserMinifiedBytes)} B minified`);
    for (const [id, key] of [['stats-esm', 'esmBytes'], ['stats-cjs', 'commonjsBytes'], ['stats-min', 'browserMinifiedBytes'], ['stats-gzip', 'browserGzipBytes']]) {
      await expect(page.locator(`#${id}`)).toContainText(`"${key}": ${stats[key]}`);
    }
    await expect(page.locator('.mk-hero-pill')).toContainText(`${(stats.browserGzipBytes / 1000).toFixed(1)} kB gzip`);
    await expect(page.locator('#intro-size')).toHaveText(`${(stats.browserMinifiedBytes / 1000).toFixed(1)} kB (${(stats.browserGzipBytes / 1000).toFixed(1)} kB gzip)`);
  });

  test('header links reach their sections without adding history entries', async ({ page }) => {
    await page.goto('/docs/');
    const before = await page.evaluate(() => history.length);
    // The section links sit in the nav; Install is the header's own button, so the nav fits on one line.
    for (const id of ['demo', 'how', 'explorer', 'compute', 'api', 'install']) {
      await page.locator(id === 'install' ? '.mk-header-actions a.btn[href="#install"]' : `.mk-header-nav a[href="#${id}"]`).click();
      await expect.poll(() => page.evaluate((id) => {
        const section = document.getElementById(id)!;
        return Math.abs(section.getBoundingClientRect().top - parseFloat(getComputedStyle(section).scrollMarginTop));
      }, id), `#${id} lands at its scroll margin`).toBeLessThan(4);
    }
    await expect(page.locator('.mk-header a[href="#mongodb"]'), 'the comparison is no menu entry').toHaveCount(0);
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
    await expect(flow.locator('.diagram-node')).toHaveCount(15);
    for (const step of ['group', 'project']) await expect(flow.locator(`[data-node="${step}"]`)).toContainText('Compute only');
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
    const high = rows.filter((row) => row.score >= 80).sort((a, b) => b.score - a.score || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
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
    await page.locator('#ex-query').fill('{"pageSize":-1}');
    await page.locator('#ex-apply').click();
    await expect(page.locator('#ex-error-title')).toHaveText('createDataview() threw');
    await expect(page.locator('#ex-error-message')).toContainText('pageSize');
    await example('a cycle terminates');
    await expect(page.locator('#ex-error')).toBeHidden();
    await expect(page.locator('#ex-row-count')).toHaveText('5');
    expect(await names()).toEqual(['Loop A', 'Loop B', 'Loop C', 'Root', 'Child']);
    expect((await entries())[0].parentId).toBe(3);
  });

  test('the explorer runs JSON compute plans on its rows: groups, HAVING, a projection, a view and errors', async ({ page }) => {
    await page.goto('/docs/');
    const rows = units(10_000);
    const example = (label: string) => page.locator('.dv-examples button', { hasText: new RegExp(`^${label}$`) }).click();
    const column = (index: number) => page.locator(`#ex-compute-body tr td:nth-child(${index})`);
    const fmt = (value: number) => value.toLocaleString('en', { maximumFractionDigits: 2 });

    // the oracle is plain JavaScript over the same seeded rows
    const regions = new Map<string, number[]>();
    for (const row of rows) regions.set(row.region, [...(regions.get(row.region) ?? []), row.score]);
    const byAverage = [...regions].map(([region, scores]) => ({ region, units: scores.length, average: scores.reduce((a, b) => a + b, 0) / scores.length }))
      .sort((a, b) => b.average - a.average);
    await example('aggregate by region');
    await expect(page.locator('#ex-grid')).toBeHidden();
    await expect(page.locator('#ex-compute-head th')).toHaveText(['region', 'units', 'averageScore', 'best', 'over80']);
    await expect(column(1)).toHaveText(byAverage.map((group) => group.region));
    await expect(column(2)).toHaveText(byAverage.map((group) => fmt(group.units)));
    await expect(explorerCount(page, 'strategy')).toHaveText('hash');
    await page.locator('#explorer summary', { hasText: 'plan.explain()' }).click();
    await expect(page.locator('#ex-state')).toContainText('"kind": "aggregate"');

    const children = new Map<number | null, number>();
    for (const row of rows) children.set(row.parentId, (children.get(row.parentId) ?? 0) + 1);
    const busy = [...children.values()].filter((value) => value >= 10);
    await example('children per parent, HAVING');
    await expect(explorerCount(page, 'totalResultRows')).toHaveText(String(busy.length));
    await expect(column(2).first()).toHaveText(String(Math.max(...busy)));

    const high = rows.filter((row) => row.score >= 80).sort((a, b) => b.score - a.score || a.id - b.id);
    await example('projection, computed column');
    await expect(page.locator('#ex-compute-head th')).toHaveText(['id', 'name', 'score', 'weighted']);
    await expect(explorerCount(page, 'totalResultRows')).toHaveText(String(high.length));
    await page.locator('#ex-pager .pagination-next').click();
    await expect(page.locator('#ex-query')).toHaveValue(/"offset": 20/);
    await expect(page.locator('#ex-page-note')).toContainText(`page 2 of ${Math.ceil(high.length / 20)}`);
    await expect(column(2)).toHaveText(high.slice(20, 40).map((row) => row.name));
    await expect(column(4)).toHaveText(high.slice(20, 40).map((row) => fmt(row.score * 1.5)));

    const euApac = rows.filter((row) => row.region === 'EU' || row.region === 'APAC');
    await example('page plus totals');
    await expect(page.locator('#ex-totals [data-count="totals.units"] .statistic-value')).toHaveText(fmt(euApac.length));
    await example('scalar aggregate');
    await expect(column(1)).toHaveText([fmt(rows.length)]);

    await page.locator('#ex-query').fill('{ "aggregate": { "measures": {} }, "rows": {} }');
    await page.locator('#ex-apply').click();
    await expect(page.locator('#ex-error')).toBeVisible();
    await expect(page.locator('#ex-error-message')).toContainText('aggregate and rows');
    await page.locator('#ex-query').fill('{ "aggregate": { "measures": { "n": { "op": "count" } } } }');
    await page.locator('#ex-apply').click();
    await expect(page.locator('#ex-error-title')).toHaveText('forRows().aggregate() threw');

    await example('filter, sort, page'); // descriptors show the grid again
    await expect(page.locator('#ex-grid')).toBeVisible();
    await expect(page.locator('#ex-compute')).toBeHidden();
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

  test('the MongoDB comparison shows mongodb.json: pairings, gauges per switch, both charts and the table', async ({ page }) => {
    const data = JSON.parse(readFileSync('docs/assets/mongodb.json', 'utf8'));
    const pairs = { scan: ['dataview + immutable array', 'MongoDB'], index: ['dataview fixed-query index', 'MongoDB + index'], stored: ['dataview + DBSONL file, same revision', 'MongoDB'] };
    const median = (rows: string, query: string, engine: string) => data.sizes[rows].results.find((r: { query: string; engine: string }) => r.query === query && r.engine === engine).medianMs;
    const ratio = (rows: string, query: string, pairing: keyof typeof pairs) => median(rows, query, pairs[pairing][1]) / median(rows, query, pairs[pairing][0]);
    const all = Object.keys(data.sizes).flatMap((rows) => ['top', 'page'].flatMap((query) => (Object.keys(pairs) as Array<keyof typeof pairs>).map((p) => ratio(rows, query, p))));
    await page.goto('/docs/');
    await expect(page.locator('#vs-hit-wins')).toHaveText(`${all.filter((r) => r >= 1).length} of ${all.length}`);
    const largestRows = Object.keys(data.sizes).sort((a, b) => Number(b) - Number(a))[0];
    const stored = ratio(largestRows, 'top', 'stored');
    await expect(page.locator('#vs-hit-stored')).toHaveText(`${stored < 10 ? stored.toFixed(1) : Math.round(stored)}×`);
    await expect(page.locator('#vs-hit-stored-text')).toContainText('stored on disk');
    await page.locator('#mongodb').scrollIntoViewIfNeeded();
    const gauge = (pairing: string) => page.locator(`#vs-${pairing} .tacho-meter`);
    const expectGauges = async (rows: string, query: string) => {
      for (const pairing of Object.keys(pairs) as Array<keyof typeof pairs>) {
        const [min, max] = [Number(await gauge(pairing).getAttribute('min')), Number(await gauge(pairing).getAttribute('max'))];
        const exact = Math.log2(ratio(rows, query, pairing));
        // The meter clamps a ratio beyond its scale to the end stop, and the readout says the ratio lies beyond it.
        await expect.poll(async () => Number(await gauge(pairing).getAttribute('value'))).toBeCloseTo(Math.min(max, Math.max(min, exact)), 2);
        if (exact >= max || exact <= min) await expect(page.locator(`#vs-${pairing} .tacho-value`)).toHaveText(/^over /);
      }
    };
    const largest = Object.keys(data.sizes).sort((a, b) => Number(b) - Number(a))[0];
    await expectGauges(largest, 'top');
    await page.locator('.dv-vs-controls [data-value="100000"]').click();
    await page.locator('.dv-vs-controls [data-value="page"]').click();
    await expect(page.locator('.dv-vs-controls [data-value="100000"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.dv-vs-controls [data-value="1000000"]')).toHaveAttribute('aria-pressed', 'false');
    await expectGauges('100000', 'page');
    await page.waitForFunction(() => ['vs-chart-top', 'vs-chart-page'].every((id) => df$.shadcn.chart.instance(document.getElementById(id))));
    const rowsOf = (id: string) => page.evaluate((id) => (df$.shadcn.chart.instance(document.getElementById(id))!.getOption().yAxis as Array<{ data: unknown[] }>)[0].data.length, id);
    expect(await rowsOf('vs-chart-top')).toBe(Object.keys(pairs).length * Object.keys(data.sizes).length);
    expect(await rowsOf('vs-chart-page')).toBe(Object.keys(pairs).length * Object.keys(data.sizes).length);
    // After a write: the 8-worker engine against MongoDB without an index, per size, in the page's duration format.
    const duration = (value: number) => (value >= 1000 ? `${(value / 1000).toFixed(1)} s` : value < 1 ? `${value.toFixed(2)} ms` : value < 10 ? `${value.toFixed(1)} ms` : `${Math.round(value)} ms`);
    const afterWrite = 'dataview + DBSONL file, 8 workers';
    for (const rows of Object.keys(data.sizes)) {
      await expect(page.locator('#vs-after-write')).toContainText(`${duration(median(rows, 'top', afterWrite))} against ${duration(median(rows, 'top', 'MongoDB'))} over ${Number(rows).toLocaleString('en-US')} documents`);
    }
    await page.locator('#mongodb summary').click();
    const listed = new Set([...Object.values(pairs).flat(), 'dataview + DBSONL file', afterWrite]);
    const engines = new Set(Object.values(data.sizes).flatMap((run) => (run as { results: Array<{ engine: string }> }).results.map((r) => r.engine)));
    await expect(page.locator('#vs-table tr')).toHaveCount([...listed].filter((engine) => engines.has(engine)).length);
  });

  test('the compute panel runs every preset on the built bundle, matches plain loops and leases prepared columns', async ({ page }) => {
    // The page generates the same seeded orders, so plain loops over them here are the oracle for what the panel shows.
    const rows = orders(10_000);
    const paid = rows.filter((row) => row.status === 'Paid');
    const regions = new Map<string, { orders: number; paid: number }>();
    for (const row of rows) {
      const group = regions.get(row.region) ?? { orders: 0, paid: 0 };
      group.orders++; if (row.status === 'Paid') group.paid += row.amount;
      regions.set(row.region, group);
    }
    const byPaid = [...regions].sort((a, b) => b[1].paid - a[1].paid);
    const cell = (row: number, column: number) => page.locator(`#cp-body tr:nth-child(${row}) td:nth-child(${column})`);
    const summary = (name: string) => page.locator(`#cp-summary [data-summary="${name}"] .statistic-value`);
    const settled = () => expect(page.locator('#cp-status')).toContainText('10,000 orders');
    // Every plan's code runs as written: it imports what it uses and defines source and q.
    const runnable = async () => {
      for (const line of ["import { forRows } from 'defuss-dataview/compute';", "import { createImmutableArraySource } from 'defuss-dataview/stream';", 'const source = createImmutableArraySource(orders);', 'const q = forRows();']) {
        await expect(page.locator('#cp-code')).toContainText(line);
      }
    };

    await page.goto('/docs/');
    await page.locator('.mk-header-nav a[href="#compute"]').click();
    await page.locator('#cp-size .toggle[data-value="10000"]').click();
    await settled();
    await expect(page.locator('#cp-code .mk-code-block-k').first()).toHaveText('import');
    await expect(page.locator('#cp-code .mk-code-block-s').first()).toHaveText("'defuss-dataview/compute'");
    await runnable();
    await expect(summary('strategy')).toHaveText('hash');
    await expect(summary('totalResultRows')).toHaveText('4');
    await expect(page.locator('#cp-head th')).toHaveText(['region', 'orders', 'paidRevenue', 'averageOrder', 'largest']);
    for (const [index, [region, group]] of byPaid.entries()) {
      await expect(cell(index + 1, 1)).toHaveText(region);
      await expect(cell(index + 1, 2)).toHaveText(count(group.orders));
    }

    await page.locator('#cp-columns .toggle[data-value="columns"]').click();
    await expect(page.locator('#cp-status')).toContainText("prepareKeys(['region', 'amount', 'status'])");
    await expect(summary('cacheBytesPinned')).not.toHaveText('0 B');
    await expect(cell(1, 1)).toHaveText(byPaid[0][0]);

    await page.locator('[data-plan="pairs"]').click();
    await settled();
    await runnable();
    await expect(page.locator('#cp-body tr')).toHaveCount(10);
    await expect(page.locator('#cp-head th')).toHaveText(['region', 'product', 'orders', 'revenue', 'averageOrder']);

    await page.locator('[data-plan="top"]').click();
    await settled();
    await runnable();
    const top = [...paid].sort((a, b) => b.amount * 1.19 - a.amount * 1.19 || a.id - b.id).slice(0, 10);
    await expect(summary('strategy')).toHaveText('top-k');
    await expect(summary('totalResultRows')).toHaveText(count(paid.length));
    await expect(page.locator('#cp-body tr td:nth-child(1)')).toHaveText(top.map((row) => count(row.id)));

    await page.locator('[data-plan="view"]').click();
    await settled();
    await runnable();
    const eu = rows.filter((row) => row.region === 'EU');
    await expect(page.locator('#cp-totals [data-summary="totals.orders"] .statistic-value')).toHaveText(count(eu.length));
    await expect(page.locator('#cp-totals [data-summary="totals.refunded"] .statistic-value')).toHaveText(count(eu.filter((row) => row.status === 'Refunded').length));
    await expect(page.locator('#cp-body tr')).toHaveCount(10);

    await page.locator('[data-plan="distinct"]').click();
    await settled();
    await runnable();
    await expect(summary('strategy')).toHaveText('first-seen');
    await expect(summary('totalResultRows')).toHaveText('unknown');
    await expect(page.locator('#cp-body tr td:nth-child(1)')).toHaveText([...new Set(rows.map((row) => row.product))].slice(0, 5));
    await page.locator('#compute summary').click();
    await expect(page.locator('#cp-explain')).toContainText('"strategy": "first-seen"');
  });

  test('the compute comparison shows mongodb-compute.json: every query, both sizes and the verdict count', async ({ page }) => {
    const data = JSON.parse(readFileSync('docs/assets/mongodb-compute.json', 'utf8'));
    const engines = ['dataview, row reads', 'dataview, prepared columns', 'MongoDB', 'MongoDB + indexes'];
    await page.goto('/docs/');
    for (const size of ['1000000', '100000']) {
      await page.locator(`#cp-vs-size .toggle[data-value="${size}"]`).click();
      await expect(page.locator(`#cp-vs-size .toggle[data-value="${size}"]`)).toHaveAttribute('aria-pressed', 'true');
      const run = data.sizes[size];
      let wins = 0;
      for (const [id, label] of Object.entries(data.queries) as [string, string][]) {
        const times = engines.map((engine) => run.results.find((r: { query: string; engine: string }) => r.query === id && r.engine === engine).medianMs);
        const ratio = Math.min(times[2], times[3]) / times[0];
        if (ratio > 1) wins++;
        const row = page.locator(`#cp-vs-body tr[data-query="${id}"]`);
        await expect(row.locator('td').first()).toHaveText(label);
        await expect(row.locator('td').nth(1)).toHaveText(ratio >= 1 ? `${ratio.toFixed(1)}× faster` : `${(1 / ratio).toFixed(1)}× slower`);
      }
      await expect(page.locator('#cp-vs-wins')).toHaveText(`faster in ${wins} of ${Object.keys(data.queries).length}`);
      await expect(page.locator('#cp-vs-source')).toContainText(run.environment.mongodb);
    }
    // Row reads against prepared columns, as code in two tabs; the preparation time comes from the JSON.
    await expect(page.locator('#cp-prep-rows')).toContainText('createImmutableArraySource(orders);');
    await expect(page.locator('#cp-prep-rows')).toContainText('const q = forRows();');
    await expect(page.locator('#cp-prep-columns')).toBeHidden();
    await page.locator('#cp-prep-columns-tab').click();
    await expect(page.locator('#cp-prep-columns')).toContainText('await source.prepareKeys(byRegion.explain().requiredFields);');
    await expect(page.locator('#cp-prep-columns')).toContainText('const q = forRows();');
    await expect(page.locator('#cp-prep-columns .mk-code-block-c', { hasText: 'key cache' })).toHaveCount(1);
    await expect(page.locator('#cp-vs-prepare')).toContainText(`${Math.round(data.sizes['100000'].prepare.ms)} ms once for 100,000 orders`);
    // The comparison's switch must not start a panel run.
    await expect(page.locator('#cp-status')).not.toContainText('Running');
  });

  test('API tabs and copy buttons', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('/docs/');
    for (const tab of ['request', 'filters', 'tree', 'result', 'identity', 'compute', 'functions']) {
      await page.locator(`#tab-${tab}`).click();
      await expect(page.locator(`#api-${tab}`)).toBeVisible();
      await expect(page.locator('.dv-api .tab-content:visible')).toHaveCount(1);
    }
    await page.locator('#api-functions').getByText('setParent(rows').waitFor();
    await page.locator('#tab-compute').click();
    await expect(page.locator('#api-compute')).toContainText('q.aggregate(d)');
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

  test('the flythrough phrases stay centered when they wrap', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/docs/');
    // Each phrase wraps at phone width; every line must keep equal gaps to the left and right of its layer.
    const gaps = await page.$$eval('.dv-fly-word', words => words.map(word => {
      const layer = word.parentElement!.getBoundingClientRect(), range = document.createRange();
      range.selectNodeContents(word);
      return [...range.getClientRects()].map(line => Math.abs((line.left - layer.left) - (layer.right - line.right)));
    }));
    expect(gaps).toHaveLength(5);
    for (const lines of gaps) {
      expect(lines.length).toBeGreaterThan(1);
      for (const gap of lines) expect(gap).toBeLessThan(2);
    }
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

  test('Reports: compute plans aggregate and project the orders into a Data Grid', async ({ page }) => {
    const rows = orders(100_000);
    const host = page.locator('#reports-host');
    const records = () => page.evaluate(() => df$.shadcn.dataGrid.rows(document.querySelector('#reports-host .data-grid')!) as unknown as Array<Record<string, unknown>>);
    await page.locator('#tab-reports').click();
    await expect(statistic(page, 'Rows returned')).toHaveText('40');
    await expect(host.locator('.data-grid-header')).toHaveText(['Region', 'Product', 'Orders', 'Paid revenue', 'Average order', 'Largest']);
    await expect(page.locator('#ins-query .mk-code-block-k').first()).toHaveText('const');
    const pairs = new Map<string, number>();
    for (const row of rows) if (row.status === 'Paid') pairs.set(`${row.region}|${row.product}`, (pairs.get(`${row.region}|${row.product}`) ?? 0) + row.amount);
    const best = [...pairs].sort((a, b) => b[1] - a[1])[0];
    const first = (await records())[0];
    expect(`${first.region}|${first.product}`).toBe(best[0]);
    expect(first.paidRevenue as number).toBeCloseTo(best[1], 6);

    await page.locator('#reports-plan').selectOption('refunds');
    await expect(host.locator('.data-grid-header').first()).toHaveText('Region');
    await expect(statistic(page, 'Rows returned')).toHaveText('4');
    const refunded = (region: string) => rows.filter((row) => row.region === region && row.status === 'Refunded').length;
    for (const record of await records()) expect(record.refunded).toBe(refunded(record.region as string));

    await page.locator('#ins-presets button', { hasText: 'Paid orders with VAT' }).click();
    await expect(statistic(page, 'Strategy')).toHaveText('top-k');
    await expect(statistic(page, 'Rows returned')).toHaveText('10,000');
    const top = (await records())[0];
    expect(top.gross as number).toBeCloseTo((top.net as number) * 1.19, 9);
    expect(top.net).toBe(Math.max(...rows.filter((row) => row.status === 'Paid').map((row) => row.amount)));

    await page.locator('#reports-plan').selectOption('eu');
    await expect(statistic(page, 'totals.orders')).toHaveText(count(rows.filter((row) => row.region === 'EU').length));
    await page.locator('#reports-size .toggle[value="10000"]').click();
    await expect(statistic(page, 'Orders').first(), 'the first statistic is the order count').toHaveText('10,000');
    await expect(statistic(page, 'totals.orders')).toHaveText(count(orders(10_000).filter((row) => row.region === 'EU').length));
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

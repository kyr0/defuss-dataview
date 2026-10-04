import { expect, test } from '@playwright/test';
test.beforeEach(async ({ page }) => { await page.goto('/'); await page.waitForFunction('globalThis.demo'); });
test('built browser module filters, sorts and pages without losing counts', async ({ page }) => {
  await expect(page.locator('#rows tr')).toHaveCount(3);
  await expect(page.locator('#counts')).toContainText('7 visible / 7 matches / 7 total');
  await page.click('#next'); await expect(page.locator('#counts')).toContainText('page 2 of 3');
  await page.fill('#search', 'Storage'); await expect(page.locator('#rows tr')).toHaveCount(1);
  await expect(page.locator('#counts')).toContainText('1 visible / 1 matches / 7 total');
  await page.fill('#search', ''); await page.click('#sort');
  await expect(page.locator('#rows tr').first()).toHaveAttribute('data-id', '4');
});
test('selection and descriptor survive JSON storage and reload', async ({ page }) => {
  await page.locator('#rows tr[data-id="3"] button').click();
  await expect(page.locator('#rows tr[data-id="3"]')).toHaveAttribute('aria-selected', 'true');
  await page.reload(); await page.waitForFunction('globalThis.demo');
  await expect(page.locator('#rows tr[data-id="3"]')).toHaveAttribute('aria-selected', 'true');
});
test('collapse all, default expansion and ancestor filtering agree in the UI', async ({ page }) => {
  await page.selectOption('#mode', 'tree'); await page.click('#collapse');
  await expect(page.locator('#rows tr')).toHaveCount(2);
  await expect(page.locator('#counts')).toContainText('2 visible / 7 matches / 7 total');
  await page.reload(); await page.waitForFunction('globalThis.demo'); await expect(page.locator('#rows tr')).toHaveCount(2);
  await page.click('#expand'); await page.fill('#search', 'Storage');
  await expect(page.locator('#rows tr')).toHaveCount(3);
  await expect(page.locator('#counts')).toContainText('3 visible / 1 matches / 7 total');
});
test('module worker handles a 30k-deep hierarchy without DOM or Node globals', async ({ page }) => {
  const result = await page.evaluate(() => new Promise(resolve => {
    const worker = new Worker('/tests/fixtures/query.worker.mjs', { type: 'module' });
    worker.onmessage = event => { resolve(event.data); worker.terminate(); };
    worker.onerror = event => { resolve({ error: event.message }); worker.terminate(); };
    worker.postMessage({ size: 30000 });
  }));
  expect(result).toEqual({ total: 30000, depth: 29999, id: 29999 });
});

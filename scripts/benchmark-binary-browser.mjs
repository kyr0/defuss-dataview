import { chromium } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, args: process.env.PLAYWRIGHT_CHROMIUM_ARGS ? JSON.parse(process.env.PLAYWRIGHT_CHROMIUM_ARGS) : undefined });
try {
  const page = await browser.newPage();
  await page.addScriptTag({ content: (await readFile('scripts/binary-kernels.mjs','utf8')).replaceAll('export function ', 'function ') });
  const result = await page.evaluate(() => runBinaryBenchmark(navigator.userAgent));
  result.chromium = browser.version();
  await writeFile('artifacts/binary-chromium.json', JSON.stringify(result,null,2)+'\n');
  console.log('Chromium binary benchmark saved:', result.chromium);
} finally { await browser.close(); }

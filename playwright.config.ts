import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e', timeout: 20000, expect: { timeout: 5000 }, workers: 2, retries: 0,
  // VERIFIED: JSON in artifacts/ is release evidence (SHA256SUMS); the HTML report in output/ is the fresh per-run e2e evidence the vae gate checks.
  reporter: [['list'], ['json', { outputFile: 'artifacts/browser-results.json' }], ['html', { outputFolder: 'output/playwright-report', open: 'never' }]],
  use: { baseURL: 'http://127.0.0.1:4179', headless: true, launchOptions: {
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}),
    ...(process.env.PLAYWRIGHT_CHROMIUM_ARGS ? { args: JSON.parse(process.env.PLAYWRIGHT_CHROMIUM_ARGS) as string[] } : {}),
  } },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: { command: 'node scripts/serve.mjs', url: 'http://127.0.0.1:4179', reuseExistingServer: false },
});

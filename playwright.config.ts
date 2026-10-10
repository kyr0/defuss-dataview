import { defineConfig } from '@playwright/test';
import { createServer, type AddressInfo } from 'node:net';
// The server and the tests share one port: PORT, as scripts/serve.mjs reads it. Without PORT the suite takes 4179, or
// any free port while 4179 is busy (a dev server you are previewing with), so `make verify` never needs a manual PORT.
// Workers and the web server inherit process.env, so the port picked here is the one they all use.
// VERIFIED: on 2026-10-10 `npm run dev` held 4179 and the suite refused to start until it moved to another port.
const bind = (port: number) => new Promise<number>((resolve, reject) => {
  const probe = createServer().once('error', reject);
  probe.listen(port, '127.0.0.1', () => {
    const { port: bound } = probe.address() as AddressInfo;
    probe.close(() => resolve(bound));
  });
});
process.env.PORT ??= String(await bind(4179).catch(() => bind(0)));
const origin = `http://127.0.0.1:${process.env.PORT}`;
export default defineConfig({
  testDir: './tests/e2e', timeout: 20000, expect: { timeout: 5000 }, workers: 2, retries: 0,
  // VERIFIED: JSON in artifacts/ is release evidence (SHA256SUMS); the HTML report in output/ is the fresh per-run e2e evidence the vae gate checks.
  reporter: [['list'], ['json', { outputFile: 'artifacts/browser-results.json' }], ['html', { outputFolder: 'output/playwright-report', open: 'never' }]],
  use: { baseURL: origin, headless: true, launchOptions: {
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}),
    ...(process.env.PLAYWRIGHT_CHROMIUM_ARGS ? { args: JSON.parse(process.env.PLAYWRIGHT_CHROMIUM_ARGS) as string[] } : {}),
  } },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: { command: 'node scripts/serve.mjs', url: origin, reuseExistingServer: false },
});

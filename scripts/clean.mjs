import { rm } from 'node:fs/promises';
for (const target of process.argv[2] === 'dist' ? ['dist'] : ['dist', 'coverage', 'test-results', 'playwright-report', 'tmp', 'artifacts']) {
  await rm(new URL(`../${target}`, import.meta.url), { recursive: true, force: true });
}

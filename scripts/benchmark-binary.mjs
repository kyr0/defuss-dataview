import { writeFile } from 'node:fs/promises';
import { runBinaryBenchmark } from './binary-kernels.mjs';
const engine = globalThis.Bun ? `bun-${Bun.version}` : `node-${process.version}`;
const report = runBinaryBenchmark(engine);
await writeFile(`artifacts/binary-${engine}.json`, JSON.stringify(report, null, 2) + '\n');
for (const c of report.results.filter(x => x.offset === 0)) console.log(c.length, c.mismatch, Object.fromEntries(Object.entries(c.variants).map(([k,v]) => [k, +(c.variants.scalar.medianMs/v.medianMs).toFixed(2)])));

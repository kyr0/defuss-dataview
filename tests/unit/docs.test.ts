/** The website (docs/) against the source and README: the API reference names every export, operator, tree option and
 * result field, and every defuss-dataview pin names one version.
 * Browser behaviour, the pin against npm's latest release and the published sizes are tests/e2e/docs.spec.ts. */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as api from '../../src/index.js';

const root = join(__dirname, '../..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const page = read('docs/index.html');
const types = read('src/types.ts');
/** Visible text: tags dropped, the few entities the page uses decoded, whitespace collapsed. */
const plain = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const missing = (names: string[], render = (name: string) => `<code>${name}`) => names.filter((name) => !page.includes(render(name)));

describe('docs/index.html', () => {
  it('documents every runtime export of src/index.ts in the API reference', () => {
    const exports = Object.keys(api).filter((name) => typeof (api as Record<string, unknown>)[name] === 'function');
    expect(exports.length).toBe(13);
    expect(missing(exports, (name) => `<td class="table-cell"><code>${name}(`)).toEqual([]);
  });

  it('names every filter operator, tree option and result field', () => {
    const operators = [...types.match(/type DataviewFilterOperator =([^;]+);/)![1].matchAll(/"(\w+)"/g)].map((m) => m[1]);
    expect(operators.length).toBe(10);
    expect(missing(operators, (op) => `<code>${op}</code>`)).toEqual([]);
    const treeBlock = types.slice(types.indexOf('export interface DataviewTreeOptions'), types.indexOf('}', types.indexOf('export interface DataviewTreeOptions')));
    const options = [...treeBlock.matchAll(/^\s+(\w+)\??:/gm)].map((m) => m[1]);
    expect(options.length).toBe(8);
    expect(missing(options, (option) => `<code>${option}</code>`)).toEqual([]);
    const fields = Object.keys(api.evaluateDataview([], api.createDataview({ pageSize: 1 })));
    expect(missing(fields, (field) => `<code>${field}</code>`)).toEqual([]);
  });

  it('ships measurements for the package version, with their machine, every benchmark group and a passing test run', () => {
    const metrics = JSON.parse(read('docs/assets/metrics.json'));
    expect(metrics.version).toBe(JSON.parse(read('package.json')).version);
    expect(metrics.environment).toMatchObject({ node: expect.stringMatching(/^v\d+/), cpu: expect.any(String) });
    for (const group of ['lists', 'depth', 'size']) {
      expect(metrics.benchmarks[group].length).toBeGreaterThan(0);
      expect(metrics.benchmarks[group].every((row: { medianMs: number; minMs: number }) => row.medianMs >= row.minMs && row.minMs > 0)).toBe(true);
    }
    for (const value of Object.values(metrics.coverage).filter((value) => typeof value === 'number')) expect(value).toBeGreaterThan(0);
    expect(metrics.tests.unit.passed).toBe(metrics.tests.unit.total);
    expect(metrics.tests.browser.passed).toBe(metrics.tests.browser.total);
  });

  it('pins one defuss-dataview version everywhere, with an integrity hash in each import map', () => {
    const files = ['docs/index.html', ...readdirSync(join(root, 'docs/demo')).map((name) => `docs/demo/${name}`), 'docs/assets/site.js']
      .filter((path) => /\.(html|js)$/.test(path));
    const pins = files.flatMap((path) => [...read(path).matchAll(/defuss-dataview@(\d+\.\d+\.\d+)/g)].map((m) => m[1]));
    expect(pins.length).toBeGreaterThanOrEqual(5);
    expect(new Set(pins).size).toBe(1);
    const importMap = JSON.parse(page.match(/<script type="importmap">([\s\S]*?)<\/script>/)![1]);
    const url = importMap.imports['defuss-dataview'];
    expect(url).toBe(`https://cdn.jsdelivr.net/npm/defuss-dataview@${pins[0]}/dist/browser.min.mjs`);
    expect(importMap.integrity[url]).toMatch(/^sha384-[A-Za-z0-9+/]{64}$/);
    // The install snippet shows the same import map the page uses.
    expect(plain(page)).toContain(`"${importMap.integrity[url]}"`);
  });
});

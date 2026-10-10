import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.map': 'application/json', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };
const server = createServer(async (request, response) => {
  try {
    const raw = new URL(request.url, 'http://localhost').pathname;
    const pathname = decodeURIComponent(raw);
    let file = resolve(root, `.${pathname === '/' ? '/examples/index.html' : pathname}`);
    if (!file.startsWith(root.endsWith(sep) ? root : root + sep)) { response.writeHead(403).end(); return; }
    // Directories answer with their index.html, as GitHub Pages serves docs/; without the trailing slash, relative
    // URLs inside the page would resolve one level up, so redirect first (to the raw path: a decoded one may not be a
    // valid header value).
    // VERIFIED: with curl on 2026-10-10, /docs/demo answered 301 to /docs/demo/, which answered 200.
    if ((await stat(file)).isDirectory()) {
      if (!raw.endsWith('/')) { response.writeHead(301, { Location: `${raw}/` }).end(); return; }
      file = join(file, 'index.html');
    }
    if (!(await stat(file)).isFile()) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    response.end(await readFile(file));
  } catch { response.writeHead(404).end('Not found'); }
});
const port = Number(process.env.PORT ?? 4179);
server.listen(port, '127.0.0.1', () => console.log(`http://127.0.0.1:${port}`));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)));

// Seeded record generators for the demo. Pure functions: the same count and seed give the same records, so the page
// and the search worker build identical data without sending it across, and a reload shows the same rows again.
// VERIFIED: generating beats shipping a dataset. In Node 24 (2026-10-10) 1,000,000 orders generate in about 0.65 s,
// while the same rows as JSON are 129.7 MB (15.4 MB gzip) to download and parse.

/** mulberry32: a small, fast, seedable PRNG; Math.random() cannot be seeded. */
export function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (next, list) => list[Math.floor(next() * list.length)];
const FIRST = ['Ada', 'Alan', 'Barbara', 'Claude', 'Dennis', 'Edsger', 'Frances', 'Grace', 'Hedy', 'Ivan', 'Jean', 'Ken', 'Linus',
  'Margaret', 'Niklaus', 'Radia', 'Sophie', 'Tim', 'Ursula', 'Vint'];
const LAST = ['Lovelace', 'Turing', 'Liskov', 'Shannon', 'Ritchie', 'Dijkstra', 'Allen', 'Hopper', 'Lamarr', 'Sutherland', 'Sammet',
  'Thompson', 'Torvalds', 'Hamilton', 'Wirth', 'Perlman', 'Wilson', 'Berners-Lee', 'Franklin', 'Cerf'];
const PRODUCTS = ['Keyboard', 'Monitor', 'Dock', 'Headset', 'Webcam', 'Laptop stand', 'Desk lamp', 'Cable kit', 'Mouse', 'Chair'];
const REGIONS = ['EU', 'US', 'APAC', 'LATAM'];
const STATUSES = ['Paid', 'Paid', 'Paid', 'Pending', 'Refunded', 'Failed'];
const DAY = 86_400_000;
const START = Date.UTC(2025, 0, 1);
const isoDay = (offset) => new Date(START + offset * DAY).toISOString().slice(0, 10);

/** Flat orders for the Data Grid: id, customer, region, product, amount (EUR), date, status. */
export function orders(count, seed = 1) {
  const next = random(seed);
  const rows = [];
  for (let index = 0; index < count; index++) {
    rows[index] = {
      id: index + 1,
      customer: `${pick(next, FIRST)} ${pick(next, LAST)}`,
      region: pick(next, REGIONS),
      product: pick(next, PRODUCTS),
      amount: Math.round(Math.exp(2 + next() * 6.5) * 100) / 100,
      date: isoDay(Math.floor(next() * 640)),
      status: pick(next, STATUSES),
    };
  }
  return rows;
}

/** A random recursive tree: every record names an earlier folder as its parent (null for the first `roots`). */
function tree(count, seed, roots, folderShare, make) {
  const next = random(seed);
  const rows = [];
  const folders = [];
  for (let index = 0; index < count; index++) {
    const parent = index < roots ? null : folders[Math.floor(next() * folders.length)];
    const folder = index < roots || next() < folderShare;
    rows[index] = make(next, index + 1, parent?.id ?? null, folder, parent);
    if (folder) folders.push(rows[index]);
  }
  return rows;
}

const FOLDERS = ['src', 'docs', 'assets', 'tests', 'scripts', 'reports', 'archive', 'design', 'data', 'exports'];
const EXTENSIONS = ['ts', 'json', 'md', 'png', 'csv', 'css', 'html', 'pdf'];

/** Files and folders for the tree grid: id, parentId, name, kind, size (bytes, files only), modified. */
export function files(count, seed = 2) {
  return tree(count, seed, 8, 0.12, (next, id, parentId, folder) => ({
    id, parentId,
    name: folder ? `${pick(next, FOLDERS)}-${id}` : `${pick(next, FOLDERS)}-${id}.${pick(next, EXTENSIONS)}`,
    kind: folder ? 'Folder' : 'File',
    size: folder ? null : Math.round(Math.exp(5 + next() * 10)),
    modified: isoDay(Math.floor(next() * 640)),
  }));
}

const DEPARTMENTS = ['Kitchen', 'Garden', 'Office', 'Outdoor', 'Workshop', 'Studio', 'Nursery', 'Pantry'];
const KINDS = ['Tools', 'Storage', 'Lighting', 'Textiles', 'Steel', 'Ceramics', 'Glass', 'Timber', 'Paper', 'Cables'];
const ITEMS = ['bracket', 'bowl', 'hook', 'lamp', 'shelf', 'tray', 'clamp', 'jar', 'rack', 'board', 'brush', 'crate'];

/** A product taxonomy for the Data Tree: id, parentId, name. */
export function taxonomy(count, seed = 3) {
  return tree(count, seed, DEPARTMENTS.length, 0.2, (next, id, parentId, folder) => ({
    id, parentId,
    name: parentId === null ? DEPARTMENTS[id - 1]
      : folder ? `${pick(next, KINDS)} ${id}` : `${pick(next, KINDS).toLowerCase()} ${pick(next, ITEMS)} #${id}`,
  }));
}

const UNITS = ['Engineering', 'Frontend', 'Backend', 'Storage', 'Operations', 'Reliability', 'Security', 'Design', 'Research',
  'Support', 'Finance', 'Sales'];

/** Org units for the landing page's query explorer: id, parentId, name, region, score (0-100). */
export function units(count, seed = 7) {
  return tree(count, seed, 6, 0.35, (next, id, parentId) => ({
    id, parentId, name: `${pick(next, UNITS)} ${id}`, region: pick(next, REGIONS), score: Math.floor(next() * 101),
  }));
}

const SERVICES = ['api', 'auth', 'billing', 'search', 'worker', 'gateway'];
const LEVELS = ['info', 'info', 'info', 'info', 'warn', 'error'];
const ROUTES = ['/orders', '/orders/:id', '/login', '/search', '/invoices', '/health', '/export'];

/** Log lines for the Virtual List: id, time (ISO), level, service, status, ms, message. */
export function logs(count, seed = 4) {
  const next = random(seed);
  const rows = [];
  let time = Date.UTC(2026, 9, 1);
  for (let index = 0; index < count; index++) {
    time += Math.floor(next() * 900);
    const level = pick(next, LEVELS);
    const status = level === 'error' ? pick(next, [500, 502, 503, 504]) : level === 'warn' ? pick(next, [404, 409, 429]) : pick(next, [200, 200, 201, 204]);
    const ms = Math.round(Math.exp(1 + next() * (level === 'error' ? 8 : 6)));
    const service = pick(next, SERVICES);
    rows[index] = { id: index + 1, time: new Date(time).toISOString(), level, service, status, ms, message: `${service} ${pick(next, ['GET', 'POST', 'PUT'])} ${pick(next, ROUTES)} ${status} in ${ms} ms` };
  }
  return rows;
}

const PREFIXES = ['Ber', 'Lis', 'Ham', 'Mün', 'Par', 'Ro', 'Wie', 'Os', 'Am', 'Brü', 'Kö', 'Lei', 'Dres', 'Gra', 'Bal', 'Mar', 'San', 'Por', 'Val', 'Zu'];
const SUFFIXES = ['lin', 'bon', 'burg', 'chen', 'is', 'ma', 'nau', 'lo', 'ster', 'gen', 'dorf', 'heim', 'ville', 'ton', 'feld', 'stad', 'berg', 'au', 'ia', 'ona'];
const QUALIFIERS = ['', '', '', 'North', 'South', 'Old', 'New', 'Upper', 'Lower'];
const COUNTRIES = ['Germany', 'Portugal', 'France', 'Italy', 'Austria', 'Norway', 'Netherlands', 'Belgium', 'Spain', 'Switzerland'];

/** Places for the Autocomplete: id, name, country, population, search (the lower-cased name the server matches). */
export function places(count, seed = 5) {
  const next = random(seed);
  const rows = [];
  for (let index = 0; index < count; index++) {
    const qualifier = pick(next, QUALIFIERS);
    const name = `${qualifier ? qualifier + ' ' : ''}${pick(next, PREFIXES)}${pick(next, SUFFIXES)}`;
    rows[index] = { id: index + 1, name, country: pick(next, COUNTRIES), population: Math.round(Math.exp(6 + next() * 9)), search: name.toLowerCase() };
  }
  return rows;
}

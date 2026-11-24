// Refreshes the market lists a static website ships with:
//   public/data/us-stocks.json, public/data/us-etfs.json
// Run: npm run update-data   (the optional GitHub Pages workflow runs it on each deploy)
//
// Only facts are kept: ticker, name, sector and industry, ordered by size. Prices, volumes and
// market caps are left out on purpose, so the repo doesn't republish anyone's market data;
// the app fills prices in live.

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchUsList } from '../lib/market-lists.mjs';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'data');
await mkdir(OUT, { recursive: true });

export const toSnapshot = (rows) => [...rows]
  .sort((a, b) => (b.m || 0) - (a.m || 0)) // stocks by market cap; ETFs have none and keep their order
  .map(({ s, n, sec, ind }) => ({ s, n, sec, ind }));

let failed = 0;
for (const id of ['us-stocks', 'us-etfs']) {
  try {
    const rows = toSnapshot(await fetchUsList(id));
    await writeFile(path.join(OUT, `${id}.json`), JSON.stringify(rows));
    console.log(`${id}: ${rows.length} instruments`);
  } catch (e) {
    failed++;
    console.error(`${id}: ${e.message} (keeping the existing file)`);
  }
}
process.exitCode = failed ? 1 : 0;

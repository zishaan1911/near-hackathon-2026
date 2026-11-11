/**
 * Live CCI snapshot.
 *   npx tsx scripts/snapshotCompute.ts               prints the live level and per-component quote counts
 *   npx tsx scripts/snapshotCompute.ts --write-base  fetches live quotes and rewrites src/compute/base.ts
 *                                                    (BASE_DATE = today, BASE_QUOTES, BASE_VALUES)
 * Optional env: GASX_ETH_RPC_URL (default https://ethereum-rpc.publicnode.com).
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createBlockspaceSource } from '../src/compute/blockspace.js';
import { fetchAllComponents } from '../src/compute/fetchers.js';
import { median } from '../src/compute/stats.js';
import { createComputeService } from '../src/compute/service.js';
import { COMPONENT_IDS } from '../src/compute/types.js';

const fetchImpl = (input: string, init?: RequestInit): Promise<Response> => fetch(input, init);
const ethRpcUrl = process.env.GASX_ETH_RPC_URL || undefined;

async function writeBase(): Promise<void> {
  const blockspace = createBlockspaceSource({ fetchImpl, ...(ethRpcUrl ? { rpcUrl: ethRpcUrl } : {}) });
  const fetched = await fetchAllComponents({ fetchImpl, blockspace });
  const quotes: Record<string, number> = {};
  const values: Record<string, number> = {};
  for (const f of fetched) {
    for (const q of f.quotes) quotes[q.key] = Number(q.price.toPrecision(8));
    if (f.quotes.length === 0) throw new Error(`refusing to write base: ${f.id} has no quotes (${f.errors.join('; ')})`);
    values[f.id] = Number(median(f.quotes.map((q) => q.price)).toPrecision(8));
    const missing = f.expected.filter((e) => !f.quotes.some((q) => q.key === e.key)).map((e) => e.key);
    if (missing.length) console.warn(`[${f.id}] no base for: ${missing.join(', ')}`);
  }
  const today = new Date().toISOString().slice(0, 10);
  const quoteLines = Object.keys(quotes)
    .sort()
    .map((k) => `  '${k}': ${quotes[k]},`)
    .join('\n');
  const valueLines = COMPONENT_IDS.map((id) => `  ${id}: ${values[id]},`).join('\n');
  const file = `import type { ComponentId } from './types.js';

/** Fixed base date at which the index is defined as 1000. */
export const BASE_DATE = '${today}';

/**
 * Base price per quote key (index = 1000 when every quote equals its base),
 * from a live snapshot taken ${new Date().toISOString()} by
 * scripts/snapshotCompute.ts --write-base. Part of methodology v2.0: change
 * only with a new methodology version.
 */
export const BASE_QUOTES: Record<string, number> = {
${quoteLines}
};

/** Representative base price per component (median of its quotes), display only. */
export const BASE_VALUES: Record<ComponentId, number> = {
${valueLines}
};
`;
  const target = fileURLToPath(new URL('../src/compute/base.ts', import.meta.url));
  writeFileSync(target, file);
  console.log(`wrote ${target}: ${Object.keys(quotes).length} base quotes, BASE_DATE ${today}`);
}

async function live(): Promise<void> {
  const getCci = createComputeService({ fetchImpl, ttlMs: 0, ...(ethRpcUrl ? { ethRpcUrl } : {}) });
  const cci = await getCci();
  console.log(`CCI level: ${cci.index.level} (degraded: ${cci.index.degraded}, base ${cci.index.baseDate})`);
  for (const c of cci.components) {
    console.log(
      `  ${c.id.padEnd(15)} quotes ${c.quotes.ok}/${c.quotes.total}  relative ${c.relative}  value ${c.value}  ${c.status}${c.error ? ' ' + c.error : ''}`,
    );
    const d = c.detail?.discarded;
    if (d) console.log(`    discarded: ${d}`);
  }
  console.log(JSON.stringify(cci, null, 2));
}

await (process.argv.includes('--write-base') ? writeBase() : live());

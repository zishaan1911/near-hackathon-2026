import { describe, expect, it } from 'vitest';
import {
  RPC_BATCH_SIZE,
  SAMPLE_COUNT,
  createBlockspaceSource,
  fetchBaseFees,
  fetchEthUsd,
  sampleBlockNumbers,
  usdPerMillionGas,
} from '../src/compute/blockspace.js';
import { chartByDate, createBackfillSource, joinHashprice } from '../src/compute/history.js';
import { hashprice } from '../src/compute/fetchers.js';
import type { FetchImpl } from '../src/compute/types.js';
import { healthyFetch, hex, json } from './computeFixtures.js';

describe('blockspace maths', () => {
  it('$/1M gas = gwei * 1e-3 * ETH/USD', () => {
    expect(usdPerMillionGas(10, 2000)).toBeCloseTo(20, 10);
    expect(usdPerMillionGas(0.5, 3000)).toBeCloseTo(1.5, 10);
  });

  it('samples hourly blocks, 168 of them, spaced 300 apart', () => {
    const b = sampleBlockNumbers(100_000, 300, SAMPLE_COUNT);
    expect(b).toHaveLength(168);
    expect(b[0]).toBe(100_000);
    expect(b[1]).toBe(99_700);
    expect(sampleBlockNumbers(500, 300, 10)).toEqual([500, 200]);
  });

  it('batches eth_getBlockByNumber in groups of 50 and tolerates missing fields', async () => {
    const sizes: number[] = [];
    const fetchImpl: FetchImpl = async (_url, init) => {
      const calls = JSON.parse(String(init?.body)) as Array<{ id: number; params: unknown[] }>;
      sizes.push(calls.length);
      return json(
        calls.map((c) => ({
          id: c.id,
          // block 7 has no baseFeePerGas (pre-London style)
          result: c.params[0] === hex(7) ? { timestamp: hex(1) } : { baseFeePerGas: hex(2_000_000_000), timestamp: hex(1_700_000_000) },
        })),
      );
    };
    const blocks = Array.from({ length: 120 }, (_, i) => i + 1);
    const fees = await fetchBaseFees(fetchImpl, 'https://rpc.test', blocks);
    expect(sizes.sort((a, b) => b - a)).toEqual([RPC_BATCH_SIZE, RPC_BATCH_SIZE, 20]);
    expect(fees).toHaveLength(119);
    expect(fees[0]?.gwei).toBe(2);
  });

  it('median over the 7-day window is cached for an hour', async () => {
    const counter = { n: 0 };
    const clock = { t: 0 };
    const src = createBlockspaceSource({ fetchImpl: healthyFetch({ counter, baseFeeGwei: 10, ethUsd: 2000 }), now: () => clock.t });
    const a = await src();
    expect(a.medianGwei).toBe(10);
    expect(a.samples).toBe(168);
    expect(a.value).toBeCloseTo(20, 8);
    const after1 = counter.n;
    clock.t += 3_599_000;
    await src();
    // Only the ETH/USD call is repeated, never the 168 block samples.
    expect(counter.n - after1).toBe(1);
    clock.t += 2_000;
    await src();
    expect(counter.n - after1).toBeGreaterThan(5);
  });

  it('is an error when too few samples come back', async () => {
    const f = healthyFetch();
    const fetchImpl: FetchImpl = async (url, init) => {
      if (url.includes('publicnode') && String(init?.body).includes('eth_getBlockByNumber')) return json({}, 500);
      return f(url, init);
    };
    await expect(createBlockspaceSource({ fetchImpl })()).rejects.toThrow(/samples/);
  });

  it('ETH/USD falls back to the Chainlink feed (8 decimals)', async () => {
    let seenData = '';
    const fetchImpl: FetchImpl = async (url, init) => {
      if (url.includes('coingecko')) return json({}, 429);
      const calls = JSON.parse(String(init?.body)) as Array<{ id: number; params: Array<{ to: string; data: string }> }>;
      seenData = `${calls[0]?.params[0]?.to}|${calls[0]?.params[0]?.data}`;
      return json([{ id: 0, result: hex(BigInt(250_012_345_678)) }]);
    };
    const r = await fetchEthUsd(fetchImpl, 'https://rpc.test');
    expect(r).toEqual({ price: 2500.12345678, source: 'chainlink' });
    expect(seenData).toBe('0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419|0x50d25bcd');
  });
});

describe('history backfill', () => {
  it('chartByDate keys by UTC date and drops bad points', () => {
    const m = chartByDate({ values: [{ x: Date.UTC(2026, 10, 9, 5) / 1000, y: 5 }, { x: 'bad', y: 1 }, { x: 1, y: -1 }] });
    expect([...m]).toEqual([['2026-11-09', 5]]);
  });

  it('joins hash rate and price by date, oldest first, within the window', () => {
    const hr = new Map([['2026-11-08', 9e8], ['2026-11-09', 1e9], ['2026-11-10', 1e9], ['2026-09-01', 9e8]]);
    const px = new Map([['2026-11-09', 80000], ['2026-11-10', 90000], ['2026-09-01', 50000]]);
    const pts = joinHashprice(hr, px, 5, Date.UTC(2026, 10, 11));
    expect(pts.map((p) => p.t)).toEqual(['2026-11-09T00:00:00.000Z', '2026-11-10T00:00:00.000Z']);
    expect(pts[0]?.value).toBeCloseTo(hashprice(80000, 1e9), 12);
  });

  it('builds both series, caches for an hour, and never fabricates when a source fails', async () => {
    const counter = { n: 0 };
    const clock = { t: Date.UTC(2026, 10, 11) };
    const get = createBackfillSource({ fetchImpl: healthyFetch({ counter, baseFeeGwei: 10, ethUsd: 2000 }), now: () => clock.t });
    const a = await get(30);
    expect(a.btc_hashprice).toHaveLength(2);
    expect(a.blockspace).toHaveLength(120); // 30 days * 4 samples
    expect(a.blockspace[0]?.value).toBeCloseTo(20, 8);
    const n = counter.n;
    await get(30);
    expect(counter.n).toBe(n);

    const broken = createBackfillSource({
      fetchImpl: async (url, init) => (url.includes('blockchain.info') ? json({}, 503) : healthyFetch()(url, init)),
      now: () => clock.t,
    });
    const b = await broken(7);
    expect(b.btc_hashprice).toEqual([]);
    expect(b.blockspace).toHaveLength(28);
  });
});

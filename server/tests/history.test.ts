import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import {
  addDays,
  backcastLevel,
  buildBackcast,
  createBackcastSource,
  rollingMedianGwei,
} from '../src/compute/backcast.js';
import { BASE_DATE } from '../src/compute/base.js';
import type { BaseFeeSample } from '../src/compute/blockspace.js';
import { buildFallbackCandles } from '../src/compute/historySources.js';
import { createBackfillSource, createMarketDataSource, pricesByDate } from '../src/compute/history.js';
import { createSettlementReader, marketNumberOf } from '../src/compute/settlements.js';
import { registerIndicesRoutes } from '../src/routes/indices.js';
import type { GatewayDeps } from '../src/server.js';
import { FakeChainAdapter, makeMarketState } from './fakes.js';
import { healthyFetch, json, hex } from './computeFixtures.js';

const DAY = 86_400_000;

/** 4 samples a day for `n` days ending at the end of `endDate`, all at `gwei`. */
function flatFees(endDate: string, n: number, gwei: number): BaseFeeSample[] {
  const end = Date.parse(`${endDate}T00:00:00.000Z`) + DAY;
  const out: BaseFeeSample[] = [];
  for (let i = 0; i < n * 4; i++) out.push({ block: i, timestamp: (end - (i + 1) * 6 * 3_600_000) / 1000, gwei });
  return out.reverse();
}

function hashSeries(values: Record<string, number>): Map<string, number> {
  return new Map(Object.entries(values));
}

describe('back-cast', () => {
  const eth = new Map<string, number>();
  for (let d = -20; d <= 0; d++) eth.set(addDays(BASE_DATE, d), 2000);

  it('equals exactly 1000 on the base date', () => {
    const hp = hashSeries({ [BASE_DATE]: 0.035, [addDays(BASE_DATE, -1)]: 0.07 });
    const r = buildBackcast({ hashprice: hp, fees: flatFees(BASE_DATE, 15, 10), ethDaily: eth, ethCurrent: 2500, days: 5 });
    const last = r.points[r.points.length - 1];
    expect(last).toEqual({ t: `${BASE_DATE}T00:00:00.000Z`, level: 1000 });
    expect(r.ethPrice).toBe('daily');
    expect(r.pillars).toEqual(['btc_hashprice', 'blockspace']);
  });

  it('exponent maths matches a hand-computed example', () => {
    // hash doubled, gas x4: 1000 * 2^0.10 * 4^0.05 = 1000 * 2^0.20 = 1148.698...
    expect(backcastLevel(2, 1, 4, 1)).toBeCloseTo(1148.698355, 5);
    // hash halves, gas flat: 1000 * 0.5^0.1 = 933.0329...
    expect(backcastLevel(1, 2, 7, 7)).toBeCloseTo(933.032991, 5);
    // end to end: yesterday hashprice 2x base, gas 4x base (via ETH price 4x with same gwei)
    const y = addDays(BASE_DATE, -1);
    const ethDaily = new Map([[BASE_DATE, 1000], [y, 4000]]);
    const r = buildBackcast({
      hashprice: hashSeries({ [BASE_DATE]: 1, [y]: 2 }),
      fees: flatFees(BASE_DATE, 15, 10),
      ethDaily,
      ethCurrent: null,
      days: 1,
    });
    expect(r.points[0]?.level).toBeCloseTo(1148.698355, 5);
  });

  it('skips days with missing inputs instead of interpolating', () => {
    const d1 = addDays(BASE_DATE, -1);
    const d2 = addDays(BASE_DATE, -2);
    const d3 = addDays(BASE_DATE, -3);
    const hp = hashSeries({ [BASE_DATE]: 1, [d1]: 1, [d3]: 1 }); // d2 hash missing
    const ethDaily = new Map([[BASE_DATE, 2000], [d1, 2000], [d2, 2000]]); // d3 eth missing
    const r = buildBackcast({ hashprice: hp, fees: flatFees(BASE_DATE, 15, 10), ethDaily, ethCurrent: null, days: 3 });
    expect(r.points.map((p) => p.t.slice(0, 10))).toEqual([d1, BASE_DATE]);
  });

  it('returns no points when the base date cannot be anchored', () => {
    const r = buildBackcast({ hashprice: hashSeries({ '2026-01-01': 1 }), fees: flatFees(BASE_DATE, 15, 10), ethDaily: eth, ethCurrent: null, days: 3 });
    expect(r.points).toEqual([]);
  });

  it('falls back to the current ETH price and says so', () => {
    const hp = hashSeries({ [BASE_DATE]: 1, [addDays(BASE_DATE, -1)]: 1 });
    const r = buildBackcast({ hashprice: hp, fees: flatFees(BASE_DATE, 15, 10), ethDaily: null, ethCurrent: 2500, days: 1 });
    expect(r.ethPrice).toBe('current');
    expect(r.points).toHaveLength(2);
    expect(r.points.every((p) => p.level === 1000)).toBe(true); // constant ETH and flat gas
  });

  it('uses a 7-day rolling median and needs enough samples', () => {
    const fees = flatFees(BASE_DATE, 7, 5);
    expect(rollingMedianGwei(fees, BASE_DATE)).toBe(5);
    expect(rollingMedianGwei(flatFees(BASE_DATE, 2, 5), BASE_DATE)).toBeNull(); // 8 < 14 samples
  });

  it('reads CoinGecko market_chart prices by UTC date', () => {
    const m = pricesByDate({ prices: [[Date.UTC(2026, 10, 9), 3000], [Date.UTC(2026, 10, 10, 0), 3100], ['x', 1], [1, -5]] });
    expect([...m]).toEqual([['2026-11-09', 3000], ['2026-11-10', 3100]]);
  });

  it('source: daily prices when CoinGecko serves them, current when it fails, cached for an hour', async () => {
    const clock = { t: Date.UTC(2026, 10, 12) };
    const end = Math.floor(Date.UTC(2026, 10, 12) / 1000);
    let calls = 0;
    const mk = (marketChartOk: boolean) => async (url: string, init?: RequestInit): Promise<Response> => {
      calls++;
      if (url.includes('charts/hash-rate') || url.includes('charts/market-price')) {
        const y = url.includes('hash-rate') ? 1e9 : 80000;
        return json({ values: Array.from({ length: 40 }, (_, i) => ({ x: Date.UTC(2026, 10, 12) / 1000 - i * 86400, y })) });
      }
      if (url.includes('market_chart')) {
        return marketChartOk
          ? json({ prices: Array.from({ length: 40 }, (_, i) => [Date.UTC(2026, 10, 12) - i * DAY, 3000]) })
          : json({}, 500);
      }
      if (url.includes('publicnode')) {
        const reqs = JSON.parse(String(init?.body)) as Array<{ id: number; method: string; params: unknown[] }>;
        return json(
          reqs.map((c) => {
            if (c.method === 'eth_blockNumber') return { id: c.id, result: hex(1_000_000) };
            if (c.method === 'eth_getBlockByNumber') {
              const b = Number(BigInt(String(c.params[0])));
              return { id: c.id, result: { baseFeePerGas: hex(10_000_000_000), timestamp: hex(end - (1_000_000 - b) * 12) } };
            }
            return { id: c.id, result: hex(BigInt(2000 * 1e8)) };
          }),
        );
      }
      if (url.includes('coingecko')) return json({ ethereum: { usd: 2000 } });
      return json({}, 404);
    };
    const daily = await createBackcastSource({ fetchImpl: mk(true), now: () => clock.t })(5);
    expect(daily.ethPrice).toBe('daily');
    expect(daily.points.length).toBeGreaterThan(0);
    expect(daily.points[daily.points.length - 1]?.level).toBe(1000);

    const cur = await createBackcastSource({ fetchImpl: mk(false), now: () => clock.t })(5);
    expect(cur.ethPrice).toBe('current');

    const get = createBackcastSource({ fetchImpl: mk(true), now: () => clock.t });
    await get(5);
    const n = calls;
    await get(5);
    expect(calls).toBe(n);
  });

  it('backfill blockspace is priced at each sample date\'s real ETH price', async () => {
    const clock = { t: Date.UTC(2026, 10, 12) };
    const ts = [Date.UTC(2026, 10, 10, 6) / 1000, Date.UTC(2026, 10, 11, 6) / 1000];
    const get = createBackfillSource({
      fetchImpl: healthyFetch(),
      now: () => clock.t,
      marketData: async () => ({
        fees: ts.map((timestamp, i) => ({ block: i, timestamp, gwei: 10 })),
        ethDaily: new Map([['2026-11-10', 1000], ['2026-11-11', 3000]]),
        ethCurrent: 9999,
      }),
    });
    const b = await get(1);
    expect(b.blockspace.map((p) => p.value)).toEqual([10, 30]); // gwei*1e-3*eth
  });

  it('createMarketDataSource fails (and is not cached) when no ETH price exists', async () => {
    let n = 0;
    const src = createMarketDataSource({
      fetchImpl: async (url, init) => {
        n++;
        if (url.includes('publicnode')) {
          const m = (JSON.parse(String(init?.body)) as Array<{ method: string }>)[0]?.method;
          return json([{ id: 0, result: m === 'eth_call' ? null : hex(10) }]);
        }
        return json({}, 500);
      },
      rpcUrl: 'https://ethereum-rpc.publicnode.com',
      now: () => 0,
      ttlMs: 1000,
    });
    await expect(src(4)).rejects.toThrow();
    const before = n;
    await expect(src(4)).rejects.toThrow();
    expect(n).toBeGreaterThan(before);
  });
});

describe('settlement reader', () => {
  function chainWith(current: number, markets: Record<number, { underlying: string; settled: boolean; price: number | null; expiryMs: number }>) {
    const chain = new FakeChainAdapter();
    chain.marketState = makeMarketState({ marketId: `gasx.testnet#${current}` });
    for (const [id, m] of Object.entries(markets)) {
      chain.marketsById.set(Number(id), {
        marketNumber: Number(id),
        underlying: m.underlying,
        expiryMs: m.expiryMs,
        settled: m.settled,
        settlementPrice: m.price,
      });
    }
    return chain;
  }

  it('parses the market number', () => {
    expect(marketNumberOf('gasx.testnet#12')).toBe(12);
    expect(marketNumberOf('dev-market')).toBeNull();
  });

  it('keeps only settled CI-1H markets and orders them by expiry', async () => {
    const chain = chainWith(5, {
      1: { underlying: 'Ethereum Gas Stress Index', settled: true, price: 400, expiryMs: 1000 },
      2: { underlying: 'SCI-1H', settled: true, price: 1010, expiryMs: Date.UTC(2026, 10, 11, 12) },
      3: { underlying: 'CCI-1H', settled: true, price: 1005, expiryMs: Date.UTC(2026, 10, 11, 11) },
      4: { underlying: 'SCI-1H', settled: false, price: null, expiryMs: Date.UTC(2026, 10, 11, 13) },
      // 5 does not exist -> null
    });
    const read = createSettlementReader({ chain, now: () => 0 });
    expect(await read()).toEqual([
      { t: '2026-11-11T11:00:00.000Z', level: 1005, marketId: 3 },
      { t: '2026-11-11T12:00:00.000Z', level: 1010, marketId: 2 },
    ]);
  });

  it('caches settled ids forever, ignores other underlyings, re-reads unsettled at most once a minute', async () => {
    const chain = chainWith(3, {
      1: { underlying: 'Ethereum Gas Stress Index', settled: true, price: 400, expiryMs: 1000 },
      2: { underlying: 'SCI-1H', settled: true, price: 1010, expiryMs: 2000 },
      3: { underlying: 'SCI-1H', settled: false, price: null, expiryMs: 3000 },
    });
    const clock = { t: 1_000_000 };
    const read = createSettlementReader({ chain, now: () => clock.t });
    expect(await read()).toHaveLength(1);
    expect(chain.getMarketByIdCalls.sort()).toEqual([1, 2, 3]);

    clock.t += 30_000; // within a minute: no chain reads at all
    await read();
    expect(chain.getMarketByIdCalls).toHaveLength(3);

    clock.t += 31_000; // past a minute: only the unsettled id is re-read
    chain.marketsById.set(3, { marketNumber: 3, underlying: 'SCI-1H', expiryMs: 3000, settled: true, settlementPrice: 1020 });
    chain.getMarketByIdCalls = [];
    const out = await read();
    expect(chain.getMarketByIdCalls).toEqual([3]);
    expect(out.map((s) => s.marketId)).toEqual([2, 3]);

    clock.t += 120_000; // everything settled or ignored: nothing to re-read
    chain.getMarketByIdCalls = [];
    expect(await read()).toHaveLength(2);
    expect(chain.getMarketByIdCalls).toEqual([]);
  });

  it('is empty in dev-market mode or when the chain read fails', async () => {
    const dev = new FakeChainAdapter();
    dev.marketState = makeMarketState({ marketId: 'dev-market' });
    expect(await createSettlementReader({ chain: dev, now: () => 0 })()).toEqual([]);
    const bad = new FakeChainAdapter();
    bad.getMarketStateError = new Error('rpc down');
    expect(await createSettlementReader({ chain: bad, now: () => 0 })()).toEqual([]);
  });
});

describe('fallback candles', () => {
  it('daily back-cast candles chain open = previous close, then settlement buckets, ascending, limited', () => {
    const backcast = [
      { t: '2026-11-09T00:00:00.000Z', level: 990 },
      { t: '2026-11-10T00:00:00.000Z', level: 1010 },
      { t: '2026-11-11T00:00:00.000Z', level: 1000 },
    ];
    const settlements = [
      { t: '2026-11-11T10:00:00.000Z', level: 1020, marketId: 1 },
      { t: '2026-11-11T10:30:00.000Z', level: 1030, marketId: 2 },
      { t: '2026-11-11T12:00:00.000Z', level: 1015, marketId: 3 },
    ];
    const c = buildFallbackCandles(backcast, settlements, 3600, 100);
    expect(c.map((x) => x.time)).toEqual([...c.map((x) => x.time)].sort((a, b) => a - b));
    expect(c).toHaveLength(5);
    expect(c[0]).toEqual({ time: Date.UTC(2026, 10, 9) / 1000, open: 990, high: 990, low: 990, close: 990, samples: 1 });
    expect(c[1]).toMatchObject({ open: 990, close: 1010, high: 1010, low: 990 });
    expect(c[2]).toMatchObject({ open: 1010, close: 1000, high: 1010, low: 1000 });
    expect(c[3]).toEqual({ time: Date.UTC(2026, 10, 11, 10) / 1000, open: 1020, high: 1030, low: 1020, close: 1030, samples: 2 });
    expect(c[4]).toMatchObject({ open: 1015, close: 1015, samples: 1 });
    expect(buildFallbackCandles(backcast, settlements, 3600, 2).map((x) => x.close)).toEqual([1030, 1015]);
  });
});

describe('GET /api/v1/indices/compute/history (back-cast + settlements)', () => {
  it('adds backcast and settlements to the existing fields', async () => {
    const app = Fastify();
    const chain = new FakeChainAdapter();
    chain.marketState = makeMarketState({ marketId: 'gasx.testnet#1' });
    chain.marketsById.set(1, { marketNumber: 1, underlying: 'SCI-1H', expiryMs: Date.UTC(2026, 10, 11, 12), settled: true, settlementPrice: 1012 });
    registerIndicesRoutes(
      app,
      { chainAdapter: chain, db: null, getCci: async () => { throw new Error('unused'); } } as unknown as GatewayDeps,
      { fetchImpl: healthyFetch(), now: () => Date.UTC(2026, 10, 12), env: {} },
    );
    const res = await app.inject({ method: 'GET', url: '/api/v1/indices/compute/history?days=7' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, s-maxage=900, stale-while-revalidate=300');
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual(['backcast', 'backfill', 'persisted', 'points', 'settlements']);
    expect(body.backcast.pillars).toEqual(['btc_hashprice', 'blockspace']);
    expect(typeof body.backcast.method).toBe('string');
    expect(['daily', 'current']).toContain(body.backcast.ethPrice);
    expect(Array.isArray(body.backcast.points)).toBe(true);
    expect(body.settlements).toEqual([{ t: '2026-11-11T12:00:00.000Z', level: 1012, marketId: 1 }]);
    expect(body.backfill.blockspace).toHaveLength(28);
  });
});

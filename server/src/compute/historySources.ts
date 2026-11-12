/**
 * The real, database-free history sources behind
 * GET /api/v1/indices/compute/history and the /api/v1/candles fallback.
 */
import type { Candle } from '../db.js';
import { createBackcastSource, type Backcast, type BackcastPoint } from './backcast.js';
import { createBackfillSource, createMarketDataSource, type Backfill } from './history.js';
import { createSettlementReader, type Settlement, type SettlementChain } from './settlements.js';
import { DEFAULT_ETH_RPC_URL } from './blockspace.js';
import type { FetchImpl } from './types.js';

export interface HistorySources {
  getBackfill(days: number): Promise<Backfill>;
  getBackcast(days: number): Promise<Backcast>;
  getSettlements(): Promise<Settlement[]>;
}

export interface HistorySourcesOptions {
  fetchImpl: FetchImpl;
  chain?: SettlementChain | undefined;
  rpcUrl?: string | undefined;
  now?: (() => number) | undefined;
}

export function createHistorySources(opts: HistorySourcesOptions): HistorySources {
  const now = opts.now ?? (() => Date.now());
  const rpcUrl = opts.rpcUrl ?? DEFAULT_ETH_RPC_URL;
  // One shared base-fee + ETH price fetch feeds both the backfill and the back-cast.
  const marketData = createMarketDataSource({ fetchImpl: opts.fetchImpl, rpcUrl, now, ttlMs: 3_600_000 });
  const getBackfill = createBackfillSource({ fetchImpl: opts.fetchImpl, rpcUrl, now, marketData });
  const getBackcast = createBackcastSource({ fetchImpl: opts.fetchImpl, rpcUrl, now, marketData });
  const reader = opts.chain ? createSettlementReader({ chain: opts.chain, now }) : async () => [] as Settlement[];
  return { getBackfill, getBackcast, getSettlements: () => reader() };
}

/**
 * Candles from the combined real series (no database): one daily candle per
 * back-cast point (open = previous close), then on-chain settlements bucketed
 * by `intervalSeconds`. Ascending by time; the newest `limit` are returned.
 */
export function buildFallbackCandles(
  backcast: readonly BackcastPoint[],
  settlements: readonly Settlement[],
  intervalSeconds: number,
  limit: number,
): Candle[] {
  const byTime = new Map<number, Candle>();
  let prevClose: number | null = null;
  for (const p of [...backcast].sort((a, b) => a.t.localeCompare(b.t))) {
    const open: number = prevClose ?? p.level;
    byTime.set(Math.floor(Date.parse(p.t) / 1000), {
      time: Math.floor(Date.parse(p.t) / 1000),
      open,
      high: Math.max(open, p.level),
      low: Math.min(open, p.level),
      close: p.level,
      samples: 1,
    });
    prevClose = p.level;
  }
  const step = Math.max(1, Math.trunc(intervalSeconds));
  const buckets = new Map<number, Candle>();
  for (const s of [...settlements].sort((a, b) => a.t.localeCompare(b.t) || a.marketId - b.marketId)) {
    const time = Math.floor(Math.floor(Date.parse(s.t) / 1000) / step) * step;
    const c = buckets.get(time);
    if (!c) buckets.set(time, { time, open: s.level, high: s.level, low: s.level, close: s.level, samples: 1 });
    else {
      c.high = Math.max(c.high, s.level);
      c.low = Math.min(c.low, s.level);
      c.close = s.level;
      c.samples += 1;
    }
  }
  // A real on-chain bucket wins over a daily back-cast candle at the same time.
  for (const [time, c] of buckets) byTime.set(time, c);
  const all = [...byTime.values()].sort((a, b) => a.time - b.time);
  const n = Math.max(1, Math.trunc(limit));
  return all.slice(-n);
}

const resolved = new WeakMap<object, HistorySources>();

/** The deps' own sources, else one shared instance per deps object (so the indices and candles routes share caches). */
export function resolveHistorySources(
  deps: { historySources?: HistorySources | null | undefined; chainAdapter?: SettlementChain | undefined },
  opts: Omit<HistorySourcesOptions, 'chain' | 'fetchImpl'> & { fetchImpl?: FetchImpl | undefined } = {},
): HistorySources {
  if (deps.historySources) return deps.historySources;
  let r = resolved.get(deps);
  if (!r) {
    r = createHistorySources({
      fetchImpl: opts.fetchImpl ?? ((input, init) => fetch(input, init)),
      chain: deps.chainAdapter,
      rpcUrl: opts.rpcUrl ?? (process.env.GASX_ETH_RPC_URL || undefined),
      now: opts.now,
    });
    resolved.set(deps, r);
  }
  return r;
}
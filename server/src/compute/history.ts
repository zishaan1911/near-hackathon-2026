/**
 * Real backfill history, only for the components with public history:
 * Bitcoin hashprice (blockchain.info charts) and Ethereum blockspace (base
 * fees sampled from JSON-RPC, priced at each day's real ETH/USD from
 * CoinGecko). GPU, cloud and AI components have no public history and are
 * never fabricated.
 */
import {
  DEFAULT_ETH_RPC_URL,
  type BaseFeeSample,
  fetchBaseFees,
  fetchBlockNumber,
  fetchEthUsd,
  sampleBlockNumbers,
  usdPerMillionGas,
} from './blockspace.js';
import { BASE_DATE } from './base.js';
import { hashprice } from './fetchers.js';
import { fetchJson, isRecord, num } from './http.js';
import type { FetchImpl } from './types.js';

export interface HistoryPoint {
  t: string;
  value: number;
}

export interface Backfill {
  btc_hashprice: HistoryPoint[];
  blockspace: HistoryPoint[];
}

export const BACKFILL_TTL_MS = 3_600_000;
const HASH_RATE_URL = 'https://api.blockchain.info/charts/hash-rate?timespan=90days&format=json';
const MARKET_PRICE_URL = 'https://api.blockchain.info/charts/market-price?timespan=90days&format=json';
const SIX_HOURS_BLOCKS = 1800; // 6h at 12s blocks
const DAY_MS = 86_400_000;
/** Daily ETH/USD, ~120 days so the back-cast window is covered. */
export const ETH_DAILY_URL = 'https://api.coingecko.com/api/v3/coins/ethereum/market_chart?vs_currency=usd&days=120&interval=daily';

/** CoinGecko market_chart prices: [[ms, usd], ...] keyed by UTC date (a later point on the same date wins). */
export function pricesByDate(body: unknown): Map<string, number> {
  const out = new Map<string, number>();
  const prices = isRecord(body) ? body.prices : undefined;
  if (!Array.isArray(prices)) return out;
  for (const p of prices) {
    if (!Array.isArray(p)) continue;
    const ms = num(p[0]);
    const usd = num(p[1]);
    if (ms === null || usd === null || usd <= 0) continue;
    out.set(new Date(ms).toISOString().slice(0, 10), usd);
  }
  return out;
}

export interface MarketData {
  /** Base-fee samples every 6 hours, oldest first. */
  fees: BaseFeeSample[];
  /** Real daily ETH/USD by UTC date, or null when CoinGecko failed. */
  ethDaily: Map<string, number> | null;
  /** Current ETH/USD, or null when unavailable. */
  ethCurrent: number | null;
}

/** Number of 6-hourly samples needed to cover `days` days back from the base date plus a 7-day window, up to now. */
export function backcastSampleCount(days: number, nowMs: number, baseDate: string): number {
  const sinceBase = Math.max(0, Math.ceil((nowMs - Date.parse(`${baseDate}T00:00:00.000Z`)) / DAY_MS));
  return Math.min(480, (days + 7 + sinceBase + 1) * 4);
}

/** Cached (1 hour, per sample count) base fees + ETH prices, shared by the backfill and the back-cast. */
export function createMarketDataSource(opts: {
  fetchImpl: FetchImpl;
  rpcUrl: string;
  now: () => number;
  ttlMs: number;
}): (sampleCount: number) => Promise<MarketData> {
  const cache = new Map<number, { at: number; value: Promise<MarketData> }>();

  async function build(count: number): Promise<MarketData> {
    const dailyP = fetchJson(opts.fetchImpl, ETH_DAILY_URL)
      .then((b) => {
        const m = pricesByDate(b);
        return m.size > 0 ? m : null;
      })
      .catch(() => null);
    const currentP = fetchEthUsd(opts.fetchImpl, opts.rpcUrl).then((e) => e.price).catch(() => null);
    const latest = await fetchBlockNumber(opts.fetchImpl, opts.rpcUrl);
    const [fees, ethDaily, ethCurrent] = await Promise.all([
      fetchBaseFees(opts.fetchImpl, opts.rpcUrl, sampleBlockNumbers(latest, SIX_HOURS_BLOCKS, count)),
      dailyP,
      currentP,
    ]);
    if (ethDaily === null && ethCurrent === null) throw new Error('no ETH/USD price available');
    return { fees, ethDaily, ethCurrent };
  }

  return (count) => {
    const hit = cache.get(count);
    if (hit && opts.now() - hit.at < opts.ttlMs) return hit.value;
    const value = build(count);
    const entry = { at: opts.now(), value };
    cache.set(count, entry);
    value.catch(() => {
      if (cache.get(count) === entry) cache.delete(count);
    });
    return value;
  };
}

/** UTC date (YYYY-MM-DD) of a unix-seconds timestamp. */
export function utcDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}
/** blockchain.info chart values: [{ x: unix seconds, y }]. Keyed by UTC date (YYYY-MM-DD). */
export function chartByDate(body: unknown): Map<string, number> {
  const out = new Map<string, number>();
  const values = isRecord(body) ? body.values : undefined;
  if (!Array.isArray(values)) return out;
  for (const v of values) {
    if (!isRecord(v)) continue;
    const x = num(v.x);
    const y = num(v.y);
    if (x === null || y === null || y <= 0) continue;
    out.set(new Date(x * 1000).toISOString().slice(0, 10), y);
  }
  return out;
}

/** Joins hash rate (TH/s) and BTC/USD by date into hashprice points, oldest first, last `days` days. */
export function joinHashprice(hashRate: Map<string, number>, price: Map<string, number>, days: number, nowMs: number): HistoryPoint[] {
  const cutoff = new Date(nowMs - days * 86_400_000).toISOString().slice(0, 10);
  const out: HistoryPoint[] = [];
  for (const [date, th] of hashRate) {
    const usd = price.get(date);
    if (usd === undefined || date < cutoff) continue;
    out.push({ t: `${date}T00:00:00.000Z`, value: hashprice(usd, th) });
  }
  return out.sort((a, b) => a.t.localeCompare(b.t));
}

export interface BackfillOptions {
  fetchImpl: FetchImpl;
  rpcUrl?: string;
  now?: () => number;
  ttlMs?: number;
  /** Shared market-data source (base fees + ETH prices); built from the other options when omitted. */
  marketData?: (sampleCount: number) => Promise<MarketData>;
}

/** Cached (1 hour, per `days`) backfill. Each series fails independently to []. */
export function createBackfillSource(opts: BackfillOptions): (days: number) => Promise<Backfill> {
  const rpcUrl = opts.rpcUrl ?? DEFAULT_ETH_RPC_URL;
  const now = opts.now ?? (() => Date.now());
  const ttl = opts.ttlMs ?? BACKFILL_TTL_MS;
  const cache = new Map<number, { at: number; value: Promise<Backfill> }>();

  async function hashSeries(days: number): Promise<HistoryPoint[]> {
    const [hr, mp] = await Promise.all([fetchJson(opts.fetchImpl, HASH_RATE_URL), fetchJson(opts.fetchImpl, MARKET_PRICE_URL)]);
    return joinHashprice(chartByDate(hr), chartByDate(mp), days, now());
  }

  const marketData = opts.marketData ?? createMarketDataSource({ fetchImpl: opts.fetchImpl, rpcUrl, now, ttlMs: ttl });

  async function blockspaceSeries(days: number): Promise<HistoryPoint[]> {
    const md = await marketData(backcastSampleCount(days, now(), BASE_DATE));
    // Newest days*4 samples; each is priced at the real ETH/USD of its UTC
    // date, falling back to the current price only for a date CoinGecko lacks.
    const out: HistoryPoint[] = [];
    for (const f of md.fees.slice(-days * 4)) {
      const usd = md.ethDaily?.get(utcDate(f.timestamp)) ?? md.ethCurrent;
      if (usd === null || usd === undefined) continue;
      out.push({ t: new Date(f.timestamp * 1000).toISOString(), value: usdPerMillionGas(f.gwei, usd) });
    }
    return out;
  }

  async function build(days: number): Promise<Backfill> {
    const [h, b] = await Promise.allSettled([hashSeries(days), blockspaceSeries(days)]);
    return {
      btc_hashprice: h.status === 'fulfilled' ? h.value : [],
      blockspace: b.status === 'fulfilled' ? b.value : [],
    };
  }

  return (days) => {
    const hit = cache.get(days);
    if (hit && now() - hit.at < ttl) return hit.value;
    const value = build(days);
    const entry = { at: now(), value };
    cache.set(days, entry);
    // Do not pin a total failure in the cache for an hour.
    void value.then((v) => {
      if (v.btc_hashprice.length === 0 && v.blockspace.length === 0 && cache.get(days) === entry) cache.delete(days);
    });
    return value;
  };
}

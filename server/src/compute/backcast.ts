/**
 * Back-cast: the SCI level re-computed day by day BEFORE the base date, using
 * only the two pillars that have real public history (Bitcoin hashprice and
 * Ethereum blockspace). The other four pillars (GPU rental, cloud GPU, cloud
 * CPU, AI inference) have no public history and are held at their base value
 * (relative 1). So this shows how those two pillars alone would have moved
 * the index, not the full index.
 *
 *   level_d = 1000 * (hash_d / hash_base)^0.10 * (gas_d / gas_base)^0.05
 *
 * Both bases are taken from the same series on BASE_DATE, so the back-cast is
 * exactly 1000 on the base date and joins the live index. A day missing either
 * input is skipped, never interpolated.
 */
import { BASE_DATE } from './base.js';
import { INDEX_BASE } from './calc.js';
import { chartByDate, createMarketDataSource, backcastSampleCount, type MarketData } from './history.js';
import { hashprice } from './fetchers.js';
import { DEFAULT_ETH_RPC_URL, usdPerMillionGas, type BaseFeeSample } from './blockspace.js';
import { fetchJson } from './http.js';
import { median } from './stats.js';
import { COMPONENT_META, type FetchImpl } from './types.js';

const weightOf = (id: string): number => COMPONENT_META.find((c) => c.id === id)?.nominalWeight ?? 0;
/** 0.10 and 0.05: the nominal weights of the two pillars with public history. */
export const BTC_WEIGHT = weightOf('btc_hashprice');
export const BLOCKSPACE_WEIGHT = weightOf('blockspace');

export const BACKCAST_TTL_MS = 3_600_000;
export const BACKCAST_METHOD =
  'Daily SCI level re-computed from only the two pillars with public history (Bitcoin hashprice at 10% and Ethereum blockspace at 5% weight), ' +
  'with the other four pillars held at their base values, so it shows how those two pillars alone would have moved the index; it is not the full index.';
const WINDOW_DAYS = 7;
const MIN_WINDOW_SAMPLES = 14; // half of 7 days * 4 samples
const DAY_MS = 86_400_000;
const HASH_RATE_URL = 'https://api.blockchain.info/charts/hash-rate?timespan=130days&format=json';
const MARKET_PRICE_URL = 'https://api.blockchain.info/charts/market-price?timespan=130days&format=json';

export interface BackcastPoint {
  t: string;
  level: number;
}

export interface Backcast {
  points: BackcastPoint[];
  method: string;
  pillars: ['btc_hashprice', 'blockspace'];
  ethPrice: 'daily' | 'current';
}

/** Median base fee (gwei) of the samples in the 7 UTC days ending at the end of `date`; null with too few samples. */
export function rollingMedianGwei(fees: readonly BaseFeeSample[], date: string): number | null {
  const end = Date.parse(`${date}T00:00:00.000Z`) + DAY_MS;
  const start = end - WINDOW_DAYS * DAY_MS;
  const inWindow = fees.filter((f) => f.timestamp * 1000 >= start && f.timestamp * 1000 < end).map((f) => f.gwei);
  return inWindow.length >= MIN_WINDOW_SAMPLES ? median(inWindow) : null;
}

/** Index level from the two relatives' underlying values. */
export function backcastLevel(hash: number, hashBase: number, gas: number, gasBase: number): number {
  return INDEX_BASE * Math.pow(hash / hashBase, BTC_WEIGHT) * Math.pow(gas / gasBase, BLOCKSPACE_WEIGHT);
}

export function addDays(date: string, delta: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + delta * DAY_MS).toISOString().slice(0, 10);
}

export interface BackcastInput {
  /** Hashprice ($/TH/s/day) by UTC date. */
  hashprice: ReadonlyMap<string, number>;
  fees: readonly BaseFeeSample[];
  ethDaily: ReadonlyMap<string, number> | null;
  ethCurrent: number | null;
  baseDate?: string;
  days: number;
}

/** Pure back-cast builder. Empty `points` when the base date cannot be anchored. */
export function buildBackcast(input: BackcastInput): Backcast {
  const baseDate = input.baseDate ?? BASE_DATE;
  const daily = input.ethDaily !== null && input.ethDaily.size > 0;
  const result: Backcast = { points: [], method: BACKCAST_METHOD, pillars: ['btc_hashprice', 'blockspace'], ethPrice: daily ? 'daily' : 'current' };

  const gasUsd = (date: string): number | null => {
    const gwei = rollingMedianGwei(input.fees, date);
    const eth = daily ? input.ethDaily?.get(date) : input.ethCurrent;
    if (gwei === null || eth === undefined || eth === null) return null;
    return usdPerMillionGas(gwei, eth);
  };

  const hashBase = input.hashprice.get(baseDate);
  const gasBase = gasUsd(baseDate);
  if (hashBase === undefined || gasBase === null) return result;

  for (let d = -input.days; d <= 0; d++) {
    const date = addDays(baseDate, d);
    const h = input.hashprice.get(date);
    const g = gasUsd(date);
    if (h === undefined || g === null) continue; // missing day: skipped, not interpolated
    result.points.push({ t: `${date}T00:00:00.000Z`, level: backcastLevel(h, hashBase, g, gasBase) });
  }
  return result;
}

export interface BackcastSourceOptions {
  fetchImpl: FetchImpl;
  rpcUrl?: string;
  now?: () => number;
  ttlMs?: number;
  marketData?: (sampleCount: number) => Promise<MarketData>;
}

/** Cached (1 hour, per `days`) back-cast. On total failure returns an empty back-cast and does not pin the failure. */
export function createBackcastSource(opts: BackcastSourceOptions): (days: number) => Promise<Backcast> {
  const rpcUrl = opts.rpcUrl ?? DEFAULT_ETH_RPC_URL;
  const now = opts.now ?? (() => Date.now());
  const ttl = opts.ttlMs ?? BACKCAST_TTL_MS;
  const marketData = opts.marketData ?? createMarketDataSource({ fetchImpl: opts.fetchImpl, rpcUrl, now, ttlMs: ttl });
  const cache = new Map<number, { at: number; value: Promise<Backcast> }>();

  async function build(days: number): Promise<Backcast> {
    const [hr, mp, md] = await Promise.all([
      fetchJson(opts.fetchImpl, HASH_RATE_URL),
      fetchJson(opts.fetchImpl, MARKET_PRICE_URL),
      marketData(backcastSampleCount(days, now(), BASE_DATE)),
    ]);
    const rate = chartByDate(hr);
    const price = chartByDate(mp);
    const hp = new Map<string, number>();
    for (const [date, th] of rate) {
      const usd = price.get(date);
      if (usd !== undefined) hp.set(date, hashprice(usd, th));
    }
    return buildBackcast({ hashprice: hp, fees: md.fees, ethDaily: md.ethDaily, ethCurrent: md.ethCurrent, days });
  }

  const empty = (): Backcast => ({ points: [], method: BACKCAST_METHOD, pillars: ['btc_hashprice', 'blockspace'], ethPrice: 'current' });

  return (days) => {
    const hit = cache.get(days);
    if (hit && now() - hit.at < ttl) return hit.value;
    const value = build(days).catch(empty);
    const entry = { at: now(), value };
    cache.set(days, entry);
    void value.then((v) => {
      if (v.points.length === 0 && cache.get(days) === entry) cache.delete(days);
    });
    return value;
  };
}

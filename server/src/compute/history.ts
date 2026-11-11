/**
 * Real backfill history, only for the components with public history:
 * Bitcoin hashprice (blockchain.info charts) and Ethereum blockspace (base
 * fees sampled from JSON-RPC). GPU, cloud and AI components have no public
 * history and are never fabricated.
 */
import {
  DEFAULT_ETH_RPC_URL,
  fetchBaseFees,
  fetchBlockNumber,
  fetchEthUsd,
  sampleBlockNumbers,
  usdPerMillionGas,
} from './blockspace.js';
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

  async function blockspaceSeries(days: number): Promise<HistoryPoint[]> {
    const latest = await fetchBlockNumber(opts.fetchImpl, rpcUrl);
    const [fees, eth] = await Promise.all([
      fetchBaseFees(opts.fetchImpl, rpcUrl, sampleBlockNumbers(latest, SIX_HOURS_BLOCKS, days * 4)),
      fetchEthUsd(opts.fetchImpl, rpcUrl),
    ]);
    // APPROXIMATION: every sample is priced at the CURRENT ETH/USD, so this
    // series shows base-fee history in dollars at today's ETH price, not what
    // a user paid in dollars on the day.
    return fees.map((f) => ({
      t: new Date(f.timestamp * 1000).toISOString(),
      value: usdPerMillionGas(f.gwei, eth.price),
    }));
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

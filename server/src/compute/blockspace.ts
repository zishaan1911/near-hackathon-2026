/**
 * Ethereum blockspace price: $/1M gas = median baseFeePerGas (gwei) * 1e-3 *
 * ETH/USD. (1 gwei = 1e-9 ETH; 1M gas = 1e6 gas, so gwei * 1e-3 ETH per 1M gas.)
 * Samples come straight from Ethereum JSON-RPC.
 */
import { fetchJson, isRecord, num } from './http.js';
import { median } from './stats.js';
import type { FetchImpl } from './types.js';

export const DEFAULT_ETH_RPC_URL = 'https://ethereum-rpc.publicnode.com';
export const SAMPLE_SPACING_BLOCKS = 300; // ~1 hour at 12s blocks
export const SAMPLE_COUNT = 168; // 7 days hourly
export const RPC_BATCH_SIZE = 50;
export const MIN_SAMPLES = 84; // at least half the window
export const MEDIAN_TTL_MS = 3_600_000;
const COINGECKO_ETH_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd';
const CHAINLINK_ETH_USD = '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419';
const CHAINLINK_LATEST_ROUND = '0x50d25bcd';

export interface BaseFeeSample {
  block: number;
  /** Unix seconds. */
  timestamp: number;
  gwei: number;
}

/** $/1M gas from a base fee in gwei and ETH/USD. */
export function usdPerMillionGas(gwei: number, ethUsd: number): number {
  return gwei * 1e-3 * ethUsd;
}

function hexToNumber(x: unknown): number | null {
  if (typeof x !== 'string' || !/^0x[0-9a-fA-F]+$/.test(x)) return null;
  const n = Number(BigInt(x));
  return Number.isFinite(n) ? n : null;
}

async function rpcBatch(fetchImpl: FetchImpl, rpcUrl: string, calls: ReadonlyArray<{ method: string; params: unknown[] }>): Promise<unknown[]> {
  const body = calls.map((c, i) => ({ jsonrpc: '2.0', id: i, method: c.method, params: c.params }));
  const res = await fetchJson(fetchImpl, rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!Array.isArray(res)) throw new Error('JSON-RPC batch: unexpected response');
  const out: unknown[] = new Array<unknown>(calls.length).fill(null);
  for (const r of res) {
    if (!isRecord(r)) continue;
    const id = num(r.id);
    if (id !== null && id >= 0 && id < calls.length) out[id] = r.result ?? null;
  }
  return out;
}

export async function fetchBlockNumber(fetchImpl: FetchImpl, rpcUrl: string): Promise<number> {
  const [res] = await rpcBatch(fetchImpl, rpcUrl, [{ method: 'eth_blockNumber', params: [] }]);
  const n = hexToNumber(res);
  if (n === null) throw new Error('eth_blockNumber: bad result');
  return n;
}

/** Block numbers latest, latest - spacing, ... (count of them, all >= 0). */
export function sampleBlockNumbers(latest: number, spacing: number, count: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const b = latest - i * spacing;
    if (b < 0) break;
    out.push(b);
  }
  return out;
}

/** Fetches base fees for the given blocks in batches of 50. Failed batches/blocks are skipped. */
export async function fetchBaseFees(fetchImpl: FetchImpl, rpcUrl: string, blocks: readonly number[]): Promise<BaseFeeSample[]> {
  const batches: number[][] = [];
  for (let i = 0; i < blocks.length; i += RPC_BATCH_SIZE) batches.push(blocks.slice(i, i + RPC_BATCH_SIZE));
  const settled = await Promise.allSettled(
    batches.map((batch) =>
      rpcBatch(
        fetchImpl,
        rpcUrl,
        batch.map((b) => ({ method: 'eth_getBlockByNumber', params: ['0x' + b.toString(16), false] })),
      ),
    ),
  );
  const out: BaseFeeSample[] = [];
  settled.forEach((s, bi) => {
    if (s.status !== 'fulfilled') return;
    s.value.forEach((blk, i) => {
      if (!isRecord(blk)) return;
      const fee = hexToNumber(blk.baseFeePerGas);
      const ts = hexToNumber(blk.timestamp);
      const block = batches[bi]?.[i];
      if (fee === null || ts === null || block === undefined) return;
      out.push({ block, timestamp: ts, gwei: fee / 1e9 });
    });
  });
  return out.sort((a, b) => a.block - b.block);
}

/** ETH/USD from CoinGecko, falling back to the Chainlink ETH/USD feed (8 decimals) via eth_call. */
export async function fetchEthUsd(fetchImpl: FetchImpl, rpcUrl: string): Promise<{ price: number; source: string }> {
  try {
    const cg = await fetchJson(fetchImpl, COINGECKO_ETH_URL);
    const eth = isRecord(cg) ? cg.ethereum : undefined;
    const p = isRecord(eth) ? num(eth.usd) : null;
    if (p !== null && p > 0) return { price: p, source: 'coingecko' };
  } catch {
    // fall through to Chainlink
  }
  const [res] = await rpcBatch(fetchImpl, rpcUrl, [
    { method: 'eth_call', params: [{ to: CHAINLINK_ETH_USD, data: CHAINLINK_LATEST_ROUND }, 'latest'] },
  ]);
  // 0x50d25bcd is latestAnswer(): a single int256 with 8 decimals.
  if (typeof res !== 'string' || !/^0x[0-9a-fA-F]+$/.test(res)) throw new Error('Chainlink ETH/USD: bad result');
  const price = Number(BigInt(res)) / 1e8;
  if (!(price > 0)) throw new Error('Chainlink ETH/USD: non-positive answer');
  return { price, source: 'chainlink' };
}

export interface BlockspaceReading {
  /** $/1M gas. */
  value: number;
  medianGwei: number;
  ethUsd: number;
  ethUsdSource: string;
  samples: number;
}

export interface BlockspaceSourceOptions {
  fetchImpl: FetchImpl;
  rpcUrl?: string;
  now?: () => number;
  ttlMs?: number;
}

/** 7-day median base fee in gwei, cached for 1 hour. ETH/USD is fetched on every call. */
export function createBlockspaceSource(opts: BlockspaceSourceOptions): () => Promise<BlockspaceReading> {
  const rpcUrl = opts.rpcUrl ?? DEFAULT_ETH_RPC_URL;
  const now = opts.now ?? (() => Date.now());
  const ttl = opts.ttlMs ?? MEDIAN_TTL_MS;
  let cached: { at: number; medianGwei: number; samples: number } | null = null;
  let inflight: Promise<{ medianGwei: number; samples: number }> | null = null;

  async function sampleMedian(): Promise<{ medianGwei: number; samples: number }> {
    if (cached && now() - cached.at < ttl) return cached;
    if (inflight) return inflight;
    inflight = (async () => {
      const latest = await fetchBlockNumber(opts.fetchImpl, rpcUrl);
      const fees = await fetchBaseFees(opts.fetchImpl, rpcUrl, sampleBlockNumbers(latest, SAMPLE_SPACING_BLOCKS, SAMPLE_COUNT));
      if (fees.length < MIN_SAMPLES) throw new Error(`only ${fees.length}/${SAMPLE_COUNT} base-fee samples`);
      const result = { medianGwei: median(fees.map((f) => f.gwei)), samples: fees.length };
      cached = { at: now(), ...result };
      return result;
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  return async () => {
    const [m, eth] = await Promise.all([sampleMedian(), fetchEthUsd(opts.fetchImpl, rpcUrl)]);
    return {
      value: usdPerMillionGas(m.medianGwei, eth.price),
      medianGwei: m.medianGwei,
      ethUsd: eth.price,
      ethUsdSource: eth.source,
      samples: m.samples,
    };
  };
}

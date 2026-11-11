import { BASE_DATE, BASE_QUOTES, BASE_VALUES } from './base.js';
import { createBlockspaceSource, type BlockspaceReading } from './blockspace.js';
import { computeIndex, INDEX_BASE, type CalcComponent, type GpuView } from './calc.js';
import { fetchAllComponents } from './fetchers.js';
import type { ComponentId, FetchImpl } from './types.js';

export const METHODOLOGY_VERSION = '2.0';
export const CACHE_TTL_MS = 60_000;

export interface CciResponse {
  index: {
    id: 'CCI';
    name: 'Congest Compute Index';
    level: number | null;
    base: number;
    baseDate: string;
    asOf: string;
    degraded: boolean;
    methodologyVersion: string;
  };
  components: CalcComponent[];
  gpus: GpuView[];
}

export interface ComputeServiceOptions {
  fetchImpl: FetchImpl;
  now?: () => number;
  ttlMs?: number;
  /** Ethereum JSON-RPC URL (GASX_ETH_RPC_URL). */
  ethRpcUrl?: string;
  baseQuotes?: Record<string, number>;
  baseValues?: Record<ComponentId, number>;
  /** Test override for the blockspace sampler. */
  blockspace?: () => Promise<BlockspaceReading>;
}

/** Computes the CCI with a short in-memory cache. Never throws. */
export function createComputeService(opts: ComputeServiceOptions): () => Promise<CciResponse> {
  const now = opts.now ?? (() => Date.now());
  const ttl = opts.ttlMs ?? CACHE_TTL_MS;
  const blockspace =
    opts.blockspace ??
    createBlockspaceSource({ fetchImpl: opts.fetchImpl, now, ...(opts.ethRpcUrl ? { rpcUrl: opts.ethRpcUrl } : {}) });
  let cached: { at: number; value: CciResponse } | null = null;
  let inflight: Promise<CciResponse> | null = null;

  async function compute(): Promise<CciResponse> {
    const fetched = await fetchAllComponents({ fetchImpl: opts.fetchImpl, blockspace });
    const calc = computeIndex(fetched, opts.baseQuotes ?? BASE_QUOTES, opts.baseValues ?? BASE_VALUES);
    return {
      index: {
        id: 'CCI',
        name: 'Congest Compute Index',
        level: calc.level,
        base: INDEX_BASE,
        baseDate: BASE_DATE,
        asOf: new Date(now()).toISOString(),
        degraded: calc.degraded,
        methodologyVersion: METHODOLOGY_VERSION,
      },
      components: calc.components,
      gpus: calc.gpus,
    };
  }

  return async () => {
    if (cached && now() - cached.at < ttl) return cached.value;
    if (inflight) return inflight;
    inflight = compute()
      .then((value) => {
        cached = { at: now(), value };
        return value;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };
}

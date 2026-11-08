import { BASE_DATE, BASE_VALUES } from './base.js';
import { computeIndex, INDEX_BASE, type CalcComponent } from './calc.js';
import { fetchAllComponents, type EgsiScoreSource } from './fetchers.js';
import type { ComponentId, FetchImpl } from './types.js';

export const METHODOLOGY_VERSION = '1.0';
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
}

export interface ComputeServiceOptions {
  fetchImpl: FetchImpl;
  getEgsiScore: EgsiScoreSource;
  now?: () => number;
  ttlMs?: number;
  baseValues?: Record<ComponentId, number>;
}

/** Computes the CCI with a short in-memory cache. Never throws. */
export function createComputeService(opts: ComputeServiceOptions): () => Promise<CciResponse> {
  const now = opts.now ?? (() => Date.now());
  const ttl = opts.ttlMs ?? CACHE_TTL_MS;
  let cached: { at: number; value: CciResponse } | null = null;
  let inflight: Promise<CciResponse> | null = null;

  async function compute(): Promise<CciResponse> {
    const readings = await fetchAllComponents({ fetchImpl: opts.fetchImpl, getEgsiScore: opts.getEgsiScore });
    const calc = computeIndex(readings, opts.baseValues ?? BASE_VALUES);
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

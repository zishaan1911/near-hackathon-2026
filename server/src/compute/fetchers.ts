/**
 * Component fetchers for the Congest Compute Index. Every fetcher takes an
 * injectable `fetchImpl` (tests never touch the network), never throws
 * (failures become `status: 'down'`), and uses 8s timeouts with one retry
 * on network error (see http.ts).
 */
import { AZURE_REGIONS, AZURE_SKUS, GPU_BASKET, MODEL_BASKET } from './basket.js';
import { errMsg, fetchJson, isRecord, num } from './http.js';
import { median, trim, weightedGeoMean } from './stats.js';
import {
  metaFor,
  type ComponentDetail,
  type ComponentId,
  type ComponentReading,
  type FetchImpl,
} from './types.js';

function ok(id: ComponentId, value: number, detail?: ComponentDetail): ComponentReading {
  const m = metaFor(id);
  return { id, label: m.label, unit: m.unit, value, status: 'ok', source: m.source, ...(detail ? { detail } : {}) };
}

function down(id: ComponentId, error: string): ComponentReading {
  const m = metaFor(id);
  return { id, label: m.label, unit: m.unit, value: null, status: 'down', error, source: m.source };
}

async function guarded(id: ComponentId, fn: () => Promise<ComponentReading>): Promise<ComponentReading> {
  try {
    return await fn();
  } catch (e) {
    return down(id, errMsg(e));
  }
}

// ---------------------------------------------------------------- Vast.ai

const VAST_URL = 'https://console.vast.ai/api/v0/bundles/';
export const MIN_VAST_OFFERS = 5;

/** Per-GPU $/hr for each offer: dph_total / num_gpus. */
export function vastPerGpuPrices(offers: unknown): number[] {
  if (!Array.isArray(offers)) return [];
  const out: number[] = [];
  for (const o of offers) {
    if (!isRecord(o)) continue;
    const dph = num(o.dph_total);
    const n = num(o.num_gpus);
    if (dph === null || n === null || n < 1 || dph <= 0) continue;
    out.push(dph / n);
  }
  return out;
}

/** Median per-GPU price after dropping the top and bottom 10% of offers. */
export function vastTrimmedMedian(prices: number[]): number {
  return median(trim(prices, 0.1));
}

export function fetchGpuMarketplace(fetchImpl: FetchImpl): Promise<ComponentReading> {
  return guarded('gpu_marketplace', async () => {
    const results = await Promise.allSettled(
      GPU_BASKET.map(async (g) => {
        const body = await fetchJson(fetchImpl, VAST_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            limit: 100,
            type: 'on-demand',
            verified: { eq: true },
            rentable: { eq: true },
            num_gpus: { gte: 1 },
            gpu_name: { eq: g.name },
          }),
        });
        const prices = vastPerGpuPrices(isRecord(body) ? body.offers : undefined);
        return { g, prices };
      }),
    );
    const items: Array<{ value: number; weight: number }> = [];
    const detail: ComponentDetail = {};
    const errors: string[] = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const g = GPU_BASKET[i];
      if (!r || !g) continue;
      if (r.status === 'rejected') {
        errors.push(`${g.name}: ${errMsg(r.reason)}`);
        continue;
      }
      detail[`${g.name} offers`] = r.value.prices.length;
      if (r.value.prices.length < MIN_VAST_OFFERS) continue;
      const med = vastTrimmedMedian(r.value.prices);
      detail[`${g.name} median`] = Number(med.toFixed(4));
      items.push({ value: med, weight: g.weight });
    }
    if (items.length === 0) {
      return down('gpu_marketplace', errors.length ? errors.join('; ') : 'no GPU had enough offers');
    }
    return ok('gpu_marketplace', weightedGeoMean(items), detail);
  });
}

// ------------------------------------------------------------------ Azure

const AZURE_URL = 'https://prices.azure.com/api/retail/prices';
const AZURE_MAX_PAGES = 4;

/** Spot, non-Windows retail prices from a list of Azure price items. */
export function azureSpotPrices(items: unknown): number[] {
  if (!Array.isArray(items)) return [];
  const out: number[] = [];
  for (const it of items) {
    if (!isRecord(it)) continue;
    const sku = typeof it.skuName === 'string' ? it.skuName : '';
    const product = typeof it.productName === 'string' ? it.productName : '';
    const price = num(it.retailPrice);
    if (!sku.includes('Spot') || product.includes('Windows') || price === null || price <= 0) continue;
    out.push(price);
  }
  return out;
}

async function azureRegionSkuPrice(fetchImpl: FetchImpl, region: string, sku: string): Promise<number | null> {
  const filter =
    `serviceName eq 'Virtual Machines' and priceType eq 'Consumption' ` +
    `and armRegionName eq '${region}' and armSkuName eq '${sku}'`;
  let url: string | null = `${AZURE_URL}?$filter=${encodeURIComponent(filter)}`;
  const prices: number[] = [];
  for (let page = 0; page < AZURE_MAX_PAGES && url; page++) {
    const body = await fetchJson(fetchImpl, url);
    if (!isRecord(body)) break;
    prices.push(...azureSpotPrices(body.Items));
    url = typeof body.NextPageLink === 'string' && body.NextPageLink ? body.NextPageLink : null;
  }
  return prices.length ? median(prices) : null;
}

export function fetchCloudGpuSpot(fetchImpl: FetchImpl): Promise<ComponentReading> {
  return guarded('cloud_gpu_spot', async () => {
    const skuMedians: Array<{ value: number; weight: number }> = [];
    const detail: ComponentDetail = {};
    const errors: string[] = [];
    for (const sku of AZURE_SKUS) {
      const settled = await Promise.allSettled(AZURE_REGIONS.map((r) => azureRegionSkuPrice(fetchImpl, r, sku)));
      const prices: number[] = [];
      for (const s of settled) {
        if (s.status === 'fulfilled' && s.value !== null) prices.push(s.value);
        else if (s.status === 'rejected') errors.push(errMsg(s.reason));
      }
      if (prices.length === 0) continue;
      const med = median(prices);
      detail[`${sku} median`] = Number(med.toFixed(4));
      detail[`${sku} regions`] = prices.length;
      skuMedians.push({ value: med, weight: 1 });
    }
    if (skuMedians.length === 0) return down('cloud_gpu_spot', errors[0] ?? 'no Azure spot prices found');
    return ok('cloud_gpu_spot', weightedGeoMean(skuMedians), detail);
  });
}

// ------------------------------------------------------------- OpenRouter

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/models';
export const MIN_MODELS = 4;

/** Blended $/1M tokens: 3:1 prompt:completion weighting. */
export function blendedPerMillion(prompt: number, completion: number): number {
  return ((3 * prompt + completion) / 4) * 1e6;
}

export function openRouterBlended(data: unknown, basket: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  if (!Array.isArray(data)) return out;
  for (const m of data) {
    if (!isRecord(m) || typeof m.id !== 'string' || !basket.includes(m.id) || !isRecord(m.pricing)) continue;
    const p = num(m.pricing.prompt);
    const c = num(m.pricing.completion);
    if (p === null || c === null) continue;
    const b = blendedPerMillion(p, c);
    if (b > 0) out[m.id] = b;
  }
  return out;
}

export function fetchAiInference(fetchImpl: FetchImpl, basket: readonly string[] = MODEL_BASKET): Promise<ComponentReading> {
  return guarded('ai_inference', async () => {
    const body = await fetchJson(fetchImpl, OPENROUTER_URL);
    const blended = openRouterBlended(isRecord(body) ? body.data : undefined, basket);
    const ids = Object.keys(blended);
    if (ids.length < MIN_MODELS) return down('ai_inference', `only ${ids.length}/${basket.length} basket models present`);
    const detail: ComponentDetail = { modelsPresent: ids.length, modelsTotal: basket.length };
    for (const id of ids) detail[id] = Number((blended[id] as number).toFixed(4));
    return ok('ai_inference', weightedGeoMean(ids.map((id) => ({ value: blended[id] as number, weight: 1 }))), detail);
  });
}

// ------------------------------------------------------------- Hashprice

const BLOCKCHAIN_STATS_URL = 'https://api.blockchain.info/stats';
const COINGECKO_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd';

/**
 * Hashprice in $/TH/day = subsidy * blocks/day * btcUsd / network TH/s.
 * Block subsidy only (3.125 BTC, no fees); 144 blocks/day is the
 * difficulty-adjusted expectation (10 min target), not the realised count.
 */
export function hashprice(btcUsd: number, hashrateTH: number): number {
  return (3.125 * 144 * btcUsd) / hashrateTH;
}

export function fetchBtcHashprice(fetchImpl: FetchImpl): Promise<ComponentReading> {
  return guarded('btc_hashprice', async () => {
    const stats = await fetchJson(fetchImpl, BLOCKCHAIN_STATS_URL);
    const ghs = isRecord(stats) ? num(stats.hash_rate) : null;
    if (ghs === null || ghs <= 0) throw new Error('blockchain.info: missing hash_rate');
    const hashrateTH = ghs / 1000;

    let btcUsd: number | null = null;
    let priceSource = 'coingecko';
    try {
      const cg = await fetchJson(fetchImpl, COINGECKO_URL);
      const btc = isRecord(cg) ? cg.bitcoin : undefined;
      btcUsd = isRecord(btc) ? num(btc.usd) : null;
    } catch {
      btcUsd = null;
    }
    if (btcUsd === null || btcUsd <= 0) {
      btcUsd = isRecord(stats) ? num(stats.market_price_usd) : null;
      priceSource = 'blockchain.info';
    }
    if (btcUsd === null || btcUsd <= 0) throw new Error('no BTC/USD price available');
    return ok('btc_hashprice', hashprice(btcUsd, hashrateTH), {
      btcUsd,
      hashrateTH: Number(hashrateTH.toFixed(0)),
      priceSource,
    });
  });
}

// ------------------------------------------------------------- Blockspace

export type EgsiScoreSource = () => Promise<number | null>;

/** EGSI score source reading {aiBaseUrl}/egsi/current. */
export function egsiScoreFromUrl(aiBaseUrl: string, fetchImpl: FetchImpl): EgsiScoreSource {
  return async () => {
    const body = await fetchJson(fetchImpl, `${aiBaseUrl.replace(/\/$/, '')}/egsi/current`);
    return isRecord(body) ? num(body.score) : null;
  };
}

export function fetchBlockspace(getScore: EgsiScoreSource): Promise<ComponentReading> {
  return guarded('blockspace', async () => {
    const score = await getScore();
    if (score === null) return down('blockspace', 'EGSI unavailable');
    return ok('blockspace', Math.max(1, score), { rawScore: score });
  });
}

// -------------------------------------------------------------------- All

export interface FetchAllOptions {
  fetchImpl: FetchImpl;
  getEgsiScore: EgsiScoreSource;
}

export async function fetchAllComponents(opts: FetchAllOptions): Promise<ComponentReading[]> {
  const ids: ComponentId[] = ['gpu_marketplace', 'cloud_gpu_spot', 'ai_inference', 'btc_hashprice', 'blockspace'];
  const settled = await Promise.allSettled([
    fetchGpuMarketplace(opts.fetchImpl),
    fetchCloudGpuSpot(opts.fetchImpl),
    fetchAiInference(opts.fetchImpl),
    fetchBtcHashprice(opts.fetchImpl),
    fetchBlockspace(opts.getEgsiScore),
  ]);
  return settled.map((s, i) => (s.status === 'fulfilled' ? s.value : down(ids[i] as ComponentId, errMsg(s.reason))));
}

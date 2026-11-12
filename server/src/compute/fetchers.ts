/**
 * Quote fetchers for the Silica Compute Index v2.0. Every fetcher takes an
 * injectable `fetchImpl` (tests never touch the network), never throws
 * (failures become missing quotes plus an error string), and uses timeouts
 * with one retry on network error (see http.ts).
 */
import {
  AWS_US_REGIONS,
  AZURE_REGIONS,
  CLOUD_CPU_SPECS,
  CLOUD_GPU_SPECS,
  GPU_PRODUCTS,
  GPU_VENUES,
  MODEL_BASKET,
  cloudQuoteKey,
  type CloudSpec,
  type GpuId,
} from './basket.js';
import type { BlockspaceReading } from './blockspace.js';
import { errMsg, fetchJson, fetchText, isRecord, num } from './http.js';
import { median, trim } from './stats.js';
import type { ComponentDetail, ComponentFetch, ComponentId, ExpectedQuote, FetchImpl, Quote } from './types.js';

function q(component: ComponentId, key: string, product: string, venue: string, price: number): Quote {
  return { key, component, product, venue, price };
}

// -------------------------------------------------------------- GPU rental

export const gpuKey = (product: GpuId, venue: string): string => `gpu/${product}/${venue}`;

const VAST_URL = 'https://console.vast.ai/api/v0/bundles/';
const RUNPOD_URL = 'https://api.runpod.io/graphql';
const AKASH_URL = 'https://console-api.akash.network/v1/gpu-prices';
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

/** RunPod: price = securePrice if > 0, else communityPrice. Keyed by gpuType id. */
export function runpodPrices(body: unknown): Map<string, number> {
  const out = new Map<string, number>();
  const data = isRecord(body) ? body.data : undefined;
  const types = isRecord(data) ? data.gpuTypes : undefined;
  if (!Array.isArray(types)) return out;
  for (const t of types) {
    if (!isRecord(t) || typeof t.id !== 'string') continue;
    const secure = num(t.securePrice);
    const community = num(t.communityPrice);
    const price = secure !== null && secure > 0 ? secure : community;
    if (price !== null && price > 0) out.set(t.id, price);
  }
  return out;
}

/** Akash: nvidia models with available > 0; median of price.weightedAverage across RAM variants. */
export function akashPrices(body: unknown): Map<string, number> {
  const out = new Map<string, number>();
  const models = isRecord(body) ? body.models : undefined;
  if (!Array.isArray(models)) return out;
  const byModel = new Map<string, number[]>();
  for (const m of models) {
    if (!isRecord(m) || m.vendor !== 'nvidia' || typeof m.model !== 'string') continue;
    const avail = isRecord(m.availability) ? num(m.availability.available) : null;
    const price = isRecord(m.price) ? num(m.price.weightedAverage) : null;
    if (avail === null || avail <= 0 || price === null || price <= 0) continue;
    const list = byModel.get(m.model) ?? [];
    list.push(price);
    byModel.set(m.model, list);
  }
  for (const [model, prices] of byModel) out.set(model, median(prices));
  return out;
}

export async function fetchGpuRental(fetchImpl: FetchImpl): Promise<ComponentFetch> {
  const expected: ExpectedQuote[] = GPU_PRODUCTS.flatMap((g) =>
    GPU_VENUES.map((v) => ({ key: gpuKey(g.id, v), product: g.id, venue: v })),
  );
  const quotes: Quote[] = [];
  const errors: string[] = [];
  const detail: ComponentDetail = {};

  const vast = async (): Promise<void> => {
    const results = await Promise.allSettled(
      GPU_PRODUCTS.map(async (g) => {
        const body = await fetchJson(fetchImpl, VAST_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            limit: 100,
            type: 'on-demand',
            verified: { eq: true },
            rentable: { eq: true },
            num_gpus: { gte: 1 },
            gpu_name: { eq: g.vastName },
          }),
        });
        return vastPerGpuPrices(isRecord(body) ? body.offers : undefined);
      }),
    );
    results.forEach((r, i) => {
      const g = GPU_PRODUCTS[i];
      if (!g) return;
      if (r.status === 'rejected') {
        errors.push(`vast ${g.id}: ${errMsg(r.reason)}`);
        return;
      }
      detail[`vast ${g.id} offers`] = r.value.length;
      if (r.value.length < MIN_VAST_OFFERS) return;
      quotes.push(q('gpu_rental', gpuKey(g.id, 'vast'), g.id, 'vast', vastTrimmedMedian(r.value)));
    });
  };

  const runpod = async (): Promise<void> => {
    const prices = runpodPrices(
      await fetchJson(fetchImpl, RUNPOD_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: '{ gpuTypes { id displayName securePrice communityPrice } }' }),
      }),
    );
    for (const g of GPU_PRODUCTS) {
      const p = prices.get(g.runpodId);
      if (p !== undefined) quotes.push(q('gpu_rental', gpuKey(g.id, 'runpod'), g.id, 'runpod', p));
    }
  };

  const akash = async (): Promise<void> => {
    const prices = akashPrices(await fetchJson(fetchImpl, AKASH_URL));
    for (const g of GPU_PRODUCTS) {
      const p = prices.get(g.akashModel);
      if (p !== undefined) quotes.push(q('gpu_rental', gpuKey(g.id, 'akash'), g.id, 'akash', p));
    }
  };

  const settled = await Promise.allSettled([vast(), runpod(), akash()]);
  settled.forEach((s, i) => {
    if (s.status === 'rejected') errors.push(`${GPU_VENUES[i]}: ${errMsg(s.reason)}`);
  });
  quotes.sort((a, b) => a.key.localeCompare(b.key));
  return { id: 'gpu_rental', quotes, expected, errors, detail };
}

// -------------------------------------------------------------- AWS spot

const AWS_SPOT_URL = 'https://website.spot.ec2.aws.a2z.com/spot.js';
const AWS_TIMEOUT_MS = 30_000; // the JSONP file is ~7 MB

/**
 * Parses the spot.js JSONP payload. Returns, per wanted instance size, the
 * median Linux spot price ($/instance-hour) across US regions. "N/A*" and
 * other non-numeric prices are skipped.
 */
export function parseAwsSpot(text: string, wanted: readonly string[]): Map<string, number> {
  const start = text.indexOf('(');
  const end = text.lastIndexOf(')');
  if (start < 0 || end <= start) throw new Error('AWS spot.js: not JSONP');
  const parsed: unknown = JSON.parse(text.slice(start + 1, end));
  const config = isRecord(parsed) ? parsed.config : undefined;
  const regions = isRecord(config) ? config.regions : undefined;
  if (!Array.isArray(regions)) throw new Error('AWS spot.js: no regions');
  const perSize = new Map<string, number[]>();
  for (const r of regions) {
    if (!isRecord(r) || typeof r.region !== 'string' || !AWS_US_REGIONS.includes(r.region)) continue;
    if (!Array.isArray(r.instanceTypes)) continue;
    for (const t of r.instanceTypes) {
      if (!isRecord(t) || !Array.isArray(t.sizes)) continue;
      for (const s of t.sizes) {
        if (!isRecord(s) || typeof s.size !== 'string' || !wanted.includes(s.size)) continue;
        const cols = Array.isArray(s.valueColumns) ? s.valueColumns : [];
        const linux = cols.find((c) => isRecord(c) && c.name === 'linux');
        const usd = isRecord(linux) && isRecord(linux.prices) ? num(linux.prices.USD) : null;
        if (usd === null || usd <= 0) continue;
        const list = perSize.get(s.size) ?? [];
        list.push(usd);
        perSize.set(s.size, list);
      }
    }
  }
  const out = new Map<string, number>();
  for (const [size, prices] of perSize) out.set(size, median(prices));
  return out;
}

export type AwsSpotLoader = (wanted: readonly string[]) => Promise<Map<string, number>>;

/** Downloads spot.js once and shares it between the GPU and CPU components. */
export function createAwsSpotLoader(fetchImpl: FetchImpl): AwsSpotLoader {
  let text: Promise<string> | null = null;
  return async (wanted) => {
    text ??= fetchText(fetchImpl, AWS_SPOT_URL, undefined, AWS_TIMEOUT_MS);
    try {
      return parseAwsSpot(await text, wanted);
    } catch (e) {
      text = null; // do not cache a failure
      throw e;
    }
  };
}

// ------------------------------------------------------------ Azure spot

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

/** Median across regions of the Azure spot instance price, or null. Errors only if every region errored. */
async function azureSkuPrice(fetchImpl: FetchImpl, sku: string): Promise<number | null> {
  const settled = await Promise.allSettled(AZURE_REGIONS.map((r) => azureRegionSkuPrice(fetchImpl, r, sku)));
  const prices: number[] = [];
  let firstError: unknown = null;
  for (const s of settled) {
    if (s.status === 'fulfilled' && s.value !== null) prices.push(s.value);
    else if (s.status === 'rejected') firstError ??= s.reason;
  }
  if (prices.length) return median(prices);
  if (firstError !== null) throw firstError instanceof Error ? firstError : new Error(String(firstError));
  return null;
}

async function fetchCloud(
  id: 'cloud_gpu_spot' | 'cloud_cpu_spot',
  specs: readonly CloudSpec[],
  fetchImpl: FetchImpl,
  aws: AwsSpotLoader,
): Promise<ComponentFetch> {
  const kind = id === 'cloud_gpu_spot' ? 'cloud_gpu' : 'cloud_cpu';
  const expected: ExpectedQuote[] = specs.map((s) => ({ key: cloudQuoteKey(kind, s), product: s.product, venue: s.venue }));
  const quotes: Quote[] = [];
  const errors: string[] = [];
  const detail: ComponentDetail = {};

  const awsSpecs = specs.filter((s) => s.venue === 'aws');
  const awsTask = async (): Promise<void> => {
    if (awsSpecs.length === 0) return;
    const prices = await aws(awsSpecs.map((s) => s.sku));
    for (const s of awsSpecs) {
      const p = prices.get(s.sku);
      if (p !== undefined) quotes.push(q(id, cloudQuoteKey(kind, s), s.product, 'aws', p / s.units));
    }
  };
  const azureTask = async (spec: CloudSpec): Promise<void> => {
    const p = await azureSkuPrice(fetchImpl, spec.sku);
    if (p !== null) quotes.push(q(id, cloudQuoteKey(kind, spec), spec.product, 'azure', p / spec.units));
  };

  const tasks: Array<[string, Promise<void>]> = [['aws', awsTask()]];
  for (const s of specs.filter((x) => x.venue === 'azure')) tasks.push([`azure ${s.sku}`, azureTask(s)]);
  const settled = await Promise.allSettled(tasks.map(([, p]) => p));
  settled.forEach((s, i) => {
    if (s.status === 'rejected') errors.push(`${tasks[i]?.[0]}: ${errMsg(s.reason)}`);
  });
  quotes.sort((a, b) => a.key.localeCompare(b.key));
  return { id, quotes, expected, errors, detail };
}

export function fetchCloudGpuSpot(fetchImpl: FetchImpl, aws: AwsSpotLoader = createAwsSpotLoader(fetchImpl)): Promise<ComponentFetch> {
  return fetchCloud('cloud_gpu_spot', CLOUD_GPU_SPECS, fetchImpl, aws);
}

export function fetchCloudCpuSpot(fetchImpl: FetchImpl, aws: AwsSpotLoader = createAwsSpotLoader(fetchImpl)): Promise<ComponentFetch> {
  return fetchCloud('cloud_cpu_spot', CLOUD_CPU_SPECS, fetchImpl, aws);
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

export const aiKey = (modelId: string): string => `ai/${modelId}`;

export async function fetchAiInference(fetchImpl: FetchImpl, basket: readonly string[] = MODEL_BASKET): Promise<ComponentFetch> {
  const expected = basket.map((id) => ({ key: aiKey(id), product: id, venue: 'openrouter' }));
  try {
    const body = await fetchJson(fetchImpl, OPENROUTER_URL);
    const blended = openRouterBlended(isRecord(body) ? body.data : undefined, basket);
    const ids = Object.keys(blended);
    if (ids.length < MIN_MODELS) {
      return { id: 'ai_inference', quotes: [], expected, errors: [`only ${ids.length}/${basket.length} basket models present`] };
    }
    return {
      id: 'ai_inference',
      quotes: ids.map((id) => q('ai_inference', aiKey(id), id, 'openrouter', blended[id] as number)),
      expected,
      errors: [],
      detail: { modelsPresent: ids.length, modelsTotal: basket.length },
    };
  } catch (e) {
    return { id: 'ai_inference', quotes: [], expected, errors: [errMsg(e)] };
  }
}

// ------------------------------------------------------------- Hashprice

const BLOCKCHAIN_STATS_URL = 'https://api.blockchain.info/stats';
const COINGECKO_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd';
export const BTC_KEY = 'btc/hashprice';

/**
 * Hashprice in $/TH/day = subsidy * blocks/day * btcUsd / network TH/s.
 * Block subsidy only (3.125 BTC, no fees); 144 blocks/day is the
 * difficulty-adjusted expectation (10 min target), not the realised count.
 */
export function hashprice(btcUsd: number, hashrateTH: number): number {
  return (3.125 * 144 * btcUsd) / hashrateTH;
}

export async function fetchBtcHashprice(fetchImpl: FetchImpl): Promise<ComponentFetch> {
  const expected = [{ key: BTC_KEY, product: 'hashprice', venue: 'blockchain' }];
  try {
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
    return {
      id: 'btc_hashprice',
      quotes: [q('btc_hashprice', BTC_KEY, 'hashprice', 'blockchain', hashprice(btcUsd, hashrateTH))],
      expected,
      errors: [],
      detail: { btcUsd, hashrateTH: Number(hashrateTH.toFixed(0)), priceSource },
    };
  } catch (e) {
    return { id: 'btc_hashprice', quotes: [], expected, errors: [errMsg(e)] };
  }
}

// ------------------------------------------------------------- Blockspace

export const BLOCKSPACE_KEY = 'eth/blockspace';

export async function fetchBlockspace(source: () => Promise<BlockspaceReading>): Promise<ComponentFetch> {
  const expected = [{ key: BLOCKSPACE_KEY, product: 'basefee', venue: 'ethrpc' }];
  try {
    const r = await source();
    return {
      id: 'blockspace',
      quotes: [q('blockspace', BLOCKSPACE_KEY, 'basefee', 'ethrpc', r.value)],
      expected,
      errors: [],
      detail: {
        medianGwei: Number(r.medianGwei.toFixed(4)),
        ethUsd: Number(r.ethUsd.toFixed(2)),
        ethUsdSource: r.ethUsdSource,
        samples: r.samples,
      },
    };
  } catch (e) {
    return { id: 'blockspace', quotes: [], expected, errors: [errMsg(e)] };
  }
}

// -------------------------------------------------------------------- All

export interface FetchAllOptions {
  fetchImpl: FetchImpl;
  blockspace: () => Promise<BlockspaceReading>;
}

export async function fetchAllComponents(opts: FetchAllOptions): Promise<ComponentFetch[]> {
  const aws = createAwsSpotLoader(opts.fetchImpl);
  return Promise.all([
    fetchGpuRental(opts.fetchImpl),
    fetchCloudGpuSpot(opts.fetchImpl, aws),
    fetchCloudCpuSpot(opts.fetchImpl, aws),
    fetchAiInference(opts.fetchImpl),
    fetchBtcHashprice(opts.fetchImpl),
    fetchBlockspace(opts.blockspace),
  ]);
}

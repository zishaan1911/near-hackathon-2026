import { describe, expect, it } from 'vitest';
import { computeIndex } from '../src/compute/calc.js';
import {
  blendedPerMillion,
  egsiScoreFromUrl,
  fetchAiInference,
  fetchBlockspace,
  fetchBtcHashprice,
  fetchCloudGpuSpot,
  fetchGpuMarketplace,
  hashprice,
} from '../src/compute/fetchers.js';
import { median, trim, weightedGeoMean } from '../src/compute/stats.js';
import { COMPONENT_META, type ComponentId, type ComponentReading, type FetchImpl } from '../src/compute/types.js';

const BASE: Record<ComponentId, number> = {
  gpu_marketplace: 2,
  cloud_gpu_spot: 1,
  ai_inference: 1,
  btc_hashprice: 0.04,
  blockspace: 400,
};

function reading(id: ComponentId, value: number | null): ComponentReading {
  const m = COMPONENT_META.find((c) => c.id === id);
  if (!m) throw new Error('meta');
  return value === null
    ? { id, label: m.label, unit: m.unit, value: null, status: 'down', error: 'x', source: m.source }
    : { id, label: m.label, unit: m.unit, value, status: 'ok', source: m.source };
}

function allAt(mult: number, skip: ComponentId[] = []): ComponentReading[] {
  return (Object.keys(BASE) as ComponentId[]).map((id) => reading(id, skip.includes(id) ? null : BASE[id] * mult));
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('stats', () => {
  it('median / trim / geometric mean', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(trim([1, 2, 3, 4, 5, 6, 7, 8, 9, 100], 0.1)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    expect(weightedGeoMean([{ value: 4, weight: 1 }, { value: 9, weight: 1 }])).toBeCloseTo(6, 10);
  });
});

describe('computeIndex', () => {
  it('is 1000 when every value equals base', () => {
    const r = computeIndex(allAt(1), BASE);
    expect(r.level).toBe(1000);
    expect(r.degraded).toBe(false);
    expect(r.components.reduce((a, c) => a + c.effectiveWeight, 0)).toBeCloseTo(1, 6);
  });

  it('matches a hand-computed weighted geometric mean', () => {
    // relatives: 2, 1, 1, 1, 1 -> 1000 * 2^0.3 = 1231.14
    const r = computeIndex(
      [
        reading('gpu_marketplace', 4),
        reading('cloud_gpu_spot', 1),
        reading('ai_inference', 1),
        reading('btc_hashprice', 0.04),
        reading('blockspace', 400),
      ],
      BASE,
    );
    expect(r.level).toBeCloseTo(1231.14, 2);
    const gpu = r.components.find((c) => c.id === 'gpu_marketplace');
    expect(gpu?.relative).toBe(2);
    expect(gpu?.contributionPoints).toBeCloseTo((2 ** 0.3 - 1) * 1000, 1);
  });

  it('renormalises weights when a component is down', () => {
    // blockspace (0.1) down, others at 2x base -> 2x everywhere -> 2000, degraded
    const r = computeIndex(allAt(2, ['blockspace']), BASE);
    expect(r.degraded).toBe(true);
    expect(r.level).toBeCloseTo(2000, 2);
    const w = r.components.find((c) => c.id === 'gpu_marketplace')?.effectiveWeight;
    expect(w).toBeCloseTo(0.3 / 0.9, 4);
    expect(r.components.find((c) => c.id === 'blockspace')?.effectiveWeight).toBe(0);
  });

  it('returns null level with fewer than 3 OK components', () => {
    const r = computeIndex(allAt(1, ['blockspace', 'btc_hashprice', 'ai_inference']), BASE);
    expect(r.level).toBeNull();
    expect(r.degraded).toBe(true);
    expect(r.components.every((c) => c.contributionPoints === null)).toBe(true);
  });

  it('treats values outside [0.1, 10] of base as down', () => {
    const readings = allAt(1);
    readings[0] = reading('gpu_marketplace', BASE.gpu_marketplace * 11);
    const r = computeIndex(readings, BASE);
    const c = r.components.find((x) => x.id === 'gpu_marketplace');
    expect(c?.status).toBe('down');
    expect(c?.error).toBe('out of range vs base');
    expect(r.degraded).toBe(true);
    expect(r.level).toBeCloseTo(1000, 2);
  });
});

describe('fetchGpuMarketplace', () => {
  function offers(prices: number[], gpus = 1): unknown {
    return { offers: prices.map((p) => ({ dph_total: p * gpus, num_gpus: gpus })) };
  }

  it('divides by num_gpus, trims outliers and takes the median', async () => {
    const h100 = [2, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 100]; // outlier 100 trimmed (and 2 low)
    const fetchImpl: FetchImpl = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { gpu_name: { eq: string } };
      if (body.gpu_name.eq === 'H100 SXM') return json(offers(h100));
      if (body.gpu_name.eq === 'A100 SXM4') return json(offers([1, 1, 1, 1, 1, 1], 4)); // per GPU 1
      return json({ offers: [] }); // RTX 4090 skipped
    };
    const r = await fetchGpuMarketplace(fetchImpl);
    expect(r.status).toBe('ok');
    // H100 trimmed -> [2.1..2.8] median 2.45 ; A100 median 1 ; weights 0.5/0.3 renormalised
    const expected = Math.exp((0.5 / 0.8) * Math.log(2.45) + (0.3 / 0.8) * Math.log(1));
    expect(r.value).toBeCloseTo(expected, 8);
    expect(r.detail?.['H100 SXM median']).toBe(2.45);
  });

  it('is down when no GPU has >= 5 offers', async () => {
    const r = await fetchGpuMarketplace(async () => json(offers([1, 2, 3, 4])));
    expect(r.status).toBe('down');
    expect(r.value).toBeNull();
  });

  it('is down on HTTP errors', async () => {
    const r = await fetchGpuMarketplace(async () => json({}, 500));
    expect(r.status).toBe('down');
    expect(r.error).toContain('500');
  });

  it('retries once on network error', async () => {
    let calls = 0;
    const fetchImpl: FetchImpl = async () => {
      calls++;
      if (calls === 1) throw new TypeError('fetch failed');
      return json(offers([1, 1, 1, 1, 1]));
    };
    const r = await fetchGpuMarketplace(fetchImpl);
    expect(r.status).toBe('ok');
  });
});

describe('fetchCloudGpuSpot', () => {
  const item = (price: number, sku: string, product = 'Virtual Machines NCads Series'): unknown => ({
    retailPrice: price,
    skuName: sku,
    productName: product,
  });

  it('keeps Spot non-Windows items and takes the region median', async () => {
    const perRegion: Record<string, number> = { eastus: 0.6, eastus2: 0.7, westus2: 0.8, southcentralus: 0.9 };
    const fetchImpl: FetchImpl = async (url) => {
      const decoded = decodeURIComponent(url);
      const region = /armRegionName eq '([^']+)'/.exec(decoded)?.[1] ?? '';
      const sku = /armSkuName eq '([^']+)'/.exec(decoded)?.[1] ?? '';
      if (sku.includes('H100')) return json({ Items: [] }); // H100 absent everywhere
      const p = perRegion[region] ?? 0;
      return json({
        Items: [
          item(p, 'NC24ads A100 v4 Spot'),
          item(p * 10, 'NC24ads A100 v4 Spot', 'Virtual Machines NCads Series Windows'),
          item(p * 5, 'NC24ads A100 v4'),
          item(p * 3, 'NC24ads A100 v4 Low Priority'),
        ],
      });
    };
    const r = await fetchCloudGpuSpot(fetchImpl);
    expect(r.status).toBe('ok');
    expect(r.value).toBeCloseTo(0.75, 10); // median of 0.6..0.9
    expect(r.detail?.['Standard_NC24ads_A100_v4 regions']).toBe(4);
  });

  it('follows NextPageLink and geo-means the two SKUs', async () => {
    const urls: string[] = [];
    const fetchImpl: FetchImpl = async (url) => {
      urls.push(url);
      if (url.startsWith('https://next.example/')) return json({ Items: [item(2, 'NC40adsH100v5 Spot')] });
      if (decodeURIComponent(url).includes('H100')) {
        return json({ Items: [], NextPageLink: 'https://next.example/p2' });
      }
      return json({ Items: [item(0.5, 'NC24ads A100 v4 Spot')] });
    };
    const r = await fetchCloudGpuSpot(fetchImpl);
    expect(urls.some((u) => u.startsWith('https://next.example/'))).toBe(true);
    expect(r.value).toBeCloseTo(Math.sqrt(0.5 * 2), 10);
  });

  it('is down when nothing is found', async () => {
    const r = await fetchCloudGpuSpot(async () => json({ Items: [] }));
    expect(r.status).toBe('down');
  });
});

describe('fetchAiInference', () => {
  const basket = ['a/one', 'b/two', 'c/three', 'd/four', 'e/five'];
  const model = (id: string, p: string, c: string): unknown => ({ id, pricing: { prompt: p, completion: c } });

  it('blends 3:1 and geo-means present models', async () => {
    expect(blendedPerMillion(0.000001, 0.000005)).toBeCloseTo(2, 10);
    const data = [
      model('a/one', '0.000001', '0.000005'), // 2
      model('b/two', '0.000002', '0.000010'), // 4
      model('c/three', '0.000004', '0.000004'), // 4
      model('d/four', '0.000001', '0.000001'), // 1
      model('x/other', '9', '9'),
      model('e/five', 'bad', 'bad'), // unparsable -> missing
    ];
    const r = await fetchAiInference(async () => json({ data }), basket);
    expect(r.status).toBe('ok');
    expect(r.value).toBeCloseTo(Math.pow(2 * 4 * 4 * 1, 1 / 4), 8);
    expect(r.detail?.modelsPresent).toBe(4);
  });

  it('is down with fewer than 4 basket models', async () => {
    const data = [model('a/one', '0.000001', '0.000001'), model('b/two', '0.000001', '0.000001')];
    const r = await fetchAiInference(async () => json({ data }), basket);
    expect(r.status).toBe('down');
  });
});

describe('fetchBtcHashprice', () => {
  const stats = { hash_rate: 9.3666e11, market_price_usd: 70000 };

  it('computes ~0.0365 $/TH/day', async () => {
    expect(hashprice(75900, 9.3666e8)).toBeCloseTo(0.03646, 4);
    const fetchImpl: FetchImpl = async (url) =>
      url.includes('blockchain.info') ? json(stats) : json({ bitcoin: { usd: 75900 } });
    const r = await fetchBtcHashprice(fetchImpl);
    expect(r.status).toBe('ok');
    expect(r.value).toBeCloseTo(0.0365, 3);
    expect(r.detail?.priceSource).toBe('coingecko');
  });

  it('falls back to blockchain.info price when CoinGecko fails', async () => {
    const fetchImpl: FetchImpl = async (url) => (url.includes('blockchain.info') ? json(stats) : json({}, 429));
    const r = await fetchBtcHashprice(fetchImpl);
    expect(r.status).toBe('ok');
    expect(r.value).toBeCloseTo(hashprice(70000, 9.3666e8), 10);
    expect(r.detail?.priceSource).toBe('blockchain.info');
  });

  it('is down when stats are unavailable', async () => {
    const r = await fetchBtcHashprice(async () => json({}, 500));
    expect(r.status).toBe('down');
  });
});

describe('fetchBlockspace', () => {
  it('floors the score at 1', async () => {
    const r = await fetchBlockspace(async () => 0);
    expect(r.value).toBe(1);
    expect(r.status).toBe('ok');
  });

  it('is down when the source returns null or throws', async () => {
    expect((await fetchBlockspace(async () => null)).status).toBe('down');
    const t = await fetchBlockspace(async () => {
      throw new Error('boom');
    });
    expect(t.status).toBe('down');
    expect(t.error).toBe('boom');
  });

  it('reads {aiBaseUrl}/egsi/current', async () => {
    let seen = '';
    const src = egsiScoreFromUrl('http://ai:8000/', async (url) => {
      seen = url;
      return json({ score: 441 });
    });
    expect(await src()).toBe(441);
    expect(seen).toBe('http://ai:8000/egsi/current');
  });
});

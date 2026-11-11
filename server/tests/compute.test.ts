import { describe, expect, it } from 'vitest';
import { computeIndex } from '../src/compute/calc.js';
import {
  akashPrices,
  blendedPerMillion,
  fetchAiInference,
  fetchBlockspace,
  fetchBtcHashprice,
  fetchCloudCpuSpot,
  fetchCloudGpuSpot,
  fetchGpuRental,
  hashprice,
  parseAwsSpot,
  runpodPrices,
} from '../src/compute/fetchers.js';
import { median, trim, weightedGeoMean } from '../src/compute/stats.js';
import {
  COMPONENT_META,
  type ComponentFetch,
  type ComponentId,
  type FetchImpl,
  type Quote,
} from '../src/compute/types.js';
import { awsJsonp, healthyFetch, json } from './computeFixtures.js';

// ---- helpers: components whose quotes all have base price 1 ------------------

type Spec = [key: string, product: string, venue: string, price: number];

function comp(id: ComponentId, specs: Spec[]): ComponentFetch {
  const quotes: Quote[] = specs.map(([key, product, venue, price]) => ({ key, component: id, product, venue, price }));
  return { id, quotes, expected: specs.map(([key, product, venue]) => ({ key, product, venue })), errors: [] };
}

const SPECS: Record<ComponentId, Spec[]> = {
  gpu_rental: [
    ['gpu/h100/vast', 'h100', 'vast', 1],
    ['gpu/h100/runpod', 'h100', 'runpod', 1],
    ['gpu/a100/vast', 'a100', 'vast', 1],
  ],
  cloud_gpu_spot: [['cloud_gpu/a100/aws-p4d.24xlarge', 'a100', 'aws', 1]],
  cloud_cpu_spot: [['cloud_cpu/general_x86/aws-m7i.xlarge', 'general_x86', 'aws', 1]],
  ai_inference: [
    ['ai/a', 'a', 'openrouter', 1],
    ['ai/b', 'b', 'openrouter', 1],
  ],
  btc_hashprice: [['btc/hashprice', 'hashprice', 'blockchain', 1]],
  blockspace: [['eth/blockspace', 'basefee', 'ethrpc', 1]],
};

const BASE_Q: Record<string, number> = {};
for (const specs of Object.values(SPECS)) for (const [key] of specs) BASE_Q[key] = 1;
const BASE_V = Object.fromEntries(COMPONENT_META.map((m) => [m.id, 1])) as Record<ComponentId, number>;

/** All components at `mult` x base; `drop` removes components, `edit` rewrites a component's specs. */
function world(mult = 1, drop: ComponentId[] = [], edit: Partial<Record<ComponentId, Spec[]>> = {}): ComponentFetch[] {
  return COMPONENT_META.map((m) => {
    if (drop.includes(m.id)) return { ...comp(m.id, SPECS[m.id]), quotes: [], errors: ['down'] };
    const specs = edit[m.id] ?? SPECS[m.id].map(([k, p, v, price]): Spec => [k, p, v, price * mult]);
    return comp(m.id, specs);
  });
}

describe('stats', () => {
  it('median / trim / geometric mean', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(trim([1, 2, 3, 4, 5, 6, 7, 8, 9, 100], 0.1)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    expect(weightedGeoMean([{ value: 4, weight: 1 }, { value: 9, weight: 1 }])).toBeCloseTo(6, 10);
  });
});

describe('computeIndex (matched-quote maths)', () => {
  it('is 1000 when every quote equals its base', () => {
    const r = computeIndex(world(1), BASE_Q, BASE_V);
    expect(r.level).toBe(1000);
    expect(r.degraded).toBe(false);
    expect(r.components.reduce((a, c) => a + c.effectiveWeight, 0)).toBeCloseTo(1, 6);
    expect(r.components.every((c) => c.level === 1000)).toBe(true);
  });

  it('matches a hand-computed weighted geometric mean', () => {
    // gpu_rental: h100 relative 2 (both venues), a100 relative 1 -> 2^(0.5/0.8) ; level = 1000 * (2^(0.5/0.8))^0.35
    const r = computeIndex(
      world(1, [], {
        gpu_rental: [
          ['gpu/h100/vast', 'h100', 'vast', 2],
          ['gpu/h100/runpod', 'h100', 'runpod', 2],
          ['gpu/a100/vast', 'a100', 'vast', 1],
        ],
      }),
      BASE_Q,
      BASE_V,
    );
    const gpuRel = 2 ** (0.5 / 0.8);
    const gpu = r.components.find((c) => c.id === 'gpu_rental');
    expect(gpu?.relative).toBeCloseTo(gpuRel, 4);
    expect(r.level).toBeCloseTo(1000 * gpuRel ** 0.35, 1);
    expect(gpu?.contributionPoints).toBeCloseTo((gpuRel ** 0.35 - 1) * 1000, 1);
  });

  it('a venue dropping out does not move the level when the remaining venues are flat', () => {
    // Everything else at 2x so the level is not trivially 1000.
    const others = world(2);
    const full = others.map((c) =>
      c.id === 'gpu_rental' ? comp('gpu_rental', SPECS.gpu_rental) : c,
    );
    const noRunpod = others.map((c) =>
      c.id === 'gpu_rental'
        ? comp(
            'gpu_rental',
            SPECS.gpu_rental.filter(([, , v]) => v !== 'runpod'),
          )
        : c,
    );
    const a = computeIndex(full, BASE_Q, BASE_V).level;
    const b = computeIndex(noRunpod, BASE_Q, BASE_V).level;
    expect(a).not.toBeNull();
    expect(b).toBe(a);
  });

  it('relatives are per quote, so a cheap venue dropping out does not drop the price level', () => {
    // runpod is structurally 4x cheaper than vast. Both at their own base -> relative 1 either way.
    const base = { ...BASE_Q, 'gpu/h100/vast': 4, 'gpu/h100/runpod': 1 };
    const both: Spec[] = [['gpu/h100/vast', 'h100', 'vast', 4], ['gpu/h100/runpod', 'h100', 'runpod', 1]];
    const onlyVast: Spec[] = [['gpu/h100/vast', 'h100', 'vast', 4]];
    const lvl = (s: Spec[]) => computeIndex(world(1, [], { gpu_rental: s }), base, BASE_V).level;
    expect(lvl(both)).toBe(1000);
    expect(lvl(onlyVast)).toBe(1000);
  });

  it('renormalises weights when a component is down', () => {
    // blockspace (0.05) down, others at 2x -> 2000, degraded
    const r = computeIndex(world(2, ['blockspace']), BASE_Q, BASE_V);
    expect(r.degraded).toBe(true);
    expect(r.level).toBeCloseTo(2000, 2);
    expect(r.components.find((c) => c.id === 'gpu_rental')?.effectiveWeight).toBeCloseTo(0.35 / 0.95, 4);
    expect(r.components.find((c) => c.id === 'blockspace')?.effectiveWeight).toBe(0);
    expect(r.components.find((c) => c.id === 'blockspace')?.status).toBe('down');
  });

  it('returns null level with fewer than 4 of 6 components', () => {
    const r3 = computeIndex(world(1, ['blockspace', 'btc_hashprice', 'ai_inference']), BASE_Q, BASE_V);
    expect(r3.level).toBeNull();
    expect(r3.degraded).toBe(true);
    expect(r3.components.every((c) => c.contributionPoints === null)).toBe(true);
    const r4 = computeIndex(world(1, ['blockspace', 'btc_hashprice']), BASE_Q, BASE_V);
    expect(r4.level).toBe(1000);
  });

  it('drops a quote whose relative is outside [0.2, 5] and reports it', () => {
    const r = computeIndex(
      world(1, [], {
        gpu_rental: [
          ['gpu/h100/vast', 'h100', 'vast', 1],
          ['gpu/h100/runpod', 'h100', 'runpod', 5.5], // out of band
          ['gpu/a100/vast', 'a100', 'vast', 0.19], // out of band (low)
        ],
      }),
      BASE_Q,
      BASE_V,
    );
    expect(r.discarded.map((d) => d.key).sort()).toEqual(['gpu/a100/vast', 'gpu/h100/runpod']);
    const gpu = r.components.find((c) => c.id === 'gpu_rental');
    expect(gpu?.quotes).toEqual({ ok: 1, total: 3 });
    expect(gpu?.relative).toBe(1);
    expect(String(gpu?.detail?.discarded)).toContain('gpu/h100/runpod');
    expect(r.level).toBe(1000);
  });

  it('keeps quotes exactly at the band edges and discards quotes with no base', () => {
    const edge = computeIndex(world(1, [], { blockspace: [['eth/blockspace', 'basefee', 'ethrpc', 5]] }), BASE_Q, BASE_V);
    expect(edge.components.find((c) => c.id === 'blockspace')?.status).toBe('ok');
    const nobase = computeIndex(world(1), { ...BASE_Q, 'eth/blockspace': 0 }, BASE_V);
    expect(nobase.components.find((c) => c.id === 'blockspace')?.status).toBe('down');
  });

  it('builds the per-GPU view', () => {
    const r = computeIndex(
      world(1, [], {
        gpu_rental: [
          ['gpu/h100/vast', 'h100', 'vast', 1.2],
          ['gpu/h100/runpod', 'h100', 'runpod', 0.8],
          ['gpu/a100/vast', 'a100', 'vast', 1],
        ],
      }),
      BASE_Q,
      BASE_V,
    );
    const h100 = r.gpus.find((g) => g.id === 'h100');
    expect(h100?.cheapest).toEqual({ venue: 'runpod', price: 0.8 });
    expect(h100?.medianPrice).toBeCloseTo(1, 10);
    expect(h100?.spreadPct).toBe(50);
    expect(h100?.level).toBeCloseTo(1000 * Math.sqrt(1.2 * 0.8), 1);
    expect(h100?.venues).toEqual([
      { venue: 'vast', price: 1.2, status: 'ok' },
      { venue: 'runpod', price: 0.8, status: 'ok' },
      { venue: 'akash', price: null, status: 'down' },
    ]);
    const rtx = r.gpus.find((g) => g.id === 'rtx4090');
    expect(rtx).toMatchObject({ level: null, medianPrice: null, cheapest: null, spreadPct: null });
    expect(rtx?.venues.every((v) => v.status === 'down')).toBe(true);
  });
});

describe('parsers', () => {
  it('RunPod: secure price if > 0, else community', () => {
    const m = runpodPrices({
      data: {
        gpuTypes: [
          { id: 'NVIDIA A100-SXM4-80GB', securePrice: 1.79, communityPrice: 1.39 },
          { id: 'NVIDIA A100-SXM4-40GB', securePrice: 0, communityPrice: 1 },
          { id: 'broken', securePrice: null, communityPrice: null },
        ],
      },
    });
    expect(m.get('NVIDIA A100-SXM4-80GB')).toBe(1.79);
    expect(m.get('NVIDIA A100-SXM4-40GB')).toBe(1);
    expect(m.has('broken')).toBe(false);
    expect(runpodPrices({ nope: true }).size).toBe(0);
  });

  it('Akash: ignores available:0 and takes the median across RAM variants', () => {
    const entry = (model: string, price: number, available: number, vendor = 'nvidia') => ({
      vendor,
      model,
      availability: { total: 5, available },
      price: { weightedAverage: price },
    });
    const m = akashPrices({
      models: [
        entry('a100', 0.84, 0), // unavailable 40Gi
        entry('a100', 1.0, 3),
        entry('a100', 2.0, 2),
        entry('a100', 4.0, 1),
        entry('h100', 2.73, 13),
        entry('rtx4090', 0.36, 0),
        entry('mi300', 1.5, 4, 'amd'),
      ],
    });
    expect(m.get('a100')).toBe(2);
    expect(m.get('h100')).toBe(2.73);
    expect(m.has('rtx4090')).toBe(false);
    expect(m.has('mi300')).toBe(false);
  });

  it('AWS spot.js: strips JSONP, skips N/A*, uses US regions only, medians across regions', () => {
    const text = awsJsonp({
      'us-east-1': { 'g5.xlarge': '0.40', 'p5.48xlarge': 'N/A*' },
      'us-west-2': { 'g5.xlarge': '0.60', 'p5.48xlarge': '24.0' },
      'eu-west-1': { 'g5.xlarge': '9.99' },
    });
    const m = parseAwsSpot(text, ['g5.xlarge', 'p5.48xlarge', 'g6.xlarge']);
    expect(m.get('g5.xlarge')).toBeCloseTo(0.5, 10);
    expect(m.get('p5.48xlarge')).toBe(24);
    expect(m.has('g6.xlarge')).toBe(false);
    expect(() => parseAwsSpot('not jsonp', ['x'])).toThrow();
  });
});

describe('fetchGpuRental', () => {
  it('produces one quote per venue per product', async () => {
    const r = await fetchGpuRental(healthyFetch());
    expect(r.quotes.map((x) => x.key)).toEqual([
      'gpu/a100/akash',
      'gpu/a100/runpod',
      'gpu/a100/vast',
      'gpu/h100/akash',
      'gpu/h100/runpod',
      'gpu/h100/vast',
      'gpu/rtx4090/akash',
      'gpu/rtx4090/runpod',
      'gpu/rtx4090/vast',
    ]);
    expect(r.expected).toHaveLength(9);
    expect(r.quotes.find((x) => x.key === 'gpu/h100/runpod')?.price).toBe(3.99);
    expect(r.quotes.find((x) => x.key === 'gpu/h100/vast')?.price).toBeCloseTo(2.2, 10);
  });

  it('survives one venue being down and reports it', async () => {
    const r = await fetchGpuRental(healthyFetch({ down: ['runpod.io'] }));
    expect(r.quotes).toHaveLength(6);
    expect(r.quotes.some((x) => x.venue === 'runpod')).toBe(false);
    expect(r.errors.join(' ')).toContain('runpod');
  });

  it('needs at least 5 Vast offers per GPU', async () => {
    const fetchImpl: FetchImpl = async (url, init) =>
      url.includes('vast.ai') ? json({ offers: [1, 2, 3, 4].map((p) => ({ dph_total: p, num_gpus: 1 })) }) : healthyFetch()(url, init);
    const r = await fetchGpuRental(fetchImpl);
    expect(r.quotes.some((x) => x.venue === 'vast')).toBe(false);
    expect(r.quotes.some((x) => x.venue === 'runpod')).toBe(true);
  });
});

describe('cloud spot fetchers', () => {
  it('GPU: per-GPU AWS price (p5 / 8) and Azure per-SKU quotes', async () => {
    const r = await fetchCloudGpuSpot(healthyFetch());
    const price = (k: string) => r.quotes.find((x) => x.key === k)?.price;
    expect(price('cloud_gpu/h100/aws-p5.48xlarge')).toBeCloseTo(3, 10);
    expect(price('cloud_gpu/a100/aws-p4d.24xlarge')).toBeCloseTo(1.2, 10);
    expect(price('cloud_gpu/a10g/aws-g5.xlarge')).toBeCloseTo(0.4, 10);
    expect(price('cloud_gpu/h100/azure-standard_nc40ads_h100_v5')).toBe(4);
    expect(r.quotes).toHaveLength(6);
  });

  it('CPU: $/vCPU-hour', async () => {
    const r = await fetchCloudCpuSpot(healthyFetch());
    expect(r.quotes.find((x) => x.key === 'cloud_cpu/general_x86/aws-m7i.xlarge')?.price).toBeCloseTo(0.02, 10);
    expect(r.quotes.find((x) => x.key === 'cloud_cpu/general_x86/azure-standard_d4s_v5')?.price).toBeCloseTo(0.01, 10);
    expect(r.quotes).toHaveLength(5);
  });

  it('downloads spot.js once for both components and survives AWS being down', async () => {
    const counter = { n: 0 };
    const f = healthyFetch({ counter });
    let awsCalls = 0;
    const fetchImpl: FetchImpl = async (url, init) => {
      if (url.includes('spot.ec2.aws')) awsCalls++;
      return f(url, init);
    };
    const { fetchAllComponents } = await import('../src/compute/fetchers.js');
    await fetchAllComponents({
      fetchImpl,
      blockspace: async () => ({ value: 1, medianGwei: 1, ethUsd: 1, ethUsdSource: 'x', samples: 1 }),
    });
    expect(awsCalls).toBe(1);
    const down = await fetchCloudGpuSpot(healthyFetch({ down: ['spot.ec2.aws'] }));
    expect(down.quotes.every((x) => x.venue === 'azure')).toBe(true);
    expect(down.errors.join(' ')).toContain('aws');
  });

  it('is empty (not a throw) when nothing is found', async () => {
    const r = await fetchCloudGpuSpot(async () => json({ Items: [] }, 500));
    expect(r.quotes).toEqual([]);
    expect(r.errors.length).toBeGreaterThan(0);
  });
});

describe('fetchAiInference', () => {
  const basket = ['a/one', 'b/two', 'c/three', 'd/four', 'e/five'];
  const model = (id: string, p: string, c: string): unknown => ({ id, pricing: { prompt: p, completion: c } });

  it('blends 3:1 and gives one quote per present model', async () => {
    expect(blendedPerMillion(0.000001, 0.000005)).toBeCloseTo(2, 10);
    const data = [
      model('a/one', '0.000001', '0.000005'),
      model('b/two', '0.000002', '0.000010'),
      model('c/three', '0.000004', '0.000004'),
      model('d/four', '0.000001', '0.000001'),
      model('x/other', '9', '9'),
      model('e/five', 'bad', 'bad'),
    ];
    const r = await fetchAiInference(async () => json({ data }), basket);
    expect(r.quotes.map((x) => [x.key, x.price])).toEqual([
      ['ai/a/one', expect.closeTo(2, 8)],
      ['ai/b/two', expect.closeTo(4, 8)],
      ['ai/c/three', expect.closeTo(4, 8)],
      ['ai/d/four', expect.closeTo(1, 8)],
    ]);
    expect(r.expected).toHaveLength(5);
  });

  it('has no quotes with fewer than 4 basket models', async () => {
    const data = [model('a/one', '0.000001', '0.000001'), model('b/two', '0.000001', '0.000001')];
    const r = await fetchAiInference(async () => json({ data }), basket);
    expect(r.quotes).toEqual([]);
    expect(r.errors[0]).toContain('2/5');
  });
});

describe('fetchBtcHashprice', () => {
  const stats = { hash_rate: 9.3666e11, market_price_usd: 70000 };

  it('computes ~0.0365 $/TH/day', async () => {
    expect(hashprice(75900, 9.3666e8)).toBeCloseTo(0.03646, 4);
    const fetchImpl: FetchImpl = async (url) =>
      url.includes('blockchain.info') ? json(stats) : json({ bitcoin: { usd: 75900 } });
    const r = await fetchBtcHashprice(fetchImpl);
    expect(r.quotes).toHaveLength(1);
    expect(r.quotes[0]?.price).toBeCloseTo(0.0365, 3);
    expect(r.detail?.priceSource).toBe('coingecko');
  });

  it('falls back to the blockchain.info price when CoinGecko fails', async () => {
    const fetchImpl: FetchImpl = async (url) => (url.includes('blockchain.info') ? json(stats) : json({}, 429));
    const r = await fetchBtcHashprice(fetchImpl);
    expect(r.quotes[0]?.price).toBeCloseTo(hashprice(70000, 9.3666e8), 10);
    expect(r.detail?.priceSource).toBe('blockchain.info');
  });

  it('has no quote when stats are unavailable', async () => {
    const r = await fetchBtcHashprice(async () => json({}, 500));
    expect(r.quotes).toEqual([]);
    expect(r.errors[0]).toContain('500');
  });
});

describe('fetchBlockspace', () => {
  it('wraps the sampler reading as one quote', async () => {
    const r = await fetchBlockspace(async () => ({ value: 0.02, medianGwei: 1, ethUsd: 20, ethUsdSource: 'coingecko', samples: 168 }));
    expect(r.quotes[0]).toMatchObject({ key: 'eth/blockspace', price: 0.02 });
    expect(r.detail?.samples).toBe(168);
  });

  it('has no quote when the sampler throws', async () => {
    const r = await fetchBlockspace(async () => {
      throw new Error('boom');
    });
    expect(r.quotes).toEqual([]);
    expect(r.errors).toEqual(['boom']);
  });
});

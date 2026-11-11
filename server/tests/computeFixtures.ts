/** Hand-made upstream fixtures for the CCI tests. No network. */
import { MODEL_BASKET } from '../src/compute/basket.js';
import type { FetchImpl } from '../src/compute/types.js';

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export function text(body: string, status = 200): Response {
  return new Response(body, { status });
}

export const hex = (n: number | bigint): string => '0x' + n.toString(16);

/** AWS spot.js JSONP with the given linux prices per region -> size. */
export function awsJsonp(regions: Record<string, Record<string, string>>): string {
  const cfg = {
    vers: 0.01,
    config: {
      rate: 'perhr',
      valueColumns: ['linux', 'mswin'],
      currencies: ['USD'],
      regions: Object.entries(regions).map(([region, sizes]) => ({
        region,
        footnotes: { '*': 'notAvailableForCCorCGPU' },
        instanceTypes: [
          {
            type: 'generalCurrentGen',
            sizes: Object.entries(sizes).map(([size, usd]) => ({
              size,
              valueColumns: [
                { name: 'linux', prices: { USD: usd } },
                { name: 'mswin', prices: { USD: 'N/A*' } },
              ],
            })),
          },
        ],
      })),
    },
  };
  return `callback(${JSON.stringify(cfg)});`;
}

export interface MockOptions {
  down?: string[]; // url substrings that return HTTP 503
  baseFeeGwei?: number;
  ethUsd?: number;
  counter?: { n: number };
}

/** A fetch that serves a coherent, healthy world. */
export function healthyFetch(opts: MockOptions = {}): FetchImpl {
  const gwei = opts.baseFeeGwei ?? 10;
  const eth = opts.ethUsd ?? 2000;
  return async (url, init) => {
    if (opts.counter) opts.counter.n++;
    if (opts.down?.some((d) => url.includes(d))) return json({}, 503);
    if (url.includes('vast.ai')) {
      const body = JSON.parse(String(init?.body)) as { gpu_name: { eq: string } };
      const p = body.gpu_name.eq === 'H100 SXM' ? 2.2 : body.gpu_name.eq === 'A100 SXM4' ? 1.2 : 0.4;
      return json({ offers: [1, 1, 1, 1, 1, 1].map(() => ({ dph_total: p, num_gpus: 1 })) });
    }
    if (url.includes('runpod.io')) {
      return json({
        data: {
          gpuTypes: [
            { id: 'NVIDIA H100 80GB HBM3', displayName: 'H100 SXM', securePrice: 3.99, communityPrice: 2.69 },
            { id: 'NVIDIA A100-SXM4-80GB', displayName: 'A100 SXM', securePrice: 1.79, communityPrice: 1.39 },
            { id: 'NVIDIA GeForce RTX 4090', displayName: 'RTX 4090', securePrice: 0.89, communityPrice: 0.34 },
          ],
        },
      });
    }
    if (url.includes('akash.network')) {
      const m = (model: string, p: number, available: number) => ({
        vendor: 'nvidia',
        model,
        ram: '80Gi',
        availability: { total: 10, available },
        price: { weightedAverage: p },
      });
      return json({ models: [m('h100', 2.73, 13), m('a100', 1.67, 32), m('rtx4090', 0.36, 2)] });
    }
    if (url.includes('spot.ec2.aws')) {
      return text(
        awsJsonp({
          'us-east-1': { 'g5.xlarge': '0.40', 'g6.xlarge': '0.30', 'p4d.24xlarge': '9.60', 'p5.48xlarge': '24.00', 'm7i.xlarge': '0.08', 'c7i.xlarge': '0.07', 'r7i.xlarge': '0.10', 'm7g.xlarge': '0.06' },
        }),
      );
    }
    if (url.includes('prices.azure.com')) {
      const sku = /armSkuName eq '([^']+)'/.exec(decodeURIComponent(url))?.[1] ?? '';
      const price = sku.includes('D4s') ? 0.04 : sku.includes('H100') ? 4 : 1;
      return json({ Items: [{ retailPrice: price, skuName: 'X Spot', productName: 'VM' }] });
    }
    if (url.includes('openrouter.ai')) {
      return json({
        data: MODEL_BASKET.map((id) => ({ id, pricing: { prompt: '0.000001', completion: '0.000001' } })),
      });
    }
    if (url.includes('api.blockchain.info/stats')) return json({ hash_rate: 9.3666e11, market_price_usd: 75900 });
    if (url.includes('charts/hash-rate')) {
      return json({ values: [{ x: Date.UTC(2026, 10, 9) / 1000, y: 9e8 }, { x: Date.UTC(2026, 10, 10) / 1000, y: 9.2e8 }] });
    }
    if (url.includes('charts/market-price')) {
      return json({ values: [{ x: Date.UTC(2026, 10, 9) / 1000, y: 70000 }, { x: Date.UTC(2026, 10, 10) / 1000, y: 71000 }] });
    }
    if (url.includes('coingecko')) {
      return json(url.includes('ids=ethereum') ? { ethereum: { usd: eth } } : { bitcoin: { usd: 75900 } });
    }
    if (url.includes('publicnode')) {
      const calls = JSON.parse(String(init?.body)) as Array<{ id: number; method: string; params: unknown[] }>;
      return json(
        calls.map((c) => {
          if (c.method === 'eth_blockNumber') return { id: c.id, result: hex(1_000_000) };
          if (c.method === 'eth_getBlockByNumber') {
            const b = Number(BigInt(String(c.params[0])));
            return { id: c.id, result: { baseFeePerGas: hex(BigInt(Math.round(gwei * 1e9))), timestamp: hex(1_700_000_000 + b * 12) } };
          }
          return { id: c.id, result: hex(BigInt(eth * 1e8)) };
        }),
      );
    }
    return json({}, 404);
  };
}

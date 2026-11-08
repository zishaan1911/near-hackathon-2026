import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { FetchImpl } from '../src/compute/types.js';
import { registerIndicesRoutes } from '../src/routes/indices.js';
import type { GatewayDeps } from '../src/server.js';
import { FakeAiClient, makeEgsiSnapshot } from './fakes.js';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function makeFetch(counter: { n: number }, opts: { vastDown?: boolean } = {}): FetchImpl {
  return async (url) => {
    counter.n++;
    if (url.includes('vast.ai')) {
      if (opts.vastDown) return json({}, 503);
      return json({ offers: [1, 1, 1, 1, 1].map((p) => ({ dph_total: p, num_gpus: 1 })) });
    }
    if (url.includes('prices.azure.com')) {
      return json({ Items: [{ retailPrice: 1, skuName: 'X Spot', productName: 'VM' }] });
    }
    if (url.includes('openrouter')) {
      const ids = [
        'openai/gpt-4o-mini',
        'anthropic/claude-haiku-4.5',
        'google/gemini-3.1-flash-lite',
        'meta-llama/llama-3.3-70b-instruct',
      ];
      return json({ data: ids.map((id) => ({ id, pricing: { prompt: '0.000001', completion: '0.000001' } })) });
    }
    if (url.includes('blockchain.info')) return json({ hash_rate: 9.3666e11, market_price_usd: 75900 });
    return json({ bitcoin: { usd: 75900 } });
  };
}

function build(fetchImpl: FetchImpl, clock: { t: number }, egsi = true) {
  const ai = new FakeAiClient();
  if (egsi) ai.currentEgsi = makeEgsiSnapshot({ score: 400 });
  const app = Fastify();
  registerIndicesRoutes(app, { aiClient: ai } as unknown as GatewayDeps, { fetchImpl, now: () => clock.t });
  return app;
}

describe('GET /api/v1/indices/compute', () => {
  it('returns the documented shape', async () => {
    const app = build(makeFetch({ n: 0 }), { t: Date.UTC(2026, 10, 8) });
    const res = await app.inject({ method: 'GET', url: '/api/v1/indices/compute' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.index).toMatchObject({
      id: 'CCI',
      name: 'Congest Compute Index',
      base: 1000,
      baseDate: '2026-11-08',
      asOf: '2026-11-08T00:00:00.000Z',
      methodologyVersion: '1.0',
      degraded: false,
    });
    expect(typeof body.index.level).toBe('number');
    expect(body.components).toHaveLength(5);
    for (const c of body.components) {
      expect(c).toHaveProperty('id');
      expect(c).toHaveProperty('nominalWeight');
      expect(c).toHaveProperty('effectiveWeight');
      expect(c).toHaveProperty('baseValue');
      expect(c).toHaveProperty('relative');
      expect(c).toHaveProperty('contributionPoints');
      expect(c.status).toBe('ok');
    }
  });

  it('caches for 60 seconds', async () => {
    const counter = { n: 0 };
    const clock = { t: 1_000_000 };
    const app = build(makeFetch(counter), clock);
    await app.inject({ method: 'GET', url: '/api/v1/indices/compute' });
    const after1 = counter.n;
    clock.t += 59_000;
    await app.inject({ method: 'GET', url: '/api/v1/indices/compute' });
    expect(counter.n).toBe(after1);
    clock.t += 2_000;
    await app.inject({ method: 'GET', url: '/api/v1/indices/compute' });
    expect(counter.n).toBeGreaterThan(after1);
  });

  it('reports partial failures per component and renormalises', async () => {
    const app = build(makeFetch({ n: 0 }, { vastDown: true }), { t: 1 }, false);
    const res = await app.inject({ method: 'GET', url: '/api/v1/indices/compute' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.index.degraded).toBe(true);
    const gpu = body.components.find((c: { id: string }) => c.id === 'gpu_marketplace');
    const space = body.components.find((c: { id: string }) => c.id === 'blockspace');
    expect(gpu.status).toBe('down');
    expect(gpu.error).toBeTruthy();
    expect(space.status).toBe('down');
    const sum = body.components.reduce((a: number, c: { effectiveWeight: number }) => a + c.effectiveWeight, 0);
    expect(sum).toBeCloseTo(1, 3);
  });

  it('returns level null when too few components are up', async () => {
    const fail: FetchImpl = async () => json({}, 500);
    const app = build(fail, { t: 1 }, false);
    const res = await app.inject({ method: 'GET', url: '/api/v1/indices/compute' });
    expect(res.statusCode).toBe(200);
    expect(res.json().index).toMatchObject({ level: null, degraded: true });
  });
});

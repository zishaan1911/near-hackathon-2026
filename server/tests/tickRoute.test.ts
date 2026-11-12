import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { NearAdapterConfig, TickContext, TickReport } from '@gasx/near-adapter';
import { registerTickRoute } from '../src/tick-route.js';

const config: NearAdapterConfig = {
  network: 'testnet',
  rpcUrl: 'http://rpc.invalid',
  contractId: 'gasx.testnet',
  collateralToken: 'tusdc.testnet',
  devMarket: false,
};

const report: TickReport = { published: 400, matched: [], errors: [] };
const KEY = { GASX_NEAR_PUBLISHER_PRIVATE_KEY: 'ed25519:test-only' };

function build(env: NodeJS.ProcessEnv, opts: { config?: NearAdapterConfig; run?: () => Promise<TickReport> } = {}) {
  const app = Fastify({ logger: false });
  let calls = 0;
  let clock = 1_000_000;
  registerTickRoute(app, {
    config: opts.config ?? config,
    getPrice: async () => 1000,
    env,
    now: () => clock,
    runTick: async (_ctx: TickContext) => {
      calls += 1;
      return opts.run ? opts.run() : report;
    },
    makeSigner: () => ({}) as TickContext['signer'],
  });
  return { app, calls: () => calls, advance: (ms: number) => (clock += ms) };
}

describe('GET/POST /api/v1/cron/tick', () => {
  it('returns 503 when CRON_SECRET is unset', async () => {
    const { app, calls } = build({});
    const res = await app.inject({ method: 'POST', url: '/api/v1/cron/tick' });
    expect(res.statusCode).toBe(503);
    expect(calls()).toBe(0);
  });

  it('returns 401 for a missing or wrong bearer', async () => {
    const { app, calls } = build({ CRON_SECRET: 's3cret' });
    const missing = await app.inject({ method: 'POST', url: '/api/v1/cron/tick' });
    const wrong = await app.inject({
      method: 'POST',
      url: '/api/v1/cron/tick',
      headers: { authorization: 'Bearer nope' },
    });
    expect(missing.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    expect(calls()).toBe(0);
  });

  it('returns 200 with the report for the right bearer, on POST and GET', async () => {
    const { app, advance } = build({ CRON_SECRET: 's3cret' });
    const headers = { authorization: 'Bearer s3cret' };
    const post = await app.inject({ method: 'POST', url: '/api/v1/cron/tick', headers });
    expect(post.statusCode).toBe(200);
    expect(post.json()).toEqual(report);
    advance(11_000);
    const get = await app.inject({ method: 'GET', url: '/api/v1/cron/tick', headers });
    expect(get.statusCode).toBe(200);
  });

  it('returns 429 on a second immediate call', async () => {
    const { app, calls } = build({ CRON_SECRET: 's3cret' });
    const headers = { authorization: 'Bearer s3cret' };
    const first = await app.inject({ method: 'POST', url: '/api/v1/cron/tick', headers });
    const second = await app.inject({ method: 'POST', url: '/api/v1/cron/tick', headers });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(429);
    expect(calls()).toBe(1);
  });
});

describe('POST /api/v1/market/poke', () => {
  it('returns { configured: false } without a publisher key', async () => {
    const { app, calls } = build({});
    const res = await app.inject({ method: 'POST', url: '/api/v1/market/poke' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ configured: false });
    expect(calls()).toBe(0);
  });

  it('returns { configured: false } in dev-market mode', async () => {
    const { app, calls } = build(KEY, { config: { ...config, devMarket: true } });
    const res = await app.inject({ method: 'POST', url: '/api/v1/market/poke' });
    expect(res.json()).toEqual({ configured: false });
    expect(calls()).toBe(0);
  });

  it('needs no auth, runs the tick and returns only summary counts', async () => {
    const { app, calls } = build(KEY, {
      run: async () => ({
        published: 412,
        settled: true,
        rolled: 1_700_000_000_000,
        matched: [{ buy: 1, sell: 2 }],
        errors: ['secret detail: ed25519:abc'],
      }),
    });
    const res = await app.inject({ method: 'POST', url: '/api/v1/market/poke' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ published: 412, settled: true, rolled: 1_700_000_000_000, matched: 1 });
    expect(res.body).not.toContain('secret');
    expect(calls()).toBe(1);
  });

  it('returns { skipped: true } on a second call within 15 s, then runs again', async () => {
    const { app, calls, advance } = build(KEY);
    const first = await app.inject({ method: 'POST', url: '/api/v1/market/poke' });
    const second = await app.inject({ method: 'POST', url: '/api/v1/market/poke' });
    expect(first.json().matched).toBe(0);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ skipped: true });
    expect(calls()).toBe(1);
    advance(15_001);
    await app.inject({ method: 'POST', url: '/api/v1/market/poke' });
    expect(calls()).toBe(2);
  });

  it('shares the in-flight guard with the cron route', async () => {
    const { app, calls } = build({ ...KEY, CRON_SECRET: 's3cret' });
    await app.inject({ method: 'POST', url: '/api/v1/cron/tick', headers: { authorization: 'Bearer s3cret' } });
    const poke = await app.inject({ method: 'POST', url: '/api/v1/market/poke' });
    expect(poke.json()).toEqual({ skipped: true });
    expect(calls()).toBe(1);
  });

  it('never leaks error text when the tick throws', async () => {
    const { app } = build(KEY, {
      run: async () => {
        throw new Error('rpc exploded with ed25519:SECRETKEY');
      },
    });
    const res = await app.inject({ method: 'POST', url: '/api/v1/market/poke' });
    expect(res.body).not.toMatch(/rpc|SECRET|exploded/);
  });
});

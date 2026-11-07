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

function build(env: NodeJS.ProcessEnv) {
  const app = Fastify({ logger: false });
  let calls = 0;
  let clock = 1_000_000;
  registerTickRoute(app, {
    config,
    aiUrl: 'http://ai.invalid',
    env,
    now: () => clock,
    runTick: async (_ctx: TickContext) => {
      calls += 1;
      return report;
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

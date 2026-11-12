import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { ComputeIndexPoint, ComputeIndexSnapshotInput, Database } from '../src/db.js';
import { createBlockspaceSource } from '../src/compute/blockspace.js';
import { fetchAllComponents } from '../src/compute/fetchers.js';
import { createComputeService } from '../src/compute/service.js';
import type { FetchImpl } from '../src/compute/types.js';
import { clampDays, registerIndicesRoutes } from '../src/routes/indices.js';
import type { GatewayDeps } from '../src/server.js';
import { healthyFetch, json } from './computeFixtures.js';

/** Base prices equal to what the healthy mock serves, so the level is 1000. */
async function baseFromMock(): Promise<Record<string, number>> {
  const fetchImpl = healthyFetch();
  const all = await fetchAllComponents({ fetchImpl, blockspace: createBlockspaceSource({ fetchImpl }) });
  return Object.fromEntries(all.flatMap((c) => c.quotes.map((q) => [q.key, q.price])));
}

class FakeDb {
  snapshots: ComputeIndexSnapshotInput[] = [];
  history: ComputeIndexPoint[] = [{ t: '2026-11-10T00:00:00.000Z', level: 1001.5 }];
  askedDays: number[] = [];
  async recordComputeIndexSnapshot(input: ComputeIndexSnapshotInput): Promise<boolean> {
    this.snapshots.push(input);
    return true;
  }
  async getComputeIndexHistory(days: number): Promise<ComputeIndexPoint[]> {
    this.askedDays.push(days);
    return this.history;
  }
}

async function build(opts: { fetchImpl?: FetchImpl; env?: NodeJS.ProcessEnv; db?: FakeDb | null; clock?: { t: number } } = {}) {
  const clock = opts.clock ?? { t: Date.UTC(2026, 10, 11) };
  const app = Fastify();
  const db = opts.db === undefined ? null : opts.db;
  const fetchImpl = opts.fetchImpl ?? healthyFetch();
  const getCci = createComputeService({ fetchImpl, now: () => clock.t, baseQuotes: await baseFromMock() });
  registerIndicesRoutes(app, { db: db as unknown as Database | null, getCci } as unknown as GatewayDeps, {
    fetchImpl,
    now: () => clock.t,
    env: opts.env ?? {},
  });
  return { app, clock };
}

describe('GET /api/v1/indices/compute', () => {
  it('returns the documented shape with cache headers', async () => {
    const { app } = await build();
    const res = await app.inject({ method: 'GET', url: '/api/v1/indices/compute' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, s-maxage=60, stale-while-revalidate=300');
    const body = res.json();
    expect(body.index).toMatchObject({
      id: 'CCI',
      name: 'Congest Compute Index',
      level: 1000,
      base: 1000,
      asOf: '2026-11-11T00:00:00.000Z',
      methodologyVersion: '2.0',
      degraded: false,
    });
    expect(typeof body.index.baseDate).toBe('string');
    expect(body.components.map((c: { id: string }) => c.id)).toEqual([
      'gpu_rental',
      'cloud_gpu_spot',
      'cloud_cpu_spot',
      'ai_inference',
      'btc_hashprice',
      'blockspace',
    ]);
    for (const c of body.components) {
      for (const k of ['label', 'unit', 'source', 'nominalWeight', 'effectiveWeight', 'value', 'baseValue', 'relative', 'contributionPoints', 'level', 'sources', 'quotes']) {
        expect(c).toHaveProperty(k);
      }
      expect(c.status).toBe('ok');
      expect(c.quotes.ok).toBe(c.quotes.total);
    }
    expect(body.gpus.map((g: { id: string }) => g.id)).toEqual(['h100', 'a100', 'rtx4090']);
    const h100 = body.gpus[0];
    expect(h100.venues.map((v: { venue: string }) => v.venue)).toEqual(['vast', 'runpod', 'akash']);
    expect(h100.cheapest).toEqual({ venue: 'vast', price: expect.closeTo(2.2, 8) });
    expect(h100.spreadPct).toBeGreaterThan(0);
    expect(body.components.find((c: { id: string }) => c.id === 'blockspace').value).toBeCloseTo(20, 6);
  });

  it('caches for 60 seconds', async () => {
    const counter = { n: 0 };
    const { app, clock } = await build({ fetchImpl: healthyFetch({ counter }) });
    await app.inject({ method: 'GET', url: '/api/v1/indices/compute' });
    const after1 = counter.n;
    clock.t += 59_000;
    await app.inject({ method: 'GET', url: '/api/v1/indices/compute' });
    expect(counter.n).toBe(after1);
    clock.t += 2_000;
    await app.inject({ method: 'GET', url: '/api/v1/indices/compute' });
    expect(counter.n).toBeGreaterThan(after1);
  });

  it('reports a dead venue without moving the level', async () => {
    const { app } = await build({ fetchImpl: healthyFetch({ down: ['runpod.io'] }) });
    const body = (await app.inject({ method: 'GET', url: '/api/v1/indices/compute' })).json();
    expect(body.index.level).toBe(1000);
    expect(body.index.degraded).toBe(false);
    const gpu = body.components[0];
    expect(gpu.quotes).toEqual({ ok: 6, total: 9 });
    expect(gpu.sources).not.toContain('RunPod');
    expect(body.gpus[0].venues.find((v: { venue: string }) => v.venue === 'runpod')).toEqual({ venue: 'runpod', price: null, status: 'down' });
  });

  it('flags a fully down component, degraded, and renormalises', async () => {
    const { app } = await build({ fetchImpl: healthyFetch({ down: ['openrouter.ai'] }) });
    const body = (await app.inject({ method: 'GET', url: '/api/v1/indices/compute' })).json();
    expect(body.index.degraded).toBe(true);
    const ai = body.components.find((c: { id: string }) => c.id === 'ai_inference');
    expect(ai.status).toBe('down');
    expect(ai.error).toBeTruthy();
    const sum = body.components.reduce((a: number, c: { effectiveWeight: number }) => a + c.effectiveWeight, 0);
    expect(sum).toBeCloseTo(1, 3);
  });

  it('returns level null when too few components are up', async () => {
    const fail: FetchImpl = async () => json({}, 500);
    const { app } = await build({ fetchImpl: fail });
    const res = await app.inject({ method: 'GET', url: '/api/v1/indices/compute' });
    expect(res.statusCode).toBe(200);
    expect(res.json().index).toMatchObject({ level: null, degraded: true });
  });
});

describe('GET /api/v1/indices/compute/history', () => {
  it('without a database: persisted false, no points, real backfill, 15 min cache', async () => {
    const { app } = await build({ db: null });
    const res = await app.inject({ method: 'GET', url: '/api/v1/indices/compute/history?days=7' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, s-maxage=900, stale-while-revalidate=300');
    const body = res.json();
    expect(body.persisted).toBe(false);
    expect(body.points).toEqual([]);
    expect(body.backfill.btc_hashprice.length).toBeGreaterThan(0);
    expect(body.backfill.blockspace.length).toBe(28);
    expect(Object.keys(body.backfill).sort()).toEqual(['blockspace', 'btc_hashprice']);
  });

  it('with a database: returns persisted points and clamps days to 1..90', async () => {
    const db = new FakeDb();
    const { app } = await build({ db });
    const body = (await app.inject({ method: 'GET', url: '/api/v1/indices/compute/history?days=500' })).json();
    expect(body.persisted).toBe(true);
    expect(body.points).toEqual(db.history);
    await app.inject({ method: 'GET', url: '/api/v1/indices/compute/history?days=0' });
    await app.inject({ method: 'GET', url: '/api/v1/indices/compute/history' });
    expect(db.askedDays).toEqual([90, 1, 30]);
    expect([clampDays('x'), clampDays('-5'), clampDays('12')]).toEqual([30, 1, 12]);
  });
});

describe('GET/POST /api/v1/cron/compute-snapshot', () => {
  it('503 when CRON_SECRET is unset', async () => {
    const db = new FakeDb();
    const { app } = await build({ db, env: {} });
    const res = await app.inject({ method: 'POST', url: '/api/v1/cron/compute-snapshot' });
    expect(res.statusCode).toBe(503);
    expect(db.snapshots).toHaveLength(0);
  });

  it('401 with a missing or wrong bearer', async () => {
    const db = new FakeDb();
    const { app } = await build({ db, env: { CRON_SECRET: 's3cret' } });
    expect((await app.inject({ method: 'POST', url: '/api/v1/cron/compute-snapshot' })).statusCode).toBe(401);
    const wrong = await app.inject({ method: 'GET', url: '/api/v1/cron/compute-snapshot', headers: { authorization: 'Bearer nope' } });
    expect(wrong.statusCode).toBe(401);
    expect(db.snapshots).toHaveLength(0);
  });

  it('200 records a snapshot with the right bearer (POST and GET)', async () => {
    const db = new FakeDb();
    const { app } = await build({ db, env: { CRON_SECRET: 's3cret' } });
    const headers = { authorization: 'Bearer s3cret' };
    const res = await app.inject({ method: 'POST', url: '/api/v1/cron/compute-snapshot', headers });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ recorded: true, level: 1000 });
    expect(db.snapshots[0]).toMatchObject({ level: 1000, methodologyVersion: '2.0' });
    expect(Array.isArray(db.snapshots[0]?.components)).toBe(true);
    const get = await app.inject({ method: 'GET', url: '/api/v1/cron/compute-snapshot', headers });
    expect(get.statusCode).toBe(200);
  });

  it('200 with recorded:false when there is no database or no level', async () => {
    const headers = { authorization: 'Bearer s3cret' };
    const noDb = await build({ db: null, env: { CRON_SECRET: 's3cret' } });
    expect((await noDb.app.inject({ method: 'POST', url: '/api/v1/cron/compute-snapshot', headers })).json()).toEqual({ recorded: false, level: 1000 });
    const db = new FakeDb();
    const dead = await build({ db, fetchImpl: async () => json({}, 500), env: { CRON_SECRET: 's3cret' } });
    expect((await dead.app.inject({ method: 'POST', url: '/api/v1/cron/compute-snapshot', headers })).json()).toEqual({ recorded: false, level: null });
    expect(db.snapshots).toHaveLength(0);
  });
});

import { describe, expect, it } from 'vitest';
import type { NearAdapterConfig } from '../src/config.js';
import { nextExpiryMs, runTick, type TickContext, type ViewFn } from '../src/tick.js';

const config: NearAdapterConfig = {
  network: 'testnet',
  rpcUrl: 'http://rpc.invalid',
  contractId: 'gasx.testnet',
  collateralToken: 'tusdc.testnet',
  devMarket: false,
};

const NOW = Date.UTC(2026, 0, 1, 12, 30, 0);

interface Recorded {
  methodName: string;
  args: Record<string, unknown>;
}

interface Setup {
  oracle?: Record<string, unknown>;
  market?: Record<string, unknown>;
  orders?: unknown[];
  failMethods?: string[];
  viewFailures?: string[];
}

function makeCtx(setup: Setup = {}) {
  const calls: Recorded[] = [];
  const oracle = { max_price: 1000, has_price: true, last_update_ms: NOW - 60_000, ...setup.oracle };
  const market = {
    expiry_ms: NOW + 3_600_000,
    paused: false,
    settled: false,
    ...setup.market,
  };
  const view = (async (_c: unknown, _id: string, method: string) => {
    if (setup.viewFailures?.includes(method)) throw new Error(`${method} unavailable`);
    if (method === 'get_oracle') return oracle;
    if (method === 'get_market') return market;
    if (method === 'get_open_orders') return setup.orders ?? [];
    throw new Error(`unexpected view ${method}`);
  }) as ViewFn;
  const ctx: TickContext = {
    config,
    contractId: 'gasx.testnet',
    aiUrl: 'http://ai.invalid/',
    now: () => NOW,
    view,
    fetchImpl: (async () =>
      new Response(JSON.stringify({ score: 412.6 }), { status: 200 })) as typeof fetch,
    signer: {
      callFunction: async (params: { methodName: string; args?: Record<string, unknown> }) => {
        if (setup.failMethods?.includes(params.methodName)) {
          throw new Error(`${params.methodName} rejected`);
        }
        calls.push({ methodName: params.methodName, args: params.args ?? {} });
        return {};
      },
    } as unknown as TickContext['signer'],
  };
  return { ctx, calls };
}

const crossing = [
  { order_id: 1, owner: 'a.testnet', is_bid: true, price: 450, quantity: 10 },
  { order_id: 2, owner: 'b.testnet', is_bid: false, price: 440, quantity: 10 },
];

describe('runTick', () => {
  it('publishes and matches in the happy path', async () => {
    const { ctx, calls } = makeCtx({ orders: crossing });
    const report = await runTick(ctx);
    expect(report.errors).toEqual([]);
    expect(report.published).toBe(413);
    expect(report.matched).toEqual([{ buy: 1, sell: 2 }]);
    expect(calls.map((c) => c.methodName)).toEqual(['update_price', 'match_orders']);
    expect(calls[1]?.args).toEqual({ buy_order_id: 1, sell_order_id: 2 });
  });

  it('settles after expiry and rolls in the same tick', async () => {
    const { ctx, calls } = makeCtx({ market: { expiry_ms: NOW - 1 } });
    const report = await runTick(ctx);
    expect(report.settled).toBe(true);
    expect(calls.map((c) => c.methodName)).toEqual(['update_price', 'settle_market', 'roll_market']);
    expect(report.rolled).toBe(nextExpiryMs(NOW));
  });

  it('rolls only when settled, with the right expiry_ms', async () => {
    const unsettled = makeCtx();
    await runTick(unsettled.ctx);
    expect(unsettled.calls.some((c) => c.methodName === 'roll_market')).toBe(false);

    const settled = makeCtx({ market: { settled: true, expiry_ms: NOW - 1000 } });
    const report = await runTick(settled.ctx);
    const roll = settled.calls.find((c) => c.methodName === 'roll_market');
    expect(roll?.args).toEqual({ expiry_ms: Date.UTC(2026, 0, 1, 13, 0, 0) });
    expect(report.settled).toBeUndefined();
    expect(report.rolled).toBe(Date.UTC(2026, 0, 1, 13, 0, 0));
  });

  it('skips publishing when the last update is fresh', async () => {
    const { ctx, calls } = makeCtx({ oracle: { last_update_ms: NOW - 5_000 } });
    const report = await runTick(ctx);
    expect(report.published).toBeUndefined();
    expect(calls.some((c) => c.methodName === 'update_price')).toBe(false);
  });

  it('a failing step does not stop the others', async () => {
    const { ctx, calls } = makeCtx({ orders: crossing, failMethods: ['update_price'] });
    const report = await runTick(ctx);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toContain('publish');
    expect(report.matched).toEqual([{ buy: 1, sell: 2 }]);
    expect(calls.map((c) => c.methodName)).toEqual(['match_orders']);
  });

  it('reports a failed view without throwing', async () => {
    const { ctx } = makeCtx({ viewFailures: ['get_oracle'] });
    const report = await runTick(ctx);
    expect(report.errors[0]).toContain('get_oracle');
  });
});

describe('nextExpiryMs', () => {
  it('at 12:49 UTC returns 13:00', () => {
    expect(nextExpiryMs(Date.UTC(2026, 0, 1, 12, 49))).toBe(Date.UTC(2026, 0, 1, 13, 0));
  });
  it('at 12:51 UTC returns 14:00', () => {
    expect(nextExpiryMs(Date.UTC(2026, 0, 1, 12, 51))).toBe(Date.UTC(2026, 0, 1, 14, 0));
  });
  it('at exactly 13:00:00 UTC returns 14:00', () => {
    expect(nextExpiryMs(Date.UTC(2026, 0, 1, 13, 0))).toBe(Date.UTC(2026, 0, 1, 14, 0));
  });
});

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
  price?: number | null;
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
    getPrice: async () => ('price' in setup ? (setup.price ?? null) : 412.6),
    now: () => NOW,
    view,
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

  it('publishes the price from getPrice, clamped to max_price', async () => {
    const { ctx, calls } = makeCtx({ price: 5000 });
    const report = await runTick(ctx);
    expect(report.published).toBe(1000);
    expect(calls[0]).toEqual({ methodName: 'update_price', args: { price: 1000 } });
  });

  it('uses a 60 s freshness window', async () => {
    const fresh = makeCtx({ oracle: { last_update_ms: NOW - 59_000 } });
    await runTick(fresh.ctx);
    expect(fresh.calls.some((c) => c.methodName === 'update_price')).toBe(false);

    const stale = makeCtx({ oracle: { last_update_ms: NOW - 61_000 } });
    await runTick(stale.ctx);
    expect(stale.calls.some((c) => c.methodName === 'update_price')).toBe(true);
  });

  it('reports an error and skips publishing on a null price', async () => {
    const { ctx, calls } = makeCtx({ price: null, orders: crossing });
    const report = await runTick(ctx);
    expect(report.published).toBeUndefined();
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toContain('publish');
    expect(calls.map((c) => c.methodName)).toEqual(['match_orders']);
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

describe('demo liquidity', () => {
  const MAKER = 'pub.testnet';
  const LIQ = { quantity: 100, offsetTicks: 1, maxRepriceDistance: 3 };
  // ref 413 (published from 412.6), tick 1: bid 412, ask 414. Margin per quote
  // = price * 100 * 10 * 1000 / 10000 = price * 100.

  interface LiqSetup {
    orders?: Array<Record<string, unknown>>;
    available?: string;
    now?: number;
    marketExtra?: Record<string, unknown>;
    myOrders?: Array<Record<string, unknown>>;
    trades?: Array<Record<string, unknown>>;
    liquidity?: TickContext['liquidity'] | null;
  }

  function make(s: LiqSetup = {}) {
    const calls: Recorded[] = [];
    const book: Array<Record<string, unknown>> = [...(s.orders ?? [])];
    let nextId = 100;
    const now = s.now ?? NOW;
    const market = {
      market_id: 5,
      expiry_ms: NOW + 3_600_000,
      paused: false,
      settled: false,
      contract_multiplier: 10,
      tick_size: 1,
      margin_ratio_bps: 1000,
      ...s.marketExtra,
    };
    const view = (async (_c: unknown, _id: string, method: string) => {
      if (method === 'get_oracle') return { max_price: 1000, has_price: true, last_update_ms: now - 60_000, price: 400 };
      if (method === 'get_market') return market;
      if (method === 'get_open_orders') return book.filter((o) => o.status === undefined || o.status === 'open');
      if (method === 'get_account') return { available: s.available ?? '1000000', locked: '0' };
      if (method === 'get_orders_by_account') return s.myOrders ?? [];
      if (method === 'get_trades_by_account') return s.trades ?? [];
      throw new Error(`unexpected view ${method}`);
    }) as ViewFn;
    const ctx: TickContext = {
      config,
      contractId: 'gasx.testnet',
      getPrice: async () => 412.6,
      now: () => now,
      view,
      signerAccountId: MAKER,
      ...(s.liquidity === null ? {} : { liquidity: s.liquidity ?? LIQ }),
      signer: {
        callFunction: async (params: { methodName: string; args?: Record<string, unknown> }) => {
          const args = params.args ?? {};
          calls.push({ methodName: params.methodName, args });
          if (params.methodName === 'place_order') {
            book.push({ order_id: nextId++, owner: MAKER, market_id: 5, status: 'open', ...args, is_bid: args.is_bid });
          }
          if (params.methodName === 'cancel_order') {
            const i = book.findIndex((o) => o.order_id === args.order_id);
            if (i >= 0) book.splice(i, 1);
          }
          return {};
        },
      } as unknown as TickContext['signer'],
    };
    return { ctx, calls, book };
  }

  const placed = (calls: Recorded[]) => calls.filter((c) => c.methodName === 'place_order').map((c) => c.args);
  const mk = (id: number, isBid: boolean, price: number, quantity = 100, owner = MAKER) => ({
    order_id: id, owner, is_bid: isBid, price, quantity, market_id: 5, status: 'open',
  });

  it('places both quotes when none exist', async () => {
    const { ctx, calls } = make();
    const report = await runTick(ctx);
    expect(report.errors).toEqual([]);
    expect(placed(calls)).toEqual([
      { is_bid: true, price: 412, quantity: 100 },
      { is_bid: false, price: 414, quantity: 100 },
    ]);
    expect(report.quoted).toEqual({ bids: 1, asks: 1 });
    expect(report.matched).toEqual([]);
  });

  it('keeps quotes within the reprice distance', async () => {
    const { ctx, calls } = make({ orders: [mk(1, true, 410), mk(2, false, 416)] });
    const report = await runTick(ctx);
    expect(calls.map((c) => c.methodName)).toEqual(['update_price']);
    expect(report.quoted).toEqual({ bids: 1, asks: 1 });
  });

  it('reprices when the reference moved', async () => {
    const { ctx, calls } = make({ orders: [mk(1, true, 300), mk(2, false, 414)] });
    const report = await runTick(ctx);
    const names = calls.map((c) => c.methodName);
    expect(names).toEqual(['update_price', 'cancel_order', 'place_order']);
    expect(calls[1]?.args).toEqual({ order_id: 1 });
    expect(placed(calls)).toEqual([{ is_bid: true, price: 412, quantity: 100 }]);
    expect(report.quoted).toEqual({ bids: 1, asks: 1 });
  });

  it('reprices an order with the wrong quantity', async () => {
    const { ctx, calls } = make({ orders: [mk(1, true, 412, 7), mk(2, false, 414)] });
    await runTick(ctx);
    expect(calls.some((c) => c.methodName === 'cancel_order' && c.args.order_id === 1)).toBe(true);
    expect(placed(calls)).toEqual([{ is_bid: true, price: 412, quantity: 100 }]);
  });

  it('skips with insufficient balance and records the error', async () => {
    const { ctx, calls } = make({ available: '41200' }); // covers the bid (41200) only
    const report = await runTick(ctx);
    expect(placed(calls)).toEqual([{ is_bid: true, price: 412, quantity: 100 }]);
    expect(report.errors).toContain('liquidity: insufficient balance');
    expect(report.quoted).toEqual({ bids: 1, asks: 0 });
  });

  it('does nothing in the last 60 s', async () => {
    const { ctx, calls } = make({ marketExtra: { expiry_ms: NOW + 30_000 } });
    const report = await runTick(ctx);
    expect(placed(calls)).toEqual([]);
    expect(report.quoted).toBeUndefined();
  });

  it('does nothing when disabled', async () => {
    const { ctx, calls } = make({ liquidity: null });
    const report = await runTick(ctx);
    expect(calls.map((c) => c.methodName)).toEqual(['update_price']);
    expect(report.quoted).toBeUndefined();
  });

  it('cancels stale-market orders and claims settled trades, at most 5', async () => {
    const trades = Array.from({ length: 7 }, (_, i) => ({
      trade_id: 20 + i, market_id: 4, buyer: MAKER, seller: 'x.testnet', buyer_claimed: false, seller_claimed: false,
    }));
    trades.push({ trade_id: 99, market_id: 4, buyer: MAKER, seller: 'x.testnet', buyer_claimed: true, seller_claimed: false });
    trades.push({ trade_id: 98, market_id: 5, buyer: MAKER, seller: 'x.testnet', buyer_claimed: false, seller_claimed: false });
    const { ctx, calls } = make({
      myOrders: [
        { order_id: 7, market_id: 4, status: 'open', owner: MAKER },
        { order_id: 8, market_id: 4, status: 'cancelled', owner: MAKER },
        { order_id: 9, market_id: 5, status: 'open', owner: MAKER },
      ],
      trades,
    });
    await runTick(ctx);
    const cancels = calls.filter((c) => c.methodName === 'cancel_order').map((c) => c.args.order_id);
    expect(cancels).toEqual([7]);
    const claims = calls.filter((c) => c.methodName === 'claim').map((c) => c.args.trade_id);
    expect(claims).toEqual([20, 21, 22, 23, 24]);
  });

  it("matches a user's 1-contract bid against the maker's ask in the same tick", async () => {
    const one = { quantity: 1, offsetTicks: 1, maxRepriceDistance: 3 };
    const { ctx, calls } = make({
      liquidity: one,
      orders: [{ order_id: 50, owner: 'user.testnet', is_bid: true, price: 414, quantity: 1, market_id: 5, status: 'open' }],
    });
    const report = await runTick(ctx);
    const askId = calls.length && report.matched[0]?.sell;
    expect(report.matched).toEqual([{ buy: 50, sell: askId }]);
    expect(askId).toBeGreaterThanOrEqual(100);
    expect(calls.at(-1)?.methodName).toBe('match_orders');
  });

  it('never matches the maker with itself', async () => {
    const { ctx } = make();
    const report = await runTick(ctx);
    expect(report.matched).toEqual([]);
  });
});
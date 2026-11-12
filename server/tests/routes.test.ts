import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer, type GatewayDeps } from '../src/server.js';
import type { CciResponse } from '../src/compute/service.js';
import { OnChainEngineLayer } from '../src/engineLayer.js';
import type { RiskPolicyConfig } from '../src/riskPolicy.js';
import {
  FakeChainAdapter,
  makeCciResponse,
  makeMarketState,
  makeOrderView,
  makeTradeView,
} from './fakes.js';

const riskPolicy: RiskPolicyConfig = {
  maxOrderContracts: 100,
  maxPositionContracts: 500,
  maxSlippageBps: 100,
};

let app: FastifyInstance;
let chainAdapter: FakeChainAdapter;
let getCci: () => Promise<CciResponse>;

beforeEach(() => {
  chainAdapter = new FakeChainAdapter();
  getCci = async () => makeCciResponse(1042.6);
  const deps: GatewayDeps = {
    chainAdapter,
    getCci: () => getCci(),
    engine: new OnChainEngineLayer(
      { contractMultiplier: 10, marginRatioBps: 1000, maxOrderQuantity: 100, maxNetPosition: 500 },
      chainAdapter,
    ),
    riskPolicy,
    logger: false,
  };
  app = buildServer(deps);
});

describe('GET /api/v1/health', () => {
  it('returns ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });
});

describe('GET /api/v1/market', () => {
  it('combines NEAR market state with the SCI, pillars, book and quote', async () => {
    chainAdapter.marketState = makeMarketState({ underlying: 'SCI-1H' });
    chainAdapter.openOrders = [makeOrderView({ orderId: 1, isBid: true, price: 1040, quantity: 5 })];

    const res = await app.inject({ method: 'GET', url: '/api/v1/market' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.market.underlying).toBe('SCI-1H');
    expect(body.index).toEqual({
      level: 1042.6,
      base: 1000,
      baseDate: '2026-11-01',
      asOf: '2026-11-10T12:00:00.000Z',
      degraded: false,
    });
    expect(body.pillars).toEqual([
      { id: 'gpu_rental', label: 'GPU rental', level: 1040, effectiveWeight: 0.35, status: 'ok' },
      { id: 'blockspace', label: 'Ethereum blockspace', level: null, effectiveWeight: 0.05, status: 'down' },
    ]);
    expect(body.orderbook.indicative).toBe(true);
    expect(body.orderbook.bestBid).toEqual({ price: 1040, quantity: 5 });
    expect(body.quote).toMatchObject({ fairPrice: 1043, bid: 1040, ask: 1046, size: 10, indicative: true });
    expect(body.egsi).toBeUndefined();
    expect(body.forecast).toBeUndefined();
  });

  it('degrades (index null, pillars empty) when the compute index throws', async () => {
    getCci = async () => {
      throw new Error('upstream exploded');
    };

    const res = await app.inject({ method: 'GET', url: '/api/v1/market' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.market).toBeDefined();
    expect(body.index).toBeNull();
    expect(body.pillars).toEqual([]);
    expect(body.quote).toBeNull();
  });

  it('has a null quote when the index level is null', async () => {
    getCci = async () => makeCciResponse(null);
    const res = await app.inject({ method: 'GET', url: '/api/v1/market' });
    expect(res.statusCode).toBe(200);
    expect(res.json().index.level).toBeNull();
    expect(res.json().quote).toBeNull();
  });
  it('returns 500 when the chain read itself fails', async () => {
    chainAdapter.getMarketStateError = new Error('rpc unreachable');

    const res = await app.inject({ method: 'GET', url: '/api/v1/market' });

    expect(res.statusCode).toBe(500);
  });

  it('maps DevMarketUnavailableError to 503 with its message', async () => {
    const err = new Error('dev market: orders unavailable');
    err.name = 'DevMarketUnavailableError';
    chainAdapter.getMarketStateError = err;

    const res = await app.inject({ method: 'GET', url: '/api/v1/market' });

    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatch(/orders unavailable/);
  });
});

describe('POST /api/v1/orders/prepare', () => {
  const validBody = {
    trader: 'alice.testnet',
    isBid: true,
    price: 500,
    quantity: 10,
  };

  it('accepts a valid order and returns a prepared transaction', async () => {
    chainAdapter.marketState = makeMarketState({
      tickSize: 10,
      oracle: { oracleId: 'gasx.testnet', price: 500, hasPrice: true, lastUpdateMs: 0, maxStalenessMs: 0, maxPrice: 1000, isFreshApprox: true },
    });

    const res = await app.inject({ method: 'POST', url: '/api/v1/orders/prepare', payload: validBody });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.receiverId).toBe('gasx.testnet');
    expect(body.actions).toHaveLength(1);
    expect(chainAdapter.lastPreparePlaceOrderParams).toEqual(validBody);
  });

  it.each([
    ['trader', { trader: undefined }],
    ['isBid', { isBid: 'yes' }],
    ['price', { price: '500' }],
    ['quantity', { quantity: undefined }],
  ])('returns 400 when %s is missing or mistyped', async (field, override) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/orders/prepare',
      payload: { ...validBody, ...override },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(new RegExp(field));
    expect(chainAdapter.lastPreparePlaceOrderParams).toBeNull();
  });

  it('returns 422 and does not call prepare when risk policy rejects the order', async () => {
    chainAdapter.marketState = makeMarketState({ paused: true });

    const res = await app.inject({ method: 'POST', url: '/api/v1/orders/prepare', payload: validBody });

    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatch(/paused/);
    expect(chainAdapter.lastPreparePlaceOrderParams).toBeNull();
  });

  it('returns 422 when quantity exceeds MAX_ORDER_CONTRACTS', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/orders/prepare',
      payload: { ...validBody, quantity: 1000 },
    });
    expect(res.statusCode).toBe(422);
  });

  it('passes the oracle price as the slippage reference price', async () => {
    chainAdapter.marketState = makeMarketState({
      tickSize: 1,
      oracle: { oracleId: 'gasx.testnet', price: 500, hasPrice: true, lastUpdateMs: 0, maxStalenessMs: 0, maxPrice: 1000, isFreshApprox: true },
    });

    // 600 vs reference 500 is 20% away — well outside a 1% MAX_SLIPPAGE.
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/orders/prepare',
      payload: { ...validBody, price: 600 },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatch(/MAX_SLIPPAGE/);
  });

  it('rejects a marginAccountId-style legacy body without a trader', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/orders/prepare',
      payload: { marginAccountId: '0xmargin', isBid: true, price: 500, quantity: 10 },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /api/v1/orders/prepare-cancel', () => {
  it('accepts a valid cancel request', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/orders/prepare-cancel',
      payload: { trader: 'alice.testnet', orderId: 7 },
    });
    expect(res.statusCode).toBe(200);
    expect(chainAdapter.lastPrepareCancelOrderParams).toEqual({ trader: 'alice.testnet', orderId: 7 });
  });

  it('returns 400 when orderId is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/orders/prepare-cancel',
      payload: { trader: 'alice.testnet' },
    });
    expect(res.statusCode).toBe(400);
  });

  it.each([['7'], [-1], [1.5]])('returns 400 when orderId is %j', async (orderId) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/orders/prepare-cancel',
      payload: { trader: 'alice.testnet', orderId },
    });
    expect(res.statusCode).toBe(400);
    expect(chainAdapter.lastPrepareCancelOrderParams).toBeNull();
  });

  it('returns 400 when trader is missing', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/orders/prepare-cancel', payload: { orderId: 7 } });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /api/v1/account/prepare-deposit', () => {
  it('accepts a valid request', async () => {
    const payload = { trader: 'alice.testnet', amount: '5000000' };
    const res = await app.inject({ method: 'POST', url: '/api/v1/account/prepare-deposit', payload });
    expect(res.statusCode).toBe(200);
    expect(chainAdapter.lastPrepareDepositParams).toEqual(payload);
  });

  it('returns 400 when trader is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/account/prepare-deposit',
      payload: { amount: '5000000' },
    });
    expect(res.statusCode).toBe(400);
  });

  it.each([[undefined], ['0'], ['-5'], ['1.5'], [5000000]])('returns 400 when amount is %j', async (amount) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/account/prepare-deposit',
      payload: { trader: 'alice.testnet', amount },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/amount/);
    expect(chainAdapter.lastPrepareDepositParams).toBeNull();
  });
});

describe('POST /api/v1/account/prepare-withdraw', () => {
  it('accepts a valid request', async () => {
    const payload = { trader: 'alice.testnet', amount: '123' };
    const res = await app.inject({ method: 'POST', url: '/api/v1/account/prepare-withdraw', payload });
    expect(res.statusCode).toBe(200);
    expect(chainAdapter.lastPrepareWithdrawParams).toEqual(payload);
  });

  it('returns 400 when trader is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/account/prepare-withdraw',
      payload: { amount: '123' },
    });
    expect(res.statusCode).toBe(400);
  });

  it.each([[undefined], ['0'], ['abc']])('returns 400 when amount is %j', async (amount) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/account/prepare-withdraw',
      payload: { trader: 'alice.testnet', amount },
    });
    expect(res.statusCode).toBe(400);
    expect(chainAdapter.lastPrepareWithdrawParams).toBeNull();
  });
});

describe('POST /api/v1/trades/prepare-claim', () => {
  it('accepts a valid request', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/trades/prepare-claim',
      payload: { trader: 'alice.testnet', tradeId: 4 },
    });
    expect(res.statusCode).toBe(200);
    expect(chainAdapter.lastPrepareClaimParams).toEqual({ trader: 'alice.testnet', tradeId: 4 });
  });

  it('returns 400 when trader is missing', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/trades/prepare-claim', payload: { tradeId: 4 } });
    expect(res.statusCode).toBe(400);
  });

  it.each([[undefined], ['4'], [-1], [2.5]])('returns 400 when tradeId is %j', async (tradeId) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/trades/prepare-claim',
      payload: { trader: 'alice.testnet', tradeId },
    });
    expect(res.statusCode).toBe(400);
    expect(chainAdapter.lastPrepareClaimParams).toBeNull();
  });
});

describe('GET /api/v1/candles and removed history', () => {
  it('without a database serves candles from the back-cast + settlements, never 503', async () => {
    const noDbApp = buildServer({
      chainAdapter,
      getCci: () => getCci(),
      riskPolicy,
      logger: false,
      historySources: {
        getBackfill: async () => ({ btc_hashprice: [], blockspace: [] }),
        getBackcast: async () => ({
          points: [
            { t: '2026-11-09T00:00:00.000Z', level: 990 },
            { t: '2026-11-10T00:00:00.000Z', level: 1010 },
          ],
          method: 'm',
          pillars: ['btc_hashprice', 'blockspace'],
          ethPrice: 'daily',
        }),
        getSettlements: async () => [{ t: '2026-11-11T10:00:00.000Z', level: 1020, marketId: 5 }],
      },
    });
    const res = await noDbApp.inject({ method: 'GET', url: '/api/v1/candles?interval=3600&limit=10' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.source).toBe('backcast+settlements');
    expect(body.market).toBe('SCI-1H');
    expect(body.count).toBe(3);
    expect(body.candles.map((c: { time: number }) => c.time)).toEqual([
      Date.UTC(2026, 10, 9) / 1000,
      Date.UTC(2026, 10, 10) / 1000,
      Date.UTC(2026, 10, 11, 10) / 1000,
    ]);
    expect(body.candles[1]).toMatchObject({ open: 990, close: 1010, high: 1010, low: 990 });
    expect(body.candles[2]).toMatchObject({ open: 1020, close: 1020, samples: 1 });
  });

  it('serves SCI-1H candles from the database', async () => {
    const seen: Array<[number, number]> = [];
    const candle = { time: 1_700_000_000, open: 1000, high: 1010, low: 995, close: 1005, samples: 3 };
    const dbApp = buildServer({
      chainAdapter,
      getCci: () => getCci(),
      riskPolicy,
      logger: false,
      db: {
        getComputeIndexCandles: async (interval: number, limit: number) => {
          seen.push([interval, limit]);
          return [candle];
        },
      } as unknown as NonNullable<GatewayDeps['db']>,
    });
    const res = await dbApp.inject({ method: 'GET', url: '/api/v1/candles?interval=60&limit=5' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ market: 'SCI-1H', interval: 60, count: 1, candles: [candle] });
    expect(seen).toEqual([[60, 5]]);

    const history = await dbApp.inject({ method: 'GET', url: '/api/v1/history' });
    expect(history.statusCode).toBe(404);
  });
});

describe('removed routes', () => {
  it('no longer serves open-account or hedge endpoints', async () => {
    const open = await app.inject({
      method: 'POST',
      url: '/api/v1/account/prepare-open',
      payload: { trader: 'alice.testnet' },
    });
    expect(open.statusCode).toBe(404);

    const hedge = await app.inject({ method: 'POST', url: '/api/v1/hedge/sync-signal' });
    expect(hedge.statusCode).toBe(404);
  });
});

describe('GET /api/v1/account/:accountId', () => {
  it('combines balance, open orders, own orders and trades', async () => {
    chainAdapter.account = { available: '9000000', locked: '1000000' };
    chainAdapter.openOrders = [makeOrderView({ orderId: 1, owner: 'bob.testnet' })];
    chainAdapter.accountOrders = [makeOrderView({ orderId: 7 })];
    chainAdapter.accountTrades = [makeTradeView({ tradeId: 4 })];

    const res = await app.inject({ method: 'GET', url: '/api/v1/account/alice.testnet' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.accountId).toBe('alice.testnet');
    expect(body.available).toBe('9000000');
    expect(body.locked).toBe('1000000');
    expect(body.openOrders).toHaveLength(1);
    expect(body.openOrders[0].orderId).toBe(1);
    expect(body.orders[0].orderId).toBe(7);
    expect(body.trades[0].tradeId).toBe(4);
    expect(chainAdapter.lastAccountId).toBe('alice.testnet');
  });

  it('returns zero balances and empty lists for an unknown account', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/account/nobody.testnet' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      accountId: 'nobody.testnet',
      available: '0',
      locked: '0',
      openOrders: [],
      orders: [],
      trades: [],
    });
  });
});



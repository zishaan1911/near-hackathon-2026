import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer, type GatewayDeps } from '../src/server.js';
import type { RiskPolicyConfig } from '../src/riskPolicy.js';
import {
  FakeAiClient,
  FakeChainAdapter,
  makeEgsiSnapshot,
  makeMarketState,
  makeOrderView,
  makeTradeView,
} from './fakes.js';

const riskPolicy: RiskPolicyConfig = {
  maxOrderContracts: 100,
  maxPositionContracts: 500,
  maxSlippageBps: 100,
  minModelConfidence: 0.7,
  maxHedgeNotional: 1000,
};

let app: FastifyInstance;
let chainAdapter: FakeChainAdapter;
let aiClient: FakeAiClient;

beforeEach(() => {
  chainAdapter = new FakeChainAdapter();
  aiClient = new FakeAiClient();
  const deps: GatewayDeps = { chainAdapter, aiClient, riskPolicy, logger: false };
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
  it('combines NEAR market state with EGSI and forecast', async () => {
    chainAdapter.marketState = makeMarketState({ underlying: 'EGSI-1H' });
    aiClient.currentEgsi = makeEgsiSnapshot({ score: 500 });

    const res = await app.inject({ method: 'GET', url: '/api/v1/market' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.market.underlying).toBe('EGSI-1H');
    expect(body.egsi.score).toBe(500);
  });

  it('still returns market state when the AI service is unreachable (egsi/forecast null)', async () => {
    aiClient.currentEgsi = null;
    aiClient.forecast = null;

    const res = await app.inject({ method: 'GET', url: '/api/v1/market' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.market).toBeDefined();
    expect(body.egsi).toBeNull();
    expect(body.forecast).toBeNull();
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

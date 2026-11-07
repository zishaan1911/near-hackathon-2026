import { describe, expect, it } from 'vitest';
import {
  parseAccountView,
  parseMarketView,
  parseOracleView,
  parseOrderView,
  parseOrderViews,
  parseTradeView,
} from '../src/marketState.js';

describe('parseMarketView', () => {
  const baseView = {
    market_id: 3,
    underlying: 'EGSI-1H',
    expiry_ms: 1700000000000,
    contract_multiplier: 10,
    tick_size: 1,
    margin_ratio_bps: 1000,
    paused: false,
    settled: false,
    settlement_price: null,
    collateral_token: 'tusdc.testnet',
  };

  it('parses all fields and builds the contract#market id', () => {
    const result = parseMarketView(baseView, 'gasx.testnet');
    expect(result.marketId).toBe('gasx.testnet#3');
    expect(result.underlying).toBe('EGSI-1H');
    expect(result.expiryMs).toBe(1700000000000);
    expect(result.contractMultiplier).toBe(10);
    expect(result.tickSize).toBe(1);
    expect(result.marginRatioBps).toBe(1000);
    expect(result.paused).toBe(false);
    expect(result.settled).toBe(false);
    expect(result.settlementPrice).toBeNull();
  });

  it('accepts u64s given as decimal strings too', () => {
    const result = parseMarketView({ ...baseView, expiry_ms: '1700000000000' }, 'gasx.testnet');
    expect(result.expiryMs).toBe(1700000000000);
  });

  it('leaves settlementPrice null when the market is not settled', () => {
    const result = parseMarketView({ ...baseView, settled: false, settlement_price: 999 }, 'gasx.testnet');
    expect(result.settlementPrice).toBeNull();
  });

  it('reads settlementPrice when the market is settled', () => {
    const result = parseMarketView({ ...baseView, settled: true, settlement_price: 487 }, 'gasx.testnet');
    expect(result.settlementPrice).toBe(487);
  });

  it('throws when a settled market has a null settlement_price', () => {
    expect(() => parseMarketView({ ...baseView, settled: true }, 'gasx.testnet')).toThrow(/settlement_price/);
  });

  it('throws with a clear message when a required field is missing', () => {
    const { underlying: _drop, ...withoutUnderlying } = baseView;
    expect(() => parseMarketView(withoutUnderlying, 'gasx.testnet')).toThrow(/underlying/);
  });

  it('throws when a bool field is given as a string instead', () => {
    expect(() => parseMarketView({ ...baseView, paused: 'false' }, 'gasx.testnet')).toThrow(/paused/);
  });

  it('throws when the view is not an object', () => {
    expect(() => parseMarketView(null, 'gasx.testnet')).toThrow(/MarketView/);
    expect(() => parseMarketView([], 'gasx.testnet')).toThrow(/MarketView/);
  });
});

describe('parseOracleView', () => {
  const baseView = {
    price: 441,
    has_price: true,
    last_update_ms: 1700000000000,
    max_staleness_ms: 60000,
    max_price: 1000,
    publisher: 'publisher.testnet',
  };

  it('parses all fields and uses the contract id as oracleId', () => {
    const result = parseOracleView(baseView, 'gasx.testnet', 1700000000000);
    expect(result.oracleId).toBe('gasx.testnet');
    expect(result.price).toBe(441);
    expect(result.hasPrice).toBe(true);
    expect(result.lastUpdateMs).toBe(1700000000000);
    expect(result.maxStalenessMs).toBe(60000);
    expect(result.maxPrice).toBe(1000);
  });

  it('reads isFreshApprox true when within the staleness window', () => {
    const result = parseOracleView(baseView, 'gasx.testnet', 1700000000000 + 30000);
    expect(result.isFreshApprox).toBe(true);
  });

  it('reads isFreshApprox false when past the staleness window', () => {
    const result = parseOracleView(baseView, 'gasx.testnet', 1700000000000 + 90000);
    expect(result.isFreshApprox).toBe(false);
  });

  it('reads isFreshApprox false when has_price is false regardless of timing', () => {
    const result = parseOracleView({ ...baseView, has_price: false }, 'gasx.testnet', 1700000000000);
    expect(result.isFreshApprox).toBe(false);
  });

  it('defaults nowMs to the real clock when omitted', () => {
    const recentView = { ...baseView, last_update_ms: Date.now(), max_staleness_ms: 3_600_000 };
    expect(parseOracleView(recentView, 'gasx.testnet').isFreshApprox).toBe(true);
  });

  it('throws on a missing or mistyped field', () => {
    const { max_price: _drop, ...withoutMaxPrice } = baseView;
    expect(() => parseOracleView(withoutMaxPrice, 'gasx.testnet')).toThrow(/max_price/);
    expect(() => parseOracleView({ ...baseView, has_price: 1 }, 'gasx.testnet')).toThrow(/has_price/);
  });
});

describe('order / trade / account views', () => {
  const orderView = {
    order_id: 7,
    market_id: 3,
    owner: 'alice.testnet',
    is_bid: true,
    price: 500,
    quantity: 10,
    locked_margin: '50000000',
    status: 'open',
  };
  const tradeView = {
    trade_id: 4,
    market_id: 3,
    buyer: 'alice.testnet',
    seller: 'bob.testnet',
    price: 500,
    quantity: 10,
    buyer_committed: '50000000',
    seller_committed: '50000000',
    buyer_claimed: false,
    seller_claimed: true,
  };

  it('parses an OrderView into camelCase, keeping the amount a string', () => {
    expect(parseOrderView(orderView)).toEqual({
      orderId: 7,
      marketId: 3,
      owner: 'alice.testnet',
      isBid: true,
      price: 500,
      quantity: 10,
      lockedMargin: '50000000',
      status: 'open',
    });
  });

  it('rejects an unknown order status and a non-string locked_margin', () => {
    expect(() => parseOrderView({ ...orderView, status: 'pending' })).toThrow(/status/);
    expect(() => parseOrderView({ ...orderView, locked_margin: 5 })).toThrow(/locked_margin/);
  });

  it('parses an array of orders and rejects a non-array', () => {
    expect(parseOrderViews([orderView])).toHaveLength(1);
    expect(parseOrderViews([])).toEqual([]);
    expect(() => parseOrderViews({})).toThrow(/array/);
  });

  it('parses a TradeView into camelCase', () => {
    expect(parseTradeView(tradeView)).toEqual({
      tradeId: 4,
      marketId: 3,
      buyer: 'alice.testnet',
      seller: 'bob.testnet',
      price: 500,
      quantity: 10,
      buyerCommitted: '50000000',
      sellerCommitted: '50000000',
      buyerClaimed: false,
      sellerClaimed: true,
    });
  });

  it('rejects a TradeView with a mistyped flag', () => {
    expect(() => parseTradeView({ ...tradeView, buyer_claimed: 'no' })).toThrow(/buyer_claimed/);
  });

  it('parses an account view and rejects non-decimal amounts', () => {
    expect(parseAccountView({ available: '100', locked: '0' })).toEqual({ available: '100', locked: '0' });
    expect(() => parseAccountView({ available: 100, locked: '0' })).toThrow(/available/);
    expect(() => parseAccountView({ available: '1.5', locked: '0' })).toThrow(/available/);
  });
});

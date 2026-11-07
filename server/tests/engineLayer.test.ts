import { describe, expect, it } from 'vitest';
import type { OrderView } from '@gasx/near-adapter';
import type { ForecastDto } from '../src/aiClient.js';
import { computeQuote, OnChainEngineLayer, type EngineConfig, type PricingConfig } from '../src/engineLayer.js';

// Mirrors the C++ PricingConfig defaults used by engine/tests/pricing_tests.cpp.
const defaults: PricingConfig = {
  priceScale: 100,
  baseHalfSpread: 50,
  volatilitySpreadMultiplier: 0.5,
  minConfidence: 0.4,
  maxQuoteSize: 100,
  minQuoteSize: 5,
  inventorySkewPerUnit: 0,
};

const input = (volatility: number, confidence: number) => ({ expectedValue: 441.2, volatility, confidence });

describe('computeQuote (QuoteEngine port)', () => {
  it('refuses below min confidence and quotes at exactly min confidence', () => {
    expect(computeQuote(input(69.4, 0.39), defaults)).toBeNull();
    expect(computeQuote(input(69.4, 0.4), defaults)).not.toBeNull();
  });

  it('scales expected value by price scale', () => {
    const q = computeQuote(input(0, 0.9), { ...defaults, minConfidence: 0 });
    expect(q?.fairPrice).toBe(44120);
  });

  it('zero volatility gives base spread only', () => {
    const q = computeQuote(input(0, 0.9), { ...defaults, minConfidence: 0 })!;
    expect(q.fairPrice - q.bid).toBe(50);
    expect(q.ask - q.fairPrice).toBe(50);
  });

  it('higher volatility widens the spread symmetrically', () => {
    const cfg = { ...defaults, volatilitySpreadMultiplier: 1, minConfidence: 0 };
    const low = computeQuote(input(10, 0.9), cfg)!;
    const high = computeQuote(input(100, 0.9), cfg)!;
    expect(high.ask - high.bid).toBeGreaterThan(low.ask - low.bid);
    expect(high.fairPrice - high.bid).toBe(high.ask - high.fairPrice);
  });

  it('size is min at the floor, max at confidence 1, monotonic between', () => {
    expect(computeQuote(input(69.4, 0.4), defaults)?.size).toBe(5);
    expect(computeQuote(input(69.4, 1), defaults)?.size).toBe(100);
    const lower = computeQuote(input(69.4, 0.6), defaults)!;
    const higher = computeQuote(input(69.4, 0.8), defaults)!;
    expect(lower.size).toBeLessThan(higher.size);
  });

  it('bid is below fair price and ask above it', () => {
    const q = computeQuote(input(69.4, 0.91), defaults)!;
    expect(q.bid).toBeLessThan(q.fairPrice);
    expect(q.ask).toBeGreaterThan(q.fairPrice);
  });

  it('zero skew config ignores net position', () => {
    const flat = computeQuote(input(69.4, 0.9), defaults, 0)!;
    const long = computeQuote(input(69.4, 0.9), defaults, 50)!;
    expect(long.bid).toBe(flat.bid);
    expect(long.ask).toBe(flat.ask);
  });

  it('long inventory skews down, short skews up, spread and fair price unchanged', () => {
    const cfg = { ...defaults, inventorySkewPerUnit: 5 };
    const flat = computeQuote(input(69.4, 0.9), cfg, 0)!;
    const long = computeQuote(input(69.4, 0.9), cfg, 10)!;
    const short = computeQuote(input(69.4, 0.9), cfg, -10)!;
    expect(long.bid).toBe(flat.bid - 50);
    expect(long.ask).toBe(flat.ask - 50);
    expect(short.bid).toBe(flat.bid + 50);
    expect(short.ask).toBe(flat.ask + 50);
    expect(long.ask - long.bid).toBe(flat.ask - flat.bid);
    expect(long.fairPrice).toBe(flat.fairPrice);
    expect(long.size).toBe(flat.size);
  });
});

const config: EngineConfig = {
  contractMultiplier: 1,
  marginRatioBps: 1000,
  maxOrderQuantity: 1000,
  maxNetPosition: 1000,
  minConfidence: 0.4,
};

let nextId = 1;
const order = (isBid: boolean, price: number, quantity: number, status: OrderView['status'] = 'open'): OrderView => ({
  orderId: nextId++,
  marketId: 1,
  owner: 'alice.testnet',
  isBid,
  price,
  quantity,
  lockedMargin: '0',
  status,
});

function makeLayer(orders: OrderView[]) {
  const clock = { t: 1_000 };
  const calls: Array<{ limit?: number } | undefined> = [];
  const layer = new OnChainEngineLayer(
    config,
    {
      getOpenOrders: async (opts) => {
        calls.push(opts);
        return orders;
      },
    },
    () => clock.t,
  );
  return { layer, clock, calls };
}

describe('OnChainEngineLayer.getBook', () => {
  it('aggregates levels, bids descending and asks ascending', async () => {
    const { layer, calls } = makeLayer([
      order(true, 430, 10),
      order(true, 440, 5),
      order(true, 440, 7),
      order(false, 460, 3),
      order(false, 450, 4),
      order(false, 450, 6),
      order(true, 420, 9, 'cancelled'),
    ]);
    const book = await layer.getBook();

    expect(calls[0]).toEqual({ limit: 200 });
    expect(book.source).toBe('chain');
    expect(book.bids.map((l) => [l.price, l.quantity, l.orders])).toEqual([
      [440, 12, 2],
      [430, 10, 1],
    ]);
    expect(book.asks.map((l) => [l.price, l.quantity, l.orders])).toEqual([
      [450, 10, 2],
      [460, 3, 1],
    ]);
    expect(book.bestBid).toEqual({ price: 440, quantity: 12 });
    expect(book.bestAsk).toEqual({ price: 450, quantity: 10 });
  });

  it('returns an empty book with null bests', async () => {
    const { layer } = makeLayer([]);
    const book = await layer.getBook();
    expect(book.bestBid).toBeNull();
    expect(book.bestAsk).toBeNull();
    expect(book.bids).toEqual([]);
    expect(book.asks).toEqual([]);
  });

  it('caches for 4 seconds then refetches', async () => {
    const { layer, clock, calls } = makeLayer([order(true, 440, 1)]);
    await layer.getBook();
    clock.t += 3_999;
    await layer.getBook();
    expect(calls).toHaveLength(1);
    clock.t += 1;
    await layer.getBook();
    expect(calls).toHaveLength(2);
  });
});

describe('OnChainEngineLayer.quoteFromForecast', () => {
  const forecast = (confidence: number): ForecastDto =>
    ({
      market: 'EGSI-1H',
      expected_egsi: 441.2,
      confidence,
      p_tail_500: 0.21,
      model_version: 'egsi-v1.3',
    });

  it('returns null for no forecast or low confidence', () => {
    const { layer } = makeLayer([]);
    expect(layer.quoteFromForecast(null, 0)).toBeNull();
    expect(layer.quoteFromForecast(forecast(0.3), 0)).toBeNull();
  });

  it('returns an indicative quote', () => {
    const { layer } = makeLayer([]);
    const q = layer.quoteFromForecast(forecast(0.9), 0)!;
    expect(q.indicative).toBe(true);
    expect(q.fairPrice).toBe(441);
    // vol = 10 -> half spread 5 + round(5) = 10
    expect(q.bid).toBe(431);
    expect(q.ask).toBe(451);
    expect(q.size).toBe(5 + Math.round(((0.9 - 0.4) / 0.6) * 95));
  });
});

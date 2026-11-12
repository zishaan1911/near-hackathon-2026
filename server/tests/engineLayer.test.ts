import { describe, expect, it } from 'vitest';
import type { OrderView } from '@gasx/near-adapter';
import { OnChainEngineLayer, quoteFromIndex, type EngineConfig } from '../src/engineLayer.js';

const config: EngineConfig = {
  contractMultiplier: 1,
  marginRatioBps: 1000,
  maxOrderQuantity: 1000,
  maxNetPosition: 1000,
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

describe('quoteFromIndex', () => {
  it('returns null when the level is null', () => {
    expect(quoteFromIndex(null)).toBeNull();
    const { layer } = makeLayer([]);
    expect(layer.quoteFromIndex(null)).toBeNull();
  });

  it('quotes around the rounded level with a 0.25% half-spread and size 10', () => {
    const q = quoteFromIndex(441.2)!;
    expect(q.indicative).toBe(true);
    expect(q.fairPrice).toBe(441);
    // 441.2 * 0.0025 = 1.1 -> 1
    expect(q.bid).toBe(440);
    expect(q.ask).toBe(442);
    expect(q.size).toBe(10);

    const big = quoteFromIndex(1000)!;
    expect(big.bid).toBe(1000 - 3);
    expect(big.ask).toBe(1000 + 3);
  });

  it('uses at least one tick of half-spread', () => {
    const q = quoteFromIndex(100)!;
    expect(q.fairPrice - q.bid).toBe(1);
    expect(q.ask - q.fairPrice).toBe(1);
  });
});

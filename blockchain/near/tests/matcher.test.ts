import { describe, expect, it } from 'vitest';
import { findMatches, type OrderLike } from '../src/matcher.js';

const bid = (order_id: number, owner: string, price: number, quantity = 10): OrderLike => ({
  order_id,
  owner,
  is_bid: true,
  price,
  quantity,
});
const ask = (order_id: number, owner: string, price: number, quantity = 10): OrderLike => ({
  order_id,
  owner,
  is_bid: false,
  price,
  quantity,
});

describe('findMatches', () => {
  it('pairs a crossing bid and ask', () => {
    expect(findMatches([bid(1, 'a', 100), ask(2, 'b', 90)])).toEqual([{ buy: 1, sell: 2 }]);
  });

  it('pairs at equal prices', () => {
    expect(findMatches([bid(1, 'a', 100), ask(2, 'b', 100)])).toEqual([{ buy: 1, sell: 2 }]);
  });

  it('does not pair non-crossing orders', () => {
    expect(findMatches([bid(1, 'a', 90), ask(2, 'b', 100)])).toEqual([]);
  });

  it('does not pair mismatched quantities', () => {
    expect(findMatches([bid(1, 'a', 100, 10), ask(2, 'b', 90, 5)])).toEqual([]);
  });

  it('does not pair orders from the same owner', () => {
    expect(findMatches([bid(1, 'a', 100), ask(2, 'a', 90)])).toEqual([]);
  });

  it('prefers the best bid, then the oldest id', () => {
    const matches = findMatches([bid(1, 'a', 100), bid(2, 'b', 110), ask(3, 'c', 90)]);
    expect(matches).toEqual([{ buy: 2, sell: 3 }]);
    const tied = findMatches([bid(5, 'a', 100), bid(4, 'b', 100), ask(6, 'c', 90)]);
    expect(tied).toEqual([{ buy: 4, sell: 6 }]);
  });

  it('prefers the lowest ask, then the oldest id', () => {
    const matches = findMatches([bid(1, 'a', 100), ask(2, 'b', 95), ask(3, 'c', 90)]);
    expect(matches).toEqual([{ buy: 1, sell: 3 }]);
    const tied = findMatches([bid(1, 'a', 100), ask(3, 'b', 90), ask(2, 'c', 90)]);
    expect(tied).toEqual([{ buy: 1, sell: 2 }]);
  });

  it('uses each order at most once', () => {
    const matches = findMatches([
      bid(1, 'a', 100),
      bid(2, 'b', 100),
      ask(3, 'c', 90),
    ]);
    expect(matches).toEqual([{ buy: 1, sell: 3 }]);
  });

  it('matches several disjoint pairs in one pass', () => {
    const matches = findMatches([
      bid(1, 'a', 100),
      bid(2, 'b', 100),
      ask(3, 'c', 90),
      ask(4, 'd', 95),
    ]);
    expect(matches).toEqual([
      { buy: 1, sell: 3 },
      { buy: 2, sell: 4 },
    ]);
  });
});

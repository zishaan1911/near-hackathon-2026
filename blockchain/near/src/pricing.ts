/**
 * Pure pricing and matching helpers used by the cron tick (tick.ts): the
 * oracle price conversion and the crossing-order pairing. No I/O.
 */

/**
 * Converts an index level into the integer the contract accepts: rounded to
 * the nearest integer and clamped to [0, maxPrice]. Returns null for a score
 * that is not a finite, non-negative number (the caller skips the tick).
 */
export function toOraclePrice(score: number, maxPrice: number): number | null {
  if (typeof score !== 'number' || !Number.isFinite(score) || score < 0) return null;
  if (!Number.isFinite(maxPrice) || maxPrice < 0) return null;
  return Math.min(Math.max(Math.round(score), 0), Math.floor(maxPrice));
}

/** The subset of the contract's OrderView the matching step needs. */
export interface OrderLike {
  order_id: number;
  owner: string;
  is_bid: boolean;
  price: number;
  quantity: number;
}

/**
 * Finds crossing pairs: bid price >= ask price, equal quantity, different
 * owners. Bids are taken best (highest) price first, then oldest id; each is
 * paired with the best (lowest-priced, then oldest) eligible ask. Every order
 * is used at most once.
 */
export function findMatches(orders: OrderLike[]): Array<{ buy: number; sell: number }> {
  const bids = orders
    .filter((o) => o.is_bid)
    .sort((a, b) => b.price - a.price || a.order_id - b.order_id);
  const asks = orders
    .filter((o) => !o.is_bid)
    .sort((a, b) => a.price - b.price || a.order_id - b.order_id);

  const usedAsks = new Set<number>();
  const matches: Array<{ buy: number; sell: number }> = [];
  for (const bid of bids) {
    const ask = asks.find(
      (a) =>
        !usedAsks.has(a.order_id) &&
        a.price <= bid.price &&
        a.quantity === bid.quantity &&
        a.owner !== bid.owner,
    );
    if (!ask) continue;
    usedAsks.add(ask.order_id);
    matches.push({ buy: bid.order_id, sell: ask.order_id });
  }
  return matches;
}

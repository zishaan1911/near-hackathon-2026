/**
 * The off-chain depth and quote layer, in pure TypeScript.
 *
 * What this is NOT: a replacement for on-chain matching. The NEAR
 * contract remains authoritative for the order book, margin and
 * settlement - every real trade is still a transaction the user's wallet
 * signs. Nothing here moves money or is trusted for settlement.
 *
 * What it does:
 *
 *   1. **Depth** - aggregates the contract's real open orders into price
 *      levels. This is authoritative chain data (`source: 'chain'`), read
 *      through the ChainAdapter and cached briefly so UI polling does not
 *      become an RPC storm.
 *   2. **An indicative two-sided quote** around the live Compute Index
 *      level (see `quoteFromIndex`).
 *
 * Depth is real; quotes stay explicitly indicative. The label travels with
 * the data rather than living only in this comment.
 */
import type { ChainAdapter } from '@gasx/near-adapter';

export interface EngineConfig {
  contractMultiplier: number;
  marginRatioBps: number;
  maxOrderQuantity: number;
  maxNetPosition: number;
}

export interface IndicativeQuote {
  bid: number;
  ask: number;
  fairPrice: number;
  size: number;
  /** Always true. Present in the payload, not just the docs, so a
   * consumer cannot mistake this for an executable price. */
  indicative: true;
}

export interface BookLevel {
  price: number;
  quantity: number;
  /** Same value as quantity; the frontend reads depth as `size`. */
  size: number;
  /** Number of resting orders aggregated into this level. */
  orders: number;
}

export interface BestLevel {
  price: number;
  quantity: number;
}

export interface BookSnapshot {
  bestBid: BestLevel | null;
  bestAsk: BestLevel | null;
  /** Descending by price. */
  bids: BookLevel[];
  /** Ascending by price. */
  asks: BookLevel[];
  source: 'chain';
}

export interface EngineLayer {
  getBook(): Promise<BookSnapshot>;
  quoteFromIndex(level: number | null): IndicativeQuote | null;
}

const BOOK_CACHE_MS = 4000;
const BOOK_ORDER_LIMIT = 200;
const HALF_SPREAD_FRACTION = 0.0025;
const QUOTE_SIZE = 10;

export class OnChainEngineLayer implements EngineLayer {
  private cache: { at: number; book: BookSnapshot } | null = null;

  constructor(
    _config: EngineConfig,
    private readonly chain: Pick<ChainAdapter, 'getOpenOrders'>,
    private readonly now: () => number = Date.now,
  ) {}

  async getBook(): Promise<BookSnapshot> {
    const t = this.now();
    if (this.cache && t - this.cache.at < BOOK_CACHE_MS) return this.cache.book;

    const orders = await this.chain.getOpenOrders({ limit: BOOK_ORDER_LIMIT });
    const bidMap = new Map<number, BookLevel>();
    const askMap = new Map<number, BookLevel>();
    for (const order of orders) {
      if (order.status !== 'open' || order.quantity <= 0) continue;
      const map = order.isBid ? bidMap : askMap;
      const level = map.get(order.price);
      if (level) {
        level.quantity += order.quantity;
        level.size += order.quantity;
        level.orders += 1;
      } else {
        map.set(order.price, { price: order.price, quantity: order.quantity, size: order.quantity, orders: 1 });
      }
    }

    const bids = [...bidMap.values()].sort((a, b) => b.price - a.price);
    const asks = [...askMap.values()].sort((a, b) => a.price - b.price);
    const book: BookSnapshot = {
      bestBid: bids[0] ? { price: bids[0].price, quantity: bids[0].quantity } : null,
      bestAsk: asks[0] ? { price: asks[0].price, quantity: asks[0].quantity } : null,
      bids,
      asks,
      source: 'chain',
    };
    this.cache = { at: t, book };
    return book;
  }

  /**
   * Indicative quote around the live index level: fair price is the rounded
   * level, half-spread is 0.25% of the level (at least 1 tick), size is
   * fixed at 10. Null when the level is unavailable.
   */
  quoteFromIndex(level: number | null): IndicativeQuote | null {
    return quoteFromIndex(level);
  }
}

/** Pure form of {@link OnChainEngineLayer.quoteFromIndex}. */
export function quoteFromIndex(level: number | null): IndicativeQuote | null {
  if (level === null || !Number.isFinite(level)) return null;
  const fairPrice = Math.round(level);
  const halfSpread = Math.max(1, Math.round(level * HALF_SPREAD_FRACTION));
  return {
    bid: fairPrice - halfSpread,
    ask: fairPrice + halfSpread,
    fairPrice,
    size: QUOTE_SIZE,
    indicative: true,
  };
}

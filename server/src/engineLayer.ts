/**
 * The off-chain depth and quote layer, in pure TypeScript.
 *
 * What this is NOT: a replacement for on-chain matching. The NEAR
 * contract remains authoritative for the order book, margin and
 * settlement — every real trade is still a transaction the user's wallet
 * signs. Nothing here moves money or is trusted for settlement.
 *
 * What it does:
 *
 *   1. **Depth** — aggregates the contract's real open orders into price
 *      levels. This is authoritative chain data (`source: 'chain'`), read
 *      through the ChainAdapter and cached briefly so UI polling does not
 *      become an RPC storm.
 *   2. **A two-sided quote** derived from the AI forecast — a port of the
 *      former C++ QuoteEngine: spread widening with volatility, size
 *      scaling with confidence, refusal below a confidence floor.
 *
 * Depth is real; quotes stay explicitly indicative. A quote is a model's
 * suggestion, not an executable price, so the label travels with the data
 * rather than living only in this comment.
 */
import type { ChainAdapter } from '@gasx/near-adapter';
import type { ForecastDto } from './aiClient.js';

export interface EngineConfig {
  contractMultiplier: number;
  marginRatioBps: number;
  maxOrderQuantity: number;
  maxNetPosition: number;
  minConfidence: number;
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
  quoteFromForecast(forecast: ForecastDto | null, netPosition: number): IndicativeQuote | null;
}

/** Fixed pricing constants, carried over from the C++ engine wiring. */
export interface PricingConfig {
  priceScale: number;
  baseHalfSpread: number;
  volatilitySpreadMultiplier: number;
  minConfidence: number;
  maxQuoteSize: number;
  minQuoteSize: number;
  inventorySkewPerUnit: number;
}

export interface ModelQuoteInput {
  expectedValue: number;
  volatility: number;
  confidence: number;
}

export interface ComputedQuote {
  fairPrice: number;
  bid: number;
  ask: number;
  size: number;
}

/** C++ std::llround: round half away from zero. */
function llround(x: number): number {
  return x < 0 ? -Math.round(-x) : Math.round(x);
}

/**
 * Pure port of QuoteEngine::compute_quote. Returns null when confidence
 * is below the floor — no quote is the honest answer.
 */
export function computeQuote(
  input: ModelQuoteInput,
  config: PricingConfig,
  netPosition = 0,
): ComputedQuote | null {
  if (input.confidence < config.minConfidence) return null;

  const fairPrice = llround(input.expectedValue * config.priceScale);
  const halfSpread = config.baseHalfSpread + llround(input.volatility * config.volatilitySpreadMultiplier);

  // Positive netPosition (long) skews the center down; negative skews up.
  // fairPrice itself stays the model's unskewed view.
  const skew = netPosition * config.inventorySkewPerUnit;
  const bid = fairPrice - halfSpread - skew;
  const ask = fairPrice + halfSpread - skew;

  // Linear interpolation of size between min (at the floor) and max (at 1.0).
  const span = 1 - config.minConfidence;
  const t = span > 0 ? (input.confidence - config.minConfidence) / span : 1;
  const clampedT = Math.min(1, Math.max(0, t));
  const size = config.minQuoteSize + llround(clampedT * (config.maxQuoteSize - config.minQuoteSize));

  return { fairPrice, bid, ask, size };
}

const BOOK_CACHE_MS = 4000;
const BOOK_ORDER_LIMIT = 200;

export class OnChainEngineLayer implements EngineLayer {
  private readonly pricing: PricingConfig;
  private cache: { at: number; book: BookSnapshot } | null = null;

  constructor(
    config: EngineConfig,
    private readonly chain: Pick<ChainAdapter, 'getOpenOrders'>,
    private readonly now: () => number = Date.now,
  ) {
    this.pricing = {
      // EGSI is already an integer 0-1000 index, so no rescaling.
      priceScale: 1,
      baseHalfSpread: 5,
      volatilitySpreadMultiplier: 0.5,
      minConfidence: config.minConfidence,
      maxQuoteSize: 100,
      minQuoteSize: 5,
      inventorySkewPerUnit: 0,
    };
  }

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
   * Turns the AI service's forecast into a two-sided quote. Returns null
   * when below the confidence floor; that refusal is not overridden.
   */
  quoteFromForecast(forecast: ForecastDto | null, netPosition: number): IndicativeQuote | null {
    if (!forecast) return null;

    const result = computeQuote(
      {
        expectedValue: forecast.expected_egsi,
        // The forecast carries no explicit volatility, so it is derived
        // from confidence: a less confident forecast implies a wider
        // plausible range. Crude, and stated as such.
        volatility: (1 - forecast.confidence) * 100,
        confidence: forecast.confidence,
      },
      this.pricing,
      netPosition,
    );
    if (!result) return null;
    return { bid: result.bid, ask: result.ask, fairPrice: result.fairPrice, size: result.size, indicative: true };
  }
}

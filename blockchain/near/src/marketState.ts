/**
 * Reads and parses the Silica contract's `get_market` / `get_oracle` views
 * (docs/near-abi.md) into the adapter's MarketState/OracleState (types.ts), plus
 * the order/trade/account views.
 *
 * parseMarketView/parseOracleView/parseOrderView/parseTradeView are pure —
 * no network — so they're fully unit-testable against synthetic fixtures
 * shaped like the ABI's JSON. fetchMarketState is the thin network
 * wrapper. u64 values are JSON numbers per the ABI; the helpers also
 * accept numeric strings defensively. U128 amounts must be decimal
 * strings and stay strings.
 */
import { viewCall } from './client.js';
import type { NearAdapterConfig } from './config.js';
import type { AccountView, MarketState, MarketSummary, OracleState, OrderStatus, OrderView, TradeView } from './types.js';

type ViewJson = Record<string, unknown>;

function viewObject(value: unknown, what: string): ViewJson {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as ViewJson;
  throw new Error(`expected ${what} to be a JSON object, got ${JSON.stringify(value)}`);
}

function viewU64(value: unknown, field: string): number {
  if (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  throw new Error(`expected a u64-like value for '${field}', got ${JSON.stringify(value)}`);
}

function viewU128(value: unknown, field: string): string {
  if (typeof value === 'string' && /^\d+$/.test(value)) return value;
  throw new Error(`expected a U128 decimal string for '${field}', got ${JSON.stringify(value)}`);
}

function viewBool(value: unknown, field: string): boolean {
  if (typeof value === 'boolean') return value;
  throw new Error(`expected a bool value for '${field}', got ${JSON.stringify(value)}`);
}

function viewString(value: unknown, field: string): string {
  if (typeof value === 'string') return value;
  throw new Error(`expected a string value for '${field}', got ${JSON.stringify(value)}`);
}

/**
 * Parses the contract's MarketView. `settled` false leaves
 * settlementPrice null rather than reading the field, which is
 * meaningless before settlement. `marketId` becomes
 * `"<contractId>#<market_id>"`.
 */
export function parseMarketView(
  view: unknown,
  contractId: string,
): Omit<MarketState, 'oracle' | 'devMode' | 'network'> {
  const fields = viewObject(view, 'MarketView');
  const settled = viewBool(fields.settled, 'settled');
  const marketNumber = viewU64(fields.market_id, 'market_id');
  let settlementPrice: number | null = null;
  if (settled) {
    if (fields.settlement_price === null || fields.settlement_price === undefined) {
      throw new Error("market is settled but 'settlement_price' is null");
    }
    settlementPrice = viewU64(fields.settlement_price, 'settlement_price');
  }
  return {
    marketId: `${contractId}#${marketNumber}`,
    underlying: viewString(fields.underlying, 'underlying'),
    expiryMs: viewU64(fields.expiry_ms, 'expiry_ms'),
    contractMultiplier: viewU64(fields.contract_multiplier, 'contract_multiplier'),
    tickSize: viewU64(fields.tick_size, 'tick_size'),
    marginRatioBps: viewU64(fields.margin_ratio_bps, 'margin_ratio_bps'),
    paused: viewBool(fields.paused, 'paused'),
    settled,
    settlementPrice,
  };
}

/** Parses the contract's OracleView. `nowMs` is injectable for
 * deterministic tests; defaults to the real clock. */
export function parseOracleView(
  view: unknown,
  contractId: string,
  nowMs: number = Date.now(),
): OracleState {
  const fields = viewObject(view, 'OracleView');
  const hasPrice = viewBool(fields.has_price, 'has_price');
  const lastUpdateMs = viewU64(fields.last_update_ms, 'last_update_ms');
  const maxStalenessMs = viewU64(fields.max_staleness_ms, 'max_staleness_ms');
  return {
    oracleId: contractId,
    price: viewU64(fields.price, 'price'),
    hasPrice,
    lastUpdateMs,
    maxStalenessMs,
    maxPrice: viewU64(fields.max_price, 'max_price'),
    isFreshApprox: hasPrice && nowMs - lastUpdateMs <= maxStalenessMs,
  };
}

function viewOrderStatus(value: unknown): OrderStatus {
  if (value === 'open' || value === 'filled' || value === 'cancelled') return value;
  throw new Error(`expected order 'status' to be open/filled/cancelled, got ${JSON.stringify(value)}`);
}

export function parseOrderView(view: unknown): OrderView {
  const fields = viewObject(view, 'OrderView');
  return {
    orderId: viewU64(fields.order_id, 'order_id'),
    marketId: viewU64(fields.market_id, 'market_id'),
    owner: viewString(fields.owner, 'owner'),
    isBid: viewBool(fields.is_bid, 'is_bid'),
    price: viewU64(fields.price, 'price'),
    quantity: viewU64(fields.quantity, 'quantity'),
    lockedMargin: viewU128(fields.locked_margin, 'locked_margin'),
    status: viewOrderStatus(fields.status),
  };
}

export function parseTradeView(view: unknown): TradeView {
  const fields = viewObject(view, 'TradeView');
  return {
    tradeId: viewU64(fields.trade_id, 'trade_id'),
    marketId: viewU64(fields.market_id, 'market_id'),
    buyer: viewString(fields.buyer, 'buyer'),
    seller: viewString(fields.seller, 'seller'),
    price: viewU64(fields.price, 'price'),
    quantity: viewU64(fields.quantity, 'quantity'),
    buyerCommitted: viewU128(fields.buyer_committed, 'buyer_committed'),
    sellerCommitted: viewU128(fields.seller_committed, 'seller_committed'),
    buyerClaimed: viewBool(fields.buyer_claimed, 'buyer_claimed'),
    sellerClaimed: viewBool(fields.seller_claimed, 'seller_claimed'),
  };
}

export function parseAccountView(view: unknown): AccountView {
  const fields = viewObject(view, 'account view');
  return {
    available: viewU128(fields.available, 'available'),
    locked: viewU128(fields.locked, 'locked'),
  };
}

export function parseOrderViews(views: unknown): OrderView[] {
  if (!Array.isArray(views)) throw new Error(`expected an OrderView array, got ${JSON.stringify(views)}`);
  return views.map(parseOrderView);
}

export function parseTradeViews(views: unknown): TradeView[] {
  if (!Array.isArray(views)) throw new Error(`expected a TradeView array, got ${JSON.stringify(views)}`);
  return views.map(parseTradeView);
}

/** Reads market marketNumber via get_market { market_id }. Null when the market does not exist. */
export async function fetchMarketSummary(config: NearAdapterConfig, marketNumber: number): Promise<MarketSummary | null> {
  let view: unknown;
  try {
    view = await viewCall<unknown>(config, config.contractId, 'get_market', { market_id: marketNumber });
  } catch (err) {
    // A contract panic for an unknown id is a normal "no such market".
    if (err instanceof Error && /failed:/.test(err.message)) return null;
    throw err;
  }
  if (view === null || view === undefined) return null;
  const m = parseMarketView(view, config.contractId);
  return {
    marketNumber,
    underlying: m.underlying,
    expiryMs: m.expiryMs,
    settled: m.settled,
    settlementPrice: m.settlementPrice,
  };
}

/** Fetches and parses both the market and the oracle in parallel. */
export async function fetchMarketState(config: NearAdapterConfig): Promise<MarketState> {
  const [marketView, oracleView] = await Promise.all([
    viewCall<unknown>(config, config.contractId, 'get_market', {}),
    viewCall<unknown>(config, config.contractId, 'get_oracle', {}),
  ]);
  return {
    ...parseMarketView(marketView, config.contractId),
    oracle: parseOracleView(oracleView, config.contractId),
    network: config.network,
  };
}

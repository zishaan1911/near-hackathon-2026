/**
 * The adapter's own view of NEAR: an adapter, not a leaky wrapper.
 * Everything here is shaped for the server's routes; the contract's
 * snake_case JSON views (docs/near-abi.md) don't cross this boundary.
 */

/** Live state of the SCI-1H market: GET /api/v1/market's chain half
 * (the on-chain config + oracle half; the orderbook comes from elsewhere). */
export interface MarketState {
  /** `"<contractId>#<market_id>"` — the contract account plus the
   * contract's numbered market. */
  marketId: string;
  underlying: string;
  expiryMs: number;
  contractMultiplier: number;
  tickSize: number;
  marginRatioBps: number;
  paused: boolean;
  settled: boolean;
  /** Only meaningful when settled is true. */
  settlementPrice: number | null;
  oracle: OracleState;
  /** True when this is the synthetic dev market (devMarket.ts), not a
   * read from chain — the UI should label it as such. */
  devMode?: boolean;
  /** The NEAR network the (real) market lives on. */
  network?: string;
}

export interface OracleState {
  /** The Silica contract account id — the oracle lives inside it. */
  oracleId: string;
  price: number;
  hasPrice: boolean;
  lastUpdateMs: number;
  maxStalenessMs: number;
  /** A published price above this is rejected on-chain (update_price) —
   * the index scale's actual enforced ceiling. */
  maxPrice: number;
  /** Computed client-side from lastUpdateMs/maxStalenessMs against the
   * time the read happened — not read from chain. An approximation for
   * display, not something settlement/margin logic should ever trust. */
  isFreshApprox: boolean;
}

/** One numbered market read by id (GET get_market { market_id }). */
export interface MarketSummary {
  marketNumber: number;
  underlying: string;
  expiryMs: number;
  settled: boolean;
  /** Null until settled. */
  settlementPrice: number | null;
}

export type OrderStatus = 'open' | 'filled' | 'cancelled';

/** The contract's OrderView in camelCase. Amounts stay decimal strings. */
export interface OrderView {
  orderId: number;
  marketId: number;
  owner: string;
  isBid: boolean;
  price: number;
  quantity: number;
  lockedMargin: string;
  status: OrderStatus;
}

/** The contract's TradeView in camelCase. Amounts stay decimal strings. */
export interface TradeView {
  tradeId: number;
  marketId: number;
  buyer: string;
  seller: string;
  price: number;
  quantity: number;
  buyerCommitted: string;
  sellerCommitted: string;
  buyerClaimed: boolean;
  sellerClaimed: boolean;
}

export interface AccountView {
  /** U128 decimal string, collateral token base units. */
  available: string;
  /** U128 decimal string, collateral token base units. */
  locked: string;
}

/** A transaction built server-side, ready for a wallet to sign via
 * `wallet.signAndSendTransaction({ receiverId, actions })` — this adapter
 * never signs anything itself. `summary` restates the key parameters in
 * plain fields so a caller (or the person, via the frontend) can
 * sanity-check what they're about to sign. `gas` and `deposit` are
 * strings in base units (gas units / yoctoNEAR). */
export interface PreparedTransaction {
  receiverId: string;
  actions: Array<{
    type: 'FunctionCall';
    params: {
      methodName: string;
      args: Record<string, unknown>;
      gas: string;
      deposit: string;
    };
  }>;
  summary: Record<string, string | number | boolean>;
}

export interface PageOptions {
  fromIndex?: number;
  limit?: number;
}

export interface DepositParams {
  trader: string;
  /** U128 decimal string, collateral token base units. */
  amount: string;
}

export interface WithdrawParams {
  trader: string;
  /** U128 decimal string, collateral token base units. */
  amount: string;
}

export interface PlaceOrderParams {
  trader: string;
  isBid: boolean;
  price: number;
  quantity: number;
}

export interface CancelOrderParams {
  trader: string;
  orderId: number;
}

export interface ClaimParams {
  trader: string;
  tradeId: number;
}

/** The narrow view of NEAR. Implemented by NearChainAdapter; tests use
 * synthetic ABI JSON fixtures for the pure parsing logic and never touch
 * a live network. */
export interface ChainAdapter {
  getMarketState(): Promise<MarketState>;
  /** Reads market marketNumber (1..current). Null when it does not exist or in dev-market mode. */
  getMarketById(marketNumber: number): Promise<MarketSummary | null>;
  getAccount(accountId: string): Promise<AccountView>;
  getOpenOrders(opts?: PageOptions): Promise<OrderView[]>;
  getOrdersByAccount(accountId: string, opts?: PageOptions): Promise<OrderView[]>;
  getTradesByAccount(accountId: string, opts?: PageOptions): Promise<TradeView[]>;
  prepareDeposit(params: DepositParams): Promise<PreparedTransaction>;
  prepareWithdraw(params: WithdrawParams): Promise<PreparedTransaction>;
  preparePlaceOrder(params: PlaceOrderParams): Promise<PreparedTransaction>;
  prepareCancelOrder(params: CancelOrderParams): Promise<PreparedTransaction>;
  prepareClaim(params: ClaimParams): Promise<PreparedTransaction>;
}

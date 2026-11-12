/**
 * Public surface of GASX's NEAR adapter. Only GASX-shaped types
 * (types.ts), the NearChainAdapter class and the read helper the
 * publisher/matcher services share are exported.
 */
export type {
  AccountView,
  CancelOrderParams,
  ChainAdapter,
  ClaimParams,
  DepositParams,
  MarketState,
  MarketSummary,
  OracleState,
  OrderStatus,
  OrderView,
  PageOptions,
  PlaceOrderParams,
  PreparedTransaction,
  TradeView,
  WithdrawParams,
} from './types.js';
export { loadConfigFromEnv, type NearAdapterConfig } from './config.js';
export { DevMarketUnavailableError, NearChainAdapter } from './nearAdapter.js';
export { viewCall } from './client.js';
export { fetchDevMarketState } from './devMarket.js';
export { createSigner } from './signer.js';
export { findMatches, type OrderLike } from './matcher.js';
export { toOraclePrice } from './publisher.js';
export { nextExpiryMs, runTick, type TickContext, type TickReport, type ViewFn } from './tick.js';

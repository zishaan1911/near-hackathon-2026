/**
 * Public surface of the Silica NEAR adapter: the adapter's own types
 * (types.ts), the NearChainAdapter class, the read helper and the cron tick.
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
export { readEnv, type EnvSource } from './env.js';
export { findMatches, toOraclePrice, type OrderLike } from './pricing.js';
export { nextExpiryMs, runTick, type TickContext, type TickReport, type ViewFn } from './tick.js';

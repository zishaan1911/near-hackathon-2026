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

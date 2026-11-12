/**
 * NearChainAdapter: the concrete ChainAdapter (types.ts) — reads the gasx
 * contract over JSON-RPC (client.ts) and exposes only GASX-shaped types.
 * Composes fetchMarketState/parse* (marketState.ts) and the build*
 * functions (actionBuilders.ts). In dev-market mode (config.devMarket,
 * devMarket.ts) it serves the synthetic market, returns empty reads, and
 * refuses to prepare transactions, because there is no on-chain market to
 * sign for.
 */
import {
  buildCancelOrder,
  buildClaim,
  buildDeposit,
  buildPlaceOrder,
  buildWithdraw,
} from './actionBuilders.js';
import { viewCall } from './client.js';
import type { NearAdapterConfig } from './config.js';
import { fetchDevMarketState } from './devMarket.js';
import {
  fetchMarketState,
  parseAccountView,
  parseOrderViews,
  parseTradeViews,
} from './marketState.js';
import type {
  AccountView,
  CancelOrderParams,
  ChainAdapter,
  ClaimParams,
  DepositParams,
  MarketState,
  OrderView,
  PageOptions,
  PlaceOrderParams,
  PreparedTransaction,
  TradeView,
  WithdrawParams,
} from './types.js';

/** Thrown by prepare* in dev-market mode. The gateway maps it to a 503
 * with the same message so the UI can explain why orders are off. */
export class DevMarketUnavailableError extends Error {
  constructor() {
    super(
      'The Silica contract is not deployed — running in dev-market mode. ' +
        'Orders need GASX_NEAR_CONTRACT_ID and GASX_NEAR_COLLATERAL_TOKEN set ' +
        '(see blockchain/near/.env.example).',
    );
    this.name = 'DevMarketUnavailableError';
  }
}

function pageArgs(opts?: PageOptions): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  if (opts?.fromIndex !== undefined) args.from_index = opts.fromIndex;
  if (opts?.limit !== undefined) args.limit = opts.limit;
  return args;
}

export class NearChainAdapter implements ChainAdapter {
  private readonly config: NearAdapterConfig;

  constructor(config: NearAdapterConfig) {
    this.config = config;
    if (config.devMarket) {
      console.warn(
        '[silica/near-adapter] dev-market mode: serving a synthetic market; ' +
          'no transactions can be prepared. Set GASX_NEAR_DEV_MARKET=false once deployed.',
      );
    }
  }

  getMarketState(): Promise<MarketState> {
    return this.config.devMarket
      ? Promise.resolve(fetchDevMarketState(this.config))
      : fetchMarketState(this.config);
  }

  async getAccount(accountId: string): Promise<AccountView> {
    if (this.config.devMarket) return { available: '0', locked: '0' };
    const view = await viewCall<unknown>(this.config, this.config.contractId, 'get_account', {
      account_id: accountId,
    });
    return parseAccountView(view);
  }

  async getOpenOrders(opts?: PageOptions): Promise<OrderView[]> {
    if (this.config.devMarket) return [];
    const views = await viewCall<unknown>(this.config, this.config.contractId, 'get_open_orders', pageArgs(opts));
    return parseOrderViews(views);
  }

  async getOrdersByAccount(accountId: string, opts?: PageOptions): Promise<OrderView[]> {
    if (this.config.devMarket) return [];
    const views = await viewCall<unknown>(this.config, this.config.contractId, 'get_orders_by_account', {
      account_id: accountId,
      ...pageArgs(opts),
    });
    return parseOrderViews(views);
  }

  async getTradesByAccount(accountId: string, opts?: PageOptions): Promise<TradeView[]> {
    if (this.config.devMarket) return [];
    const views = await viewCall<unknown>(this.config, this.config.contractId, 'get_trades_by_account', {
      account_id: accountId,
      ...pageArgs(opts),
    });
    return parseTradeViews(views);
  }

  prepareDeposit(params: DepositParams): Promise<PreparedTransaction> {
    if (this.config.devMarket) throw new DevMarketUnavailableError();
    return Promise.resolve(buildDeposit(this.config, params));
  }

  prepareWithdraw(params: WithdrawParams): Promise<PreparedTransaction> {
    if (this.config.devMarket) throw new DevMarketUnavailableError();
    return Promise.resolve(buildWithdraw(this.config, params));
  }

  preparePlaceOrder(params: PlaceOrderParams): Promise<PreparedTransaction> {
    if (this.config.devMarket) throw new DevMarketUnavailableError();
    return Promise.resolve(buildPlaceOrder(this.config, params));
  }

  prepareCancelOrder(params: CancelOrderParams): Promise<PreparedTransaction> {
    if (this.config.devMarket) throw new DevMarketUnavailableError();
    return Promise.resolve(buildCancelOrder(this.config, params));
  }

  prepareClaim(params: ClaimParams): Promise<PreparedTransaction> {
    if (this.config.devMarket) throw new DevMarketUnavailableError();
    return Promise.resolve(buildClaim(this.config, params));
  }
}

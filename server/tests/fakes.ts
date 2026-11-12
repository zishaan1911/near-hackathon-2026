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
} from '@gasx/near-adapter';
import type { CciResponse } from '../src/compute/service.js';

export function makeMarketState(overrides: Partial<MarketState> = {}): MarketState {
  return {
    marketId: 'gasx.testnet#1',
    underlying: 'CCI-1H',
    expiryMs: 1_700_000_000_000,
    contractMultiplier: 10,
    tickSize: 10,
    marginRatioBps: 1000,
    paused: false,
    settled: false,
    settlementPrice: null,
    oracle: {
      oracleId: 'gasx.testnet',
      price: 441,
      hasPrice: true,
      lastUpdateMs: 1_700_000_000_000,
      maxStalenessMs: 60_000,
      maxPrice: 1000,
      isFreshApprox: true,
    },
    ...overrides,
  };
}

export function makeOrderView(overrides: Partial<OrderView> = {}): OrderView {
  return {
    orderId: 7,
    marketId: 1,
    owner: 'alice.testnet',
    isBid: true,
    price: 500,
    quantity: 10,
    lockedMargin: '50000000',
    status: 'open',
    ...overrides,
  };
}

export function makeTradeView(overrides: Partial<TradeView> = {}): TradeView {
  return {
    tradeId: 4,
    marketId: 1,
    buyer: 'alice.testnet',
    seller: 'bob.testnet',
    price: 500,
    quantity: 10,
    buyerCommitted: '50000000',
    sellerCommitted: '50000000',
    buyerClaimed: false,
    sellerClaimed: false,
    ...overrides,
  };
}

export class FakeChainAdapter implements ChainAdapter {
  marketState: MarketState = makeMarketState();
  getMarketStateError: Error | null = null;
  account: AccountView = { available: '0', locked: '0' };
  openOrders: OrderView[] = [];
  accountOrders: OrderView[] = [];
  accountTrades: TradeView[] = [];
  lastAccountId: string | null = null;
  lastPreparePlaceOrderParams: PlaceOrderParams | null = null;
  lastPrepareCancelOrderParams: CancelOrderParams | null = null;
  lastPrepareDepositParams: DepositParams | null = null;
  lastPrepareWithdrawParams: WithdrawParams | null = null;
  lastPrepareClaimParams: ClaimParams | null = null;

  async getMarketState(): Promise<MarketState> {
    if (this.getMarketStateError) throw this.getMarketStateError;
    return this.marketState;
  }

  async getAccount(accountId: string): Promise<AccountView> {
    this.lastAccountId = accountId;
    return this.account;
  }

  async getOpenOrders(_opts?: PageOptions): Promise<OrderView[]> {
    return this.openOrders;
  }

  async getOrdersByAccount(accountId: string, _opts?: PageOptions): Promise<OrderView[]> {
    this.lastAccountId = accountId;
    return this.accountOrders;
  }

  async getTradesByAccount(accountId: string, _opts?: PageOptions): Promise<TradeView[]> {
    this.lastAccountId = accountId;
    return this.accountTrades;
  }

  async prepareDeposit(params: DepositParams): Promise<PreparedTransaction> {
    this.lastPrepareDepositParams = params;
    return fakePrepared({ action: 'deposit', amount: params.amount });
  }

  async prepareWithdraw(params: WithdrawParams): Promise<PreparedTransaction> {
    this.lastPrepareWithdrawParams = params;
    return fakePrepared({ action: 'withdraw', amount: params.amount });
  }

  async preparePlaceOrder(params: PlaceOrderParams): Promise<PreparedTransaction> {
    this.lastPreparePlaceOrderParams = params;
    return fakePrepared({
      action: 'place_order',
      side: params.isBid ? 'bid' : 'ask',
      price: params.price,
      quantity: params.quantity,
    });
  }

  async prepareCancelOrder(params: CancelOrderParams): Promise<PreparedTransaction> {
    this.lastPrepareCancelOrderParams = params;
    return fakePrepared({ action: 'cancel_order', orderId: params.orderId });
  }

  async prepareClaim(params: ClaimParams): Promise<PreparedTransaction> {
    this.lastPrepareClaimParams = params;
    return fakePrepared({ action: 'claim', tradeId: params.tradeId });
  }
}

function fakePrepared(summary: PreparedTransaction['summary']): PreparedTransaction {
  return {
    receiverId: 'gasx.testnet',
    actions: [
      {
        type: 'FunctionCall',
        params: { methodName: String(summary.action), args: {}, gas: '30000000000000', deposit: '0' },
      },
    ],
    summary,
  };
}

export function makeCciResponse(level: number | null = 1042.6): CciResponse {
  const component = (
    id: string,
    label: string,
    effectiveWeight: number,
    status: 'ok' | 'down' = 'ok',
  ) =>
    ({
      id,
      label,
      unit: '$',
      source: 'test',
      nominalWeight: effectiveWeight,
      effectiveWeight,
      value: 1,
      baseValue: 1,
      relative: 1.04,
      contributionPoints: 40,
      status,
      level: status === 'ok' ? 1040 : null,
    }) as unknown as CciResponse['components'][number];
  return {
    index: {
      id: 'CCI',
      name: 'Congest Compute Index',
      level,
      base: 1000,
      baseDate: '2026-11-01',
      asOf: '2026-11-10T12:00:00.000Z',
      degraded: false,
      methodologyVersion: '2.0',
    },
    components: [
      component('gpu_rental', 'GPU rental', 0.35),
      component('blockspace', 'Ethereum blockspace', 0.05, 'down'),
    ],
    gpus: [],
  };
}

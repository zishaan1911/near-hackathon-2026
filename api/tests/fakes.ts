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
import type { AiClient, EgsiSnapshotDto, ForecastDto, RunCycleInput } from '../src/aiClient.js';

export function makeMarketState(overrides: Partial<MarketState> = {}): MarketState {
  return {
    marketId: 'gasx.testnet#1',
    underlying: 'EGSI-1H',
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

export class FakeAiClient implements AiClient {
  currentEgsi: EgsiSnapshotDto | null = null;
  forecast: ForecastDto | null = null;
  runCycleError: Error | null = null;
  lastRunCycleInput: RunCycleInput | undefined;
  runCycleResult: EgsiSnapshotDto = makeEgsiSnapshot();

  async getCurrentEgsi(): Promise<EgsiSnapshotDto | null> {
    return this.currentEgsi;
  }

  async getForecast(): Promise<ForecastDto | null> {
    return this.forecast;
  }

  restoredScores: number[] | null = null;

  async restoreHistory(scores: number[]): Promise<number | null> {
    this.restoredScores = scores;
    return scores.length;
  }

  async runCycle(input?: RunCycleInput): Promise<EgsiSnapshotDto> {
    if (this.runCycleError) throw this.runCycleError;
    this.lastRunCycleInput = input;
    return this.runCycleResult;
  }
}

export function makeEgsiSnapshot(overrides: Partial<EgsiSnapshotDto> = {}): EgsiSnapshotDto {
  return {
    market: 'EGSI-1H',
    score: 441,
    components: {
      base_fee: 0.4,
      utilization: 0.5,
      mempool_pressure: 0.3,
      fee_momentum: 0.2,
      gas_volatility: 0.1,
      dex_activity: 0.3,
      thetanuts_iv: null,
    },
    block_number: 12345,
    timestamp: 1_700_000_000,
    ...overrides,
  };
}

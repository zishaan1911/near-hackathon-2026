import type { FunctionCallAction } from '@near-wallet-selector/core';

export type JsonObject = Record<string, unknown>;

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface MarketSnapshot {
  raw: JsonObject;
  egsi: {
    score: number;
    components: Record<string, number>;
    timestamp?: number;
  };
  forecast: {
    expected: number;
    confidence: number;
    tailProbability: number;
    modelVersion: string;
    fallback: boolean;
  };
  market: {
    id: string;
    label: string;
    expiryMs?: number;
    tickSize?: number;
    contractMultiplier?: number;
    marginRate?: number;
    devMode: boolean;
    oracleHasPrice: boolean;
    oraclePrice: number;
    oracleFresh: boolean;
    settled: boolean;
  };
  quote: {
    bid?: number;
    ask?: number;
    mid?: number;
  };
  orderbook: {
    asks: Array<{ price: number; size: number }>;
    bids: Array<{ price: number; size: number }>;
    indicative: boolean;
  };
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rec(value: unknown): JsonObject {
  return isRecord(value) ? value : {};
}

function first(obj: JsonObject, keys: string[]): unknown {
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null) return obj[key];
  }
  return undefined;
}

function num(obj: JsonObject, keys: string[], fallback = 0): number {
  const value = first(obj, keys);
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function str(obj: JsonObject, keys: string[], fallback = ''): string {
  const value = first(obj, keys);
  return typeof value === 'string' && value.length ? value : fallback;
}

function bool(obj: JsonObject, keys: string[], fallback = false): boolean {
  const value = first(obj, keys);
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 1) return true;
  if (value === 'false' || value === 0) return false;
  return fallback;
}

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });

  const text = await response.text();
  let payload: unknown = null;

  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { message: text };
    }
  }

  if (!response.ok) {
    const message = isRecord(payload)
      ? str(payload, ['message', 'error', 'detail'], `${response.status} ${response.statusText}`)
      : `${response.status} ${response.statusText}`;

    const error = new Error(message) as Error & {
      status?: number;
      payload?: unknown;
    };

    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  return payload;
}

function normaliseLevels(value: unknown): Array<{ price: number; size: number }> {
  if (!Array.isArray(value)) return [];

  return value.flatMap((item) => {
    if (Array.isArray(item) && item.length >= 2) {
      const price = Number(item[0]);
      const size = Number(item[1]);

      return Number.isFinite(price) && Number.isFinite(size)
        ? [{ price, size }]
        : [];
    }

    const row = rec(item);
    const price = num(row, ['price', 'px'], Number.NaN);
    const size = num(row, ['size', 'qty', 'quantity'], Number.NaN);

    return Number.isFinite(price) && Number.isFinite(size)
      ? [{ price, size }]
      : [];
  });
}

export function normaliseMarket(payload: unknown): MarketSnapshot {
  const root = rec(payload);
  const egsi = rec(first(root, ['egsi', 'index', 'gas_stress']));
  const forecast = rec(first(root, ['forecast', 'ai_forecast']));
  const market = rec(first(root, ['market', 'instrument']));
  const quote = rec(first(root, ['quote', 'pricing']));
  const orderbook = rec(first(root, ['orderbook', 'book', 'depth']));
  const oracleObj = rec(first(market, ['oracle']));
  const componentsRaw = rec(first(egsi, ['components', 'drivers', 'inputs']));

  const components: Record<string, number> = {};

  Object.entries(componentsRaw).forEach(([key, value]) => {
    const parsed = Number(
      isRecord(value)
        ? first(value, ['score', 'value', 'contribution'])
        : value,
    );

    if (Number.isFinite(parsed)) {
      components[key] = parsed > 1 && parsed <= 100 ? parsed / 100 : parsed;
    }
  });

  const bid = num(quote, ['bid', 'best_bid'], Number.NaN);
  const ask = num(quote, ['ask', 'best_ask'], Number.NaN);
  const rawMid = num(quote, ['mid', 'fair', 'fair_value', 'mark'], Number.NaN);

  const mid = Number.isFinite(rawMid)
    ? rawMid
    : Number.isFinite(bid) && Number.isFinite(ask)
      ? (bid + ask) / 2
      : undefined;

  const expiryRaw = first(market, ['expiry_ms', 'expiryMs', 'expires_at', 'expiry']);
  let expiryMs: number | undefined;

  if (typeof expiryRaw === 'number') {
    expiryMs = expiryRaw < 10_000_000_000 ? expiryRaw * 1000 : expiryRaw;
  } else if (typeof expiryRaw === 'string') {
    const numeric = Number(expiryRaw);

    if (Number.isFinite(numeric)) {
      expiryMs = numeric < 10_000_000_000 ? numeric * 1000 : numeric;
    } else {
      const parsed = Date.parse(expiryRaw);
      if (Number.isFinite(parsed)) expiryMs = parsed;
    }
  }

  const timestampRaw = first(egsi, [
    'timestamp',
    'updated_at_ms',
    'updatedAt',
    'created_at',
    'time',
  ]);

  let timestamp: number | undefined;
  if (typeof timestampRaw === 'number' && Number.isFinite(timestampRaw)) {
    timestamp = timestampRaw;
  } else if (typeof timestampRaw === 'string') {
    const numeric = Number(timestampRaw);
    if (Number.isFinite(numeric)) timestamp = numeric;
    else {
      const parsed = Date.parse(timestampRaw);
      if (Number.isFinite(parsed)) timestamp = parsed;
    }
  }

  return {
    raw: root,
    egsi: {
      score: num(egsi, ['score', 'value', 'egsi'], num(root, ['egsi_score', 'score'], 0)),
      components,
      timestamp,
    },
    forecast: {
      expected: num(
        forecast,
        ['expected_egsi', 'expected', 'forecast', 'prediction'],
        num(egsi, ['score'], 0),
      ),
      confidence: num(forecast, ['confidence', 'confidence_score'], 0),
      tailProbability: num(
        forecast,
        ['p_tail_500', 'p_tail', 'probability_above_500'],
        0,
      ),
      modelVersion: str(
        forecast,
        ['model_version', 'modelVersion', 'model'],
        'egsi-v1',
      ),
      fallback: bool(
        forecast,
        ['fallback', 'is_fallback', 'fallback_forecast'],
        false,
      ),
    },
    market: {
      id: str(market, ['id', 'market_id', 'marketId'], 'EGSI-1H'),
      label: str(market, ['underlying', 'symbol', 'name', 'label'], 'EGSI-1H'),
      expiryMs,
      tickSize: num(market, ['tick_size', 'tickSize'], Number.NaN),
      contractMultiplier: num(
        market,
        ['contract_multiplier', 'contractMultiplier', 'multiplier'],
        Number.NaN,
      ),
      // Real field is marginRatioBps (basis points, e.g. 100 = 1%).
      // margin_rate/marginRate/initial_margin never existed on the real
      // response, so this always fell to NaN and callers silently
      // substituted their own guessed default instead of the real ratio.
      marginRate: num(market, ['marginRatioBps', 'margin_ratio_bps'], Number.NaN) / 10_000,
      devMode: bool(
        market,
        ['dev_mode', 'devMode', 'synthetic'],
        bool(root, ['dev_mode', 'devMarket'], false),
      ),
      // Mirrors api/src/routes/orders.ts's own gate EXACTLY:
      // `referencePrice = market.oracle.hasPrice ? market.oracle.price :
      // undefined`. oracleHasPrice is what TradePage must use to decide
      // whether it is even possible to price against a live oracle value
      // -- freshness is a separate, additional signal for the UI banner,
      // not part of what the backend's slippage check actually keys on.
      oracleHasPrice: bool(oracleObj, ['hasPrice', 'has_price'], false),
      oraclePrice: num(oracleObj, ['price'], Number.NaN),
      oracleFresh:
        bool(oracleObj, ['hasPrice', 'has_price'], false) &&
        bool(oracleObj, ['isFreshApprox', 'is_fresh_approx', 'fresh'], false),
      settled: bool(market, ['settled', 'is_settled', 'isSettled'], false),
    },
    quote: {
      bid: Number.isFinite(bid) ? bid : undefined,
      ask: Number.isFinite(ask) ? ask : undefined,
      mid,
    },
    orderbook: {
      asks: normaliseLevels(first(orderbook, ['asks', 'sell', 'bestAsk', 'best_ask'])),
      bids: normaliseLevels(first(orderbook, ['bids', 'buy', 'bestBid', 'best_bid'])),
      indicative: bool(orderbook, ['indicative'], true),
    },
  };
}

export async function getMarket(): Promise<MarketSnapshot> {
  return normaliseMarket(await request('/api/v1/market'));
}

function parseTime(value: unknown): number {
  if (typeof value === 'string') {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric > 10_000_000_000 ? Math.floor(numeric / 1000) : numeric;

    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : Number.NaN;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 10_000_000_000 ? Math.floor(value / 1000) : value;
  }

  return Number.NaN;
}

function findHistoryArray(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;

  const root = rec(payload);
  const direct = first(root, ['candles', 'history', 'readings', 'snapshots', 'items']);
  if (Array.isArray(direct)) return direct;

  const nested = rec(first(root, ['data', 'result']));
  const nestedArray = first(nested, ['candles', 'history', 'readings', 'snapshots', 'items']);
  if (Array.isArray(nestedArray)) return nestedArray;

  const data = first(root, ['data', 'result']);
  return Array.isArray(data) ? data : [];
}

function normaliseCandle(item: unknown): Candle | null {
  /**
   * Accept compact arrays:
   * [timestamp, value]
   * [timestamp, open, high, low, close, volume?]
   */
  if (Array.isArray(item)) {
    const time = parseTime(item[0]);

    if (item.length >= 5) {
      const open = Number(item[1]);
      const high = Number(item[2]);
      const low = Number(item[3]);
      const close = Number(item[4]);
      const volume = Number(item[5]);

      if ([time, open, high, low, close].every(Number.isFinite)) {
        return {
          time,
          open,
          high,
          low,
          close,
          volume: Number.isFinite(volume) ? volume : undefined,
        };
      }
    }

    if (item.length >= 2) {
      const value = Number(item[1]);
      if (Number.isFinite(time) && Number.isFinite(value)) {
        return { time, open: value, high: value, low: value, close: value };
      }
    }

    return null;
  }

  const row = rec(item);
  const time = parseTime(
    first(row, [
      'time',
      'timestamp',
      'ts',
      'timestamp_ms',
      'created_at',
      'createdAt',
      'updated_at',
    ]),
  );

  const open = num(row, ['open', 'o'], Number.NaN);
  const high = num(row, ['high', 'h'], Number.NaN);
  const low = num(row, ['low', 'l'], Number.NaN);
  const close = num(row, ['close', 'c'], Number.NaN);
  const volume = num(row, ['volume', 'v'], Number.NaN);

  if ([time, open, high, low, close].every(Number.isFinite)) {
    return {
      time,
      open,
      high,
      low,
      close,
      volume: Number.isFinite(volume) ? volume : undefined,
    };
  }

  /**
   * Some history endpoints expose raw EGSI snapshots rather than OHLC bars.
   * Treat each real snapshot as a flat candle. This is still real observed
   * data; the frontend is not fabricating intermediate prices.
   */
  const value = num(row, ['value', 'score', 'egsi', 'egsi_score'], Number.NaN);

  if (Number.isFinite(time) && Number.isFinite(value)) {
    return {
      time,
      open: value,
      high: value,
      low: value,
      close: value,
    };
  }

  return null;
}

/** `intervalSeconds` is the candle bucket width the gateway aggregates
 * EGSI readings into (e.g. 60 = 1m, 3600 = 1h). Defaults to the
 * gateway's own default (300s / 5m) when omitted. */
export async function getCandles(intervalSeconds?: number): Promise<Candle[]> {
  const query = intervalSeconds ? `?interval=${intervalSeconds}` : '';
  const payload = await request(`/api/v1/candles${query}`);
  const source = findHistoryArray(payload);

  const byTime = new Map<number, Candle>();

  for (const item of source) {
    const candle = normaliseCandle(item);
    if (candle) byTime.set(candle.time, candle);
  }

  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

/**
 * What the gateway's prepare endpoints return: one NEAR function call to be
 * signed by the trader's wallet. Amounts are already in base units.
 */
export interface PreparedTransaction {
  receiverId: string;
  actions: FunctionCallAction[];
  summary: Record<string, string | number | boolean>;
}

export interface OrderView {
  orderId: number;
  marketId: number;
  owner: string;
  isBid: boolean;
  price: number;
  quantity: number;
  lockedMargin: string;
  status: 'open' | 'filled' | 'cancelled';
}

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
  accountId: string;
  /** Token base units (tUSDC, 6 decimals). */
  available: string;
  locked: string;
  openOrders: OrderView[];
  orders: OrderView[];
  trades: TradeView[];
}

async function preparePost(path: string, body: object): Promise<PreparedTransaction> {
  const payload = await request(path, {
    method: 'POST',
    body: JSON.stringify(body),
  });

  if (!isRecord(payload) || typeof payload.receiverId !== 'string' || !Array.isArray(payload.actions)) {
    throw new Error('Gateway approved the request but did not return a NEAR transaction.');
  }

  return payload as unknown as PreparedTransaction;
}

export interface PrepareOrderInput {
  trader: string;
  isBid: boolean;
  price: number;
  quantity: number;
}

export function prepareOrder(input: PrepareOrderInput): Promise<PreparedTransaction> {
  return preparePost('/api/v1/orders/prepare', input);
}

export interface PrepareCancelInput {
  trader: string;
  orderId: number;
}

export function prepareCancel(input: PrepareCancelInput): Promise<PreparedTransaction> {
  return preparePost('/api/v1/orders/prepare-cancel', input);
}

export interface PrepareAmountInput {
  trader: string;
  /** Token base units, as a decimal string. */
  amount: string;
}

export function prepareDeposit(input: PrepareAmountInput): Promise<PreparedTransaction> {
  return preparePost('/api/v1/account/prepare-deposit', input);
}

export function prepareWithdraw(input: PrepareAmountInput): Promise<PreparedTransaction> {
  return preparePost('/api/v1/account/prepare-withdraw', input);
}

export interface PrepareClaimInput {
  trader: string;
  tradeId: number;
}

export function prepareClaim(input: PrepareClaimInput): Promise<PreparedTransaction> {
  return preparePost('/api/v1/trades/prepare-claim', input);
}

export async function getAccount(accountId: string): Promise<AccountView> {
  const root = rec(await request(`/api/v1/account/${encodeURIComponent(accountId)}`));

  return {
    accountId: str(root, ['accountId'], accountId),
    available: str(root, ['available'], '0'),
    locked: str(root, ['locked'], '0'),
    openOrders: (root.openOrders as OrderView[] | undefined) ?? [],
    orders: (root.orders as OrderView[] | undefined) ?? [],
    trades: (root.trades as TradeView[] | undefined) ?? [],
  };
}

export function pretty(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '—';

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function pickText(value: unknown, keys: string[], fallback = ''): string {
  return str(rec(value), keys, fallback);
}

export function pickNumber(value: unknown, keys: string[], fallback = Number.NaN): number {
  return num(rec(value), keys, fallback);
}

export function pickBoolean(value: unknown, keys: string[], fallback = false): boolean {
  return bool(rec(value), keys, fallback);
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export async function sendChatMessage(messages: ChatMessage[]): Promise<string> {
  const payload = await request('/api/v1/chat', {
    method: 'POST',
    body: JSON.stringify({ messages }),
  });
  const root = rec(payload);
  const reply = str(root, ['reply'], '');
  if (!reply) {
    throw new Error('The assistant did not return a reply.');
  }
  return reply;
}

export type ComputeComponentId =
  | 'gpu_marketplace'
  | 'cloud_gpu_spot'
  | 'ai_inference'
  | 'btc_hashprice'
  | 'blockspace';

export interface ComputeIndexComponent {
  id: ComputeComponentId;
  label: string;
  unit: string;
  source: string;
  nominalWeight: number;
  effectiveWeight: number;
  value: number | null;
  baseValue: number;
  relative: number | null;
  contributionPoints: number | null;
  status: 'ok' | 'down';
  error?: string;
  detail?: Record<string, number | string>;
}

export interface ComputeIndexResponse {
  index: {
    id: 'CCI';
    name: string;
    level: number | null;
    base: number;
    baseDate: string;
    /** ISO timestamp. */
    asOf: string;
    degraded: boolean;
    methodologyVersion: string;
  };
  components: ComputeIndexComponent[];
}

export async function getComputeIndex(): Promise<ComputeIndexResponse> {
  const payload = await request('/api/v1/indices/compute');
  const root = rec(payload);
  if (!isRecord(root.index) || !Array.isArray(root.components)) {
    throw new Error('The Compute Index response was not in the expected shape.');
  }
  return payload as ComputeIndexResponse;
}

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

export interface IndexSnapshot {
  level: number | null;
  base: number;
  baseDate: string;
  /** Epoch milliseconds the index was computed at, when known. */
  asOfMs?: number;
  degraded: boolean;
}

export interface PillarSnapshot {
  id: string;
  label: string;
  level: number | null;
  effectiveWeight: number;
  status: 'ok' | 'down';
}

export interface MarketSnapshot {
  raw: JsonObject;
  index: IndexSnapshot | null;
  pillars: PillarSnapshot[];
  market: {
    id: string;
    /** The on-chain market number, parsed from an id like "contract.testnet#4". */
    number: number | null;
    label: string;
    expiryMs?: number;
    tickSize?: number;
    contractMultiplier?: number;
    marginRate?: number;
    devMode: boolean;
    oracleHasPrice: boolean;
    oraclePrice: number;
    oracleFresh: boolean;
    /** Epoch ms of the last on-chain oracle update, when reported. */
    oracleUpdatedMs?: number;
    settled: boolean;
    paused: boolean;
    settlementPrice: number | null;
  };
  quote: {
    bid?: number;
    ask?: number;
    mid?: number;
    fairPrice?: number;
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

/** "contract.testnet#4" -> 4. Null when the id carries no number. */
export function marketNumber(id: string | null | undefined): number | null {
  const match = /#(\d+)$/.exec(id ?? '');
  return match ? Number(match[1]) : null;
}

export function normaliseMarket(payload: unknown): MarketSnapshot {
  const root = rec(payload);
  const indexObj = first(root, ['index']);
  const market = rec(first(root, ['market', 'instrument']));
  const quote = rec(first(root, ['quote', 'pricing']));
  const orderbook = rec(first(root, ['orderbook', 'book', 'depth']));
  const oracleObj = rec(first(market, ['oracle']));
  const bid = num(quote, ['bid', 'best_bid'], Number.NaN);
  const ask = num(quote, ['ask', 'best_ask'], Number.NaN);
  const rawMid = num(quote, ['mid', 'fair', 'fair_value', 'fairPrice', 'mark'], Number.NaN);
  const fairPrice = num(quote, ['fairPrice', 'fair_price', 'fair', 'fair_value'], Number.NaN);

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

  let index: IndexSnapshot | null = null;
  if (isRecord(indexObj)) {
    const levelRaw = indexObj.level;
    const asOfRaw = indexObj.asOf;
    const asOfParsed =
      typeof asOfRaw === 'number' ? (asOfRaw < 10_000_000_000 ? asOfRaw * 1000 : asOfRaw)
      : typeof asOfRaw === 'string' ? Date.parse(asOfRaw) : Number.NaN;
    index = {
      level: typeof levelRaw === 'number' && Number.isFinite(levelRaw) ? levelRaw : null,
      base: num(indexObj, ['base'], 1000),
      baseDate: str(indexObj, ['baseDate'], ''),
      asOfMs: Number.isFinite(asOfParsed) ? asOfParsed : undefined,
      degraded: bool(indexObj, ['degraded'], false),
    };
  }

  const pillars: PillarSnapshot[] = Array.isArray(root.pillars)
    ? root.pillars.flatMap((item) => {
        const p = rec(item);
        const id = str(p, ['id']);
        if (!id) return [];
        const lv = p.level;
        return [{
          id,
          label: str(p, ['label'], id),
          level: typeof lv === 'number' && Number.isFinite(lv) ? lv : null,
          effectiveWeight: num(p, ['effectiveWeight'], 0),
          status: p.status === 'down' ? ('down' as const) : ('ok' as const),
        }];
      })
    : [];

  const oracleUpdatedRaw = num(oracleObj, ['lastUpdateMs', 'last_update_ms'], Number.NaN);
  const marketId = str(market, ['id', 'market_id', 'marketId'], 'SCI-1H');
  const settlementRaw = num(market, ['settlementPrice', 'settlement_price'], Number.NaN);

  return {
    raw: root,
    index,
    pillars,
    market: {
      id: marketId,
      number: marketNumber(marketId),
      label: str(market, ['underlying', 'symbol', 'name', 'label'], 'SCI-1H'),
      expiryMs,
      tickSize: num(market, ['tick_size', 'tickSize'], Number.NaN),
      contractMultiplier: num(
        market,
        ['contract_multiplier', 'contractMultiplier', 'multiplier'],
        Number.NaN,
      ),
      // marginRatioBps is in basis points (1000 = 10%).
      marginRate: num(market, ['marginRatioBps', 'margin_ratio_bps'], Number.NaN) / 10_000,
      devMode: bool(
        market,
        ['dev_mode', 'devMode', 'synthetic'],
        bool(root, ['dev_mode', 'devMarket'], false),
      ),
      // Mirrors the gateway's own gate: the oracle price is the reference
      // whenever hasPrice is true. Freshness is a separate signal.
      oracleHasPrice: bool(oracleObj, ['hasPrice', 'has_price'], false),
      oraclePrice: num(oracleObj, ['price'], Number.NaN),
      oracleFresh:
        bool(oracleObj, ['hasPrice', 'has_price'], false) &&
        bool(oracleObj, ['isFreshApprox', 'is_fresh_approx', 'fresh'], false),
      oracleUpdatedMs: Number.isFinite(oracleUpdatedRaw) && oracleUpdatedRaw > 0 ? oracleUpdatedRaw : undefined,
      settled: bool(market, ['settled', 'is_settled', 'isSettled'], false),
      paused: bool(market, ['paused'], false),
      settlementPrice: Number.isFinite(settlementRaw) ? settlementRaw : null,
    },
    quote: {
      bid: Number.isFinite(bid) ? bid : undefined,
      ask: Number.isFinite(ask) ? ask : undefined,
      mid,
      fairPrice: Number.isFinite(fairPrice) ? fairPrice : undefined,
    },
    orderbook: {
      asks: normaliseLevels(first(orderbook, ['asks', 'sell', 'bestAsk', 'best_ask'])),
      bids: normaliseLevels(first(orderbook, ['bids', 'buy', 'bestBid', 'best_bid'])),
      indicative: bool(orderbook, ['indicative'], true),
    },
  };
}

/** Fire-and-forget keeper nudge. Never throws; failures are ignored. */
export async function pokeMarket(): Promise<void> {
  try {
    await request('/api/v1/market/poke', { method: 'POST', body: '{}' });
  } catch {
    /* intentionally ignored */
  }
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
   * Some history endpoints expose raw index snapshots rather than OHLC bars.
   * Treat each real snapshot as a flat candle. This is still real observed
   * data; the frontend is not fabricating intermediate prices.
   */
  const value = num(row, ['value', 'score', 'level'], Number.NaN);

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
 * index readings into (e.g. 60 = 1m, 3600 = 1h). Defaults to the
 * gateway's own default (300s / 5m) when omitted. */
export async function getCandles(intervalSeconds?: number, limit?: number): Promise<Candle[]> {
  const params = new URLSearchParams();
  if (intervalSeconds) params.set('interval', String(intervalSeconds));
  if (limit) params.set('limit', String(limit));
  const qs = params.toString();
  const query = qs ? `?${qs}` : '';
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

/**
 * Whether the assistant is configured. The gateway answers 501 before it
 * validates the body, so an empty request is a free probe: 400 means it is on.
 */
export async function chatAvailable(): Promise<boolean> {
  try {
    const response = await fetch('/api/v1/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    return response.status === 400 || response.ok;
  } catch {
    return false;
  }
}

export type ComputeComponentId =
  | 'gpu_rental'
  | 'cloud_gpu_spot'
  | 'cloud_cpu_spot'
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
  /** 1000 * relative. Optional so a partial API response still renders. */
  level?: number | null;
  sources?: string[];
  quotes?: { ok: number; total: number };
}

export type ComputeGpuId = 'h100' | 'a100' | 'rtx4090';

export interface ComputeGpuVenue {
  venue: string;
  price: number | null;
  status: 'ok' | 'down';
}

export interface ComputeGpu {
  id: ComputeGpuId;
  label: string;
  level: number | null;
  medianPrice: number | null;
  venues: ComputeGpuVenue[];
  cheapest: { venue: string; price: number } | null;
  spreadPct: number | null;
}

export interface ComputeIndexResponse {
  index: {
    id: string;
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
  gpus?: ComputeGpu[];
}

export async function getComputeIndex(): Promise<ComputeIndexResponse> {
  const payload = await request('/api/v1/indices/compute');
  const root = rec(payload);
  if (!isRecord(root.index) || !Array.isArray(root.components)) {
    throw new Error('The Compute Index response was not in the expected shape.');
  }
  return payload as ComputeIndexResponse;
}

export interface ComputeHistoryPoint {
  t: string;
  value: number;
}

export interface ComputeHistoryResponse {
  /** False when the gateway has no database, so no index levels are stored. */
  persisted: boolean;
  points: Array<{ t: string; level: number }>;
  backfill: {
    btc_hashprice: ComputeHistoryPoint[];
    blockspace: ComputeHistoryPoint[];
  };
  /** Daily partial reconstruction from the pillars with public history. */
  backcast: {
    points: Array<{ t: string; level: number }>;
    method: string;
    pillars: string[];
  };
  /** Hourly markets settled on chain, each at its settlement level. */
  settlements: Array<{ t: string; level: number; marketId: number | null }>;
}

function historySeries(value: unknown, key: string): Array<{ t: string; v: number }> {
  if (!Array.isArray(value)) return [];
  const out: Array<{ t: string; v: number }> = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.t !== 'string') continue;
    const v = item[key];
    if (typeof v === 'number' && Number.isFinite(v)) out.push({ t: item.t, v });
  }
  return out;
}

export async function getComputeHistory(days = 30): Promise<ComputeHistoryResponse> {
  const root = rec(await request(`/api/v1/indices/compute/history?days=${days}`));
  const backfill = rec(root.backfill);
  const toPoints = (value: unknown) =>
    historySeries(value, 'value').map(({ t, v }) => ({ t, value: v }));
  const backcast = rec(root.backcast);
  const settlements = Array.isArray(root.settlements)
    ? root.settlements.flatMap((item) => {
        if (!isRecord(item) || typeof item.t !== 'string') return [];
        const level = item.level;
        if (typeof level !== 'number' || !Number.isFinite(level)) return [];
        const id = Number(item.marketId);
        return [{ t: item.t, level, marketId: Number.isFinite(id) ? id : null }];
      })
    : [];
  return {
    backcast: {
      points: historySeries(backcast.points, 'level').map(({ t, v }) => ({ t, level: v })),
      method: typeof backcast.method === 'string' ? backcast.method : '',
      pillars: Array.isArray(backcast.pillars)
        ? backcast.pillars.filter((p): p is string => typeof p === 'string')
        : [],
    },
    settlements,
    persisted: root.persisted === true,
    points: historySeries(root.points, 'level').map(({ t, v }) => ({ t, level: v })),
    backfill: {
      btc_hashprice: toPoints(backfill.btc_hashprice),
      blockspace: toPoints(backfill.blockspace),
    },
  };
}

export interface NewsItem {
  id: string;
  title: string;
  url: string;
  source: string;
  publishedAt: string;
  via: 'hn' | 'google';
}

export interface NewsResponse {
  asOf: string;
  items: NewsItem[];
}

export async function getNews(): Promise<NewsResponse> {
  const payload = await request('/api/v1/news');
  const root = rec(payload);
  if (!Array.isArray(root.items)) throw new Error('The news response was not in the expected shape.');
  return payload as NewsResponse;
}

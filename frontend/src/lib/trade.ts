/** Pure order-ticket maths and rules. No React, no network. */
import type { PreparedTransaction, TradeView } from './api';

/** One displayed contract is 100 on-chain quantity units. */
export const CONTRACT_SCALE = 100;
/** tUSDC has 6 decimals. */
export const TOKEN_DECIMALS = 6;
export const MIN_CONTRACTS = 1 / CONTRACT_SCALE;

const TOKEN_UNIT = 10n ** BigInt(TOKEN_DECIMALS);

/** Rounds a price to the nearest tick, never below one tick. */
export function snapToTick(value: number, tickSize: number): number {
  const tick = Number.isFinite(tickSize) && tickSize > 0 ? tickSize : 1;
  if (!Number.isFinite(value)) return tick;
  return Math.max(tick, Math.round(value / tick) * tick);
}

/** Displayed contracts to the whole on-chain quantity, never below 1. */
export function toOnChainQuantity(contracts: number): number {
  if (!Number.isFinite(contracts)) return 1;
  return Math.max(1, Math.round(contracts * CONTRACT_SCALE));
}

export function fromOnChainQuantity(quantity: number): number {
  return quantity / CONTRACT_SCALE;
}

/** tUSDC gained or lost per index point by one displayed contract. */
export function perPoint(contractMultiplier: number): number {
  return (contractMultiplier * CONTRACT_SCALE) / 10 ** TOKEN_DECIMALS;
}

/**
 * Margin for an order in token base units, as the contract counts it:
 * price x on-chain quantity x multiplier x marginRatioBps / 10000, rounded up.
 */
export function marginBaseUnits(
  price: number,
  contracts: number,
  contractMultiplier: number,
  marginRate: number,
): bigint {
  if (![price, contracts, contractMultiplier, marginRate].every(Number.isFinite)) return 0n;
  if (price <= 0 || contracts <= 0) return 0n;
  const notional =
    BigInt(Math.round(price)) *
    BigInt(toOnChainQuantity(contracts)) *
    BigInt(Math.round(contractMultiplier));
  const bps = BigInt(Math.round(marginRate * 10_000));
  return (notional * bps + 9_999n) / 10_000n;
}

/** Parses a base-unit string; anything unusable counts as zero. */
export function toBig(baseUnits: string | null | undefined): bigint {
  return baseUnits && /^\d+$/.test(baseUnits) ? BigInt(baseUnits) : 0n;
}

/** The deposit that covers a margin shortfall, rounded up to a whole token. */
export function depositNeeded(margin: bigint, available: bigint): bigint {
  if (margin <= available) return 0n;
  const shortfall = margin - available;
  return ((shortfall + TOKEN_UNIT - 1n) / TOKEN_UNIT) * TOKEN_UNIT;
}

export type GuidedStep = 'connect' | 'fund' | 'deposit' | 'trade';
export const GUIDED_STEPS: readonly GuidedStep[] = ['connect', 'fund', 'deposit', 'trade'];

export interface GuidedInput {
  connected: boolean;
  /** Wallet tUSDC, base units. */
  wallet: bigint;
  /** Deposited and free. */
  available: bigint;
  /** Deposited and locked in orders or positions. */
  locked: bigint;
  /** Margin the current ticket needs. */
  margin: bigint;
}

export interface GuidedState {
  step: GuidedStep;
  /** Base units to deposit; only set on the deposit step. */
  deposit: bigint;
}

/** Picks the one action the ticket button offers next. */
export function guidedState(input: GuidedInput): GuidedState {
  if (!input.connected) return { step: 'connect', deposit: 0n };
  if (input.wallet === 0n && input.available === 0n && input.locked === 0n) {
    return { step: 'fund', deposit: 0n };
  }
  if (input.available >= input.margin) return { step: 'trade', deposit: 0n };
  const deposit = depositNeeded(input.margin, input.available);
  // The wallet cannot cover the shortfall: more test tokens first.
  if (input.wallet < deposit) return { step: 'fund', deposit: 0n };
  return { step: 'deposit', deposit };
}

/**
 * The price the market is at: the on-chain oracle price when it has one,
 * otherwise the live index level. Null when neither is known.
 */
export function referencePrice(input: {
  oracleHasPrice: boolean;
  oraclePrice: number;
  indexLevel: number | null | undefined;
}): number | null {
  if (input.oracleHasPrice && Number.isFinite(input.oraclePrice) && input.oraclePrice > 0) {
    return input.oraclePrice;
  }
  const level = input.indexLevel;
  return typeof level === 'number' && Number.isFinite(level) && level > 0 ? level : null;
}

/** How far the best opposite quote may sit from the reference and still be used. */
const NEAR_QUOTE = 0.02;

/**
 * The ticket's default limit price: the best opposite quote when one rests
 * close to the market (so the order can match at once), otherwise the
 * reference price snapped to the tick.
 */
export function defaultLimitPrice(
  side: Side,
  reference: number,
  tickSize: number,
  book: { bestAsk?: number; bestBid?: number },
): number {
  const snapped = snapToTick(reference, tickSize);
  const opposite = side === 'long' ? book.bestAsk : book.bestBid;
  if (opposite === undefined || !Number.isFinite(opposite) || opposite <= 0) return snapped;
  if (Math.abs(opposite - reference) > reference * NEAR_QUOTE) return snapped;
  return snapToTick(opposite, tickSize);
}

/** Whether a typed price is usable: positive and a whole number of ticks. */
export function isOnTick(price: number, tickSize: number): boolean {
  const tick = Number.isFinite(tickSize) && tickSize > 0 ? tickSize : 1;
  if (!Number.isFinite(price) || price <= 0) return false;
  const steps = price / tick;
  return Math.abs(steps - Math.round(steps)) < 1e-9;
}

/**
 * Typed size in contracts: a positive decimal with at most two places, at
 * least the 0.01 minimum. Null for anything else.
 */
export function parseContracts(text: string): number | null {
  const clean = text.trim();
  if (clean === '' || clean === '.' || !/^\d*(?:\.\d{0,2})?$/.test(clean)) return null;
  const value = Number(clean);
  if (!Number.isFinite(value) || value < MIN_CONTRACTS - 1e-12) return null;
  return Math.round(value * CONTRACT_SCALE) / CONTRACT_SCALE;
}

/** Contracts as short text: "1", "2.5", "0.01". */
export function formatContracts(contracts: number): string {
  if (!Number.isFinite(contracts)) return '0';
  return String(Math.round(contracts * CONTRACT_SCALE) / CONTRACT_SCALE);
}

/** Next size from the stepper: whole contracts, never below one. */
export function stepSize(current: number, direction: 1 | -1): number {
  const value = Number.isFinite(current) && current > 0 ? current : 1;
  if (direction === 1) return Math.floor(value + 1e-9) + 1;
  return Math.max(1, Math.ceil(value - 1e-9) - 1);
}

export type Side = 'long' | 'short';

export function tradeSide(trade: Pick<TradeView, 'buyer'>, accountId: string): Side {
  return trade.buyer === accountId ? 'long' : 'short';
}

/** Gain or loss in tUSDC of a trade against a price. */
export function tradePnl(
  side: Side,
  entry: number,
  quantity: number,
  price: number,
  contractMultiplier: number,
): number {
  const points = side === 'long' ? price - entry : entry - price;
  return points * fromOnChainQuantity(quantity) * perPoint(contractMultiplier);
}

type ClaimFields = Pick<TradeView, 'marketId' | 'buyer' | 'buyerClaimed' | 'sellerClaimed'>;

export function isClaimed(trade: Omit<ClaimFields, 'marketId'>, accountId: string): boolean {
  return trade.buyer === accountId ? trade.buyerClaimed : trade.sellerClaimed;
}

/**
 * A trade can be claimed once its market has settled: either it belongs to a
 * different market than the current one, or the current market is settled.
 */
export function isClaimable(
  trade: ClaimFields,
  accountId: string,
  currentMarket: number | null,
  currentSettled: boolean,
): boolean {
  if (isClaimed(trade, accountId)) return false;
  if (currentMarket === null) return false;
  return trade.marketId !== currentMarket || currentSettled;
}

/**
 * The first trade that was not on the account when the order was signed, in
 * the given market. Used to turn "waiting for a match" into "filled".
 */
export function findNewFill<T extends Pick<TradeView, 'tradeId' | 'marketId'>>(
  trades: readonly T[],
  knownIds: ReadonlySet<number>,
  marketNumber: number | null,
): T | null {
  for (const trade of trades) {
    if (knownIds.has(trade.tradeId)) continue;
    if (marketNumber !== null && trade.marketId !== marketNumber) continue;
    return trade;
  }
  return null;
}

const MAX_TX_GAS = 300_000_000_000_000n;

/**
 * Merges prepared calls to the same contract into as few transactions as the
 * 300 Tgas limit allows, so several claims need one signature.
 */
export function batchPrepared(list: readonly PreparedTransaction[]): PreparedTransaction[] {
  const out: Array<{ tx: PreparedTransaction; gas: bigint }> = [];
  for (const item of list) {
    const gas = item.actions.reduce((sum, a) => sum + toBig(String(a.params.gas)), 0n);
    const last = out[out.length - 1];
    if (last && last.tx.receiverId === item.receiverId && last.gas + gas <= MAX_TX_GAS) {
      last.tx.actions = [...last.tx.actions, ...item.actions];
      last.gas += gas;
    } else {
      out.push({ tx: { receiverId: item.receiverId, actions: [...item.actions], summary: {} }, gas });
    }
  }
  return out.map((entry) => entry.tx);
}

/** A short, safe line for the UI from any thrown value. */
export function errorLine(error: unknown, fallback = 'Something went wrong. Try again.'): string {
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const clean = text.replace(/\s+/g, ' ').trim();
  // Never surface configuration names or stack-like text.
  if (!clean || /[A-Z]{3,}_[A-Z_]{2,}/.test(clean)) return fallback;
  return clean.length > 140 ? `${clean.slice(0, 137)}...` : clean;
}

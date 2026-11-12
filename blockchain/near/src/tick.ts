/**
 * Serverless cron tick. One call does everything the long-running
 * publisher and matcher services do per loop, plus rolling a settled
 * market into the next one: publish the Silica Compute Index (SCI) price, settle past expiry,
 * roll once settled, optionally quote demo liquidity, then match crossing orders. Every step is try/caught
 * on its own so one failure never blocks the others; failures are reported
 * in `TickReport.errors` (messages only, never keys).
 *
 * All signing uses one account (the publisher, which is also the matcher).
 */

import type { Account } from 'near-api-js';
import { viewCall } from './client.js';
import type { NearAdapterConfig } from './config.js';
import { findMatches, type OrderLike } from './matcher.js';
import { toOraclePrice } from './publisher.js';

const TGAS_30 = '30000000000000';
const PAGE_SIZE = 100;
const MIN_UPDATE_AGE_MS = 60_000;
const MIN_MARKET_LIFE_MS = 10 * 60_000;
const HOUR_MS = 60 * 60_000;

/** Signature of `viewCall`, injectable so tests need no network. */
export type ViewFn = <T>(
  config: Pick<NearAdapterConfig, 'rpcUrl'>,
  contractId: string,
  methodName: string,
  args?: Record<string, unknown>,
) => Promise<T>;

export interface TickContext {
  config: NearAdapterConfig;
  contractId: string;
  signer: Pick<Account, 'callFunction'>;
  /** Current Compute Index level, or null when unavailable. */
  getPrice: () => Promise<number | null>;
  now?: () => number;
  view?: ViewFn;
  /** The signer's account id (the publisher). Required for demo liquidity. */
  signerAccountId?: string;
  /** Demo liquidity: the signer quotes a bid and an ask around the index. */
  liquidity?: { quantity: number; offsetTicks: number; maxRepriceDistance: number };
}

export interface TickReport {
  published?: number;
  settled?: boolean;
  rolled?: number;
  matched: Array<{ buy: number; sell: number }>;
  /** Live maker quotes after the liquidity step; absent when it did not run. */
  quoted?: { bids: number; asks: number };
  errors: string[];
}

interface OracleViewLike {
  max_price: number;
  has_price: boolean;
  last_update_ms: number;
  price?: number;
}

interface MarketViewLike {
  expiry_ms: number;
  paused: boolean;
  settled: boolean;
  market_id?: number;
  contract_multiplier?: number;
  tick_size?: number;
  margin_ratio_bps?: number;
}

interface FullOrderLike extends OrderLike {
  market_id?: number;
  status?: string;
}

interface TradeLike {
  trade_id: number;
  market_id: number;
  buyer: string;
  seller: string;
  buyer_claimed: boolean;
  seller_claimed: boolean;
}

const STOP_BEFORE_EXPIRY_MS = 60_000;
const MAX_CLAIMS_PER_TICK = 5;

/**
 * The next full UTC hour boundary strictly after `nowMs + 10 min`, so a
 * freshly rolled market always lives at least 10 minutes.
 */
export function nextExpiryMs(nowMs: number): number {
  const earliest = nowMs + MIN_MARKET_LIFE_MS;
  return (Math.floor(earliest / HOUR_MS) + 1) * HOUR_MS;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function runTick(ctx: TickContext): Promise<TickReport> {
  const now = ctx.now ?? Date.now;
  const view: ViewFn = ctx.view ?? viewCall;
  const report: TickReport = { matched: [], errors: [] };

  const call = (methodName: string, args: Record<string, unknown>) =>
    ctx.signer.callFunction({
      contractId: ctx.contractId,
      methodName,
      args,
      gas: TGAS_30,
      deposit: '0',
    });

  let oracle: OracleViewLike | null = null;
  let market: MarketViewLike | null = null;
  try {
    oracle = await view<OracleViewLike>(ctx.config, ctx.contractId, 'get_oracle', {});
  } catch (err) {
    report.errors.push(`get_oracle: ${message(err)}`);
  }
  try {
    market = await view<MarketViewLike>(ctx.config, ctx.contractId, 'get_market', {});
  } catch (err) {
    report.errors.push(`get_market: ${message(err)}`);
  }

  // 2. Publish the SCI level (skipped if the last update is fresh).
  if (oracle) {
    try {
      const fresh = oracle.has_price && now() - oracle.last_update_ms < MIN_UPDATE_AGE_MS;
      if (!fresh) {
        const level = await ctx.getPrice();
        const price = level === null ? null : toOraclePrice(level, oracle.max_price);
        if (price === null) throw new Error('no usable index level');
        await call('update_price', { price });
        report.published = price;
      }
    } catch (err) {
      report.errors.push(`publish: ${message(err)}`);
    }
  }

  // 3. Settle once past expiry.
  let settled = market?.settled ?? false;
  if (market && !market.settled && now() >= market.expiry_ms) {
    try {
      await call('settle_market', {});
      report.settled = true;
      settled = true;
    } catch (err) {
      report.errors.push(`settle: ${message(err)}`);
    }
  }

  // 4. Roll a settled market into the next one.
  let rolledOk = false;
  if (market && settled) {
    try {
      const expiryMs = nextExpiryMs(now());
      await call('roll_market', { expiry_ms: expiryMs });
      report.rolled = expiryMs;
      rolledOk = true;
    } catch (err) {
      report.errors.push(`roll: ${message(err)}`);
    }
  }

  // Current market view (re-read after a roll).
  let current = market;
  if (rolledOk) {
    try {
      current = await view<MarketViewLike>(ctx.config, ctx.contractId, 'get_market', {});
    } catch (err) {
      current = null;
      report.errors.push(`match: ${message(err)}`);
    }
  }
  const tradable = !!current && !current.paused && !current.settled && now() < current.expiry_ms;

  const pageAll = async <T>(method: string, args: Record<string, unknown>): Promise<T[]> => {
    const all: T[] = [];
    for (let from = 0; ; from += PAGE_SIZE) {
      const page = await view<T[]>(ctx.config, ctx.contractId, method, {
        ...args,
        from_index: from,
        limit: PAGE_SIZE,
      });
      all.push(...page);
      if (page.length < PAGE_SIZE) break;
    }
    return all;
  };

  // Open orders of the current market, fetched once and reused by the
  // liquidity step and the matcher (refetched only if the maker changed the book).
  let openOrders: FullOrderLike[] | null = null;
  let bookChanged = false;

  // 5. Demo liquidity: the signer (publisher) quotes a bid and an ask.
  const liq = ctx.liquidity;
  const maker = ctx.signerAccountId;
  if (liq && maker && current && current.market_id !== undefined) {
    const currentMarketId = current.market_id;

    // 5a. Release stale-market orders and recycle margin from settled trades.
    try {
      const mine = await pageAll<FullOrderLike>('get_orders_by_account', { account_id: maker });
      for (const o of mine) {
        if (o.status === 'open' && o.market_id !== currentMarketId) {
          try {
            await call('cancel_order', { order_id: o.order_id });
          } catch (err) {
            report.errors.push(`liquidity: cancel stale ${o.order_id}: ${message(err)}`);
          }
        }
      }
    } catch (err) {
      report.errors.push(`liquidity: stale orders: ${message(err)}`);
    }
    try {
      const trades = await pageAll<TradeLike>('get_trades_by_account', { account_id: maker });
      const claimable = trades
        .filter(
          (tr) =>
            tr.market_id !== currentMarketId &&
            ((tr.buyer === maker && !tr.buyer_claimed) || (tr.seller === maker && !tr.seller_claimed)),
        )
        .slice(0, MAX_CLAIMS_PER_TICK);
      for (const tr of claimable) {
        try {
          await call('claim', { trade_id: tr.trade_id });
        } catch (err) {
          report.errors.push(`liquidity: claim ${tr.trade_id}: ${message(err)}`);
        }
      }
    } catch (err) {
      report.errors.push(`liquidity: trades: ${message(err)}`);
    }

    // 5b. Quote around the reference price.
    const ref = report.published ?? (oracle?.has_price && oracle.price !== undefined ? oracle.price : null);
    const quotable = now() < current.expiry_ms - STOP_BEFORE_EXPIRY_MS;
    if (tradable && quotable && ref !== null) {
      try {
        const tickSize = current.tick_size;
        const multiplier = current.contract_multiplier;
        const marginBps = current.margin_ratio_bps;
        if (!oracle || !tickSize || multiplier === undefined || marginBps === undefined) {
          throw new Error('market parameters unavailable');
        }
        const maxPrice = Math.floor(oracle.max_price / tickSize) * tickSize;
        const clamp = (p: number) => Math.min(Math.max(p, tickSize), maxPrice);
        const refTick = Math.round(ref / tickSize) * tickSize;
        const bidTarget = clamp(refTick - liq.offsetTicks * tickSize);
        const askTarget = clamp(refTick + liq.offsetTicks * tickSize);
        if (bidTarget >= askTarget) throw new Error('degenerate quotes (bid would reach ask)');

        openOrders = await pageAll<FullOrderLike>('get_open_orders', {});
        const mine = openOrders.filter((o) => o.owner === maker);
        const quoted = { bids: 0, asks: 0 };
        const toPlace: Array<{ isBid: boolean; price: number }> = [];

        for (const isBid of [true, false]) {
          const target = isBid ? bidTarget : askTarget;
          const side = mine.filter((o) => o.is_bid === isBid);
          const keep = side.find(
            (o) =>
              o.quantity === liq.quantity &&
              Math.abs(o.price - target) <= liq.maxRepriceDistance * tickSize,
          );
          if (keep) {
            quoted[isBid ? 'bids' : 'asks'] += 1;
            continue;
          }
          for (const o of side) {
            try {
              await call('cancel_order', { order_id: o.order_id });
              bookChanged = true;
            } catch (err) {
              report.errors.push(`liquidity: cancel ${o.order_id}: ${message(err)}`);
            }
          }
          toPlace.push({ isBid, price: target });
        }

        if (toPlace.length > 0) {
          let available: bigint | null = null;
          try {
            const acct = await view<{ available: string }>(ctx.config, ctx.contractId, 'get_account', {
              account_id: maker,
            });
            available = BigInt(acct.available);
          } catch (err) {
            report.errors.push(`liquidity: get_account: ${message(err)}`);
          }
          let insufficient = false;
          if (available !== null) {
            for (const q of toPlace) {
              const num = BigInt(q.price) * BigInt(liq.quantity) * BigInt(multiplier) * BigInt(marginBps);
              const margin = (num + 9999n) / 10000n;
              if (available < margin) {
                insufficient = true;
                continue;
              }
              try {
                await call('place_order', { is_bid: q.isBid, price: q.price, quantity: liq.quantity });
                available -= margin;
                bookChanged = true;
                quoted[q.isBid ? 'bids' : 'asks'] += 1;
              } catch (err) {
                report.errors.push(`liquidity: place ${q.isBid ? 'bid' : 'ask'}: ${message(err)}`);
              }
            }
          }
          if (insufficient) report.errors.push('liquidity: insufficient balance');
        }
        report.quoted = quoted;
      } catch (err) {
        report.errors.push(`liquidity: ${message(err)}`);
      }
    }
  }

  // 6. Match crossing orders while the market is tradable.
  try {
    if (tradable) {
      if (openOrders === null || bookChanged) {
        openOrders = await pageAll<FullOrderLike>('get_open_orders', {});
      }
      for (const pair of findMatches(openOrders)) {
        try {
          await call('match_orders', { buy_order_id: pair.buy, sell_order_id: pair.sell });
          report.matched.push(pair);
        } catch (err) {
          report.errors.push(`match ${pair.buy}/${pair.sell}: ${message(err)}`);
        }
      }
    }
  } catch (err) {
    report.errors.push(`match: ${message(err)}`);
  }
  return report;
}

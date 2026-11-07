/**
 * Serverless cron tick. One call does everything the long-running
 * publisher and matcher services do per loop, plus rolling a settled
 * market into the next one: publish the EGSI price, settle past expiry,
 * roll once settled, then match crossing orders. Every step is try/caught
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
const MIN_UPDATE_AGE_MS = 20_000;
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
  /** Base URL of the AI service (serves GET /egsi/current). */
  aiUrl: string;
  now?: () => number;
  fetchImpl?: typeof fetch;
  view?: ViewFn;
}

export interface TickReport {
  published?: number;
  settled?: boolean;
  rolled?: number;
  matched: Array<{ buy: number; sell: number }>;
  errors: string[];
}

interface OracleViewLike {
  max_price: number;
  has_price: boolean;
  last_update_ms: number;
}

interface MarketViewLike {
  expiry_ms: number;
  paused: boolean;
  settled: boolean;
}

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
  const fetchImpl = ctx.fetchImpl ?? fetch;
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

  // 2. Publish the EGSI score (skipped if the last update is fresh).
  if (oracle) {
    try {
      const fresh = oracle.has_price && now() - oracle.last_update_ms < MIN_UPDATE_AGE_MS;
      if (!fresh) {
        const res = await fetchImpl(`${ctx.aiUrl.replace(/\/$/, '')}/egsi/current`);
        if (!res.ok) throw new Error(`ai service returned HTTP ${res.status}`);
        const body = (await res.json()) as { score?: number };
        const price =
          typeof body.score === 'number' ? toOraclePrice(body.score, oracle.max_price) : null;
        if (price === null) throw new Error('ai service returned no usable score');
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

  // 5. Match crossing orders while the market is tradable.
  try {
    let current = market;
    if (rolledOk) {
      current = await view<MarketViewLike>(ctx.config, ctx.contractId, 'get_market', {});
    }
    if (current && !current.paused && !current.settled && now() < current.expiry_ms) {
      const orders: OrderLike[] = [];
      for (let from = 0; ; from += PAGE_SIZE) {
        const page = await view<OrderLike[]>(ctx.config, ctx.contractId, 'get_open_orders', {
          from_index: from,
          limit: PAGE_SIZE,
        });
        orders.push(...page);
        if (page.length < PAGE_SIZE) break;
      }
      for (const pair of findMatches(orders)) {
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

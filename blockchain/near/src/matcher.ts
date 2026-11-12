/**
 * Order matcher service. Every GASX_MATCH_INTERVAL_SECONDS it pages through
 * `get_open_orders`, pairs crossing bids and asks and submits `match_orders`
 * from the matcher account. The contract re-validates every match, so a
 * failed call (someone else matched first, margin moved, ...) is logged and
 * otherwise ignored.
 *
 * Run with: `npx tsx src/matcher.ts` (or `npm run matcher`).
 */

import { pathToFileURL } from 'node:url';
import { loadConfigFromEnv, viewCall } from './index.js';
import { createSigner } from './signer.js';

const TGAS_30 = '30000000000000';
const PAGE_SIZE = 100;

/** The subset of the contract's OrderView the matcher needs. */
export interface OrderLike {
  order_id: number;
  owner: string;
  is_bid: boolean;
  price: number;
  quantity: number;
}

interface MarketViewLike {
  expiry_ms: number;
  paused: boolean;
  settled: boolean;
}

function log(message: string, fields: Record<string, unknown> = {}): void {
  console.log(`[silica/matcher] ${message} ${JSON.stringify(fields)}`);
}

/**
 * Finds crossing pairs: bid price >= ask price, equal quantity, different
 * owners. Bids are taken best (highest) price first, then oldest id; each is
 * paired with the best (lowest-priced, then oldest) eligible ask. Every order
 * is used at most once.
 */
export function findMatches(orders: OrderLike[]): Array<{ buy: number; sell: number }> {
  const bids = orders
    .filter((o) => o.is_bid)
    .sort((a, b) => b.price - a.price || a.order_id - b.order_id);
  const asks = orders
    .filter((o) => !o.is_bid)
    .sort((a, b) => a.price - b.price || a.order_id - b.order_id);

  const usedAsks = new Set<number>();
  const matches: Array<{ buy: number; sell: number }> = [];
  for (const bid of bids) {
    const ask = asks.find(
      (a) =>
        !usedAsks.has(a.order_id) &&
        a.price <= bid.price &&
        a.quantity === bid.quantity &&
        a.owner !== bid.owner,
    );
    if (!ask) continue;
    usedAsks.add(ask.order_id);
    matches.push({ buy: bid.order_id, sell: ask.order_id });
  }
  return matches;
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

async function fetchOpenOrders(
  config: ReturnType<typeof loadConfigFromEnv>,
  contractId: string,
): Promise<OrderLike[]> {
  const all: OrderLike[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const page = await viewCall<OrderLike[]>(config, contractId, 'get_open_orders', {
      from_index: from,
      limit: PAGE_SIZE,
    });
    all.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return all;
}

async function tick(
  contractId: string,
  config: ReturnType<typeof loadConfigFromEnv>,
  matcher: ReturnType<typeof createSigner>,
): Promise<void> {
  const market = await viewCall<MarketViewLike>(config, contractId, 'get_market', {});
  if (market.paused || market.settled || Date.now() >= market.expiry_ms) {
    log('market not matchable', {
      paused: market.paused,
      settled: market.settled,
      expiry_ms: market.expiry_ms,
    });
    return;
  }

  const orders = await fetchOpenOrders(config, contractId);
  const pairs = findMatches(orders);
  for (const { buy, sell } of pairs) {
    try {
      await matcher.callFunction({
        contractId,
        methodName: 'match_orders',
        args: { buy_order_id: buy, sell_order_id: sell },
        gas: TGAS_30,
        deposit: '0',
      });
      log('matched', { buy, sell });
    } catch (err) {
      log('match failed', { buy, sell, error: (err as Error).message });
    }
  }
}

async function main(): Promise<void> {
  const contractId = process.env.GASX_NEAR_CONTRACT_ID;
  if (!contractId) throw new Error('GASX_NEAR_CONTRACT_ID is required (see .env.example)');
  const intervalMs = envNumber('GASX_MATCH_INTERVAL_SECONDS', 5) * 1000;

  const config = loadConfigFromEnv();
  const matcher = createSigner('GASX_NEAR_MATCHER_ACCOUNT_ID', 'GASX_NEAR_MATCHER_PRIVATE_KEY');
  log('started', { contractId, intervalMs, matcher: matcher.accountId });

  for (;;) {
    try {
      await tick(contractId, config, matcher);
    } catch (err) {
      log('tick failed', { error: (err as Error).message });
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    log('fatal', { error: (err as Error).message });
    process.exit(1);
  });
}

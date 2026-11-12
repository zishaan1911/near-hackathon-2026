/**
 * Liquidity seeder CLI. Quotes a ladder around the oracle price from the seed
 * account: N bids at `price - k*tick` and N asks at `price + k*tick`
 * (k = 1..N). Each round first cancels the account's own open orders, then
 * re-places the ladder. The account must already have deposited collateral.
 *
 *   npx tsx src/seedLiquidity.ts          # refresh every GASX_SEED_INTERVAL_SECONDS
 *   npx tsx src/seedLiquidity.ts --once   # a single round
 */

import { loadConfigFromEnv, viewCall } from './index.js';
import { createSigner } from './signer.js';

const TGAS_30 = '30000000000000';
const PAGE_SIZE = 100;

interface OracleViewLike {
  price: number;
  has_price: boolean;
  max_price: number;
}

interface MarketViewLike {
  tick_size: number;
  paused: boolean;
  settled: boolean;
}

interface OrderViewLike {
  order_id: number;
  status: 'open' | 'filled' | 'cancelled';
}

function log(message: string, fields: Record<string, unknown> = {}): void {
  console.log(`[silica/seed] ${message} ${JSON.stringify(fields)}`);
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

async function openOrdersOf(
  config: ReturnType<typeof loadConfigFromEnv>,
  contractId: string,
  accountId: string,
): Promise<OrderViewLike[]> {
  const open: OrderViewLike[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const page = await viewCall<OrderViewLike[]>(config, contractId, 'get_orders_by_account', {
      account_id: accountId,
      from_index: from,
      limit: PAGE_SIZE,
    });
    open.push(...page.filter((o) => o.status === 'open'));
    if (page.length < PAGE_SIZE) break;
  }
  return open;
}

async function round(
  contractId: string,
  config: ReturnType<typeof loadConfigFromEnv>,
  seeder: ReturnType<typeof createSigner>,
  levels: number,
  quantity: number,
): Promise<void> {
  const oracle = await viewCall<OracleViewLike>(config, contractId, 'get_oracle', {});
  const market = await viewCall<MarketViewLike>(config, contractId, 'get_market', {});
  if (!oracle.has_price) {
    log('skipping round: oracle has no price yet');
    return;
  }
  if (market.paused || market.settled) {
    log('skipping round: market paused or settled', { paused: market.paused, settled: market.settled });
    return;
  }

  for (const order of await openOrdersOf(config, contractId, seeder.accountId)) {
    try {
      await seeder.callFunction({
        contractId,
        methodName: 'cancel_order',
        args: { order_id: order.order_id },
        gas: TGAS_30,
        deposit: '0',
      });
      log('cancelled', { order_id: order.order_id });
    } catch (err) {
      log('cancel failed', { order_id: order.order_id, error: (err as Error).message });
    }
  }

  // Snap the mid to the tick grid; place_order requires multiples of tick.
  const tick = market.tick_size;
  const mid = Math.round(oracle.price / tick) * tick;
  for (let k = 1; k <= levels; k++) {
    const quotes = [
      { is_bid: true, price: mid - k * tick },
      { is_bid: false, price: mid + k * tick },
    ];
    for (const { is_bid, price } of quotes) {
      if (price <= 0 || price > oracle.max_price) continue;
      try {
        await seeder.callFunction({
          contractId,
          methodName: 'place_order',
          args: { is_bid, price, quantity },
          gas: TGAS_30,
          deposit: '0',
        });
        log('placed', { is_bid, price, quantity });
      } catch (err) {
        log('place failed', { is_bid, price, error: (err as Error).message });
      }
    }
  }
}

async function main(): Promise<void> {
  const contractId = process.env.GASX_NEAR_CONTRACT_ID;
  if (!contractId) throw new Error('GASX_NEAR_CONTRACT_ID is required (see .env.example)');
  const once = process.argv.includes('--once');
  const levels = Math.floor(envNumber('GASX_SEED_LEVELS', 3));
  const quantity = Math.floor(envNumber('GASX_SEED_QUANTITY', 100));
  const intervalMs = envNumber('GASX_SEED_INTERVAL_SECONDS', 300) * 1000;

  const config = loadConfigFromEnv();
  const seeder = createSigner('GASX_NEAR_SEED_ACCOUNT_ID', 'GASX_NEAR_SEED_PRIVATE_KEY');
  log('started', { contractId, levels, quantity, once, seeder: seeder.accountId });

  for (;;) {
    try {
      await round(contractId, config, seeder, levels, quantity);
    } catch (err) {
      log('round failed', { error: (err as Error).message });
      if (once) process.exitCode = 1;
    }
    if (once) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

main().catch((err) => {
  log('fatal', { error: (err as Error).message });
  process.exit(1);
});

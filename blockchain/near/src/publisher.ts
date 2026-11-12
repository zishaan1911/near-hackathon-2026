/**
 * Oracle publisher service. Every GASX_PUBLISH_INTERVAL_SECONDS it reads the
 * latest Compute Index level from the gateway (GET /api/v1/indices/compute,
 * `index.level`; base URL in GASX_PUBLISH_API_URL), converts it to
 * an integer oracle price and submits `update_price` from the publisher
 * account. Once the market is past expiry it also calls the permissionless
 * `settle_market` each tick until the market is settled.
 *
 * Run with: `npx tsx src/publisher.ts` (or `npm run publisher`).
 */

import { pathToFileURL } from 'node:url';
import { loadConfigFromEnv, viewCall } from './index.js';
import { createSigner } from './signer.js';

const TGAS_30 = '30000000000000';

interface OracleViewLike {
  max_price: number;
  has_price: boolean;
}

interface MarketViewLike {
  expiry_ms: number;
  settled: boolean;
}

function log(message: string, fields: Record<string, unknown> = {}): void {
  console.log(`[gasx/publisher] ${message} ${JSON.stringify(fields)}`);
}

/**
 * Converts an index level into the integer the contract accepts: rounded to
 * the nearest integer and clamped to [0, maxPrice]. Returns null for a score
 * that is not a finite, non-negative number (the caller skips the tick).
 */
export function toOraclePrice(score: number, maxPrice: number): number | null {
  if (typeof score !== 'number' || !Number.isFinite(score) || score < 0) return null;
  if (!Number.isFinite(maxPrice) || maxPrice < 0) return null;
  return Math.min(Math.max(Math.round(score), 0), Math.floor(maxPrice));
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

async function fetchScore(apiUrl: string): Promise<number | null> {
  const res = await fetch(`${apiUrl.replace(/\/$/, '')}/api/v1/indices/compute`);
  if (!res.ok) {
    log('index endpoint returned an error', { status: res.status });
    return null;
  }
  const body = (await res.json()) as { index?: { level?: number | null } };
  const level = body.index?.level;
  return typeof level === 'number' ? level : null;
}

async function tick(
  contractId: string,
  apiUrl: string,
  config: ReturnType<typeof loadConfigFromEnv>,
  publisher: ReturnType<typeof createSigner>,
): Promise<void> {
  const oracle = await viewCall<OracleViewLike>(config, contractId, 'get_oracle', {});
  const score = await fetchScore(apiUrl);
  const price = score === null ? null : toOraclePrice(score, oracle.max_price);
  if (price === null) {
    log('skipping publish: no usable score', { score });
  } else {
    await publisher.callFunction({
      contractId,
      methodName: 'update_price',
      args: { price },
      gas: TGAS_30,
      deposit: '0',
    });
    log('published price', { score, price });
  }

  const market = await viewCall<MarketViewLike>(config, contractId, 'get_market', {});
  if (!market.settled && Date.now() >= market.expiry_ms) {
    await publisher.callFunction({
      contractId,
      methodName: 'settle_market',
      args: {},
      gas: TGAS_30,
      deposit: '0',
    });
    log('settled market', { expiry_ms: market.expiry_ms });
  }
}

async function main(): Promise<void> {
  const contractId = process.env.GASX_NEAR_CONTRACT_ID;
  if (!contractId) throw new Error('GASX_NEAR_CONTRACT_ID is required (see .env.example)');
  const apiUrl = process.env.GASX_PUBLISH_API_URL || 'http://localhost:3000';
  const intervalMs = envNumber('GASX_PUBLISH_INTERVAL_SECONDS', 60) * 1000;

  const config = loadConfigFromEnv();
  const publisher = createSigner(
    'GASX_NEAR_PUBLISHER_ACCOUNT_ID',
    'GASX_NEAR_PUBLISHER_PRIVATE_KEY',
  );
  log('started', { contractId, apiUrl, intervalMs, publisher: publisher.accountId });

  for (;;) {
    try {
      await tick(contractId, apiUrl, config, publisher);
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

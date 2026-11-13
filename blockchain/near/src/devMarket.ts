/**
 * Dev-market mode: a synthetic, clearly-marked SCI-1H market served
 * when the Silica contract is not yet deployed (config.devMarket).
 *
 * It exists so the whole stack (server, frontend)
 * runs end-to-end before anyone has deployed the contract to NEAR.
 * Everything that reads the market (GET /api/v1/market) works; reads of
 * accounts/orders/trades return empty results; everything that would
 * build a transaction to sign (prepare*) refuses, because there is no
 * on-chain market to sign for.
 *
 * The synthetic market mirrors a typical on-chain configuration:
 * 1-hour expiry rolling to the next whole hour, multiplier 1, tick 1,
 * 50% initial margin, unpaused, unsettled. The oracle has never
 * published, which the frontend displays honestly as "never published" —
 * the live index value itself comes from the server's compute service,
 * not from this synthetic market.
 */
import type { NearAdapterConfig } from './config.js';
import type { MarketState } from './types.js';

export function fetchDevMarketState(config: NearAdapterConfig): MarketState {
  const now = Date.now();
  const hourMs = 3_600_000;
  const expiryMs = Math.floor(now / hourMs) * hourMs + hourMs;

  return {
    marketId: 'dev-market',
    underlying: 'Silica Compute Index',
    expiryMs,
    contractMultiplier: 1,
    tickSize: 1,
    marginRatioBps: 5000,
    paused: false,
    settled: false,
    settlementPrice: null,
    oracle: {
      oracleId: 'dev-oracle',
      price: 0,
      hasPrice: false,
      lastUpdateMs: 0,
      maxStalenessMs: hourMs,
      maxPrice: 1000,
      isFreshApprox: false,
    },
    devMode: true,
    network: config.network,
  };
}

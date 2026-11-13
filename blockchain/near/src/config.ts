/**
 * Environment-driven configuration for the NEAR adapter. Copy .env.example
 * to .env and fill in real values (the contract account and collateral
 * token come from the Silica contract deployment, see docs/near-abi.md).
 */
import { readEnv } from './env.js';

export interface NearAdapterConfig {
  /** 'testnet' | 'mainnet' | 'localnet'. */
  network: string;
  /** NEAR JSON-RPC URL (e.g. https://test.rpc.fastnear.com). */
  rpcUrl: string;
  /** The Silica contract account. Empty in dev-market mode. */
  contractId: string;
  /** The NEP-141 collateral token account (tUSDC, 6 decimals). Empty in
   * dev-market mode. */
  collateralToken: string;
  /** True when the contract is not deployed and the adapter serves a
   * synthetic market instead of reading NEAR. See devMarket.ts. */
  devMarket: boolean;
}

/**
 * SILICA_NEAR_DEV_MARKET: 'true' forces the synthetic dev market, 'false'
 * requires the contract and collateral token to be set (fail fast), and
 * unset (the default) auto-selects: any missing ID means dev-market mode.
 *
 * Dev mode exists so the whole stack (server -> frontend) runs before the
 * contract is deployed, see devMarket.ts.
 */
export function loadConfigFromEnv(): NearAdapterConfig {
  const network = readEnv('NEAR_NETWORK') || 'testnet';
  const rpcUrl = readEnv('NEAR_RPC_URL') || 'https://test.rpc.fastnear.com';

  const contractId = readEnv('NEAR_CONTRACT_ID') || '';
  const collateralToken = readEnv('NEAR_COLLATERAL_TOKEN') || '';

  const idsMissing = !contractId || !collateralToken;
  const forced = readEnv('NEAR_DEV_MARKET');
  const devMarket = forced === 'true' ? true : forced === 'false' ? false : idsMissing;

  if (!devMarket && idsMissing) {
    throw new Error(
      'SILICA_NEAR_CONTRACT_ID and SILICA_NEAR_COLLATERAL_TOKEN are both required ' +
        'unless SILICA_NEAR_DEV_MARKET is set (see blockchain/near/.env.example)',
    );
  }

  return { network, rpcUrl, contractId, collateralToken, devMarket };
}
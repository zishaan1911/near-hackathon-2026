/**
 * Server-side signing helper for the NEAR services (publisher, matcher,
 * liquidity seeder). The adapter itself never signs; only these long-running
 * processes hold a key, and each reads its own account/key pair from env.
 */

import { Account } from 'near-api-js';

const DEFAULT_RPC_URLS: Record<string, string> = {
  testnet: 'https://test.rpc.fastnear.com',
  mainnet: 'https://free.rpc.fastnear.com',
};

/** Resolves the JSON-RPC URL: GASX_NEAR_RPC_URL, else the network default. */
export function resolveRpcUrl(): string {
  const explicit = process.env.GASX_NEAR_RPC_URL;
  if (explicit) return explicit;
  const network = process.env.GASX_NEAR_NETWORK || 'testnet';
  const url = DEFAULT_RPC_URLS[network];
  if (!url) {
    throw new Error(`GASX_NEAR_RPC_URL is required for network "${network}"`);
  }
  return url;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required (see .env.example)`);
  }
  return value;
}

/**
 * Builds a signing near-api-js Account from two env vars: one holding the
 * account id, one holding the private key in `ed25519:...` form. Throws if
 * either is missing or the key is malformed. The key is never logged, and
 * error messages name only the variable.
 */
export function createSigner(accountIdEnv: string, privateKeyEnv: string): Account {
  const accountId = requireEnv(accountIdEnv);
  const privateKey = requireEnv(privateKeyEnv);
  if (!privateKey.startsWith('ed25519:')) {
    throw new Error(`${privateKeyEnv} must be an ed25519 key in the form "ed25519:..."`);
  }
  return new Account(accountId, resolveRpcUrl(), privateKey as `ed25519:${string}`);
}

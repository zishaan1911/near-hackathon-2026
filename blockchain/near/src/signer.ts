/**
 * Server-side signing helper for the cron tick. The adapter itself never
 * signs; only the tick holds a key (the publisher account's), read from env.
 */

import { Account } from 'near-api-js';
import { readEnv, type EnvSource } from './env.js';

const DEFAULT_RPC_URLS: Record<string, string> = {
  testnet: 'https://test.rpc.fastnear.com',
  mainnet: 'https://free.rpc.fastnear.com',
};

/** Resolves the JSON-RPC URL: SILICA_NEAR_RPC_URL, else the network default. */
export function resolveRpcUrl(env: EnvSource = process.env): string {
  const explicit = readEnv('NEAR_RPC_URL', env);
  if (explicit) return explicit;
  const network = readEnv('NEAR_NETWORK', env) || 'testnet';
  const url = DEFAULT_RPC_URLS[network];
  if (!url) {
    throw new Error(`SILICA_NEAR_RPC_URL is required for network "${network}"`);
  }
  return url;
}

function requireEnv(name: string, env: EnvSource): string {
  const value = readEnv(name, env);
  if (!value) {
    throw new Error(`SILICA_${name} is required (see .env.example)`);
  }
  return value;
}

/**
 * Builds the publisher's signing near-api-js Account from
 * SILICA_NEAR_PUBLISHER_ACCOUNT_ID and SILICA_NEAR_PUBLISHER_PRIVATE_KEY
 * (`ed25519:...`; the GASX_ names also work). Throws if either is missing
 * or the key is malformed. The key is never logged, and error messages name
 * only the variable.
 */
export function createSigner(env: EnvSource = process.env): Account {
  const accountId = requireEnv('NEAR_PUBLISHER_ACCOUNT_ID', env);
  const privateKey = requireEnv('NEAR_PUBLISHER_PRIVATE_KEY', env);
  if (!privateKey.startsWith('ed25519:')) {
    throw new Error('SILICA_NEAR_PUBLISHER_PRIVATE_KEY must be an ed25519 key in the form "ed25519:..."');
  }
  return new Account(accountId, resolveRpcUrl(env), privateKey as `ed25519:${string}`);
}
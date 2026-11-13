import type { PreparedTransaction } from './api';

/** The collateral token (tUSDC) contract. Account ids keep the project's original name (they are on-chain). */
export const TOKEN_ID: string = import.meta.env.VITE_NEAR_COLLATERAL_TOKEN || 'tusdc.gasx.testnet';
export const TOKEN_SYMBOL = 'tUSDC';

const RPC_URL = 'https://test.rpc.fastnear.com';

/** One faucet call: 1,000 tUSDC to the signer. Refused above 10,000 held. */
export function faucetTransaction(token: string = TOKEN_ID): PreparedTransaction {
  return {
    receiverId: token,
    actions: [
      {
        type: 'FunctionCall',
        params: { methodName: 'faucet', args: {}, gas: '30000000000000', deposit: '0' },
      },
    ],
    summary: {},
  };
}

/** Decodes the byte array of a view-call result into a base-unit string. */
export function decodeBalance(bytes: unknown): string {
  if (!Array.isArray(bytes)) throw new Error('Could not read your wallet balance.');
  const value: unknown = JSON.parse(new TextDecoder().decode(Uint8Array.from(bytes as number[])));
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new Error('Could not read your wallet balance.');
  }
  return value;
}

/** Wallet tUSDC balance in base units, read straight from the token contract. */
export async function getWalletBalance(accountId: string): Promise<string> {
  const response = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'silica',
      method: 'query',
      params: {
        request_type: 'call_function',
        finality: 'final',
        account_id: TOKEN_ID,
        method_name: 'ft_balance_of',
        args_base64: btoa(JSON.stringify({ account_id: accountId })),
      },
    }),
  });
  if (!response.ok) throw new Error('Could not read your wallet balance.');
  const payload = (await response.json()) as { result?: { result?: unknown } };
  return decodeBalance(payload.result?.result);
}

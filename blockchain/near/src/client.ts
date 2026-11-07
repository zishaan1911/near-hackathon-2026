/**
 * Minimal NEAR JSON-RPC read client: a `call_function` view call over
 * plain `fetch`. No signing and no SDK — this adapter only reads (writes
 * are prepared for a wallet, see actionBuilders.ts).
 */
import type { NearAdapterConfig } from './config.js';

interface CallFunctionResponse {
  result?: { result?: unknown; error?: unknown; logs?: unknown };
  error?: { name?: string; cause?: { name?: string }; message?: string; data?: unknown };
}

/**
 * Calls a view method on `contractId` and decodes the result bytes as
 * JSON. `args` is JSON-encoded then base64'd, as `call_function` expects.
 * Throws on transport errors, RPC errors and contract panics (which NEAR
 * reports as a successful RPC response carrying an `error` string).
 */
export async function viewCall<T>(
  config: Pick<NearAdapterConfig, 'rpcUrl'>,
  contractId: string,
  methodName: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const response = await fetch(config.rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'gasx',
      method: 'query',
      params: {
        request_type: 'call_function',
        finality: 'final',
        account_id: contractId,
        method_name: methodName,
        args_base64: Buffer.from(JSON.stringify(args), 'utf8').toString('base64'),
      },
    }),
  });
  if (!response.ok) {
    throw new Error(`NEAR RPC ${config.rpcUrl} returned HTTP ${response.status} for ${methodName}`);
  }

  const payload = (await response.json()) as CallFunctionResponse;
  if (payload.error) {
    const detail = payload.error.message ?? payload.error.cause?.name ?? payload.error.name ?? 'unknown error';
    throw new Error(`NEAR RPC error calling ${contractId}.${methodName}: ${detail}`);
  }

  const result = payload.result;
  if (!result) {
    throw new Error(`NEAR RPC response for ${contractId}.${methodName} had no result`);
  }
  if (typeof result.error === 'string') {
    throw new Error(`${contractId}.${methodName} failed: ${result.error}`);
  }
  const bytes = result.result;
  if (!Array.isArray(bytes) || !bytes.every((b) => typeof b === 'number')) {
    throw new Error(`NEAR RPC response for ${contractId}.${methodName} had a non-byte result`);
  }

  const text = Buffer.from(bytes as number[]).toString('utf8');
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${contractId}.${methodName} returned non-JSON: ${text.slice(0, 200)}`);
  }
}

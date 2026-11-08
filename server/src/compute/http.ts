import type { FetchImpl } from './types.js';

export const TIMEOUT_MS = 8000;

/** fetch with an 8s timeout and one retry on network error (not on HTTP status). */
export async function fetchJson(fetchImpl: FetchImpl, url: string, init?: RequestInit): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return res.json();
}

export function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null;
}

export function num(x: unknown): number | null {
  const n = typeof x === 'string' ? Number(x) : x;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

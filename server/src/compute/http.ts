import type { FetchImpl } from './types.js';

export const TIMEOUT_MS = 8000;

async function fetchOk(fetchImpl: FetchImpl, url: string, init: RequestInit | undefined, timeoutMs: number): Promise<Response> {
  let res: Response;
  try {
    res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return res;
}

/** fetch with an 8s timeout and one retry on network error (not on HTTP status). */
export async function fetchJson(fetchImpl: FetchImpl, url: string, init?: RequestInit): Promise<unknown> {
  return (await fetchOk(fetchImpl, url, init, TIMEOUT_MS)).json();
}

/** Same as fetchJson but returns the body text, with a caller-chosen timeout (large payloads). */
export async function fetchText(
  fetchImpl: FetchImpl,
  url: string,
  init?: RequestInit,
  timeoutMs: number = TIMEOUT_MS,
): Promise<string> {
  return (await fetchOk(fetchImpl, url, init, timeoutMs)).text();
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

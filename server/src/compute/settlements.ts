/**
 * On-chain settlements: every settled hourly market (underlying ending in
 * "CI-1H": CCI-1H, SCI-1H) stores its settlement price on chain. Read
 * get_market({market_id}) for ids 1..current and keep the settled ones.
 * Settled markets never change, so they are cached forever in memory; ids not
 * yet settled are re-read at most once a minute.
 */
import type { MarketState, MarketSummary } from '@gasx/near-adapter';

export const SETTLEMENT_RECHECK_MS = 60_000;
const CONCURRENCY = 8;

export interface Settlement {
  t: string;
  level: number;
  marketId: number;
}

export interface SettlementChain {
  getMarketState(): Promise<MarketState>;
  getMarketById?(marketNumber: number): Promise<MarketSummary | null>;
}

export interface SettlementReaderOptions {
  chain: SettlementChain;
  now?: () => number;
  recheckMs?: number;
}

/** Current market number from "<contractId>#<n>"; null for the dev market. */
export function marketNumberOf(marketId: string): number | null {
  const m = /#(\d+)$/.exec(marketId);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export function isHourlyIndexMarket(underlying: string): boolean {
  return underlying.endsWith('CI-1H');
}

export function createSettlementReader(opts: SettlementReaderOptions): () => Promise<Settlement[]> {
  const now = opts.now ?? (() => Date.now());
  const recheck = opts.recheckMs ?? SETTLEMENT_RECHECK_MS;
  const settled = new Map<number, Settlement>(); // cached forever
  const ignored = new Set<number>(); // other underlyings, immutable: never re-read
  let lastPass = -Infinity;
  let inflight: Promise<Settlement[]> | null = null;

  const sorted = (): Settlement[] => [...settled.values()].sort((a, b) => a.t.localeCompare(b.t) || a.marketId - b.marketId);

  async function pass(): Promise<Settlement[]> {
    lastPass = now();
    const getById = opts.chain.getMarketById?.bind(opts.chain);
    if (!getById) return sorted();
    let current: number | null;
    try {
      current = marketNumberOf((await opts.chain.getMarketState()).marketId);
    } catch {
      return sorted();
    }
    if (current === null) return sorted();
    const todo: number[] = [];
    for (let id = 1; id <= current; id++) if (!settled.has(id) && !ignored.has(id)) todo.push(id);
    let next = 0;
    async function worker(): Promise<void> {
      while (next < todo.length) {
        const id = todo[next++] as number;
        try {
          const m = await getById!(id);
          if (!m) continue;
          if (!isHourlyIndexMarket(m.underlying)) ignored.add(id);
          else if (m.settled && m.settlementPrice !== null) {
            settled.set(id, { t: new Date(m.expiryMs).toISOString(), level: m.settlementPrice, marketId: id });
          }
        } catch {
          // transient read failure: retried on the next pass
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker));
    return sorted();
  }

  return async () => {
    if (inflight) return inflight;
    if (now() - lastPass < recheck) return sorted();
    inflight = pass().finally(() => {
      inflight = null;
    });
    return inflight;
  };
}

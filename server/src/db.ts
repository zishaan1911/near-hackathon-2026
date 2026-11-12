/**
 * Postgres (Supabase) access for the API gateway — the only service that
 * talks to the database (ARCHITECTURE.md §2: the gateway owns "indexing",
 * and Storage holds "durable state; live index/orderbook cached in API
 * memory").
 *
 * Two deliberate design points:
 *
 * 1. **Persistence never fails a request.** Every write here is
 *    best-effort: it logs and swallows on error rather than throwing.
 *    A trader placing an order
 *    should not get a 500 because the audit table was briefly
 *    unreachable. The request's own work has already succeeded by the
 *    time these are called. Reads are separate — those propagate, since
 *    a caller asking for history explicitly wants to know if it failed.
 *
 * 2. **The database is optional.** With no GASX_API_DATABASE_URL
 *    configured, `createDatabase` returns null and the gateway runs
 *    exactly as before, just without durable state. That keeps the
 *    dev-market path (blockchain/near's devMarket.ts) working with no
 *    Postgres at all.
 */
import postgres from 'postgres';
import type { JSONValue, Sql } from 'postgres';

/** One OHLC bar. `time` is the bucket's start, unix seconds — the unit
 * TradingView's lightweight-charts expects. */
export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Readings in the bucket. The index has no traded volume, so this is
   * sample count — useful for spotting thin buckets, and honestly named
   * rather than dressed up as volume. */
  samples: number;
}

export interface PreparedOrderRow {
  trader: string;
  /** The migration's margin_account column is NOT NULL and predates the
   * NEAR port; on NEAR there is no per-trader margin account, so the
   * gateway records the contract id here. */
  marginAccount: string;
  isBid: boolean;
  price: number;
  quantity: number;
  outcome: 'prepared' | 'rejected';
  rejectReason: string | null;
}

export interface ComputeIndexSnapshotInput {
  level: number;
  /** Stored as jsonb; must be JSON-serialisable. */
  components: unknown;
  methodologyVersion: string;
}

export interface ComputeIndexPoint {
  /** ISO timestamp. */
  t: string;
  level: number;
}

export interface Database {
  /** Best-effort SCI snapshot write. Resolves true when stored. */
  recordComputeIndexSnapshot(input: ComputeIndexSnapshotInput): Promise<boolean>;
  /** SCI levels of the last `days` days (clamped 1..90), oldest first; [] on error. */
  getComputeIndexHistory(days: number): Promise<ComputeIndexPoint[]>;
  recordPreparedOrder(row: PreparedOrderRow): Promise<void>;
  /** SCI levels aggregated into OHLC candles for charting, oldest first; [] on error. */
  getComputeIndexCandles(intervalSeconds: number, limit: number): Promise<Candle[]>;
  close(): Promise<void>;
}

type Logger = { error: (msg: string) => void };

type RawRow = Record<string, unknown>;

/** Clamps a caller-supplied limit to an integer in [1, max]. */
export function clampLimit(limit: number, max: number): number {
  if (!Number.isFinite(limit)) return 1;
  return Math.max(1, Math.min(max, Math.trunc(limit)));
}

/** Candle bucket width in whole seconds, at least 1. */
export function clampInterval(intervalSeconds: number): number {
  if (!Number.isFinite(intervalSeconds)) return 1;
  return Math.max(1, Math.trunc(intervalSeconds));
}

/** Start (unix seconds) of the bucket a timestamp falls in. Mirrors the
 * SQL bucketing so the two can be checked against each other. */
export function bucketStart(timestampSeconds: number, intervalSeconds: number): number {
  return Math.floor(timestampSeconds / intervalSeconds) * intervalSeconds;
}

/** Postgres returns numeric and bigint as strings; the app's types are numbers. numeric comes back as a string and timestamptz as a Date. */
export function mapComputeIndexRow(r: RawRow): ComputeIndexPoint {
  const taken = r.taken_at instanceof Date ? r.taken_at : new Date(String(r.taken_at));
  return { t: taken.toISOString(), level: Number(r.level) };
}

export function mapCandleRow(r: RawRow): Candle {
  return {
    time: Number(r.time),
    open: Number(r.open),
    high: Number(r.high),
    low: Number(r.low),
    close: Number(r.close),
    samples: Number(r.samples),
  };
}

export class PostgresDatabase implements Database {
  constructor(
    private readonly sql: Sql,
    private readonly log: Logger,
  ) {}

  async recordComputeIndexSnapshot(input: ComputeIndexSnapshotInput): Promise<boolean> {
    try {
      await this.sql`
        INSERT INTO compute_index_snapshots (level, components, methodology_version)
        VALUES (${input.level}, ${this.sql.json(input.components as JSONValue)}, ${input.methodologyVersion})`;
      return true;
    } catch (err) {
      this.log.error(`failed to record compute index snapshot: ${(err as Error).message}`);
      return false;
    }
  }

  async getComputeIndexHistory(days: number): Promise<ComputeIndexPoint[]> {
    try {
      const safeDays = clampLimit(days, 90);
      const rows = await this.sql<RawRow[]>`
        SELECT taken_at, level
        FROM compute_index_snapshots
        WHERE taken_at >= now() - make_interval(days => ${safeDays}::int)
        ORDER BY taken_at ASC
        LIMIT 10000`;
      return rows.map(mapComputeIndexRow);
    } catch (err) {
      this.log.error(`failed to read compute index history: ${(err as Error).message}`);
      return [];
    }
  }

  async recordPreparedOrder(row: PreparedOrderRow): Promise<void> {
    try {
      await this.sql`
        INSERT INTO prepared_order
          (trader, margin_account, is_bid, price, quantity, outcome, reject_reason)
        VALUES (${row.trader}, ${row.marginAccount}, ${row.isBid}, ${row.price},
                ${row.quantity}, ${row.outcome}, ${row.rejectReason})`;
    } catch (err) {
      this.log.error(`failed to record prepared order: ${(err as Error).message}`);
    }
  }

  /**
   * Buckets SCI snapshots into fixed intervals and derives OHLC per bucket
   * in SQL (open/close are the first/last level by `taken_at`). The query
   * runs newest-first so LIMIT keeps the most recent candles; the result is
   * reversed because charts read oldest-first.
   */
  async getComputeIndexCandles(intervalSeconds: number, limit: number): Promise<Candle[]> {
    try {
      const interval = clampInterval(intervalSeconds);
      const safeLimit = clampLimit(limit, 5_000);
      const rows = await this.sql<RawRow[]>`
        SELECT bucket AS time,
               MIN(level) AS low,
               MAX(level) AS high,
               (ARRAY_AGG(level ORDER BY taken_at ASC))[1] AS open,
               (ARRAY_AGG(level ORDER BY taken_at DESC))[1] AS close,
               COUNT(*) AS samples
        FROM (
          SELECT level, taken_at,
                 FLOOR(EXTRACT(EPOCH FROM taken_at) / ${interval}::bigint)::bigint * ${interval}::bigint AS bucket
          FROM compute_index_snapshots
        ) AS bucketed
        GROUP BY bucket
        ORDER BY bucket DESC
        LIMIT ${safeLimit}`;
      return rows.map(mapCandleRow).reverse();
    } catch (err) {
      this.log.error(`failed to read compute index candles: ${(err as Error).message}`);
      return [];
    }
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }
}

function isLocalHost(databaseUrl: string): boolean {
  try {
    const host = new URL(databaseUrl).hostname.replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
}

/** Returns null when no database is configured — the gateway then runs
 * without durable state rather than refusing to start. */
export function createDatabase(databaseUrl: string | undefined, log: Logger): Database | null {
  if (!databaseUrl) return null;
  const sql = postgres(databaseUrl, {
    // One connection and no prepared statements: both are required for
    // Supabase's transaction pooler and for serverless runtimes, where
    // connections are short-lived and shared.
    max: 1,
    prepare: false,
    idle_timeout: 20,
    ssl: isLocalHost(databaseUrl) ? false : 'require',
  });
  return new PostgresDatabase(sql, log);
}



/**
 * Postgres (Supabase) access for the API gateway — the only service that
 * talks to the database (ARCHITECTURE.md §2: the gateway owns "indexing",
 * and Storage holds "durable state; live EGSI/orderbook cached in API
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

export interface EgsiSnapshotRow {
  market: string;
  score: number;
  blockNumber: number;
  blockTimestamp: number;
  baseFee: number;
  utilization: number;
  mempoolPressure: number;
  feeMomentum: number;
  gasVolatility: number;
  dexActivity: number;
  thetanutsIv: number | null;
  thetanutsSkew: number | null;
}

/** One OHLC bar. `time` is the bucket's start, unix seconds — the unit
 * TradingView's lightweight-charts expects. */
export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Readings in the bucket. EGSI has no traded volume, so this is
   * sample count — useful for spotting thin buckets, and honestly named
   * rather than dressed up as volume. */
  samples: number;
}

export interface ForecastRow {
  market: string;
  expectedEgsi: number;
  confidence: number;
  pTail500: number;
  modelVersion: string;
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
  /** Best-effort CCI snapshot write. Resolves true when stored. */
  recordComputeIndexSnapshot(input: ComputeIndexSnapshotInput): Promise<boolean>;
  /** CCI levels of the last `days` days (clamped 1..90), oldest first; [] on error. */
  getComputeIndexHistory(days: number): Promise<ComputeIndexPoint[]>;
  recordEgsiSnapshot(row: EgsiSnapshotRow): Promise<number | null>;
  recordForecast(row: ForecastRow, snapshotId: number | null): Promise<void>;
  recordPreparedOrder(row: PreparedOrderRow): Promise<void>;
  /** Durable EGSI history, oldest first — what ai/inference/train.py
   * needs in order to train on real data rather than synthetic. */
  getEgsiHistory(market: string, limit: number): Promise<EgsiSnapshotRow[]>;
  /** EGSI aggregated into OHLC candles for charting. */
  getEgsiCandles(market: string, intervalSeconds: number, limit: number): Promise<Candle[]>;
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

/** Postgres returns numeric and bigint as strings; the app's types are
 * numbers, so the conversion lives here in one place. */
export function mapSnapshotRow(r: RawRow): EgsiSnapshotRow {
  return {
    market: String(r.market),
    score: Number(r.score),
    blockNumber: Number(r.block_number),
    blockTimestamp: Number(r.block_timestamp),
    baseFee: Number(r.base_fee),
    utilization: Number(r.utilization),
    mempoolPressure: Number(r.mempool_pressure),
    feeMomentum: Number(r.fee_momentum),
    gasVolatility: Number(r.gas_volatility),
    dexActivity: Number(r.dex_activity),
    thetanutsIv: r.thetanuts_iv === null || r.thetanuts_iv === undefined ? null : Number(r.thetanuts_iv),
    thetanutsSkew:
      r.thetanuts_skew === null || r.thetanuts_skew === undefined ? null : Number(r.thetanuts_skew),
  };
}

/** numeric comes back as a string and timestamptz as a Date. */
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

  /** Returns the row id so a forecast can be linked to it, or null if
   * the write failed (in which case the forecast is stored unlinked
   * rather than lost). */
  async recordEgsiSnapshot(row: EgsiSnapshotRow): Promise<number | null> {
    try {
      // ON CONFLICT: the gateway polls faster than the AI service
      // produces new blocks, so re-seeing the same block is the normal
      // case, not an error. Touching score keeps the row current if a
      // recomputation changed it, and RETURNING id yields the existing
      // row's id either way.
      const rows = await this.sql<RawRow[]>`
        INSERT INTO egsi_snapshot
          (market, score, block_number, block_timestamp, base_fee, utilization,
           mempool_pressure, fee_momentum, gas_volatility, dex_activity,
           thetanuts_iv, thetanuts_skew)
        VALUES (${row.market}, ${row.score}, ${row.blockNumber}, ${row.blockTimestamp},
                ${row.baseFee}, ${row.utilization}, ${row.mempoolPressure},
                ${row.feeMomentum}, ${row.gasVolatility}, ${row.dexActivity},
                ${row.thetanutsIv}, ${row.thetanutsSkew})
        ON CONFLICT (market, block_number) DO UPDATE SET score = EXCLUDED.score
        RETURNING id`;
      const id = Number(rows[0]?.id);
      return Number.isFinite(id) && id > 0 ? id : null;
    } catch (err) {
      this.log.error(`failed to record EGSI snapshot: ${(err as Error).message}`);
      return null;
    }
  }

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

  async recordForecast(row: ForecastRow, snapshotId: number | null): Promise<void> {
    try {
      await this.sql`
        INSERT INTO forecast
          (market, expected_egsi, confidence, p_tail_500, model_version, egsi_snapshot_id)
        VALUES (${row.market}, ${row.expectedEgsi}, ${row.confidence}, ${row.pTail500},
                ${row.modelVersion}, ${snapshotId})`;
    } catch (err) {
      this.log.error(`failed to record forecast: ${(err as Error).message}`);
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

  async getEgsiHistory(market: string, limit: number): Promise<EgsiSnapshotRow[]> {
    // The limit is still clamped to a bounded integer rather than
    // trusted, even though it is bound as a parameter here.
    const safeLimit = clampLimit(limit, 10_000);
    const rows = await this.sql<RawRow[]>`
      SELECT market, score, block_number, block_timestamp, base_fee, utilization,
             mempool_pressure, fee_momentum, gas_volatility, dex_activity,
             thetanuts_iv, thetanuts_skew
      FROM egsi_snapshot
      WHERE market = ${market}
      ORDER BY block_number ASC
      LIMIT ${safeLimit}`;
    return rows.map(mapSnapshotRow);
  }

  /**
   * Buckets readings into fixed intervals and derives OHLC per bucket.
   *
   * Done in SQL rather than in JS because the alternative is shipping
   * every raw reading to the gateway just to fold it — at 12s cycles a
   * day of history is ~7,000 rows for maybe 100 candles.
   *
   * Open and close use Postgres window functions ordered by block_number,
   * so "first" and "last" mean first and last *by block*, not by
   * whichever row the engine happened to return first.
   */
  async getEgsiCandles(market: string, intervalSeconds: number, limit: number): Promise<Candle[]> {
    const interval = clampInterval(intervalSeconds);
    const safeLimit = clampLimit(limit, 5_000);
    // Integer division on bigint truncates, matching FLOOR for the
    // non-negative unix timestamps stored here.
    const rows = await this.sql<RawRow[]>`
      SELECT bucket AS time,
             MIN(score) AS low,
             MAX(score) AS high,
             MIN(first_score) AS open,
             MIN(last_score)  AS close,
             COUNT(*) AS samples
      FROM (
        SELECT score,
               (block_timestamp / ${interval}::bigint) * ${interval}::bigint AS bucket,
               FIRST_VALUE(score) OVER w AS first_score,
               LAST_VALUE(score)  OVER w AS last_score
        FROM egsi_snapshot
        WHERE market = ${market}
        WINDOW w AS (
          PARTITION BY (block_timestamp / ${interval}::bigint)
          ORDER BY block_number
          ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
        )
      ) AS bucketed
      GROUP BY bucket
      ORDER BY bucket DESC
      LIMIT ${safeLimit}`;
    // Query descending so LIMIT keeps the most RECENT candles, then
    // reverse: charts read oldest-first.
    return rows.map(mapCandleRow).reverse();
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

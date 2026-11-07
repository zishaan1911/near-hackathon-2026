/**
 * Database tests.
 *
 * The pure helpers (row mapping, limit clamping, candle bucketing math)
 * are tested unconditionally. The integration block runs against a REAL
 * Postgres server, not a mock — a mocked database would happily accept
 * SQL that a real server rejects, which defeats the point of testing the
 * schema at all. It is skipped automatically when GASX_TEST_DATABASE_URL
 * is unset, so the default test run needs no database.
 *
 * To run it (the migration is applied by the test itself, idempotently;
 * tables are truncated before each case, so use a scratch database):
 *   GASX_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/gasx_test npm test
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import {
  bucketStart,
  clampInterval,
  clampLimit,
  createDatabase,
  mapCandleRow,
  mapSnapshotRow,
  type Database,
} from '../src/db.js';

const url = process.env.GASX_TEST_DATABASE_URL;
const silentLog = { error: () => {} };

describe('pure helpers', () => {
  it('clamps limits to a bounded positive integer', () => {
    expect(clampLimit(10_000_000, 10_000)).toBe(10_000);
    expect(clampLimit(2.7, 10_000)).toBe(2);
    expect(clampLimit(0, 10_000)).toBe(1);
    expect(clampLimit(-5, 10_000)).toBe(1);
    expect(clampLimit(Number.NaN, 10_000)).toBe(1);
  });

  it('clamps the candle interval to at least one second', () => {
    expect(clampInterval(60)).toBe(60);
    expect(clampInterval(0.4)).toBe(1);
    expect(clampInterval(-10)).toBe(1);
    expect(clampInterval(90.9)).toBe(90);
  });

  it('buckets timestamps to the start of their interval', () => {
    expect(bucketStart(1_700_000_000, 60)).toBe(1_699_999_980);
    expect(bucketStart(120, 60)).toBe(120);
    expect(bucketStart(179, 60)).toBe(120);
    expect(bucketStart(5, 1)).toBe(5);
  });

  it('maps a snapshot row, converting strings to numbers and keeping nulls', () => {
    const mapped = mapSnapshotRow({
      market: 'EGSI-1H',
      score: 612,
      block_number: '21458332',
      block_timestamp: '1700000000',
      base_fee: '0.72000',
      utilization: '0.88000',
      mempool_pressure: '0.61000',
      fee_momentum: '0.44000',
      gas_volatility: '0.29000',
      dex_activity: '0.53000',
      thetanuts_iv: null,
      thetanuts_skew: '-0.05000',
    });
    expect(mapped.blockNumber).toBe(21458332);
    expect(mapped.baseFee).toBeCloseTo(0.72, 5);
    expect(mapped.thetanutsIv).toBeNull();
    expect(mapped.thetanutsSkew).toBeCloseTo(-0.05, 5);
  });

  it('keeps a zero Thetanuts IV as zero, not null', () => {
    const mapped = mapSnapshotRow({
      market: 'M',
      score: 1,
      block_number: 1,
      block_timestamp: 1,
      base_fee: 0,
      utilization: 0,
      mempool_pressure: 0,
      fee_momentum: 0,
      gas_volatility: 0,
      dex_activity: 0,
      thetanuts_iv: '0.00000',
      thetanuts_skew: null,
    });
    expect(mapped.thetanutsIv).toBe(0);
  });

  it('maps a candle row to numbers', () => {
    expect(
      mapCandleRow({ time: '1699999980', open: 100, high: '300', low: 100, close: 200, samples: '3' }),
    ).toEqual({ time: 1_699_999_980, open: 100, high: 300, low: 100, close: 200, samples: 3 });
  });
});

// describe.skipIf keeps this block harmless in environments without a
// database, rather than failing a run for an absent optional dependency.
describe.skipIf(!url)('PostgresDatabase (real server)', () => {
  const db: Database = createDatabase(url, silentLog)!;
  const raw = postgres(url!, {
    max: 1,
    prepare: false,
    ssl: /localhost|127\.0\.0\.1|\[::1\]/.test(url!) ? false : 'require',
  });

  beforeAll(async () => {
    const migration = readFileSync(
      fileURLToPath(new URL('../../supabase/migrations/0001_init.sql', import.meta.url)),
      'utf8',
    );
    await raw.unsafe(migration);
  });

  beforeEach(async () => {
    // forecast references egsi_snapshot; truncating together with
    // CASCADE handles ordering.
    await raw.unsafe('TRUNCATE forecast, egsi_snapshot, prepared_order RESTART IDENTITY CASCADE');
  });

  afterAll(async () => {
    await db.close();
    await raw.end({ timeout: 5 });
  });

  function snapshot(overrides: Partial<Parameters<Database['recordEgsiSnapshot']>[0]> = {}) {
    return {
      market: 'EGSI-1H',
      score: 612,
      blockNumber: 21458332,
      blockTimestamp: 1_700_000_000,
      baseFee: 0.72,
      utilization: 0.88,
      mempoolPressure: 0.61,
      feeMomentum: 0.44,
      gasVolatility: 0.29,
      dexActivity: 0.53,
      thetanutsIv: null,
      thetanutsSkew: null,
      ...overrides,
    };
  }

  it('stores a snapshot and reads it back with values intact', async () => {
    await db.recordEgsiSnapshot(snapshot());
    const history = await db.getEgsiHistory('EGSI-1H', 10);

    expect(history).toHaveLength(1);
    expect(history[0]!.score).toBe(612);
    expect(history[0]!.blockNumber).toBe(21458332);
    expect(history[0]!.baseFee).toBeCloseTo(0.72, 5);
  });

  it('returns an id that a forecast can be linked to', async () => {
    const id = await db.recordEgsiSnapshot(snapshot());
    expect(id).toBeGreaterThan(0);

    await db.recordForecast(
      { market: 'EGSI-1H', expectedEgsi: 687.4, confidence: 0.83, pTail500: 0.79, modelVersion: 'egsi-v1' },
      id,
    );

    const rows = await raw`SELECT egsi_snapshot_id, confidence FROM forecast`;
    const row = rows[0]!;
    expect(Number(row.egsi_snapshot_id)).toBe(id);
    expect(Number(row.confidence)).toBeCloseTo(0.83, 4);
  });

  it('is idempotent on the same block, rather than duplicating rows', async () => {
    const first = await db.recordEgsiSnapshot(snapshot());
    const second = await db.recordEgsiSnapshot(snapshot());

    const history = await db.getEgsiHistory('EGSI-1H', 10);
    expect(history).toHaveLength(1);
    // The same row id comes back, so a forecast written on the second
    // pass still links to the right snapshot.
    expect(second).toBe(first);
  });

  it('updates the score when the same block is re-recorded with a new value', async () => {
    await db.recordEgsiSnapshot(snapshot({ score: 500 }));
    await db.recordEgsiSnapshot(snapshot({ score: 640 }));

    const history = await db.getEgsiHistory('EGSI-1H', 10);
    expect(history).toHaveLength(1);
    expect(history[0]!.score).toBe(640);
  });

  it('preserves a null Thetanuts signal as null, not zero', async () => {
    await db.recordEgsiSnapshot(snapshot({ thetanutsIv: null }));
    const history = await db.getEgsiHistory('EGSI-1H', 10);
    expect(history[0]!.thetanutsIv).toBeNull();
  });

  it('stores a present Thetanuts signal distinctly from an absent one', async () => {
    await db.recordEgsiSnapshot(snapshot({ blockNumber: 1, thetanutsIv: 0, thetanutsSkew: -0.05 }));
    await db.recordEgsiSnapshot(snapshot({ blockNumber: 2, thetanutsIv: null }));

    const history = await db.getEgsiHistory('EGSI-1H', 10);
    expect(history[0]!.thetanutsIv).toBe(0);
    expect(history[0]!.thetanutsSkew).toBeCloseTo(-0.05, 5);
    expect(history[1]!.thetanutsIv).toBeNull();
  });

  it('returns history oldest first, so it can be fed to a model in order', async () => {
    await db.recordEgsiSnapshot(snapshot({ blockNumber: 30, score: 300 }));
    await db.recordEgsiSnapshot(snapshot({ blockNumber: 10, score: 100 }));
    await db.recordEgsiSnapshot(snapshot({ blockNumber: 20, score: 200 }));

    const history = await db.getEgsiHistory('EGSI-1H', 10);
    expect(history.map((h) => h.score)).toEqual([100, 200, 300]);
  });

  it('separates markets', async () => {
    await db.recordEgsiSnapshot(snapshot({ market: 'EGSI-1H', blockNumber: 1 }));
    await db.recordEgsiSnapshot(snapshot({ market: 'OTHER', blockNumber: 1 }));

    expect(await db.getEgsiHistory('EGSI-1H', 10)).toHaveLength(1);
    expect(await db.getEgsiHistory('OTHER', 10)).toHaveLength(1);
  });

  it('records both prepared and rejected orders', async () => {
    await db.recordPreparedOrder({
      trader: 'alice.testnet',
      marginAccount: 'gasx.testnet',
      isBid: true,
      price: 500,
      quantity: 10,
      outcome: 'prepared',
      rejectReason: null,
    });
    await db.recordPreparedOrder({
      trader: 'alice.testnet',
      marginAccount: 'gasx.testnet',
      isBid: false,
      price: 999,
      quantity: 9999,
      outcome: 'rejected',
      rejectReason: 'quantity exceeds MAX_ORDER_CONTRACTS (100)',
    });

    const list = await raw`SELECT outcome, reject_reason FROM prepared_order ORDER BY id`;
    expect(list[0]!.outcome).toBe('prepared');
    expect(list[1]!.outcome).toBe('rejected');
    expect(String(list[1]!.reject_reason)).toMatch(/MAX_ORDER_CONTRACTS/);
  });

  it('caps an absurd history limit instead of trusting it', async () => {
    await db.recordEgsiSnapshot(snapshot());
    // Should not throw on a huge or fractional limit.
    await expect(db.getEgsiHistory('EGSI-1H', 10_000_000)).resolves.toHaveLength(1);
    await expect(db.getEgsiHistory('EGSI-1H', 2.7)).resolves.toHaveLength(1);
  });

  it('aggregates readings into OHLC candles by block order', async () => {
    // Two 60s buckets: [1_699_999_980, +60) and the next one.
    await db.recordEgsiSnapshot(snapshot({ blockNumber: 1, blockTimestamp: 1_699_999_990, score: 100 }));
    await db.recordEgsiSnapshot(snapshot({ blockNumber: 2, blockTimestamp: 1_699_999_995, score: 300 }));
    await db.recordEgsiSnapshot(snapshot({ blockNumber: 3, blockTimestamp: 1_700_000_040, score: 200 }));
    await db.recordEgsiSnapshot(snapshot({ blockNumber: 4, blockTimestamp: 1_700_000_050, score: 250 }));

    const candles = await db.getEgsiCandles('EGSI-1H', 60, 10);
    expect(candles).toEqual([
      { time: 1_699_999_980, open: 100, high: 300, low: 100, close: 300, samples: 2 },
      { time: 1_700_000_040, open: 200, high: 250, low: 200, close: 250, samples: 2 },
    ]);
    // Oldest first.
    expect(candles[0]!.time).toBeLessThan(candles[1]!.time);
  });
});

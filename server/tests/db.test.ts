/**
 * Database tests.
 *
 * The pure helpers (row mapping, limit clamping, candle bucketing math)
 * are tested unconditionally. The integration block runs against a REAL
 * Postgres server, not a mock — a mocked database would happily accept
 * SQL that a real server rejects, which defeats the point of testing the
 * schema at all. It is skipped automatically when SILICA_TEST_DATABASE_URL
 * is unset, so the default test run needs no database.
 *
 * To run it (the migration is applied by the test itself, idempotently;
 * tables are truncated before each case, so use a scratch database):
 *   SILICA_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/silica_test npm test
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { readEnv } from '../src/env.js';
import {
  bucketStart,
  clampInterval,
  clampLimit,
  createDatabase,
  mapCandleRow,
  mapComputeIndexRow,
  PostgresDatabase,
  type Database,
} from '../src/db.js';

const url = readEnv('TEST_DATABASE_URL');
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
    await raw.unsafe('TRUNCATE prepared_order RESTART IDENTITY');
  });

  afterAll(async () => {
    await db.close();
    await raw.end({ timeout: 5 });
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
});

describe('compute index snapshots (pure)', () => {
  it('maps numeric strings and Date/ISO timestamps', () => {
    expect(mapComputeIndexRow({ taken_at: new Date('2026-11-10T12:00:00Z'), level: '1012.34' })).toEqual({
      t: '2026-11-10T12:00:00.000Z',
      level: 1012.34,
    });
    expect(mapComputeIndexRow({ taken_at: '2026-11-10T12:00:00Z', level: 1000 }).t).toBe('2026-11-10T12:00:00.000Z');
  });
});

describe('getComputeIndexCandles (stubbed sql)', () => {
  function makeDb(rows: unknown[] | Error) {
    const seen: unknown[][] = [];
    const sql = (async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      seen.push(values);
      if (rows instanceof Error) throw rows;
      return rows;
    }) as unknown as ConstructorParameters<typeof PostgresDatabase>[0];
    const errors: string[] = [];
    return { db: new PostgresDatabase(sql, { error: (m) => errors.push(m) }), seen, errors };
  }

  it('maps rows to numbers and returns them oldest first', async () => {
    const { db } = makeDb([
      { time: '1700000040', open: '1010.5', high: '1020', low: '1005', close: '1015', samples: '4' },
      { time: '1699999980', open: '1000', high: '1012', low: '999.5', close: '1010.5', samples: '2' },
    ]);
    const candles = await db.getComputeIndexCandles(60, 10);
    expect(candles.map((c) => c.time)).toEqual([1_699_999_980, 1_700_000_040]);
    expect(candles[0]).toEqual({ time: 1_699_999_980, open: 1000, high: 1012, low: 999.5, close: 1010.5, samples: 2 });
  });

  it('clamps the interval and limit it passes to SQL', async () => {
    const { db, seen } = makeDb([]);
    await db.getComputeIndexCandles(0.2, 10_000_000);
    expect(seen[0]).toEqual([1, 1, 5_000]);
  });

  it('returns [] and logs when the query fails', async () => {
    const { db, errors } = makeDb(new Error('boom'));
    await expect(db.getComputeIndexCandles(300, 200)).resolves.toEqual([]);
    expect(errors[0]).toMatch(/boom/);
  });
});

describe.skipIf(!url)('compute index snapshots (real server)', () => {
  const db: Database = createDatabase(url, silentLog)!;
  const raw = postgres(url!, {
    max: 1,
    prepare: false,
    ssl: /localhost|127\.0\.0\.1|\[::1\]/.test(url!) ? false : 'require',
  });

  beforeAll(async () => {
    const migration = readFileSync(
      fileURLToPath(new URL('../../supabase/migrations/0003_compute_index.sql', import.meta.url)),
      'utf8',
    );
    await raw.unsafe(migration);
    await raw.unsafe(migration); // idempotent
  });

  beforeEach(async () => {
    await raw.unsafe('TRUNCATE compute_index_snapshots RESTART IDENTITY');
  });

  afterAll(async () => {
    await db.close();
    await raw.end({ timeout: 5 });
  });

  it('stores a snapshot and reads the level back', async () => {
    const ok = await db.recordComputeIndexSnapshot({
      level: 1012.34,
      components: [{ id: 'gpu_rental', relative: 1.01 }],
      methodologyVersion: '2.0',
    });
    expect(ok).toBe(true);
    const history = await db.getComputeIndexHistory(1);
    expect(history).toHaveLength(1);
    expect(history[0]!.level).toBeCloseTo(1012.34, 5);
  });

  it('aggregates snapshots into OHLC candles by time order', async () => {
    const insert = (iso: string, level: number) =>
      raw.unsafe(
        `INSERT INTO compute_index_snapshots (taken_at, level, components, methodology_version)
         VALUES ('${iso}', ${level}, '[]'::jsonb, '2.0')`,
      );
    // 2023-11-14T22:13:00Z .. two 60 s buckets.
    await insert('2023-11-14T22:13:10Z', 1000);
    await insert('2023-11-14T22:13:15Z', 1030);
    await insert('2023-11-14T22:14:05Z', 1020);
    await insert('2023-11-14T22:14:50Z', 1025);

    const candles = await db.getComputeIndexCandles(60, 10);
    expect(candles).toEqual([
      { time: 1_700_000_000 - 20, open: 1000, high: 1030, low: 1000, close: 1030, samples: 2 },
      { time: 1_700_000_000 + 40, open: 1020, high: 1025, low: 1020, close: 1025, samples: 2 },
    ]);
  });

  it('excludes snapshots older than the window', async () => {
    await raw.unsafe(
      `INSERT INTO compute_index_snapshots (taken_at, level, components, methodology_version)
       VALUES (now() - interval '10 days', 990, '[]'::jsonb, '2.0')`,
    );
    expect(await db.getComputeIndexHistory(7)).toHaveLength(0);
    expect(await db.getComputeIndexHistory(30)).toHaveLength(1);
  });
});


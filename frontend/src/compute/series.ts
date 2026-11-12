/**
 * Pure helpers that turn the history endpoints into chart series. No React,
 * no chart library. Nothing here invents a value: every output point is an
 * input point, at its own time.
 */

export type Range = '1D' | '1W' | '1M' | '3M';

export const RANGES: readonly Range[] = ['1D', '1W', '1M', '3M'];

export const RANGE_SECONDS: Readonly<Record<Range, number>> = {
  '1D': 86_400,
  '1W': 7 * 86_400,
  '1M': 30 * 86_400,
  '3M': 90 * 86_400,
};

/** A point on a line chart. `time` is whole UTC seconds, as the chart library wants. */
export interface LinePoint {
  time: number;
  value: number;
}

export interface CandlePoint {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface IndexSeries {
  /** The daily back-cast: a partial reconstruction, before any real reading. */
  reconstructed: LinePoint[];
  /** Real readings: recorded levels, on-chain settlements, the live level. */
  measured: LinePoint[];
  /** Time of the first on-chain settlement, or null if there is none. */
  onchainFrom: number | null;
}

function isNum(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** ISO string, epoch seconds or epoch ms -> whole epoch seconds; NaN if unusable. */
export function toSeconds(t: string | number | null | undefined): number {
  if (typeof t === 'number') {
    if (!Number.isFinite(t)) return Number.NaN;
    return Math.floor(t > 10_000_000_000 ? t / 1000 : t);
  }
  if (typeof t !== 'string') return Number.NaN;
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : Number.NaN;
}

type Raw = { t: string | number; level: number } | null | undefined;

function clean(list: ReadonlyArray<Raw> | null | undefined, rank: number) {
  const out: Array<LinePoint & { rank: number }> = [];
  for (const p of list ?? []) {
    if (!p) continue;
    const time = toSeconds(p.t);
    if (Number.isFinite(time) && isNum(p.level)) out.push({ time, value: p.level, rank });
  }
  return out;
}

/** Sorted, one point per second; at a shared second the higher rank wins. */
function dedupe(points: Array<LinePoint & { rank: number }>): LinePoint[] {
  const sorted = [...points].sort((a, b) => a.time - b.time || a.rank - b.rank);
  const out: LinePoint[] = [];
  for (const p of sorted) {
    const last = out[out.length - 1];
    if (last && last.time === p.time) last.value = p.value;
    else out.push({ time: p.time, value: p.value });
  }
  return out;
}

/**
 * Joins the back-cast (daily), recorded levels, on-chain settlements (hourly)
 * and the live level into two series. The reconstruction stops where real
 * readings begin, so the two never overlap. At a shared second the more
 * authoritative reading wins: live > settlement > recorded.
 */
export function mergeIndexSeries(input: {
  backcast?: ReadonlyArray<Raw> | null;
  recorded?: ReadonlyArray<Raw> | null;
  settlements?: ReadonlyArray<Raw> | null;
  live?: Raw;
}): IndexSeries {
  const settlements = clean(input.settlements, 2);
  const measured = dedupe([
    ...clean(input.recorded, 1),
    ...settlements,
    ...clean(input.live ? [input.live] : [], 3),
  ]);
  const firstReal = measured[0]?.time ?? Number.POSITIVE_INFINITY;
  const reconstructed = dedupe(clean(input.backcast, 0)).filter((p) => p.time < firstReal);
  const onchainFrom = settlements.length
    ? Math.min(...settlements.map((s) => s.time))
    : null;
  return { reconstructed, measured, onchainFrom };
}

/** The newest time across any number of series; null when all are empty. */
export function latestTime(...series: ReadonlyArray<ReadonlyArray<{ time: number }>>): number | null {
  let best: number | null = null;
  for (const list of series) {
    const last = list[list.length - 1];
    if (last && (best === null || last.time > best)) best = last.time;
  }
  return best;
}

/**
 * Points inside a range that ends at `anchor` (the newest data point, so a
 * stale feed still shows its last day rather than nothing).
 */
export function filterRange<T extends { time: number }>(
  points: readonly T[],
  range: Range,
  anchor: number | null,
): T[] {
  if (anchor === null) return [];
  const from = anchor - RANGE_SECONDS[range];
  return points.filter((p) => p.time >= from && p.time <= anchor);
}

/** Whether a range holds at least two points to draw a line between. */
export function rangeHasData(series: IndexSeries, range: Range): boolean {
  const anchor = latestTime(series.reconstructed, series.measured);
  return (
    filterRange(series.reconstructed, range, anchor).length +
      filterRange(series.measured, range, anchor).length >=
    2
  );
}

/** The preferred range if it can be drawn, else the widest one that can. */
export function pickRange(series: IndexSeries, preferred: Range): Range {
  if (rangeHasData(series, preferred)) return preferred;
  for (const r of [...RANGES].reverse()) if (rangeHasData(series, r)) return r;
  return preferred;
}

/**
 * Percent move over the last `seconds`, from the newest point at or before
 * that time to `current`. Null when the history does not reach back far enough.
 */
export function changeOver(
  points: readonly LinePoint[],
  seconds: number,
  current: number | null,
  now: number,
): number | null {
  if (!isNum(current)) return null;
  let then: LinePoint | undefined;
  for (const p of points) {
    if (p.time <= now - seconds) then = p;
    else break;
  }
  if (!then || then.value === 0) return null;
  return (current / then.value - 1) * 100;
}

/** Real OHLC bars, sorted and de-duplicated; malformed bars dropped. */
export function cleanCandles(
  candles: ReadonlyArray<{ time: number; open: number; high: number; low: number; close: number }> | null | undefined,
): CandlePoint[] {
  const byTime = new Map<number, CandlePoint>();
  for (const c of candles ?? []) {
    const time = toSeconds(c.time);
    if (!Number.isFinite(time)) continue;
    if (![c.open, c.high, c.low, c.close].every(isNum)) continue;
    byTime.set(time, { time, open: c.open, high: c.high, low: c.low, close: c.close });
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

/**
 * Whether bars are worth drawing as candles. Bars built from one reading each
 * are flat dashes; those read better as a line of closes.
 */
export function candlesHaveBodies(candles: readonly CandlePoint[]): boolean {
  if (candles.length < 3) return false;
  const shaped = candles.filter((c) => c.high !== c.low || c.open !== c.close).length;
  return shaped / candles.length >= 0.3;
}

/**
 * Folds the live level into the bars: inside the newest bar it moves the
 * close (and the high or low); after it, it starts a new bar of its own.
 */
export function applyLiveCandle(
  candles: readonly CandlePoint[],
  live: { time: number; value: number } | null,
  intervalSeconds: number,
): CandlePoint[] {
  if (!live || !isNum(live.value) || !Number.isFinite(live.time)) return [...candles];
  const last = candles[candles.length - 1];
  if (!last) return [{ time: live.time, open: live.value, high: live.value, low: live.value, close: live.value }];
  if (live.time < last.time) return [...candles];
  if (live.time < last.time + intervalSeconds) {
    return [
      ...candles.slice(0, -1),
      {
        ...last,
        close: live.value,
        high: Math.max(last.high, live.value),
        low: Math.min(last.low, live.value),
      },
    ];
  }
  const bucket = last.time + Math.floor((live.time - last.time) / intervalSeconds) * intervalSeconds;
  return [...candles, { time: bucket, open: live.value, high: live.value, low: live.value, close: live.value }];
}

/** The live level as the newest point of a line: replaces a point at the same second, never one in the past. */
export function applyLivePoint(
  points: readonly LinePoint[],
  live: { time: number; value: number } | null,
): LinePoint[] {
  if (!live || !isNum(live.value) || !Number.isFinite(live.time)) return [...points];
  const last = points[points.length - 1];
  if (last && live.time < last.time) return [...points];
  if (last && live.time === last.time) return [...points.slice(0, -1), { time: live.time, value: live.value }];
  return [...points, { time: live.time, value: live.value }];
}

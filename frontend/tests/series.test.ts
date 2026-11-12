import { describe, expect, it } from 'vitest';
import {
  applyLiveCandle,
  applyLivePoint,
  candlesHaveBodies,
  changeOver,
  cleanCandles,
  filterRange,
  latestTime,
  mergeIndexSeries,
  pickRange,
  rangeHasData,
  toSeconds,
} from '../src/compute/series';

const DAY = 86_400;
const T0 = Date.UTC(2026, 7, 1) / 1000;
const iso = (s: number) => new Date(s * 1000).toISOString();

describe('toSeconds', () => {
  it('accepts ISO, seconds and milliseconds', () => {
    expect(toSeconds('2026-08-01T00:00:00.000Z')).toBe(T0);
    expect(toSeconds(T0)).toBe(T0);
    expect(toSeconds(T0 * 1000 + 999)).toBe(T0);
  });
  it('rejects junk', () => {
    expect(toSeconds('not a date')).toBeNaN();
    expect(toSeconds(Number.NaN)).toBeNaN();
    expect(toSeconds(null)).toBeNaN();
  });
});

describe('mergeIndexSeries', () => {
  const backcast = [0, 1, 2, 3, 4].map((d) => ({ t: iso(T0 + d * DAY), level: 1000 + d }));

  it('keeps the back-cast alone when there is nothing real', () => {
    const s = mergeIndexSeries({ backcast });
    expect(s.reconstructed.map((p) => p.value)).toEqual([1000, 1001, 1002, 1003, 1004]);
    expect(s.measured).toEqual([]);
    expect(s.onchainFrom).toBeNull();
  });

  it('ends the reconstruction where real readings begin, without overlap', () => {
    const settlements = [
      { t: iso(T0 + 3 * DAY), level: 990 },
      { t: iso(T0 + 3 * DAY + 3600), level: 991 },
    ];
    const s = mergeIndexSeries({ backcast, settlements });
    expect(s.reconstructed.map((p) => p.time)).toEqual([T0, T0 + DAY, T0 + 2 * DAY]);
    expect(s.measured.map((p) => p.value)).toEqual([990, 991]);
    expect(s.onchainFrom).toBe(T0 + 3 * DAY);
  });

  it('sorts input, drops unusable points and lets the live level win a shared second', () => {
    const s = mergeIndexSeries({
      settlements: [
        { t: iso(T0 + 7200), level: 1002 },
        { t: iso(T0 + 3600), level: 1001 },
        { t: 'garbage', level: 5 },
        { t: iso(T0), level: Number.NaN },
      ],
      recorded: [{ t: iso(T0 + 3600), level: 999 }],
      live: { t: (T0 + 7200) * 1000, level: 1003 },
    });
    expect(s.measured).toEqual([
      { time: T0 + 3600, value: 1001 },
      { time: T0 + 7200, value: 1003 },
    ]);
  });

  it('copes with every field missing', () => {
    expect(mergeIndexSeries({})).toEqual({ reconstructed: [], measured: [], onchainFrom: null });
    expect(mergeIndexSeries({ backcast: null, settlements: undefined, live: null }).measured).toEqual([]);
  });
});

describe('ranges', () => {
  const points = Array.from({ length: 91 }, (_, d) => ({ time: T0 + d * DAY, value: 1000 + d }));
  const anchor = latestTime(points);

  it('filters to the window ending at the newest point', () => {
    expect(filterRange(points, '1W', anchor)).toHaveLength(8);
    expect(filterRange(points, '1M', anchor)).toHaveLength(31);
    expect(filterRange(points, '3M', anchor)).toHaveLength(91);
    expect(filterRange(points, '1D', anchor)).toHaveLength(2);
    expect(filterRange(points, '1D', null)).toEqual([]);
  });

  it('knows which ranges can be drawn and falls back to the widest one', () => {
    const daily = { reconstructed: points.slice(0, 10), measured: [], onchainFrom: null };
    expect(rangeHasData(daily, '1D')).toBe(true);
    const sparse = {
      reconstructed: [{ time: T0, value: 1 }, { time: T0 + 20 * DAY, value: 2 }],
      measured: [],
      onchainFrom: null,
    };
    expect(rangeHasData(sparse, '1W')).toBe(false);
    expect(pickRange(sparse, '1W')).toBe('3M');
    expect(pickRange({ reconstructed: [], measured: [], onchainFrom: null }, '1M')).toBe('1M');
  });

  it('measures change over a span, or reports null when history is too short', () => {
    expect(changeOver(points, DAY, 1100, anchor!)).toBeCloseTo((1100 / 1089 - 1) * 100);
    expect(changeOver(points.slice(-1), DAY, 1100, anchor!)).toBeNull();
    expect(changeOver(points, DAY, null, anchor!)).toBeNull();
  });
});

describe('candles', () => {
  const H = 3600;
  const bars = [
    { time: T0 + H, open: 2, high: 3, low: 1, close: 2 },
    { time: T0, open: 1, high: 2, low: 1, close: 2 },
    { time: T0, open: 9, high: 9, low: 9, close: 9 },
    { time: T0 + 2 * H, open: Number.NaN, high: 1, low: 1, close: 1 },
  ];

  it('cleans, sorts and de-duplicates bars', () => {
    const clean = cleanCandles(bars);
    expect(clean.map((c) => c.time)).toEqual([T0, T0 + H]);
    expect(clean[0]!.close).toBe(9);
    expect(cleanCandles(null)).toEqual([]);
  });

  it('draws candles only when bars have shape', () => {
    const flat = [0, 1, 2, 3].map((i) => ({ time: T0 + i * H, open: 5, high: 5, low: 5, close: 5 }));
    expect(candlesHaveBodies(flat)).toBe(false);
    expect(candlesHaveBodies(flat.map((c, i) => (i < 2 ? { ...c, high: 6 } : c)))).toBe(true);
    expect(candlesHaveBodies(flat.slice(0, 2))).toBe(false);
  });

  it('moves the newest bar with the live level, or opens a new one', () => {
    const clean = cleanCandles(bars);
    const inside = applyLiveCandle(clean, { time: T0 + H + 60, value: 4 }, H);
    expect(inside).toHaveLength(2);
    expect(inside[1]).toEqual({ time: T0 + H, open: 2, high: 4, low: 1, close: 4 });
    const after = applyLiveCandle(clean, { time: T0 + 3 * H + 5, value: 0.5 }, H);
    expect(after[2]).toEqual({ time: T0 + 3 * H, open: 0.5, high: 0.5, low: 0.5, close: 0.5 });
    expect(applyLiveCandle(clean, { time: T0 - 10, value: 7 }, H)).toEqual(clean);
    expect(applyLiveCandle(clean, null, H)).toEqual(clean);
  });

  it('puts the live level at the end of a line, never in the past', () => {
    const line = [{ time: T0, value: 1 }, { time: T0 + H, value: 2 }];
    expect(applyLivePoint(line, { time: T0 + 2 * H, value: 3 })).toHaveLength(3);
    expect(applyLivePoint(line, { time: T0 + H, value: 9 })[1]).toEqual({ time: T0 + H, value: 9 });
    expect(applyLivePoint(line, { time: T0 - 1, value: 9 })).toEqual(line);
  });
});

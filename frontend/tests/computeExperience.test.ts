import { describe, expect, it } from 'vitest';
import {
  buildChart,
  formatAsOf,
  formatChange,
  formatCoverage,
  formatLevel,
  formatPrice,
  formatSpread,
  formatUnit,
  formatWeight,
  gpuVenueColumns,
  isCheapestVenue,
  nearestIndex,
  formatPoints,
  venueName,
  weightSegments,
} from '../src/compute/helpers';
import { IMAGE_CREDITS, PEOPLE, PILLARS, USED_IMAGE_SLUGS } from '../src/compute/content';

describe('formatPrice', () => {
  it('uses per-unit precision', () => {
    expect(formatPrice('$/GPU-hour', 2.189)).toBe('$2.19');
    expect(formatPrice('$/vCPU-hour', 0.03121)).toBe('$0.0312');
    expect(formatPrice('$/1M tokens (blended)', 0.5)).toBe('$0.50');
    expect(formatPrice('$/TH/day', 0.0451234)).toBe('$0.0451');
    expect(formatPrice('$/1M gas (7-day median)', 0.61234)).toBe('$0.6123');
  });
  it('never rounds a real tiny price to zero', () => {
    expect(formatPrice('$/GPU-hour', 0.004)).toBe('$0.004000');
  });
  it('handles missing values and non-dollar units', () => {
    expect(formatPrice('$/GPU-hour', null)).toBe('n/a');
    expect(formatPrice('$/GPU-hour', undefined)).toBe('n/a');
    expect(formatPrice('$/GPU-hour', Number.NaN)).toBe('n/a');
    expect(formatPrice('points', 412.6)).toBe('412.60');
  });
});

describe('formatUnit', () => {
  it('reads units as words', () => {
    expect(formatUnit('$/GPU-hour')).toBe('per GPU-hour');
    expect(formatUnit('$/TH/day')).toBe('per TH per day');
    expect(formatUnit('$/1M tokens (blended)')).toBe('per 1M tokens, blended');
    expect(formatUnit('$/1M gas (7-day median)')).toBe('per 1M gas, 7-day median');
    expect(formatUnit('points')).toBe('points');
  });
});

describe('formatSpread', () => {
  it('formats to one decimal', () => {
    expect(formatSpread(23.45)).toBe('23.4%');
    expect(formatSpread(0)).toBe('0.0%');
  });
  it('returns n/a when there is no spread', () => {
    expect(formatSpread(null)).toBe('n/a');
    expect(formatSpread(undefined)).toBe('n/a');
  });
});

describe('level and change', () => {
  it('formats levels', () => {
    expect(formatLevel(1023.456)).toBe('1,023.46');
    expect(formatLevel(1000, 0)).toBe('1,000');
    expect(formatLevel(null)).toBe('n/a');
  });
  it('formats market prices as whole points when they are whole', () => {
    expect(formatPoints(1012)).toBe('1,012');
    expect(formatPoints(1012.5)).toBe('1,012.50');
    expect(formatPoints(null)).toBe('n/a');
  });
  it('signs the change against base', () => {
    expect(formatChange(1100, 1000)).toEqual({ text: '+10.00%', direction: 'up' });
    expect(formatChange(900, 1000)).toEqual({ text: '-10.00%', direction: 'down' });
    expect(formatChange(1000, 1000)).toEqual({ text: '0.00%', direction: 'flat' });
    expect(formatChange(null, 1000)).toEqual({ text: 'n/a', direction: null });
    expect(formatChange(1000, 0)).toEqual({ text: 'n/a', direction: null });
  });
});

describe('small formatters', () => {
  it('formats weights', () => {
    expect(formatWeight(0.35)).toBe('35%');
    expect(formatWeight(0.2333)).toBe('23.3%');
    expect(formatWeight(null)).toBe('n/a');
  });
  it('formats coverage', () => {
    expect(formatCoverage({ ok: 9, total: 9 })).toBe('9/9 quotes');
    expect(formatCoverage(undefined)).toBe('n/a');
  });
  it('formats as-of in UTC', () => {
    expect(formatAsOf('2026-11-11T14:32:05.000Z')).toBe('Nov 11, 14:32 UTC');
    expect(formatAsOf('nonsense')).toBe('unknown');
    expect(formatAsOf(null)).toBe('unknown');
  });
});

describe('GPU board helpers', () => {
  const gpus = [
    { venues: [{ venue: 'vast', price: 2 }, { venue: 'runpod', price: null }], cheapest: { venue: 'vast', price: 2 } },
    { venues: [{ venue: 'akash', price: 1 }], cheapest: null },
    { venues: null },
  ];
  it('collects venue columns in first-seen order', () => {
    expect(gpuVenueColumns(gpus)).toEqual(['vast', 'runpod', 'akash']);
  });
  it('identifies the cheapest venue and tolerates none', () => {
    expect(isCheapestVenue(gpus[0]!, 'vast')).toBe(true);
    expect(isCheapestVenue(gpus[0]!, 'runpod')).toBe(false);
    expect(isCheapestVenue(gpus[1]!, 'akash')).toBe(false);
  });
  it('names venues, passing unknown ones through', () => {
    expect(venueName('vast')).toBe('Vast.ai');
    expect(venueName('newco')).toBe('newco');
  });
});

describe('weightSegments', () => {
  it('sums to 100 on effective weights and zeroes down pillars', () => {
    const segments = weightSegments([
      { id: 'a', label: 'A', effectiveWeight: 0.75, nominalWeight: 0.6, status: 'ok' },
      { id: 'b', label: 'B', effectiveWeight: 0.25, nominalWeight: 0.2, status: 'ok' },
      { id: 'c', label: 'C', effectiveWeight: 0, nominalWeight: 0.2, status: 'down' },
    ]);
    expect(segments.map((s) => s.pct)).toEqual([75, 25, 0]);
    expect(segments[2]!.down).toBe(true);
  });
  it('falls back to nominal weights when nothing is effective', () => {
    const segments = weightSegments([
      { id: 'a', label: 'A', effectiveWeight: 0, nominalWeight: 0.5 },
      { id: 'b', label: 'B', effectiveWeight: 0, nominalWeight: 0.5 },
    ]);
    expect(segments.map((s) => s.pct)).toEqual([50, 50]);
  });
  it('survives no weights at all', () => {
    expect(weightSegments([{ id: 'a', label: 'A' }])[0]!.pct).toBe(0);
  });
});

describe('buildChart', () => {
  const size = { width: 100, height: 50, padTop: 0, padBottom: 0 };
  it('builds line and area paths with time-proportional x', () => {
    const g = buildChart(
      [
        { t: '2026-01-01T00:00:00Z', value: 10 },
        { t: '2026-01-02T00:00:00Z', value: 20 },
        { t: '2026-01-05T00:00:00Z', value: 15 },
      ],
      size,
    )!;
    expect(g.line).toBe('M0 50 L25 0 L100 25');
    expect(g.area).toBe('M0 50 L25 0 L100 25 L100 50 L0 50 Z');
    expect(g.min).toBe(10);
    expect(g.max).toBe(20);
  });
  it('sorts by time and drops unusable points', () => {
    const g = buildChart(
      [
        { t: '2026-01-02T00:00:00Z', value: 2 },
        { t: 'bad', value: 5 },
        { t: '2026-01-03T00:00:00Z', value: Number.NaN },
        { t: '2026-01-01T00:00:00Z', value: 1 },
      ],
      size,
    )!;
    expect(g.coords.map((c) => c.value)).toEqual([1, 2]);
  });
  it('centres a flat series', () => {
    const g = buildChart(
      [
        { t: '2026-01-01T00:00:00Z', value: 5 },
        { t: '2026-01-02T00:00:00Z', value: 5 },
      ],
      size,
    )!;
    expect(g.coords.map((c) => c.y)).toEqual([25, 25]);
  });
  it('refuses to draw fewer than two real points', () => {
    expect(buildChart([], size)).toBeNull();
    expect(buildChart([{ t: '2026-01-01T00:00:00Z', value: 5 }], size)).toBeNull();
    expect(
      buildChart(
        [
          { t: '2026-01-01T00:00:00Z', value: 5 },
          { t: '2026-01-01T00:00:00Z', value: 6 },
        ],
        size,
      ),
    ).toBeNull();
  });
});

describe('nearestIndex', () => {
  it('finds the closest coordinate', () => {
    expect(nearestIndex([{ x: 0 }, { x: 10 }, { x: 30 }], 12)).toBe(1);
    expect(nearestIndex([], 12)).toBe(-1);
  });
});

describe('content', () => {
  it('credits every image the page uses, with author, licence and source', () => {
    expect(new Set(USED_IMAGE_SLUGS).size).toBe(USED_IMAGE_SLUGS.length);
    expect(IMAGE_CREDITS.map((c) => c.slug).sort()).toEqual([...USED_IMAGE_SLUGS].sort());
    for (const credit of IMAGE_CREDITS) {
      expect(credit.author).toBeTruthy();
      expect(credit.license).toBeTruthy();
      expect(credit.sourceUrl).toMatch(/^https:/);
    }
  });
  it('has the six pillars and nine people', () => {
    expect(PILLARS.map((p) => p.id)).toEqual([
      'gpu_rental',
      'cloud_gpu_spot',
      'cloud_cpu_spot',
      'ai_inference',
      'btc_hashprice',
      'blockspace',
    ]);
    expect(PEOPLE).toHaveLength(9);
  });
});

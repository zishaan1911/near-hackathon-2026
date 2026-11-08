import { describe, expect, it } from 'vitest';
import { formatComponentValue, relativeToPercent, relativeBarOffset } from '../src/components/ComputeIndexPage';

describe('formatComponentValue', () => {
  it('formats by unit', () => {
    expect(formatComponentValue('$/GPU-hr', 1.2345)).toBe('$1.23 /GPU-hr');
    expect(formatComponentValue('$/1M tokens', 0.5)).toBe('$0.50 /1M tokens');
    expect(formatComponentValue('$/TH/day', 0.0451234)).toBe('$0.0451 /TH/day');
    expect(formatComponentValue('EGSI', 412.6)).toBe('413 EGSI');
  });
  it('handles null and non-finite values', () => {
    expect(formatComponentValue('$/GPU-hr', null)).toBe('n/a');
    expect(formatComponentValue('EGSI', Number.NaN)).toBe('n/a');
  });
  it('falls back to two decimals for unknown units', () => {
    expect(formatComponentValue('widgets', 3)).toBe('3.00 widgets');
  });
});

describe('relativeToPercent', () => {
  it('converts a relative to percent vs base', () => {
    expect(relativeToPercent(1.1)).toBeCloseTo(10);
    expect(relativeToPercent(0.8)).toBeCloseTo(-20);
    expect(relativeToPercent(1)).toBe(0);
  });
  it('returns null for missing values', () => {
    expect(relativeToPercent(null)).toBeNull();
    expect(relativeToPercent(Number.NaN)).toBeNull();
  });
});

describe('relativeBarOffset', () => {
  it('clamps to +/-50 percent of the track', () => {
    expect(relativeBarOffset(1)).toBe(0);
    expect(relativeBarOffset(3)).toBe(50);
    expect(relativeBarOffset(0)).toBe(-50);
    expect(relativeBarOffset(null)).toBe(0);
  });
});

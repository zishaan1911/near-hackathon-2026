import { describe, expect, it } from 'vitest';
import { formatTokenAmount, parseTokenAmount } from '../src/lib/format';

describe('formatTokenAmount', () => {
  it('shows base units as a two-decimal token amount', () => {
    expect(formatTokenAmount('1500000')).toBe('1.50');
    expect(formatTokenAmount('0')).toBe('0.00');
    expect(formatTokenAmount('12000000000')).toBe('12000.00');
  });

  it('rounds half up to the nearest cent', () => {
    expect(formatTokenAmount('1234567')).toBe('1.23');
    expect(formatTokenAmount('1235000')).toBe('1.24');
    expect(formatTokenAmount('5000')).toBe('0.01');
  });

  it('respects a custom token precision', () => {
    expect(formatTokenAmount('150', 2)).toBe('1.50');
  });

  it('returns a dash for input that is not a base-unit integer', () => {
    expect(formatTokenAmount('-1')).toBe('—');
    expect(formatTokenAmount('1.5')).toBe('—');
    expect(formatTokenAmount('')).toBe('—');
  });
});

describe('parseTokenAmount', () => {
  it('converts decimal text into base units', () => {
    expect(parseTokenAmount('1.5')).toBe('1500000');
    expect(parseTokenAmount('2')).toBe('2000000');
    expect(parseTokenAmount('0.000001')).toBe('1');
    expect(parseTokenAmount(' 3.25 ')).toBe('3250000');
  });

  it('keeps zero as zero', () => {
    expect(parseTokenAmount('0')).toBe('0');
    expect(parseTokenAmount('0.0')).toBe('0');
  });

  it('rejects negatives', () => {
    expect(parseTokenAmount('-1')).toBeNull();
  });

  it('rejects NaN and other non-numeric text', () => {
    expect(parseTokenAmount('NaN')).toBeNull();
    expect(parseTokenAmount('abc')).toBeNull();
    expect(parseTokenAmount('')).toBeNull();
    expect(parseTokenAmount('1e3')).toBeNull();
    expect(parseTokenAmount('1.')).toBeNull();
  });

  it('rejects more fractional digits than the token supports', () => {
    expect(parseTokenAmount('1.1234567')).toBeNull();
    expect(parseTokenAmount('1.123', 2)).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { toOraclePrice } from '../src/publisher.js';

describe('toOraclePrice', () => {
  it('rounds to the nearest integer', () => {
    expect(toOraclePrice(412.4, 1000)).toBe(412);
    expect(toOraclePrice(412.5, 1000)).toBe(413);
    expect(toOraclePrice(0.2, 1000)).toBe(0);
  });

  it('clamps to max_price', () => {
    expect(toOraclePrice(1500, 1000)).toBe(1000);
    expect(toOraclePrice(1000, 1000)).toBe(1000);
  });

  it('accepts zero', () => {
    expect(toOraclePrice(0, 1000)).toBe(0);
  });

  it('returns null for NaN, infinite and negative scores', () => {
    expect(toOraclePrice(Number.NaN, 1000)).toBeNull();
    expect(toOraclePrice(Number.POSITIVE_INFINITY, 1000)).toBeNull();
    expect(toOraclePrice(-1, 1000)).toBeNull();
  });
});

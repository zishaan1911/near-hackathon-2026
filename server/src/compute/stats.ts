export function median(xs: number[]): number {
  if (xs.length === 0) throw new Error('median of empty array');
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  const lo = s[mid - 1] as number;
  const hi = s[mid] as number;
  return s.length % 2 ? hi : (lo + hi) / 2;
}

/** Drops the lowest and highest `frac` of values (floor(n*frac) each side). */
export function trim(xs: number[], frac: number): number[] {
  const s = [...xs].sort((a, b) => a - b);
  const k = Math.floor(s.length * frac);
  return s.slice(k, s.length - k);
}

/** Weighted geometric mean; weights are renormalised. Values must be > 0. */
export function weightedGeoMean(items: ReadonlyArray<{ value: number; weight: number }>): number {
  const wsum = items.reduce((a, i) => a + i.weight, 0);
  if (items.length === 0 || wsum <= 0) throw new Error('empty geometric mean');
  return Math.exp(items.reduce((a, i) => a + (i.weight / wsum) * Math.log(i.value), 0));
}

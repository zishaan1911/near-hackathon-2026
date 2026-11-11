/** Pure formatting and geometry helpers for the /compute page. No React here. */

export type Direction = 'up' | 'down' | 'flat';

const NA = 'n/a';

function isNum(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Index level with thousands separators, or "n/a". */
export function formatLevel(level: number | null | undefined, digits = 2): string {
  if (!isNum(level)) return NA;
  return level.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** Splits a level into the big whole part and the small decimals for the hero. */
export function splitLevel(level: number): { whole: string; fraction: string } {
  const [whole = '0', fraction = '00'] = level.toFixed(2).split('.');
  return { whole, fraction };
}

/** Change of a level against its base, as text plus a direction for styling. */
export function formatChange(
  level: number | null | undefined,
  base: number | null | undefined,
): { text: string; direction: Direction | null } {
  if (!isNum(level) || !isNum(base) || base === 0) return { text: NA, direction: null };
  return formatPercentChange(base, level);
}

/** Signed percent move from one value to another. */
export function formatPercentChange(
  from: number,
  to: number,
): { text: string; direction: Direction | null } {
  if (!isNum(from) || !isNum(to) || from === 0) return { text: NA, direction: null };
  const pct = (to / from - 1) * 100;
  const rounded = Number(pct.toFixed(2));
  if (rounded === 0) return { text: '0.00%', direction: 'flat' };
  return {
    text: `${rounded > 0 ? '+' : ''}${rounded.toFixed(2)}%`,
    direction: rounded > 0 ? 'up' : 'down',
  };
}

function unitDigits(unit: string): number {
  if (/vCPU|\/TH|gas/i.test(unit)) return 4;
  return 2;
}

/** Amount for a price, with precision chosen per unit. The unit is separate. */
export function formatPrice(unit: string, value: number | null | undefined): string {
  if (!isNum(value)) return NA;
  if (!unit.startsWith('$')) return value.toFixed(2);
  let digits = unitDigits(unit);
  // A real but tiny price must never read as $0.00.
  if (value !== 0 && Math.abs(value) < 10 ** -digits) digits = 6;
  return `$${value.toFixed(digits)}`;
}

/** "$/1M tokens (blended)" becomes "per 1M tokens, blended". */
export function formatUnit(unit: string): string {
  if (!unit.startsWith('$/')) return unit;
  const match = /^\$\/(.*?)(?:\s*\((.*)\))?$/.exec(unit);
  const rate = (match?.[1] ?? unit.slice(2)).split('/').join(' per ');
  return match?.[2] ? `per ${rate}, ${match[2]}` : `per ${rate}`;
}

/** Spread between venues, one decimal; "n/a" with fewer than two venues. */
export function formatSpread(spreadPct: number | null | undefined): string {
  if (!isNum(spreadPct)) return NA;
  return `${spreadPct.toFixed(1)}%`;
}

/** A 0-1 weight as a percent; whole numbers lose the decimal. */
export function formatWeight(weight: number | null | undefined): string {
  if (!isNum(weight)) return NA;
  const pct = Number((weight * 100).toFixed(1));
  return `${Number.isInteger(pct) ? pct.toFixed(0) : pct.toFixed(1)}%`;
}

/** "9/9 quotes", or "n/a" if the API did not send coverage. */
export function formatCoverage(quotes: { ok: number; total: number } | null | undefined): string {
  if (!quotes || !isNum(quotes.ok) || !isNum(quotes.total)) return NA;
  return `${quotes.ok}/${quotes.total} quotes`;
}

/** "Nov 11, 14:32 UTC". */
export function formatAsOf(iso: string | null | undefined): string {
  const t = iso ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(t)) return 'unknown';
  const d = new Date(t);
  const day = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${day}, ${hh}:${mm} UTC`;
}

/** "Nov 11", for chart axes. */
export function formatDay(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  return new Date(t).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

const VENUE_NAMES: Readonly<Record<string, string>> = {
  vast: 'Vast.ai',
  runpod: 'RunPod',
  akash: 'Akash',
  aws: 'AWS',
  azure: 'Azure',
};

export function venueName(venue: string): string {
  return VENUE_NAMES[venue] ?? venue;
}

interface GpuLike {
  venues?: Array<{ venue: string; price: number | null }> | null;
  cheapest?: { venue: string; price: number } | null;
}

/** Every venue across all GPU rows, in first-seen order: the board's columns. */
export function gpuVenueColumns(gpus: readonly GpuLike[]): string[] {
  const seen = new Set<string>();
  for (const gpu of gpus) for (const v of gpu.venues ?? []) seen.add(v.venue);
  return [...seen];
}

export function isCheapestVenue(gpu: GpuLike, venue: string): boolean {
  return gpu.cheapest?.venue === venue;
}

export interface WeightSegment {
  id: string;
  label: string;
  /** Share of the bar, 0-100. Zero when the pillar is down. */
  pct: number;
  down: boolean;
}

/**
 * Segments for the weight bar. Uses effective weights, which already exclude
 * pillars that are down; if none are usable (no level) it falls back to the
 * nominal weights so the bar still shows the design of the index.
 */
export function weightSegments(
  components: ReadonlyArray<{
    id: string;
    label: string;
    effectiveWeight?: number | null;
    nominalWeight?: number | null;
    status?: string;
  }>,
): WeightSegment[] {
  const effective = components.map((c) => (isNum(c.effectiveWeight) ? c.effectiveWeight : 0));
  const useEffective = effective.some((w) => w > 0);
  const weights = useEffective
    ? effective
    : components.map((c) => (isNum(c.nominalWeight) ? c.nominalWeight : 0));
  const total = weights.reduce((sum, w) => sum + w, 0);
  return components.map((c, i) => ({
    id: c.id,
    label: c.label,
    pct: total > 0 ? ((weights[i] ?? 0) / total) * 100 : 0,
    down: c.status === 'down',
  }));
}

export interface ChartPoint {
  t: string;
  value: number;
}

export interface ChartCoord extends ChartPoint {
  x: number;
  y: number;
}

export interface ChartGeometry {
  line: string;
  area: string;
  coords: ChartCoord[];
  min: number;
  max: number;
  /** y of the area's flat bottom edge. */
  baseY: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * SVG paths for a time series, x proportional to real time so gaps in the data
 * stay visible as gaps. Returns null below two usable points, because one
 * point is not a line and nothing is ever interpolated or invented.
 */
export function buildChart(
  points: readonly ChartPoint[],
  size: { width: number; height: number; padTop?: number; padBottom?: number },
): ChartGeometry | null {
  const clean = points
    .map((p) => ({ ...p, ms: Date.parse(p.t) }))
    .filter((p) => Number.isFinite(p.ms) && isNum(p.value))
    .sort((a, b) => a.ms - b.ms);
  const first = clean[0];
  const last = clean[clean.length - 1];
  if (!first || !last || clean.length < 2 || first.ms === last.ms) return null;

  const padTop = size.padTop ?? 12;
  const padBottom = size.padBottom ?? 12;
  const values = clean.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || Math.abs(max) * 0.1 || 1;
  // A flat series sits mid-chart rather than on an edge.
  const lo = max === min ? min - span / 2 : min;
  const hi = max === min ? max + span / 2 : max;
  const plotH = size.height - padTop - padBottom;

  const coords = clean.map((p) => ({
    t: p.t,
    value: p.value,
    x: r2(((p.ms - first.ms) / (last.ms - first.ms)) * size.width),
    y: r2(padTop + (1 - (p.value - lo) / (hi - lo)) * plotH),
  }));

  const line = coords.map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x} ${c.y}`).join(' ');
  const baseY = size.height;
  const area = `${line} L${coords[coords.length - 1]!.x} ${baseY} L${coords[0]!.x} ${baseY} Z`;
  return { line, area, coords, min, max, baseY };
}

/** Index of the coordinate closest to x; -1 for an empty list. */
export function nearestIndex(coords: ReadonlyArray<{ x: number }>, x: number): number {
  let best = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  coords.forEach((c, i) => {
    const distance = Math.abs(c.x - x);
    if (distance < bestDistance) {
      best = i;
      bestDistance = distance;
    }
  });
  return best;
}

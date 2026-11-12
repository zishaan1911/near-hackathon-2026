/**
 * SCI v2.0 calculation (matched-quote method).
 *
 * quote relative = price / base price of the same quote key. Relatives are
 * combined by weighted geometric mean: quote -> product -> component, and
 * level = 1000 * prod(componentRelative ^ effectiveWeight). Because every
 * relative is against the SAME quote's own base, a venue dropping out cannot
 * move the level by itself.
 */
import { PRODUCT_WEIGHTS, GPU_PRODUCTS, GPU_VENUES, type GpuId } from './basket.js';
import { BASE_QUOTES, BASE_VALUES } from './base.js';
import { median, weightedGeoMean } from './stats.js';
import {
  COMPONENT_META,
  venueLabel,
  type ComponentDetail,
  type ComponentFetch,
  type ComponentId,
  type Quote,
} from './types.js';

export const INDEX_BASE = 1000;
export const MIN_OK_COMPONENTS = 4;
export const RELATIVE_MIN = 0.2;
export const RELATIVE_MAX = 5;

export interface CalcComponent {
  id: ComponentId;
  label: string;
  unit: string;
  source: string;
  nominalWeight: number;
  effectiveWeight: number;
  /** Representative price (median of the kept quotes), for display. */
  value: number | null;
  baseValue: number;
  relative: number | null;
  /**
   * Stand-alone contribution in index points: (relative^w - 1) * 1000, w the
   * effective weight. Contributions are NOT additive to (level - 1000)
   * because the index is multiplicative; they are comparable across
   * components. Null when the component is down or the level is null.
   */
  contributionPoints: number | null;
  status: 'ok' | 'down';
  error?: string;
  detail?: ComponentDetail;
  /** 1000 * relative, or null. */
  level: number | null;
  sources: string[];
  quotes: { ok: number; total: number };
}

export interface GpuView {
  id: GpuId;
  label: string;
  level: number | null;
  medianPrice: number | null;
  venues: Array<{ venue: string; price: number | null; status: 'ok' | 'down' }>;
  cheapest: { venue: string; price: number } | null;
  spreadPct: number | null;
}

export interface DiscardedQuote {
  key: string;
  price: number;
  /** Null when the quote has no base price. */
  relative: number | null;
}

export interface CalcResult {
  level: number | null;
  degraded: boolean;
  components: CalcComponent[];
  gpus: GpuView[];
  discarded: DiscardedQuote[];
}

const round2 = (x: number): number => Math.round(x * 100) / 100;
const round4 = (x: number): number => Math.round(x * 10000) / 10000;

interface KeptQuote {
  quote: Quote;
  relative: number;
}

/** Groups quotes by product, geo-means within product, then across products. */
function componentRelative(id: ComponentId, kept: readonly KeptQuote[]): { relative: number; products: Map<string, number> } | null {
  const byProduct = new Map<string, KeptQuote[]>();
  for (const k of kept) {
    const list = byProduct.get(k.quote.product) ?? [];
    list.push(k);
    byProduct.set(k.quote.product, list);
  }
  const products = new Map<string, number>();
  for (const [product, list] of byProduct) {
    products.set(product, weightedGeoMean(list.map((k) => ({ value: k.relative, weight: 1 }))));
  }
  if (products.size === 0) return null;
  const weights = PRODUCT_WEIGHTS[id] ?? {};
  const rel = weightedGeoMean([...products].map(([product, value]) => ({ value, weight: weights[product] ?? 1 })));
  return { relative: rel, products };
}

export function computeIndex(
  fetched: readonly ComponentFetch[],
  baseQuotes: Readonly<Record<string, number>> = BASE_QUOTES,
  baseValues: Readonly<Record<ComponentId, number>> = BASE_VALUES,
): CalcResult {
  const discarded: DiscardedQuote[] = [];
  const keptByComponent = new Map<ComponentId, KeptQuote[]>();

  for (const meta of COMPONENT_META) {
    const f = fetched.find((x) => x.id === meta.id);
    const kept: KeptQuote[] = [];
    for (const q of f?.quotes ?? []) {
      const base = baseQuotes[q.key];
      if (!(typeof base === 'number' && base > 0) || !Number.isFinite(q.price) || q.price <= 0) {
        discarded.push({ key: q.key, price: q.price, relative: null });
        continue;
      }
      const relative = q.price / base;
      if (relative < RELATIVE_MIN || relative > RELATIVE_MAX) {
        discarded.push({ key: q.key, price: q.price, relative: round4(relative) });
        continue;
      }
      kept.push({ quote: q, relative });
    }
    keptByComponent.set(meta.id, kept);
  }

  const rels = new Map<ComponentId, ReturnType<typeof componentRelative>>();
  for (const meta of COMPONENT_META) rels.set(meta.id, componentRelative(meta.id, keptByComponent.get(meta.id) ?? []));

  const okMetas = COMPONENT_META.filter((m) => rels.get(m.id) !== null);
  const nominalOk = okMetas.reduce((a, m) => a + m.nominalWeight, 0);
  const enough = okMetas.length >= MIN_OK_COMPONENTS;

  let level: number | null = null;
  if (enough) {
    let logSum = 0;
    for (const m of okMetas) logSum += (m.nominalWeight / nominalOk) * Math.log((rels.get(m.id) as { relative: number }).relative);
    level = round2(INDEX_BASE * Math.exp(logSum));
  }

  const components: CalcComponent[] = COMPONENT_META.map((meta) => {
    const f = fetched.find((x) => x.id === meta.id);
    const kept = keptByComponent.get(meta.id) ?? [];
    const rel = rels.get(meta.id) ?? null;
    const status: 'ok' | 'down' = rel ? 'ok' : 'down';
    const effectiveWeight = enough && rel ? meta.nominalWeight / nominalOk : 0;
    const detail: ComponentDetail = { ...(f?.detail ?? {}) };
    const discardedHere = discarded.filter((d) => f?.quotes.some((q) => q.key === d.key));
    if (discardedHere.length) {
      detail.discarded = discardedHere.map((d) => (d.relative === null ? `${d.key} (no base)` : `${d.key} (x${d.relative})`)).join('; ');
    }
    if (f?.errors.length && status === 'ok') detail.venueErrors = f.errors.join('; ');

    const out: CalcComponent = {
      id: meta.id,
      label: meta.label,
      unit: meta.unit,
      source: meta.source,
      nominalWeight: meta.nominalWeight,
      effectiveWeight: round4(effectiveWeight),
      value: kept.length ? median(kept.map((k) => k.quote.price)) : null,
      baseValue: baseValues[meta.id],
      relative: rel ? round4(rel.relative) : null,
      contributionPoints:
        enough && rel ? round2((Math.pow(rel.relative, effectiveWeight) - 1) * INDEX_BASE) : null,
      status,
      level: rel ? round2(INDEX_BASE * rel.relative) : null,
      sources: [...new Set(kept.map((k) => venueLabel(k.quote.venue)))],
      quotes: { ok: kept.length, total: f?.expected.length ?? 0 },
    };
    if (status === 'down') {
      out.error = f?.errors.length ? f.errors.join('; ') : f ? 'no usable quotes' : 'missing';
    }
    if (Object.keys(detail).length) out.detail = detail;
    return out;
  });

  return {
    level,
    degraded: level === null || okMetas.length < COMPONENT_META.length,
    components,
    gpus: gpuViews(keptByComponent.get('gpu_rental') ?? []),
    discarded,
  };
}

function gpuViews(kept: readonly KeptQuote[]): GpuView[] {
  return GPU_PRODUCTS.map((g) => {
    const mine = kept.filter((k) => k.quote.product === g.id);
    const venues = GPU_VENUES.map((v) => {
      const q = mine.find((k) => k.quote.venue === v);
      return { venue: v, price: q ? q.quote.price : null, status: (q ? 'ok' : 'down') as 'ok' | 'down' };
    });
    const prices = mine.map((k) => k.quote.price);
    const cheapestQuote = mine.reduce<KeptQuote | null>((a, k) => (a === null || k.quote.price < a.quote.price ? k : a), null);
    const lo = prices.length ? Math.min(...prices) : 0;
    const hi = prices.length ? Math.max(...prices) : 0;
    const rel = mine.length ? weightedGeoMean(mine.map((k) => ({ value: k.relative, weight: 1 }))) : null;
    return {
      id: g.id,
      label: g.label,
      level: rel === null ? null : round2(INDEX_BASE * rel),
      medianPrice: prices.length ? median(prices) : null,
      venues,
      cheapest: cheapestQuote ? { venue: cheapestQuote.quote.venue, price: cheapestQuote.quote.price } : null,
      spreadPct: mine.length >= 2 && lo > 0 ? round2(((hi - lo) / lo) * 100) : null,
    };
  });
}

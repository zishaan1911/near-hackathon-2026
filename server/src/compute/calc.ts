/**
 * CCI calculation: level = 1000 * prod_i (value_i / base_i) ^ w_i over OK
 * components, with weights renormalised to sum to 1.
 */
import { BASE_VALUES } from './base.js';
import { COMPONENT_META, type ComponentId, type ComponentReading } from './types.js';

export const INDEX_BASE = 1000;
export const MIN_OK_COMPONENTS = 3;
export const RELATIVE_MIN = 0.1;
export const RELATIVE_MAX = 10;

export interface CalcComponent {
  id: ComponentId;
  label: string;
  unit: string;
  source: string;
  nominalWeight: number;
  effectiveWeight: number;
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
  detail?: ComponentReading['detail'];
}

export interface CalcResult {
  level: number | null;
  degraded: boolean;
  components: CalcComponent[];
}

const round2 = (x: number): number => Math.round(x * 100) / 100;

export function computeIndex(
  readings: readonly ComponentReading[],
  baseValues: Record<ComponentId, number> = BASE_VALUES,
): CalcResult {
  // Apply the sanity guard first so out-of-range components count as down.
  const guarded = COMPONENT_META.map((meta) => {
    const r = readings.find((x) => x.id === meta.id);
    const baseValue = baseValues[meta.id];
    let status: 'ok' | 'down' = 'down';
    let error: string | undefined = r ? r.error : 'missing';
    let relative: number | null = null;
    if (r && r.status === 'ok' && r.value !== null && Number.isFinite(r.value) && r.value > 0) {
      const rel = r.value / baseValue;
      if (rel >= RELATIVE_MIN && rel <= RELATIVE_MAX) {
        status = 'ok';
        error = undefined;
        relative = rel;
      } else {
        error = 'out of range vs base';
      }
    } else if (r && r.status === 'ok') {
      error = 'invalid value';
    }
    return { meta, r, baseValue, status, error, relative };
  });

  const okItems = guarded.filter((g) => g.status === 'ok');
  const nominalOk = okItems.reduce((a, g) => a + g.meta.nominalWeight, 0);
  const enough = okItems.length >= MIN_OK_COMPONENTS;
  const degraded = okItems.length < COMPONENT_META.length;

  let level: number | null = null;
  if (enough) {
    let logSum = 0;
    for (const g of okItems) logSum += (g.meta.nominalWeight / nominalOk) * Math.log(g.relative as number);
    level = round2(INDEX_BASE * Math.exp(logSum));
  }

  const components: CalcComponent[] = guarded.map((g) => {
    const effectiveWeight = enough && g.status === 'ok' ? g.meta.nominalWeight / nominalOk : 0;
    const out: CalcComponent = {
      id: g.meta.id,
      label: g.meta.label,
      unit: g.meta.unit,
      source: g.r?.source ?? g.meta.source,
      nominalWeight: g.meta.nominalWeight,
      effectiveWeight: Math.round(effectiveWeight * 10000) / 10000,
      value: g.r?.value ?? null,
      baseValue: g.baseValue,
      relative: g.relative === null ? null : Math.round(g.relative * 10000) / 10000,
      contributionPoints:
        enough && g.status === 'ok' ? round2((Math.pow(g.relative as number, effectiveWeight) - 1) * INDEX_BASE) : null,
      status: g.status,
    };
    if (g.error) out.error = g.error;
    if (g.r?.detail) out.detail = g.r.detail;
    return out;
  });

  return { level, degraded: degraded || level === null, components };
}

import { useCallback, useEffect, useState } from 'react';
import { getComputeIndex, type ComputeIndexResponse } from '../lib/api';

const POLL_MS = 60_000;

/** Formats a component's current value with its unit; "n/a" when missing. */
export function formatComponentValue(unit: string, value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'n/a';
  switch (unit) {
    case '$/GPU-hr':
    case '$/1M tokens':
      return `$${value.toFixed(2)} ${unit.slice(1)}`;
    case '$/TH/day':
      return `$${value.toFixed(4)} ${unit.slice(1)}`;
    default:
      return `${value.toFixed(2)} ${unit}`;
  }
}

/** Price relative (1.00 = base) as a signed percent change; null when unknown. */
export function relativeToPercent(relative: number | null | undefined): number | null {
  if (relative === null || relative === undefined || !Number.isFinite(relative)) return null;
  return (relative - 1) * 100;
}

/** Offset of the bar from the centre, as % of track width, clamped to +/-50. */
export function relativeBarOffset(relative: number | null | undefined): number {
  const pct = relativeToPercent(relative);
  if (pct === null) return 0;
  return Math.max(-50, Math.min(50, pct));
}

/** Compact teaser on the Markets page. The full experience lives at /compute. */
export function ComputeIndexPage() {
  const [data, setData] = useState<ComputeIndexResponse | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      setData(await getComputeIndex());
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the Compute Index');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  const level = data?.index.level;
  const hasLevel = typeof level === 'number' && Number.isFinite(level);

  return (
    <section className="card cci-hero">
      <div className="card-heading">
        <div>
          <span className="section-kicker">COMPUTE INDEX</span>
          <h2>Congest Compute Index</h2>
        </div>
        <a className="button button-small button-primary" href="/compute">Open the index</a>
      </div>
      <div className="cci-hero-body">
        <strong className="cci-level">
          {hasLevel ? level.toFixed(2) : loading ? '…' : 'n/a'}
        </strong>
        {error && !data && (
          <span className="cci-muted">
            Could not load the level. <button onClick={() => void load()}>Retry</button>
          </span>
        )}
      </div>
    </section>
  );
}

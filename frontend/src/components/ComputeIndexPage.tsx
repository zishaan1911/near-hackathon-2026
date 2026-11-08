import { useCallback, useEffect, useState } from 'react';
import { getComputeIndex, type ComputeIndexComponent, type ComputeIndexResponse } from '../lib/api';

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
    case 'EGSI':
      return `${Math.round(value)} EGSI`;
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

function signedPercent(pct: number | null): string {
  if (pct === null) return 'n/a';
  return `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`;
}

function relativeTime(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'unknown';
  const secs = Math.max(0, Math.round((now - t) / 1000));
  if (secs < 10) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

function pctWeight(w: number): string {
  return Number.isFinite(w) ? `${(w * 100).toFixed(1)}%` : 'n/a';
}

function RelativeBar({ relative }: { relative: number | null }) {
  const pct = relativeToPercent(relative);
  const offset = relativeBarOffset(relative);
  const style =
    offset >= 0
      ? { left: '50%', width: `${offset}%` }
      : { left: `${50 + offset}%`, width: `${-offset}%` };
  return (
    <div className="cci-rel">
      <div className="cci-rel-track" aria-hidden="true">
        <span className="cci-rel-mid" />
        {pct !== null && <span className={`cci-rel-fill ${pct >= 0 ? 'up' : 'down'}`} style={style} />}
      </div>
      <span className={pct === null ? '' : pct >= 0 ? 'positive-text' : 'negative-text'}>
        {signedPercent(pct)}
      </span>
    </div>
  );
}

function ComponentRow({ c }: { c: ComputeIndexComponent }) {
  const weightDiffers = Math.abs(c.effectiveWeight - c.nominalWeight) > 0.0005;
  return (
    <div className="cci-row">
      <div className="cci-cell cci-label">
        <span
          className={`cci-dot ${c.status === 'ok' ? 'ok' : 'down'}`}
          title={c.status === 'ok' ? 'Source healthy' : (c.error ?? 'Source unavailable')}
        />
        <b>{c.label}</b>
      </div>
      <div className="cci-cell cci-value">{formatComponentValue(c.unit, c.value)}</div>
      <div className="cci-cell">
        <RelativeBar relative={c.relative} />
      </div>
      <div className="cci-cell">
        {pctWeight(c.effectiveWeight)}
        {weightDiffers && <small className="cci-muted"> (nominal {pctWeight(c.nominalWeight)})</small>}
      </div>
      <div className="cci-cell cci-muted">{c.source}</div>
    </div>
  );
}

function Skeleton() {
  return (
    <div className="cci-skeleton" aria-busy="true" aria-label="Loading Compute Index">
      <div className="cci-skel-block cci-skel-hero" />
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="cci-skel-block cci-skel-row" />
      ))}
    </div>
  );
}

const BUILD_BULLETS: Array<[string, string]> = [
  ['GPU marketplace', 'Vast.ai marketplace offers, the going $/GPU-hr for rentable GPUs.'],
  ['Cloud GPU spot', 'Azure Spot GPU VM prices, in $/GPU-hr.'],
  ['AI inference', 'OpenRouter model prices, in $ per 1M tokens.'],
  ['Bitcoin hashprice', 'Derived from Bitcoin network hashrate and the BTC price, in $/TH/day.'],
  ['Blockspace', 'Ethereum blockspace stress (EGSI), the same index traded on Congest.'],
];

export function ComputeIndexPage() {
  const [data, setData] = useState<ComputeIndexResponse | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = await getComputeIndex();
      setData(next);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the Compute Index');
    } finally {
      setLoading(false);
      setNow(Date.now());
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  const idx = data?.index;
  const level = idx && idx.level !== null && Number.isFinite(idx.level) ? idx.level : null;
  const change = idx && level !== null && idx.base ? (level / idx.base - 1) * 100 : null;

  return (
    <div className="cci-page">
      {error && (
        <div className="top-error">
          <b>Compute Index:</b> {error}
          <button onClick={() => void load()}>Retry</button>
        </div>
      )}

      {loading && !data ? (
        <Skeleton />
      ) : data && idx ? (
        <>
          <section className="card cci-hero">
            <div className="card-heading">
              <div>
                <span className="section-kicker">COMPUTE INDEX</span>
                <h2>{idx.name}</h2>
              </div>
              {idx.degraded && (
                <span className="cci-badge-degraded">Degraded: some sources unavailable</span>
              )}
            </div>
            <div className="cci-hero-body">
              <strong className="cci-level">{level === null ? 'n/a' : level.toFixed(2)}</strong>
              <div className="cci-hero-meta">
                <span className="cci-muted">Base {idx.base} on {idx.baseDate}</span>
                <span className={change === null ? '' : change >= 0 ? 'positive-text' : 'negative-text'}>
                  {change === null ? 'n/a' : `${signedPercent(change)} vs base`}
                </span>
                <span className="cci-muted">As of {relativeTime(idx.asOf, now)}</span>
              </div>
            </div>
          </section>

          <section className="card cci-components">
            <div className="card-heading">
              <div>
                <h2>Components</h2>
                <span className="section-note">Methodology {idx.methodologyVersion}</span>
              </div>
            </div>
            <div className="cci-table">
              <div className="cci-row cci-head">
                <div className="cci-cell">Component</div>
                <div className="cci-cell">Current</div>
                <div className="cci-cell">vs base (1.00)</div>
                <div className="cci-cell">Weight</div>
                <div className="cci-cell">Source</div>
              </div>
              {data.components.map((c) => (
                <ComponentRow key={c.id} c={c} />
              ))}
            </div>
          </section>
        </>
      ) : null}

      <section className="card cci-how">
        <button
          className="cci-how-toggle"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <span>How it's built</span>
          <span aria-hidden="true">{open ? '−' : '+'}</span>
        </button>
        {open && (
          <div className="cci-how-body">
            <ul>
              {BUILD_BULLETS.map(([name, text]) => (
                <li key={name}><b>{name}:</b> {text}</li>
              ))}
            </ul>
            <p>
              The index is a weighted geometric mean of each component's price relative to the
              base date, scaled to 1000 at the base. If a source is down, the remaining weights
              renormalise so the index stays comparable.
            </p>
            <p className="cci-muted">Testnet preview: trading on the Compute Index is coming soon.</p>
            <button className="button button-small button-primary" disabled>Trade CCI</button>
          </div>
        )}
      </section>
    </div>
  );
}

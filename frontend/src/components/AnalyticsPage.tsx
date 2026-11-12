import type { Candle, MarketSnapshot } from '../lib/api';
import { rsi, macd, sma, summarise } from '../lib/indicators';

export function AnalyticsPage({ snapshot, candles }: { snapshot: MarketSnapshot | null; candles: Candle[] }) {
  const closes = candles.map((c) => c.close);
  const rsi14 = rsi(closes, 14).at(-1);
  const m = macd(closes);
  const macdNow = m.macd.at(-1);
  const ma20 = sma(closes, 20).at(-1);
  const summary = summarise(closes);
  const level = snapshot?.index?.level;
  const pillars = snapshot?.pillars ?? [];
  const hasHistory = closes.length >= 2;
  const fmt = (v: number | null | undefined, digits: number) =>
    v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(digits);

  return (
    <div className="analytics-page">
      <section className="card">
        <div className="card-heading">
          <div>
            <span className="section-kicker">INDEX ANALYTICS</span>
            <h2>Compute Index Momentum</h2>
          </div>
          {hasHistory && <span className={`analysis-tone tone-${summary.tone}`}>{summary.label}</span>}
        </div>
        {!hasHistory && (
          <div className="muted-empty">
            Not enough index history yet. Indicators appear once at least two candles have been recorded
            or observed in this session; none are estimated.
          </div>
        )}
      </section>
      <div className="analytics-metrics">
        <section className="card"><span>Current CCI</span><strong>{typeof level === 'number' ? level.toFixed(1) : '—'}</strong><small>Base {snapshot?.index?.base ?? 1000}</small></section>
        <section className="card"><span>RSI 14</span><strong>{fmt(rsi14, 1)}</strong><small>Momentum only — not “overbought”</small></section>
        <section className="card"><span>MACD</span><strong>{fmt(macdNow, 2)}</strong><small>EMA momentum spread</small></section>
        <section className="card"><span>SMA 20</span><strong>{fmt(ma20, 1)}</strong><small>Trailing CCI average</small></section>
      </div>
      <section className="card">
        <div className="card-heading"><h2>Pillar levels</h2></div>
        <div className="driver-list">
          {pillars.length ? pillars.map((p) => (
            <div className="driver" key={p.id}>
              <div>
                <span className="driver-icon">⌁</span>
                <span>{p.label}</span>
                <b>{p.status === 'down' || p.level === null ? 'down' : p.level.toFixed(0)} · {Math.round(p.effectiveWeight * 100)}%</b>
              </div>
              <div className="driver-track"><span style={{ width: `${Math.min(100, Math.max(2, p.effectiveWeight * 100))}%` }} /></div>
            </div>
          )) : <div className="muted-empty">No pillar data available.</div>}
        </div>
      </section>
      <div className="analytics-note">Technical indicators here are applied to the Compute Index, a computed benchmark of compute prices, so conventional “overbought/oversold” interpretations should not be used.</div>
    </div>
  );
}

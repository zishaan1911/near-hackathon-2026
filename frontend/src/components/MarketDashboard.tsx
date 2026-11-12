import { useEffect, useState } from 'react';
import type { MarketSnapshot } from '../lib/api';
import { formatAge, formatCountdown, percentVsBase } from '../lib/market';

function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export function MarketDashboard({
  snapshot,
  loading,
  error,
  onTrade,
}: {
  snapshot: MarketSnapshot | null;
  loading: boolean;
  error: string;
  onTrade: () => void;
}) {
  const now = useNow();

  if (!snapshot) {
    return (
      <div className="screen-state card">
        {loading ? 'Loading live market…' : error || 'No market data available.'}
      </div>
    );
  }

  const { index, pillars, market, quote, orderbook } = snapshot;
  const level = index?.level ?? null;
  const base = index?.base ?? 1000;
  const vsBase = percentVsBase(level, base);
  const countdown = market.settled
    ? 'Settled'
    : market.expiryMs
      ? (formatCountdown(market.expiryMs, now) ?? 'Awaiting settlement')
      : '—';
  const oracleAge = formatAge(market.oracleUpdatedMs, now);
  const oracleLabel = !market.oracleHasPrice
    ? 'No price yet'
    : market.oracleFresh
      ? 'Fresh'
      : 'Stale';
  const asks = orderbook.asks.slice(0, 3).reverse();
  const bids = orderbook.bids.slice(0, 3);
  const price = market.oracleHasPrice && Number.isFinite(market.oraclePrice)
    ? market.oraclePrice
    : (quote.fairPrice ?? level ?? Number.NaN);
  const degraded = index?.degraded === true;

  return (
    <div className="dashboard-page">
      <div className="dashboard-top-grid">
        <section className="card gauge-card">
          <div className="card-heading">
            <div>
              <span className="section-kicker">LIVE INDEX</span>
              <h2>Congest Compute Index (CCI)</h2>
            </div>

            <span className="live-badge">
              <i /> {degraded ? 'Degraded' : 'Live'}
            </span>
          </div>

          <div className="index-gauge">
            <div className="gauge-center">
              <strong>{level !== null ? level.toFixed(1) : '—'}</strong>
              <span>
                {vsBase !== null
                  ? `${vsBase >= 0 ? '+' : ''}${vsBase.toFixed(2)}% vs base ${base}`
                  : `Base ${base}`}
              </span>
            </div>
          </div>
          {index?.baseDate && (
            <div className="indicative-note">Base {base} set on {index.baseDate}.</div>
          )}
        </section>
      </div>

      <div className="dashboard-bottom-grid">
        <section className="card drivers-card">
          <div className="card-heading">
            <h2>Pillars</h2>
          </div>

          <div className="driver-list">
            {pillars.length ? (
              pillars.map((pillar) => (
                <div className="driver" key={pillar.id}>
                  <div>
                    <span className="driver-icon">⌁</span>
                    <span>{pillar.label}</span>
                    <b>
                      {pillar.status === 'down' || pillar.level === null
                        ? 'down'
                        : pillar.level.toFixed(0)}{' '}
                      · {Math.round(pillar.effectiveWeight * 100)}%
                    </b>
                  </div>

                  <div className="driver-track">
                    <span style={{ width: `${Math.min(100, Math.max(2, pillar.effectiveWeight * 100))}%` }} />
                  </div>
                </div>
              ))
            ) : (
              <div className="muted-empty">No pillar breakdown returned yet.</div>
            )}
          </div>
        </section>

        <section className="card kpi-card">
          <div className="card-heading">
            <div>
              <span className="section-kicker">ON-CHAIN</span>
              <h2>Oracle &amp; Expiry</h2>
            </div>
          </div>

          <div className="kpi-summary-row">
            <div className="kpi-stat-card">
              <span>Oracle price</span>
              <strong>
                {market.oracleHasPrice && Number.isFinite(market.oraclePrice)
                  ? market.oraclePrice.toFixed(0)
                  : '—'}
              </strong>
              <small>
                {oracleLabel}
                {oracleAge ? ` · ${oracleAge}` : ''}
              </small>
            </div>

            <div className="kpi-stat-card emphasis">
              <span>Expires in</span>
              <strong>{countdown}</strong>
              <small>Hourly market</small>
            </div>
          </div>

          <div className="book-head"><span>Order book (indicative)</span><span>Size</span></div>
          <div className="book-rows asks">
            {asks.length ? asks.map((row, i) => <div key={`a${row.price}-${i}`}><span>{row.price.toFixed(2)}</span><b>{row.size}</b></div>) : <div className="book-empty">No asks</div>}
          </div>
          <div className="book-rows bids">
            {bids.length ? bids.map((row, i) => <div key={`b${row.price}-${i}`}><span>{row.price.toFixed(2)}</span><b>{row.size}</b></div>) : <div className="book-empty">No bids</div>}
          </div>
        </section>

        <section className="card market-overview-card">
          <div className="card-heading">
            <h2>Market Overview</h2>
          </div>

          <div className="overview-list">
            <div>
              <span>Market</span>
              <b>{market.label}</b>
            </div>

            <div>
              <span>Reference price</span>
              <b>{Number.isFinite(price) ? price.toFixed(1) : '—'}</b>
            </div>

            <div>
              <span>Collateral</span>
              <b>tUSDC</b>
            </div>

            <div>
              <span>Status</span>
              <b className={market.settled ? undefined : 'positive-text'}>{market.settled ? 'Settled' : 'Open'}</b>
            </div>

            <div>
              <span>Index detail</span>
              <b><a href="/compute">Open the index</a></b>
            </div>
          </div>

          <button
            className="button button-primary overview-action"
            onClick={onTrade}
          >
            Trade {market.label} →
          </button>
        </section>
      </div>
    </div>
  );
}

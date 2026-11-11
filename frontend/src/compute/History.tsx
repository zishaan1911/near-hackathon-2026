import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { getComputeHistory, type ComputeHistoryResponse } from '../lib/api';
import { buildChart, formatDay, formatLevel, formatPercentChange, formatPrice, formatUnit, nearestIndex, type ChartPoint } from './helpers';
import { Reveal, SectionHead } from './Reveal';

const WIDTH = 640;
const HEIGHT = 220;

function AreaChart({
  id,
  title,
  caption,
  points,
  format,
  wide,
}: {
  id: string;
  title: string;
  caption: string;
  points: ChartPoint[];
  format: (value: number) => string;
  wide?: boolean;
}) {
  const height = wide ? 170 : HEIGHT;
  const geometry = useMemo(() => buildChart(points, { width: WIDTH, height }), [points, height]);
  const [hover, setHover] = useState<number | null>(null);

  function track(event: PointerEvent<SVGSVGElement>) {
    if (!geometry) return;
    const rect = event.currentTarget.getBoundingClientRect();
    setHover(nearestIndex(geometry.coords, ((event.clientX - rect.left) / rect.width) * WIDTH));
  }

  const coords = geometry?.coords ?? [];
  const first = coords[0];
  const last = coords[coords.length - 1];
  const shown = (hover !== null ? coords[hover] : undefined) ?? last;
  const change = first && last ? formatPercentChange(first.value, last.value) : null;

  return (
    <Reveal className={`cx-chart${wide ? ' cx-chart-wide' : ''}`}>
      <header>
        <div>
          <h3>{title}</h3>
          <p>{caption}</p>
        </div>
        {shown && (
          <div className="cx-chart-read">
            <b>{format(shown.value)}</b>
            <span>
              {formatDay(shown.t)}
              {hover === null && change?.direction && (
                <em className={`cx-${change.direction}`}> {change.text}</em>
              )}
            </span>
          </div>
        )}
      </header>

      {geometry && first && last ? (
        <>
          <svg
            viewBox={`0 0 ${WIDTH} ${height}`}
            role="img"
            aria-label={`${title}: from ${format(first.value)} on ${formatDay(first.t)} to ${format(last.value)} on ${formatDay(last.t)}.`}
            onPointerMove={track}
            onPointerDown={track}
            onPointerLeave={() => setHover(null)}
          >
            <defs>
              <linearGradient id={`cx-fill-${id}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#ffb020" stopOpacity="0.34" />
                <stop offset="1" stopColor="#ffb020" stopOpacity="0" />
              </linearGradient>
            </defs>
            <path d={geometry.area} fill={`url(#cx-fill-${id})`} />
            <path d={geometry.line} className="cx-chart-line" />
            {shown && hover !== null && (
              <>
                <line x1={shown.x} x2={shown.x} y1={0} y2={height} className="cx-chart-cross" />
                <circle cx={shown.x} cy={shown.y} r={4} className="cx-chart-dot" />
              </>
            )}
          </svg>
          <footer>
            <span>{formatDay(first.t)}</span>
            <span>Low {format(geometry.min)} · High {format(geometry.max)}</span>
            <span>{formatDay(last.t)}</span>
          </footer>
        </>
      ) : (
        <p className="cx-chart-empty">
          {points.length === 0
            ? 'No data from this source right now.'
            : 'Not enough points to draw a line yet.'}
        </p>
      )}
    </Reveal>
  );
}

export function History() {
  const [data, setData] = useState<ComputeHistoryResponse | null>(null);
  const [error, setError] = useState('');
  const latest = useRef(0);

  const load = useCallback(async () => {
    const id = ++latest.current;
    setError('');
    try {
      const next = await getComputeHistory(30);
      if (id === latest.current) setData(next);
    } catch (e) {
      if (id === latest.current) setError(e instanceof Error ? e.message : 'Could not load history.');
    }
  }, []);

  useEffect(() => {
    void load();
    return () => {
      latest.current += 1;
    };
  }, [load]);

  const levels = useMemo(
    () => (data?.points ?? []).map((p) => ({ t: p.t, value: p.level })),
    [data],
  );
  const hashUnit = '$/TH/day';
  const gasUnit = '$/1M gas';

  return (
    <section id="history" className="cx-section">
      <div className="cx-wrap">
        <SectionHead eyebrow="History" title="Only what really happened." lede="The last 30 days, from real public data." />

        {error && !data ? (
          <div className="cx-error" role="alert">
            <h3>History didn't load.</h3>
            <p>{error}</p>
            <button type="button" className="cx-btn" onClick={() => void load()}>Retry</button>
          </div>
        ) : !data ? (
          <div className="cx-charts" role="status" aria-label="Loading history">
            <div className="cx-skel cx-skel-chart" />
            <div className="cx-skel cx-skel-chart" />
          </div>
        ) : (
          <>
            {data.persisted ? (
              levels.length >= 2 ? (
                <AreaChart
                  id="cci"
                  title="Congest Compute Index"
                  caption="Recorded index levels."
                  points={levels}
                  format={(v) => formatLevel(v)}
                  wide
                />
              ) : (
                <Reveal className="cx-notice">
                  <p>Storage is connected. The index line appears once at least two snapshots are recorded.</p>
                </Reveal>
              )
            ) : (
              <Reveal className="cx-notice">
                <p>Index history starts accumulating once storage is connected. These two series have real public history.</p>
              </Reveal>
            )}

            <div className="cx-charts">
              <AreaChart
                id="btc"
                title="Bitcoin hashprice"
                caption={`USD ${formatUnit(hashUnit)}, daily, from blockchain.info.`}
                points={data.backfill.btc_hashprice}
                format={(v) => formatPrice(hashUnit, v)}
              />
              <AreaChart
                id="eth"
                title="Ethereum blockspace"
                caption={`USD ${formatUnit(gasUnit)}: real base fees, valued at today's ETH price.`}
                points={data.backfill.blockspace}
                format={(v) => formatPrice(gasUnit, v)}
              />
            </div>
          </>
        )}
      </div>
    </section>
  );
}

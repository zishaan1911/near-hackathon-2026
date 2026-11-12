import { useMemo, useState } from 'react';
import { getComputeHistory, type ComputeHistoryResponse } from '../lib/api';
import { usePolled, type Polled } from '../lib/usePolled';
import { ErrorLine, Skeleton } from '../ui/bits';
import { Chart, type ChartMarker, type ChartSeries } from '../ui/Chart';
import { formatAsOf, formatDay, formatLevel } from './helpers';
import {
  filterRange,
  latestTime,
  mergeIndexSeries,
  pickRange,
  rangeHasData,
  RANGES,
  type IndexSeries,
  type Range,
} from './series';

export interface IndexHistory {
  history: Polled<ComputeHistoryResponse>;
  series: IndexSeries | null;
}

/** Ninety days of history joined with the live level. One fetch, shared by everything on the page. */
export function useIndexHistory(live: { level: number | null; asOf?: string | null } | null): IndexHistory {
  const history = usePolled(() => getComputeHistory(90), 10 * 60_000);
  const level = live?.level ?? null;
  const asOf = live?.asOf ?? null;
  const series = useMemo(() => {
    const data = history.data;
    if (!data) return null;
    return mergeIndexSeries({
      backcast: data.backcast.points,
      recorded: data.persisted ? data.points : [],
      settlements: data.settlements,
      live: level !== null ? { t: asOf ?? Date.now(), level } : null,
    });
  }, [history.data, level, asOf]);
  return { history, series };
}

export function RangePills({
  value,
  onChange,
  isAvailable,
}: {
  value: Range;
  onChange: (range: Range) => void;
  isAvailable?: (range: Range) => boolean;
}) {
  return (
    <div className="pills" role="radiogroup" aria-label="Time range">
      {RANGES.map((r) => (
        <button
          key={r}
          type="button"
          role="radio"
          aria-checked={value === r}
          className={value === r ? 'pill on' : 'pill'}
          disabled={isAvailable ? !isAvailable(r) : false}
          onClick={() => onChange(r)}
        >
          {r}
        </button>
      ))}
    </div>
  );
}

export function formatChartTime(seconds: number, intraday: boolean): string {
  const iso = new Date(seconds * 1000).toISOString();
  return intraday ? formatAsOf(iso) : formatDay(iso);
}

/** The index over time: the back-cast in violet, real readings in cyan, with range pills. */
export function IndexChart({ data, height = 360 }: { data: IndexHistory; height?: number }) {
  const { history, series } = data;
  const [chosen, setChosen] = useState<Range | null>(null);
  const [hover, setHover] = useState<{ time: number; value: number } | null>(null);

  const range = series ? (chosen ?? pickRange(series, '3M')) : chosen ?? '3M';
  const view = useMemo(() => {
    if (!series) return null;
    const anchor = latestTime(series.reconstructed, series.measured);
    const rec = filterRange(series.reconstructed, range, anchor);
    const real = filterRange(series.measured, range, anchor);
    const chartSeries: ChartSeries[] = [];
    // The violet line runs into the first real point, so the two read as one line.
    if (rec.length) chartSeries.push({ id: 'rec', kind: 'area', tone: 'violet', points: real[0] ? [...rec, real[0]] : rec });
    if (real.length) chartSeries.push({ id: 'real', kind: 'area', tone: 'cyan', points: real });
    const markers: ChartMarker[] =
      series.onchainFrom !== null && real.some((p) => p.time === series.onchainFrom)
        ? [{ seriesId: 'real', time: series.onchainFrom, text: 'On-chain' }]
        : [];
    const last = real[real.length - 1] ?? rec[rec.length - 1] ?? null;
    return { chartSeries, markers, last, count: rec.length + real.length, firstReal: real[0]?.time ?? null };
  }, [series, range]);

  if (!history.data) {
    return history.error ? (
      <div className="chart-card">
        <ErrorLine text="History did not load." onRetry={() => void history.reload()} />
      </div>
    ) : (
      <div className="chart-card">
        <Skeleton className="skel-block" label="Loading history" />
      </div>
    );
  }

  const intraday = range === '1D' || range === '1W';
  const shown = hover ?? (view?.last ? { time: view.last.time, value: view.last.value } : null);
  const shownReal = shown && view?.firstReal !== null && view?.firstReal !== undefined && shown.time >= view.firstReal;
  const method = history.data.backcast.method;

  return (
    <div className="chart-card">
      <div className="chart-top">
        <div className="chart-readout">
          <p className="chart-value num">{shown ? formatLevel(shown.value) : 'n/a'}</p>
          <p className="muted small num">
            {shown ? formatChartTime(shown.time, intraday) : ' '}
            {shown && <> · {shownReal ? 'Measured' : 'Reconstructed'}</>}
          </p>
        </div>
        <RangePills
          value={range}
          onChange={(r) => {
            setChosen(r);
            setHover(null);
          }}
          isAvailable={series ? (r) => rangeHasData(series, r) : undefined}
        />
      </div>
      {view && view.count >= 2 ? (
        <Chart
          series={view.chartSeries}
          markers={view.markers}
          height={height}
          intraday={intraday}
          label={`Silica Compute Index, ${range}`}
          onCrosshair={setHover}
        />
      ) : (
        <p className="chart-empty muted" style={{ minHeight: height }}>
          No history in this range yet.
        </p>
      )}
      <div className="chart-legend small">
        {series && series.reconstructed.length > 0 && (
          <span>
            <i className="key key-violet" aria-hidden="true" />
            Reconstructed, daily
          </span>
        )}
        {series && series.measured.length > 0 && (
          <span>
            <i className="key key-cyan" aria-hidden="true" />
            On-chain settlements and live, hourly
          </span>
        )}
      </div>
      {method && <p className="chart-note muted small">{method}</p>}
    </div>
  );
}

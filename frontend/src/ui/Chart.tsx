import { useEffect, useRef, useState } from 'react';
import type {
  IChartApi,
  ISeriesApi,
  ISeriesMarkersPluginApi,
  SeriesType,
  Time,
  UTCTimestamp,
} from 'lightweight-charts';
import type { CandlePoint, LinePoint } from '../compute/series';

type Lib = typeof import('lightweight-charts');

// The library loads on first use, so it never weighs on the first paint.
let libPromise: Promise<Lib> | null = null;
function loadLib(): Promise<Lib> {
  libPromise ??= import('lightweight-charts');
  return libPromise;
}

export type Tone = 'violet' | 'cyan';

export type ChartSeries =
  | { id: string; kind: 'area'; tone: Tone; points: readonly LinePoint[] }
  | { id: string; kind: 'candles'; candles: readonly CandlePoint[] };

export interface ChartMarker {
  seriesId: string;
  time: number;
  text: string;
}

const TONES: Record<Tone, { line: string; top: string }> = {
  violet: { line: 'rgba(196, 181, 253, 0.9)', top: 'rgba(139, 92, 246, 0.26)' },
  cyan: { line: '#67e8f9', top: 'rgba(103, 232, 249, 0.3)' },
};

const UP = '#34d399';
const DOWN = '#fb7185';

function ts(seconds: number): UTCTimestamp {
  return seconds as UTCTimestamp;
}

/**
 * The one chart: dark, brand-coloured areas or candles, crosshair, time
 * scale, nothing else. It sizes itself to its container and is torn down on
 * unmount. `onCrosshair` reports the value under the pointer (null when it
 * leaves) so the caller can show it in its own type.
 */
export function Chart({
  series,
  markers = [],
  height,
  intraday,
  label,
  onCrosshair,
}: {
  series: readonly ChartSeries[];
  markers?: readonly ChartMarker[];
  height: number;
  intraday: boolean;
  label: string;
  onCrosshair?: (point: { time: number; value: number } | null) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [lib, setLib] = useState<Lib | null>(null);
  const [failed, setFailed] = useState(false);
  const chart = useRef<IChartApi | null>(null);
  const apis = useRef(new Map<string, { kind: string; api: ISeriesApi<SeriesType>; marks?: ISeriesMarkersPluginApi<Time> }>());
  const crosshair = useRef(onCrosshair);
  crosshair.current = onCrosshair;

  useEffect(() => {
    let active = true;
    loadLib().then(
      (mod) => active && setLib(mod),
      () => active && setFailed(true),
    );
    return () => {
      active = false;
    };
  }, []);

  // Create once the library is here; remove on unmount.
  useEffect(() => {
    const el = host.current;
    if (!lib || !el) return;
    const created = lib.createChart(el, {
      autoSize: true,
      layout: {
        background: { type: lib.ColorType.Solid, color: 'transparent' },
        textColor: 'rgba(255, 255, 255, 0.46)',
        fontFamily: "'Inter', system-ui, sans-serif",
        fontSize: 11,
        attributionLogo: false,
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { color: 'rgba(255, 255, 255, 0.05)' },
      },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.18, bottom: 0.08 } },
      timeScale: { borderVisible: false, fixLeftEdge: true, fixRightEdge: true, lockVisibleTimeRangeOnResize: true },
      crosshair: {
        mode: lib.CrosshairMode.Magnet,
        vertLine: { color: 'rgba(255, 255, 255, 0.28)', width: 1, style: lib.LineStyle.Dashed, labelBackgroundColor: '#1c1c20' },
        horzLine: { color: 'rgba(255, 255, 255, 0.16)', width: 1, style: lib.LineStyle.Dashed, labelBackgroundColor: '#1c1c20' },
      },
      // Range pills choose the window; the page keeps the wheel and the swipe.
      handleScroll: false,
      handleScale: false,
    });
    chart.current = created;
    const map = apis.current;
    created.subscribeCrosshairMove((param) => {
      const report = crosshair.current;
      if (!report) return;
      if (param.time === undefined || !param.point) {
        report(null);
        return;
      }
      for (const { api } of map.values()) {
        const d = param.seriesData.get(api) as { value?: number; close?: number } | undefined;
        const value = d?.value ?? d?.close;
        if (typeof value === 'number') {
          report({ time: Number(param.time), value });
          return;
        }
      }
    });
    return () => {
      map.clear();
      chart.current = null;
      created.remove();
    };
  }, [lib]);

  useEffect(() => {
    chart.current?.applyOptions({ timeScale: { timeVisible: intraday, secondsVisible: false } });
  }, [intraday, lib]);

  // Sync series and markers with props.
  useEffect(() => {
    const c = chart.current;
    if (!lib || !c) return;
    const map = apis.current;
    const wanted = new Set(series.map((s) => `${s.id}:${s.kind}`));
    for (const [key, entry] of map) {
      if (!wanted.has(key)) {
        entry.marks?.detach();
        c.removeSeries(entry.api);
        map.delete(key);
      }
    }
    series.forEach((s, i) => {
      const key = `${s.id}:${s.kind}`;
      const lastOne = i === series.length - 1;
      let entry = map.get(key);
      if (!entry) {
        const api =
          s.kind === 'area'
            ? (c.addSeries(lib.AreaSeries, {
                lineColor: TONES[s.tone].line,
                topColor: TONES[s.tone].top,
                bottomColor: 'rgba(0, 0, 0, 0)',
                lineWidth: 2,
                lineType: lib.LineType.Simple,
                crosshairMarkerRadius: 4,
                crosshairMarkerBorderColor: '#000',
                crosshairMarkerBackgroundColor: TONES[s.tone].line,
                priceLineVisible: false,
                priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
              }) as ISeriesApi<SeriesType>)
            : (c.addSeries(lib.CandlestickSeries, {
                upColor: UP,
                downColor: DOWN,
                wickUpColor: UP,
                wickDownColor: DOWN,
                borderVisible: false,
                priceLineVisible: false,
                priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
              }) as ISeriesApi<SeriesType>);
        entry = { kind: s.kind, api };
        map.set(key, entry);
      }
      entry.api.applyOptions({ lastValueVisible: lastOne });
      if (s.kind === 'area') {
        entry.api.setData(s.points.map((p) => ({ time: ts(p.time), value: p.value })));
      } else {
        entry.api.setData(
          s.candles.map((k) => ({ time: ts(k.time), open: k.open, high: k.high, low: k.low, close: k.close })),
        );
      }
      const mine = markers
        .filter((m) => m.seriesId === s.id)
        .map((m) => ({
          time: ts(m.time),
          position: 'aboveBar' as const,
          shape: 'circle' as const,
          color: '#67e8f9',
          text: m.text,
          size: 0.6,
        }));
      if (mine.length) {
        if (entry.marks) entry.marks.setMarkers(mine);
        else entry.marks = lib.createSeriesMarkers(entry.api, mine) as ISeriesMarkersPluginApi<Time>;
      } else {
        entry.marks?.setMarkers([]);
      }
    });
    c.timeScale().fitContent();
  }, [lib, series, markers]);

  return (
    <div className="chart-host" style={{ height }} role="img" aria-label={label}>
      <div ref={host} className="chart-canvas" />
      {!lib && !failed && <span className="skel chart-loading" aria-hidden="true" />}
      {failed && <p className="chart-empty muted">The chart did not load.</p>}
    </div>
  );
}

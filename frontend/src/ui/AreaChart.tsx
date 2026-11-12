import { useId, useMemo, useState, type PointerEvent, type ReactNode } from 'react';
import { buildChart, nearestIndex, type ChartPoint } from '../compute/helpers';

const WIDTH = 640;

/**
 * A line over a faint area, x proportional to real time. Hovering or dragging
 * reads out the nearest real point; nothing is interpolated.
 */
export function AreaChart({
  title,
  caption,
  label,
  points,
  format,
  formatTime,
  height = 220,
  empty = 'Not enough data to draw yet.',
}: {
  title?: string;
  caption?: string;
  /** Accessible name when there is no visible title. */
  label?: string;
  points: readonly ChartPoint[];
  format: (value: number) => string;
  formatTime: (iso: string) => string;
  height?: number;
  empty?: ReactNode;
}) {
  const id = useId();
  const geometry = useMemo(
    () => buildChart(points, { width: WIDTH, height, padTop: 14, padBottom: 14 }),
    [points, height],
  );
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
  const name = title ?? label ?? 'Chart';

  return (
    <figure className="chart">
      {(title || shown) && (
        <figcaption className="chart-head">
          <div>
            {title && <h3>{title}</h3>}
            {caption && <p className="muted small">{caption}</p>}
          </div>
          {shown && geometry && (
            <p className="chart-read num">
              <b>{format(shown.value)}</b>
              <span className="muted small">{formatTime(shown.t)}</span>
            </p>
          )}
        </figcaption>
      )}

      {geometry && first && last ? (
        <>
          <svg
            viewBox={`0 0 ${WIDTH} ${height}`}
            role="img"
            aria-label={`${name}: ${format(first.value)} at ${formatTime(first.t)}, ${format(last.value)} at ${formatTime(last.t)}.`}
            onPointerMove={track}
            onPointerDown={track}
            onPointerLeave={() => setHover(null)}
          >
            <defs>
              <linearGradient id={id} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2={WIDTH} y2="0">
                <stop offset="0" stopColor="var(--brand-a)" />
                <stop offset="1" stopColor="var(--brand-b)" />
              </linearGradient>
            </defs>
            <path d={geometry.area} className="chart-area" />
            <path d={geometry.line} className="chart-line" stroke={`url(#${id})`} />
            {shown && hover !== null && (
              <>
                <line x1={shown.x} x2={shown.x} y1={0} y2={height} className="chart-cross" />
                <circle cx={shown.x} cy={shown.y} r={4} className="chart-dot" />
              </>
            )}
          </svg>
          <p className="chart-foot muted small num">
            <span>{formatTime(first.t)}</span>
            <span>{formatTime(last.t)}</span>
          </p>
        </>
      ) : (
        <p className="chart-empty muted">{empty}</p>
      )}
    </figure>
  );
}

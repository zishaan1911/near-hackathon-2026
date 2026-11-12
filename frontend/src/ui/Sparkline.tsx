import { useId, useMemo } from 'react';
import { motion } from 'motion/react';
import { buildChart } from '../compute/helpers';
import type { LinePoint } from '../compute/series';

const W = 160;
const H = 44;

/** A small line of real points, drawn in once. Nothing when there are fewer than two. */
export function Sparkline({ points, label }: { points: readonly LinePoint[]; label: string }) {
  const id = useId();
  const geometry = useMemo(
    () =>
      buildChart(
        points.map((p) => ({ t: new Date(p.time * 1000).toISOString(), value: p.value })),
        { width: W, height: H, padTop: 4, padBottom: 4 },
      ),
    [points],
  );
  if (!geometry) return null;
  const last = geometry.coords[geometry.coords.length - 1];
  return (
    <svg className="spark" viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={label}>
      <defs>
        <linearGradient id={`${id}l`} x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stopColor="#8b5cf6" />
          <stop offset="1" stopColor="#67e8f9" />
        </linearGradient>
        <linearGradient id={`${id}a`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#67e8f9" stopOpacity="0.22" />
          <stop offset="1" stopColor="#67e8f9" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={geometry.area} fill={`url(#${id}a)`} />
      <motion.path
        d={geometry.line}
        fill="none"
        stroke={`url(#${id}l)`}
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 1.2, ease: [0.2, 0, 0, 1] }}
      />
      {last && <circle cx={last.x} cy={last.y} r={2.5} className="spark-dot" />}
    </svg>
  );
}

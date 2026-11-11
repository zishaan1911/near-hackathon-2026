import { useEffect } from 'react';
import { motion, useReducedMotion, useScroll, useSpring, useTransform } from 'motion/react';
import type { ComputeIndexResponse } from '../lib/api';
import { HERO_IMAGE } from './content';
import { formatAsOf, formatChange, formatLevel, splitLevel } from './helpers';
import { SPRING_COUNT } from './motion';

/**
 * The live level. The spring lives as long as this component, so each poll
 * re-targets from the number currently on screen. The first load counts from
 * the index base, which is the only meaningful starting point.
 */
function LevelCounter({ level, base }: { level: number | null; base: number }) {
  const reduced = useReducedMotion();
  const count = useSpring(reduced && level !== null ? level : base, SPRING_COUNT);
  const whole = useTransform(count, (v) => splitLevel(v).whole);
  const fraction = useTransform(count, (v) => `.${splitLevel(v).fraction}`);

  useEffect(() => {
    if (level === null) return;
    if (reduced) count.jump(level);
    else count.set(level);
  }, [count, level, reduced]);

  if (level === null) {
    return <p className="cx-level cx-level-na">n/a</p>;
  }
  return (
    <p className="cx-level">
      <span className="cx-sr">{formatLevel(level)}</span>
      <span aria-hidden="true">
        <motion.span>{whole}</motion.span>
        <motion.span className="cx-level-fraction">{fraction}</motion.span>
      </span>
    </p>
  );
}

export function Hero({
  data,
  loading,
  error,
  onRetry,
}: {
  data: ComputeIndexResponse | null;
  loading: boolean;
  error: string;
  onRetry: () => void;
}) {
  const reduced = useReducedMotion();
  const { scrollY } = useScroll();
  const photoY = useTransform(scrollY, (v) => (reduced ? 0 : v * 0.22));
  const fade = useTransform(scrollY, [120, 620], [1, reduced ? 1 : 0]);

  const index = data?.index;
  const level = typeof index?.level === 'number' && Number.isFinite(index.level) ? index.level : null;
  const base = typeof index?.base === 'number' ? index.base : 1000;
  const change = formatChange(level, base);
  const downCount = data?.components.filter((c) => c.status === 'down').length ?? 0;
  const totalCount = data?.components.length ?? 0;
  const pulse = !index ? 'off' : index.degraded || error ? 'warn' : 'live';

  return (
    <section className="cx-hero" aria-labelledby="cx-hero-title">
      <motion.img
        className="cx-hero-photo"
        src={HERO_IMAGE.src}
        width={HERO_IMAGE.width}
        height={HERO_IMAGE.height}
        alt={HERO_IMAGE.alt}
        fetchPriority="high"
        style={{ y: photoY }}
      />
      <div className="cx-hero-scrim" />

      <motion.div className="cx-wrap cx-hero-body" style={{ opacity: fade }}>
        <p className="cx-hero-eyebrow">
          <span className={`cx-pulse cx-pulse-${pulse}`} aria-hidden="true" />
          <span id="cx-hero-title">Congest Compute Index</span>
          {index?.degraded && (
            <span className="cx-badge">
              Degraded
              {downCount > 0 && <>: {downCount} of {totalCount} pillars down</>}
            </span>
          )}
        </p>

        {index ? (
          <LevelCounter level={level} base={base} />
        ) : loading ? (
          <div className="cx-skel cx-skel-level" role="status" aria-label="Loading the index" />
        ) : (
          <div className="cx-error cx-hero-error" role="alert">
            <h2>The index didn't load.</h2>
            <p>{error || 'The server did not respond.'}</p>
            <button type="button" className="cx-btn" onClick={onRetry}>Retry</button>
          </div>
        )}

        <p className="cx-hero-line">The price of compute, in one number.</p>

        {index && (
          <dl className="cx-hero-meta">
            <div>
              <dt>Change vs base</dt>
              <dd className={change.direction ? `cx-${change.direction}` : undefined}>
                {change.direction === 'up' && <span aria-hidden="true">▲ </span>}
                {change.direction === 'down' && <span aria-hidden="true">▼ </span>}
                {change.text}
              </dd>
            </div>
            <div>
              <dt>Base</dt>
              <dd>{formatLevel(base, 0)}{index.baseDate ? ` on ${index.baseDate}` : ''}</dd>
            </div>
            <div>
              <dt>As of</dt>
              <dd><time dateTime={index.asOf}>{formatAsOf(index.asOf)}</time></dd>
            </div>
          </dl>
        )}
      </motion.div>
    </section>
  );
}

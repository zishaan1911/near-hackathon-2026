import { useEffect } from 'react';
import { motion, useReducedMotion, useSpring, useTransform } from 'motion/react';
import { formatLevel } from '../compute/helpers';
import { SPRING_COUNT } from './motion';

/**
 * A number that springs to each new value from the one on screen. The spring
 * lives as long as the component, so a poll re-targets it mid-flight. The
 * first value counts from `from`, never from zero.
 */
export function Counter({
  value,
  from,
  digits = 2,
  splitFraction = false,
}: {
  value: number;
  from?: number;
  digits?: number;
  /** Renders the decimals in their own span so they can be set smaller. */
  splitFraction?: boolean;
}) {
  const reduced = useReducedMotion();
  const count = useSpring(reduced ? value : (from ?? value), SPRING_COUNT);
  const whole = useTransform(count, (v) =>
    splitFraction ? (formatLevel(v, digits).split('.')[0] ?? '') : formatLevel(v, digits),
  );
  const fraction = useTransform(count, (v) => `.${formatLevel(v, digits).split('.')[1] ?? ''}`);

  useEffect(() => {
    if (reduced) count.jump(value);
    else count.set(value);
  }, [count, value, reduced]);

  return (
    <>
      <span className="sr-only">{formatLevel(value, digits)}</span>
      <span aria-hidden="true">
        <motion.span>{whole}</motion.span>
        {splitFraction && digits > 0 && <motion.span className="fraction">{fraction}</motion.span>}
      </span>
    </>
  );
}

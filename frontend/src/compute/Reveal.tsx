import type { ReactNode } from 'react';
import { motion } from 'motion/react';
import { SPRING_REVEAL } from './motion';

/** Fades and lifts content in once, the first time it scrolls into view. */
export function Reveal({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 28 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.1 }}
      transition={SPRING_REVEAL}
    >
      {children}
    </motion.div>
  );
}

export function SectionHead({
  eyebrow,
  title,
  lede,
}: {
  eyebrow: string;
  title: string;
  lede?: string;
}) {
  return (
    <Reveal className="cx-head">
      <p className="cx-eyebrow">{eyebrow}</p>
      <h2 className="cx-h2">{title}</h2>
      {lede && <p className="cx-lede">{lede}</p>}
    </Reveal>
  );
}

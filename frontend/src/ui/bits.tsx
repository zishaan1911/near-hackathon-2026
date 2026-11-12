import { useId, useState, type ReactNode } from 'react';
import { motion } from 'motion/react';
import { SPRING_REVEAL } from './motion';

/** Fades and lifts content in once, the first time it scrolls into view. */
export function Reveal({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.1 }}
      transition={SPRING_REVEAL}
    >
      {children}
    </motion.div>
  );
}

export function Skeleton({ className = '', label }: { className?: string; label?: string }) {
  return label ? (
    <span className={`skel ${className}`} role="status" aria-label={label} />
  ) : (
    <span className={`skel ${className}`} aria-hidden="true" />
  );
}

/** One line of error with a way out. */
export function ErrorLine({ text, onRetry }: { text: string; onRetry?: () => void }) {
  return (
    <p className="error-line" role="alert">
      <span>{text}</span>
      {onRetry && (
        <button type="button" className="link" onClick={onRetry}>
          Retry
        </button>
      )}
    </p>
  );
}

/**
 * A small "?" that discloses one short explanation. Returned as two parts so
 * the button can sit beside a label while the text opens below the row.
 */
export function useHint(label: string, children: ReactNode) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return {
    button: (
      <button
        type="button"
        className="hint-button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
      >
        ?
      </button>
    ),
    panel: open ? (
      <p id={id} className="hint-panel">
        {children}
      </p>
    ) : null,
  };
}

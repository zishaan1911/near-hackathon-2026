/**
 * Light as decoration: soft ribbons of violet and cyan with thin glowing
 * streaks across them. CSS only; drifts slowly and stops for reduced motion.
 */
export function Glow({ variant = 'hero' }: { variant?: 'hero' | 'band' | 'soft' }) {
  return (
    <div className={`glow glow-${variant}`} aria-hidden="true">
      <span className="ribbon ribbon-a" />
      <span className="ribbon ribbon-b" />
      <span className="ribbon ribbon-c" />
      <span className="streak streak-1" />
      <span className="streak streak-2" />
      <span className="streak streak-3" />
      <span className="streak streak-4" />
      <span className="streak streak-5" />
    </div>
  );
}

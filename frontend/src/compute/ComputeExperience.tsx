import { useEffect } from 'react';
import { MotionConfig, motion, useReducedMotion, useScroll, useTransform } from 'motion/react';
import './compute.css';
import { BREAK_AISLE, BREAK_DGX, type ImageSpec } from './content';
import { GpuBoard } from './GpuBoard';
import { formatLevel } from './helpers';
import { Hero } from './Hero';
import { History } from './History';
import { Credits, Method } from './Method';
import { People } from './People';
import { Pillars } from './Pillars';
import { Reveal } from './Reveal';
import { useComputeIndex } from './useComputeIndex';

const NAV = [
  { href: '#pillars', label: 'Pillars' },
  { href: '#gpus', label: 'GPUs' },
  { href: '#history', label: 'History' },
  { href: '#people', label: 'People' },
  { href: '#method', label: 'Method' },
];

function TopBar({ level }: { level: number | null | undefined }) {
  const { scrollY } = useScroll();
  // The level moves into the bar as the big number leaves the screen.
  const readout = useTransform(scrollY, [420, 620], [0, 1]);
  return (
    <header className="cx-bar">
      <div className="cx-bar-inner">
        <a className="cx-bar-brand" href="/" aria-label="Back to Congest">
          <img src="/logo.png" width={28} height={28} alt="" />
          <span>Congest</span>
        </a>
        <nav aria-label="Sections">
          {NAV.map((n) => <a key={n.href} href={n.href}>{n.label}</a>)}
        </nav>
        <motion.p className="cx-bar-level" style={{ opacity: readout }}>
          <span>CCI</span> <b>{formatLevel(level)}</b>
        </motion.p>
      </div>
    </header>
  );
}

function ImageBreak({ image, line, position }: { image: ImageSpec; line: string; position: string }) {
  return (
    <section className="cx-break">
      <img
        src={image.src}
        width={image.width}
        height={image.height}
        alt={image.alt}
        loading="lazy"
        style={{ objectPosition: position }}
      />
      <div className="cx-break-scrim" />
      <Reveal className="cx-wrap cx-break-body">
        <p>{line}</p>
      </Reveal>
    </section>
  );
}

export default function ComputeExperience() {
  const { data, loading, error, retry } = useComputeIndex();
  const reduced = useReducedMotion();
  const pending = loading && !data;

  // The page is always dark and has its own title, whatever the app's theme is.
  useEffect(() => {
    const root = document.documentElement;
    const previous = {
      title: document.title,
      body: document.body.style.background,
      root: root.style.background,
    };
    document.title = 'Congest Compute Index';
    document.body.style.background = '#050507';
    root.style.background = '#050507';
    return () => {
      document.title = previous.title;
      document.body.style.background = previous.body;
      root.style.background = previous.root;
    };
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    const previous = root.style.scrollBehavior;
    if (reduced) root.style.scrollBehavior = 'auto';
    return () => {
      root.style.scrollBehavior = previous;
    };
  }, [reduced]);

  return (
    <MotionConfig reducedMotion="user">
      <div className="cx">
        <TopBar level={data?.index.level} />

        {error && data && (
          <div className="cx-stale" role="status">
            <span>Couldn't refresh. Showing the last good data.</span>
            <button type="button" className="cx-btn cx-btn-small" onClick={retry}>Retry</button>
          </div>
        )}

        <main>
          <Hero data={data} loading={loading} error={error} onRetry={retry} />
          {(data || pending) && (
            <>
              <Pillars components={data?.components ?? []} loading={pending} />
              <GpuBoard gpus={data?.gpus ?? []} asOf={data?.index.asOf} loading={pending} />
            </>
          )}
          <ImageBreak image={BREAK_DGX} line="The hardware is identical. The market is not." position="50% 50%" />
          <History />
          <ImageBreak image={BREAK_AISLE} line="Behind every price on this page is a room like this one." position="60% 55%" />
          <People />
          <Method baseDate={data?.index.baseDate} version={data?.index.methodologyVersion} />
          <Credits />
        </main>
      </div>
    </MotionConfig>
  );
}

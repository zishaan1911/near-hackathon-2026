import { motion } from 'motion/react';
import type { ComputeIndexComponent } from '../lib/api';
import { PILLARS, type PillarSpec } from './content';
import { formatCoverage, formatLevel, formatPrice, formatUnit, formatWeight, weightSegments } from './helpers';
import { CARD_VARIANTS, PHOTO_VARIANTS, SPRING_REVEAL } from './motion';
import { Reveal, SectionHead } from './Reveal';

function Stat({ label, value, loading }: { label: string; value: string; loading: boolean }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{loading ? <span className="cx-skel cx-skel-text" /> : value}</dd>
    </div>
  );
}

function PillarCard({
  spec,
  component,
  loading,
}: {
  spec: PillarSpec;
  component: ComputeIndexComponent | undefined;
  loading: boolean;
}) {
  const down = component?.status === 'down';
  const unit = component?.unit ?? '';
  return (
    <motion.article
      className={`cx-pillar cx-span-${spec.span}`}
      variants={CARD_VARIANTS}
      initial="rest"
      animate="rest"
      whileHover="hover"
      whileTap="press"
      tabIndex={-1}
    >
      <div className="cx-pillar-photo">
        <motion.img
          variants={PHOTO_VARIANTS}
          src={spec.image.src}
          width={spec.image.width}
          height={spec.image.height}
          alt={spec.image.alt}
          loading="lazy"
          style={{ objectPosition: spec.objectPosition }}
        />
      </div>
      <div className="cx-pillar-caption">
        <div className="cx-pillar-title">
          <h3>{component?.label ?? spec.label}</h3>
          {down && (
            <span className="cx-badge" title={component?.error}>Source down</span>
          )}
        </div>
        <p className="cx-pillar-price">
          {loading ? (
            <span className="cx-skel cx-skel-price" />
          ) : (
            <>
              <b>{formatPrice(unit, component?.value)}</b>
              {unit && <span>{formatUnit(unit)}</span>}
            </>
          )}
        </p>
        <dl className="cx-pillar-stats">
          <Stat label="Sub-index" value={formatLevel(component?.level, 1)} loading={loading} />
          <Stat label="Weight" value={formatWeight(component?.effectiveWeight)} loading={loading} />
          <Stat label="Coverage" value={formatCoverage(component?.quotes)} loading={loading} />
        </dl>
      </div>
    </motion.article>
  );
}

function WeightBar({ components }: { components: ComputeIndexComponent[] }) {
  const ordered = PILLARS.flatMap((p) => components.filter((c) => c.id === p.id));
  const segments = weightSegments(ordered);
  if (segments.length === 0) return null;
  return (
    <Reveal className="cx-weights">
      <div className="cx-weights-head">
        <h3>How the six pillars make up 100%</h3>
      </div>
      <motion.div
        className="cx-weights-bar"
        role="img"
        aria-label={segments.map((s) => `${s.label} ${s.pct.toFixed(1)}%`).join(', ')}
        initial={{ scaleX: 0 }}
        whileInView={{ scaleX: 1 }}
        viewport={{ once: true, amount: 0.5 }}
        transition={SPRING_REVEAL}
      >
        {segments.map((s, i) =>
          s.pct > 0 ? (
            <span key={s.id} className={`cx-seg cx-seg-${i}`} style={{ flexGrow: s.pct }} />
          ) : null,
        )}
      </motion.div>
      <ul className="cx-weights-legend">
        {segments.map((s, i) => (
          <li key={s.id} className={s.down ? 'cx-is-down' : undefined}>
            <i className={`cx-seg-${i}`} aria-hidden="true" />
            <span>{s.label}</span>
            <b>{s.down ? 'Down' : `${s.pct.toFixed(s.pct % 1 ? 1 : 0)}%`}</b>
          </li>
        ))}
      </ul>
    </Reveal>
  );
}

export function Pillars({
  components,
  loading,
}: {
  components: ComputeIndexComponent[];
  loading: boolean;
}) {
  return (
    <section id="pillars" className="cx-section">
      <div className="cx-wrap">
        <SectionHead
          eyebrow="Six pillars"
          title="What compute costs, wherever you buy it."
          lede="Rented GPUs, cloud spot capacity, AI tokens, Bitcoin hash and Ethereum blockspace, each tracked against its own base price."
        />
        <div className="cx-pillars">
          {PILLARS.map((spec) => (
            <PillarCard
              key={spec.id}
              spec={spec}
              component={components.find((c) => c.id === spec.id)}
              loading={loading}
            />
          ))}
        </div>
        <WeightBar components={components} />
      </div>
    </section>
  );
}

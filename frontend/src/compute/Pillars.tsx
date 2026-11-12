import type { ComputeIndexComponent } from '../lib/api';
import { Skeleton } from '../ui/bits';
import { PILLARS } from './content';
import { formatChange, formatLevel, formatPrice, formatUnit, formatWeight } from './helpers';

/** Every pillar's level is 1,000 on the base date. */
const PILLAR_BASE = 1000;

function find(components: readonly ComputeIndexComponent[], id: string) {
  return components.find((c) => c.id === id);
}

/** The six pillars as photo cards: name, level, weight, and on request the live price. */
export function PillarCards({
  components,
  loading,
  detail = false,
}: {
  components: readonly ComputeIndexComponent[];
  loading: boolean;
  detail?: boolean;
}) {
  return (
    <ul className="pcards">
      {PILLARS.map((spec) => {
        const c = find(components, spec.id);
        const down = c?.status === 'down';
        const change = formatChange(c?.level, PILLAR_BASE);
        const unit = c?.unit ?? '';
        return (
          <li key={spec.id} className="pcard">
            <img
              className="pcard-img"
              src={spec.image.src}
              width={spec.image.width}
              height={spec.image.height}
              alt={spec.image.alt}
              loading="lazy"
              style={{ objectPosition: spec.objectPosition }}
            />
            <div className="pcard-body">
              <p className="pcard-chip small num">
                {down ? 'Source down' : c ? `${formatWeight(c.effectiveWeight)} weight` : ' '}
              </p>
              <div className="pcard-foot">
                <h3>{spec.label}</h3>
                <p className="pcard-level num">
                  {loading && !c ? <Skeleton className="skel-text" /> : formatLevel(c?.level, 1)}
                  {change.direction && !down && (
                    <span className={`pcard-change ${change.direction}`}>{change.text}</span>
                  )}
                </p>
                {detail && c && !down && (
                  <p className="muted small num">
                    {formatPrice(unit, c.value)} {unit && formatUnit(unit)}
                  </p>
                )}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** A thin strip that drifts the six pillar levels past, with their move since base. */
export function PillarTicker({ components }: { components: readonly ComputeIndexComponent[] }) {
  const items = PILLARS.map((spec) => {
    const c = find(components, spec.id);
    const change = formatChange(c?.level, PILLAR_BASE);
    return { id: spec.id, label: spec.label, level: c?.level, down: c?.status === 'down', change };
  });
  return (
    <div className="ticker" aria-label="Pillar levels">
      <div className="ticker-track">
        {[0, 1].map((copy) => (
          <ul key={copy} className="ticker-list" aria-hidden={copy === 1 ? true : undefined}>
            {items.map((item) => (
              <li key={item.id}>
                <span className="ticker-name">{item.label}</span>
                <span className="num">{formatLevel(item.level, 1)}</span>
                {item.down ? (
                  <span className="muted">down</span>
                ) : item.change.direction ? (
                  <span className={`num ticker-move ${item.change.direction}`}>
                    <i aria-hidden="true">{item.change.direction === 'up' ? '▲' : item.change.direction === 'down' ? '▼' : '•'}</i>
                    {item.change.text}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        ))}
      </div>
    </div>
  );
}

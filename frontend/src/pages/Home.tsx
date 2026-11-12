import { creditFor, HERO_IMAGE, PILLARS } from '../compute/content';
import { formatChange, formatLevel, formatWeight } from '../compute/helpers';
import { useComputeIndex } from '../compute/useComputeIndex';
import { PATHS } from '../lib/routes';
import { ErrorLine, Reveal, Skeleton } from '../ui/bits';
import { Counter } from '../ui/Counter';
import { Link } from '../ui/router';

const STEPS = [
  { title: 'Connect', text: 'Use any NEAR testnet wallet.' },
  { title: 'Deposit', text: 'Get free test tUSDC and deposit it.' },
  { title: 'Go long or short', text: 'Each contract moves 1 tUSDC per index point.' },
];

export default function Home() {
  const { data, loading, error, retry } = useComputeIndex();
  const index = data?.index;
  const level = typeof index?.level === 'number' && Number.isFinite(index.level) ? index.level : null;
  const base = typeof index?.base === 'number' ? index.base : 1000;
  const change = formatChange(level, base);
  const credit = creditFor(HERO_IMAGE.slug);

  return (
    <>
      <section className="wrap hero">
        <h1 className="display">Trade the price of compute.</h1>
        <p className="lede">
          One index of what compute costs, and an hourly future on it that anyone can go long or short.
        </p>
        <p className="actions">
          <Link to={PATHS.trade} className="btn btn-lg">
            Start trading
          </Link>
          <Link to={PATHS.index} className="link">
            See what's inside
          </Link>
        </p>

        <div className="hero-index">
          <p className="live-label">
            <span className={level !== null ? 'dot dot-live' : 'dot'} aria-hidden="true" />
            Silica Compute Index
          </p>
          {level !== null ? (
            <>
              <p className="hero-number num">
                <Counter value={level} from={base} splitFraction />
              </p>
              <p className="muted num">
                {change.text} vs base {formatLevel(base, 0)}
              </p>
            </>
          ) : loading ? (
            <Skeleton className="skel-hero" label="Loading the index" />
          ) : (
            <ErrorLine text={error || 'The index is not available right now.'} onRetry={retry} />
          )}
        </div>
      </section>

      <section className="wrap section">
        <Reveal>
          <h2 className="title">Six prices. One number.</h2>
          <ul className="pillar-grid">
            {PILLARS.map((spec) => {
              const c = data?.components.find((item) => item.id === spec.id);
              const weight = c && c.status !== 'down' ? c.effectiveWeight : 0;
              return (
                <li key={spec.id} className="pillar-cell">
                  <p className="pillar-name">{spec.label}</p>
                  <p className="pillar-level num">
                    {loading && !c ? <Skeleton className="skel-text" /> : formatLevel(c?.level, 1)}
                  </p>
                  <div className="bar" aria-hidden="true">
                    <span style={{ transform: `scaleX(${Math.min(1, Math.max(0, weight))})` }} />
                  </div>
                  <p className="muted small num">
                    {c?.status === 'down'
                      ? 'Source down'
                      : c
                        ? `${formatWeight(c.effectiveWeight)} of the index` : ' '}
                  </p>
                </li>
              );
            })}
          </ul>
        </Reveal>
      </section>

      <section className="wrap section">
        <Reveal>
          <h2 className="title">How it works</h2>
          <ol className="steps">
            {STEPS.map((step, i) => (
              <li key={step.title}>
                <span className="step-n num" aria-hidden="true">
                  {i + 1}
                </span>
                <h3>{step.title}</h3>
                <p className="muted">{step.text}</p>
              </li>
            ))}
          </ol>
        </Reveal>
      </section>

      <section className="wrap section">
        <Reveal>
          <figure className="band">
            <img
              src={HERO_IMAGE.src}
              width={HERO_IMAGE.width}
              height={HERO_IMAGE.height}
              alt={HERO_IMAGE.alt}
              loading="lazy"
            />
            <figcaption className="muted small">
              Frontier, one of the fastest computers ever built.
              {credit && (
                <>
                  {' '}
                  Photo:{' '}
                  <a href={credit.sourceUrl} target="_blank" rel="noreferrer">
                    {credit.author}
                  </a>
                  , {credit.license}.
                </>
              )}
            </figcaption>
          </figure>
        </Reveal>
      </section>
    </>
  );
}

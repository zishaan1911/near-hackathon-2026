import { useMemo } from 'react';
import { creditFor, HERO_IMAGE } from '../compute/content';
import { formatChange, formatLevel } from '../compute/helpers';
import { IndexChart, useIndexHistory } from '../compute/IndexHistory';
import { PillarCards, PillarTicker } from '../compute/Pillars';
import { changeOver, filterRange, latestTime } from '../compute/series';
import { useComputeIndex } from '../compute/useComputeIndex';
import { PATHS } from '../lib/routes';
import { ErrorLine, Reveal, Skeleton } from '../ui/bits';
import { Counter } from '../ui/Counter';
import { Glow } from '../ui/Glow';
import { Link } from '../ui/router';
import { Sparkline } from '../ui/Sparkline';

const STEPS = [
  { title: 'Connect', text: 'Any NEAR testnet wallet.' },
  { title: 'Deposit', text: 'Free test tUSDC, one click.' },
  { title: 'Go long or short', text: '1 tUSDC per index point, settled hourly.' },
];

function Stat({ value, label, tone }: { value: string; label: string; tone?: string | null }) {
  return (
    <div className="stat">
      <dt className="stat-label">{label}</dt>
      <dd className={`stat-value num ${tone ?? ''}`}>{value}</dd>
    </div>
  );
}

export default function Home() {
  const { data, loading, error, retry } = useComputeIndex();
  const index = data?.index;
  const level = typeof index?.level === 'number' && Number.isFinite(index.level) ? index.level : null;
  const base = typeof index?.base === 'number' ? index.base : 1000;
  const sinceBase = formatChange(level, base);
  const credit = creditFor(HERO_IMAGE.slug);
  const components = data?.components ?? [];

  const history = useIndexHistory(level !== null ? { level, asOf: index?.asOf } : null);
  const series = history.series;

  const { spark, day } = useMemo(() => {
    if (!series) return { spark: [], day: null };
    const all = [...series.reconstructed, ...series.measured];
    const anchor = latestTime(all);
    let pts = filterRange(all, '1W', anchor);
    if (pts.length < 2) pts = filterRange(all, '1M', anchor);
    return { spark: pts, day: changeOver(all, 86_400, level, anchor ?? 0) };
  }, [series, level]);

  const quotes = components.reduce(
    (sum, c) => (c.quotes && Number.isFinite(c.quotes.ok) ? (sum ?? 0) + c.quotes.ok : sum),
    null as number | null,
  );
  const settled = history.history.data ? history.history.data.settlements.length : null;
  const dayText = day !== null ? `${day > 0 ? '+' : ''}${day.toFixed(2)}%` : sinceBase.text;
  const dayTone = day !== null ? (day > 0 ? 'up' : day < 0 ? 'down' : null) : sinceBase.direction;

  return (
    <>
      <section className="hero">
        <Glow variant="hero" />
        <div className="wrap hero-inner">
          <div className="hero-copy">
            <h1 className="display">
              <span>Trade the price</span> <span className="lo">of compute.</span>
            </h1>
            <p className="lede">One index of what compute costs, and an hourly future on it anyone can go long or short.</p>
            <p className="actions">
              <Link to={PATHS.trade} className="btn btn-lg">
                Start trading
              </Link>
              <Link to={PATHS.index} className="btn btn-lg btn-outline">
                See what's inside
              </Link>
            </p>
          </div>

          <div className="hero-stat">
            <p className="live-label">
              <span className={level !== null ? 'dot dot-live' : 'dot'} aria-hidden="true" />
              Silica Compute Index
            </p>
            {level !== null ? (
              <>
                <div className="hero-stat-row">
                  <p className="hero-number num">
                    <Counter value={level} from={base} splitFraction />
                  </p>
                  <Sparkline points={spark} label="The index over the last week" />
                </div>
                <p className="muted num">
                  <span className={sinceBase.direction ?? ''}>{sinceBase.text}</span> since base{' '}
                  {formatLevel(base, 0)}
                </p>
              </>
            ) : loading ? (
              <Skeleton className="skel-hero" label="Loading the index" />
            ) : (
              <ErrorLine text={error || 'The index is not available right now.'} onRetry={retry} />
            )}
          </div>
        </div>
      </section>

      <PillarTicker components={components} />

      <section className="wrap">
        <dl className="stats">
          <Stat value={formatLevel(level)} label="Index level" />
          <Stat value={dayText} label={day !== null ? '24h change' : 'Since base'} tone={dayTone} />
          <Stat value={settled === null ? 'n/a' : settled.toLocaleString('en-US')} label="Markets settled on-chain" />
          <Stat value={quotes === null ? 'n/a' : quotes.toLocaleString('en-US')} label="Live price quotes" />
        </dl>
      </section>

      <section className="wrap section">
        <Reveal>
          <div className="section-head">
            <h2 className="title">
              <span>Six prices.</span> <span className="lo">One number.</span>
            </h2>
            <Link to={PATHS.index} className="btn btn-outline btn-sm">
              View all
            </Link>
          </div>
          <PillarCards components={components} loading={loading} />
        </Reveal>
      </section>

      <section className="wrap section">
        <Reveal>
          <div className="section-head">
            <h2 className="title">
              <span>The index,</span> <span className="lo">over time.</span>
            </h2>
            <Link to={PATHS.index} className="btn btn-outline btn-sm">
              Methodology
            </Link>
          </div>
          <IndexChart data={history} />
        </Reveal>
      </section>

      <section className="wrap section">
        <Reveal>
          <div className="section-head">
            <h2 className="title">
              <span>Three steps</span> <span className="lo">to a first trade.</span>
            </h2>
          </div>
          <ol className="steps">
            {STEPS.map((step, i) => (
              <li key={step.title} className="card step">
                <span className="step-n num" aria-hidden="true">
                  0{i + 1}
                </span>
                <h3>{step.title}</h3>
                <p className="muted">{step.text}</p>
              </li>
            ))}
          </ol>
        </Reveal>
      </section>

      <section className="closing-band">
        <img
          className="closing-img"
          src={HERO_IMAGE.src}
          width={HERO_IMAGE.width}
          height={HERO_IMAGE.height}
          alt=""
          loading="lazy"
        />
        <Glow variant="band" />
        <div className="wrap closing-inner">
          <h2 className="title">
            <span>Take a view</span> <span className="lo">on compute.</span>
          </h2>
          <p className="actions">
            <Link to={PATHS.trade} className="btn btn-lg">
              Start trading
            </Link>
          </p>
          {credit && (
            <p className="closing-credit small">
              Frontier supercomputer. Photo:{' '}
              <a href={credit.sourceUrl} target="_blank" rel="noreferrer">
                {credit.author}
              </a>
              , {credit.license}.
            </p>
          )}
        </div>
      </section>
    </>
  );
}

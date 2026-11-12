import { useEffect, useMemo, useRef } from 'react';
import {
  getComputeHistory,
  type ComputeGpu,
  type ComputeIndexComponent,
} from '../lib/api';
import {
  IMAGE_CREDITS,
  PEOPLE,
  PEOPLE_DISCLAIMER,
  PILLARS,
  SOURCES,
} from '../compute/content';
import {
  formatAsOf,
  formatChange,
  formatDay,
  formatLevel,
  formatPrice,
  formatSpread,
  formatUnit,
  formatWeight,
  gpuVenueColumns,
  isCheapestVenue,
  venueName,
} from '../compute/helpers';
import { useComputeIndex } from '../compute/useComputeIndex';
import { PATHS } from '../lib/routes';
import { usePolled } from '../lib/usePolled';
import { AreaChart } from '../ui/AreaChart';
import { ErrorLine, Reveal, Skeleton } from '../ui/bits';
import { Counter } from '../ui/Counter';
import { Link, useHash } from '../ui/router';

const GPU_UNIT = '$/GPU-hour';
const HASH_UNIT = '$/TH/day';
const GAS_UNIT = '$/1M gas';

function Pillars({ components, loading }: { components: ComputeIndexComponent[]; loading: boolean }) {
  return (
    <ul className="pillar-list">
      {PILLARS.map((spec) => {
        const c = components.find((item) => item.id === spec.id);
        const unit = c?.unit ?? '';
        return (
          <li key={spec.id} className="pillar-row">
            <img
              src={spec.image.src}
              width={spec.image.width}
              height={spec.image.height}
              alt={spec.image.alt}
              loading="lazy"
              style={{ objectPosition: spec.objectPosition }}
            />
            <div className="pillar-text">
              <h3>{spec.label}</h3>
              {loading && !c ? (
                <Skeleton className="skel-text" />
              ) : c?.status === 'down' ? (
                <p className="muted small">Source down</p>
              ) : (
                <p className="muted small num">
                  {formatPrice(unit, c?.value)} {unit && formatUnit(unit)}
                </p>
              )}
            </div>
            <div className="pillar-nums num">
              <b>{formatLevel(c?.level, 1)}</b>
              <span className="muted small">{formatWeight(c?.effectiveWeight)}</span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function GpuBoard({ gpus, loading }: { gpus: ComputeGpu[]; loading: boolean }) {
  const columns = gpuVenueColumns(gpus);
  if (loading && gpus.length === 0) return <Skeleton className="skel-block" label="Loading GPU prices" />;
  if (gpus.length === 0) return <p className="muted">GPU prices are not available right now.</p>;
  return (
    <div className="table-scroll" role="region" aria-label="GPU prices by venue" tabIndex={0}>
      <table className="table num">
        <thead>
          <tr>
            <th scope="col">Chip</th>
            {columns.map((v) => (
              <th scope="col" key={v}>
                {venueName(v)}
              </th>
            ))}
            <th scope="col">Median</th>
            <th scope="col">Spread</th>
          </tr>
        </thead>
        <tbody>
          {gpus.map((gpu) => (
            <tr key={gpu.id}>
              <th scope="row">{gpu.label}</th>
              {columns.map((venue) => {
                const price = gpu.venues?.find((v) => v.venue === venue)?.price ?? null;
                const cheapest = price !== null && isCheapestVenue(gpu, venue);
                return (
                  <td key={venue} className={price === null ? 'muted' : undefined}>
                    {cheapest ? (
                      <b title="Lowest price">
                        {formatPrice(GPU_UNIT, price)}
                        <span className="tag">Low</span>
                      </b>
                    ) : (
                      formatPrice(GPU_UNIT, price)
                    )}
                  </td>
                );
              })}
              <td>{formatPrice(GPU_UNIT, gpu.medianPrice)}</td>
              <td>{formatSpread(gpu.spreadPct)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function History() {
  const { data, error, reload } = usePolled(() => getComputeHistory(30), 10 * 60_000);
  const levels = useMemo(
    () => (data?.points ?? []).map((p) => ({ t: p.t, value: p.level })),
    [data],
  );

  if (!data) {
    return error ? (
      <ErrorLine text="History did not load." onRetry={() => void reload()} />
    ) : (
      <div className="chart-grid">
        <Skeleton className="skel-block" label="Loading history" />
        <Skeleton className="skel-block" />
      </div>
    );
  }

  return (
    <>
      {data.persisted && levels.length >= 2 && (
        <AreaChart
          title="Silica Compute Index"
          caption="Recorded index levels."
          points={levels}
          format={(v) => formatLevel(v)}
          formatTime={formatDay}
          height={170}
        />
      )}
      <div className="chart-grid">
        <AreaChart
          title="Bitcoin hashprice"
          caption={`USD ${formatUnit(HASH_UNIT)}, from blockchain.info.`}
          points={data.backfill.btc_hashprice}
          format={(v) => formatPrice(HASH_UNIT, v)}
          formatTime={formatDay}
          empty="No data from this source right now."
        />
        <AreaChart
          title="Ethereum blockspace"
          caption={`USD ${formatUnit(GAS_UNIT)}, at today's ETH price.`}
          points={data.backfill.blockspace}
          format={(v) => formatPrice(GAS_UNIT, v)}
          formatTime={formatDay}
          empty="No data from this source right now."
        />
      </div>
    </>
  );
}

function People() {
  return (
    <>
      <ul className="people">
        {PEOPLE.map((person) => (
          <li key={person.slug}>
            <div className="person-photo">
              <img
                src={`/img/compute/${person.slug}.jpg`}
                width={person.width}
                height={person.height}
                alt={`Portrait of ${person.name}`}
                loading="lazy"
                style={{
                  objectPosition: person.objectPosition,
                  ...(person.zoom
                    ? { transform: `scale(${person.zoom.scale})`, transformOrigin: person.zoom.origin }
                    : null),
                }}
              />
            </div>
            <h3>{person.name}</h3>
            <p className="muted small">{person.company}</p>
            <p className="small">{person.line}</p>
          </li>
        ))}
      </ul>
      <p className="muted small disclaimer">{PEOPLE_DISCLAIMER}</p>
    </>
  );
}

function Method({ baseDate, version }: { baseDate?: string; version?: string }) {
  return (
    <div className="method">
      <div>
        <h3>Matched quotes</h3>
        <p>
          A quote is one price, from one venue, for one product. Each quote is only ever compared
          with its own price on the base date{baseDate ? ` (${baseDate})` : ''}, so like is always
          measured against like.
        </p>
        <p>
          Those ratios are averaged with a weighted geometric mean: quotes into products, products
          into pillars, pillars into the index. The index is 1,000 at the base.
        </p>
        <p>
          When a venue drops out, its quote leaves the comparison, so a change in who is reporting
          can't move the level by itself. If a whole pillar is down, the others reweight to 100%.
          With fewer than four pillars, the index reports no level at all.
        </p>
        {version && <p className="muted small">Methodology v{version}</p>}
      </div>
      <div>
        <h3>Six sources</h3>
        <dl>
          {SOURCES.map((s) => (
            <div key={s.id}>
              <dt>{s.label}</dt>
              <dd>{s.text}</dd>
            </div>
          ))}
        </dl>
      </div>
      <div>
        <h3>Limitations</h3>
        <dl>
          <div>
            <dt>Unofficial endpoints</dt>
            <dd>Several feeds are public web endpoints, not licensed data products. They can change or vanish without notice.</dd>
          </div>
          <div>
            <dt>Spot, not contract</dt>
            <dd>These are spot and listed prices. Reserved capacity and negotiated contracts aren't captured.</dd>
          </div>
          <div>
            <dt>Short history</dt>
            <dd>GPU, cloud and inference prices have no public history, so the index only has history from its first recorded snapshot.</dd>
          </div>
          <div>
            <dt>Outliers are dropped</dt>
            <dd>A quote below 0.2x or above 5x its base is discarded rather than trusted.</dd>
          </div>
          <div>
            <dt>Settlement timing</dt>
            <dd>Each hourly future settles at the index level of the first update after its expiry.</dd>
          </div>
        </dl>
      </div>
    </div>
  );
}

function Credits() {
  return (
    <ul className="credits small">
      {IMAGE_CREDITS.map((c) => (
        <li key={c.slug}>
          <a href={c.sourceUrl} target="_blank" rel="noreferrer">
            {c.title}
          </a>{' '}
          by {c.author},{' '}
          {c.licenseUrl ? (
            <a href={c.licenseUrl} target="_blank" rel="noreferrer license">
              {c.license}
            </a>
          ) : (
            c.license
          )}
        </li>
      ))}
    </ul>
  );
}

export default function IndexPage() {
  const { data, loading, error, retry } = useComputeIndex();
  const hash = useHash();
  const method = useRef<HTMLDetailsElement>(null);
  const credits = useRef<HTMLDetailsElement>(null);

  // Footer links land on a collapsed section: open it, then bring it into view.
  useEffect(() => {
    const target = hash === '#method' ? method.current : hash === '#credits' ? credits.current : null;
    if (!target) return;
    target.open = true;
    target.scrollIntoView();
  }, [hash]);

  const index = data?.index;
  const level = typeof index?.level === 'number' && Number.isFinite(index.level) ? index.level : null;
  const base = typeof index?.base === 'number' ? index.base : 1000;
  const change = formatChange(level, base);
  const components = data?.components ?? [];
  const down = components.filter((c) => c.status === 'down').length;

  return (
    <>
      <section className="wrap page-head">
        <p className="live-label">
          <span className={level !== null ? 'dot dot-live' : 'dot'} aria-hidden="true" />
          <span>Live</span>
        </p>
        <h1 className="title">Silica Compute Index</h1>
        {level !== null ? (
          <>
            <p className="big-number num">
              <Counter value={level} from={base} splitFraction />
            </p>
            <p className="muted num">
              {change.text} vs base {formatLevel(base, 0)}
              {index?.asOf && <> · {formatAsOf(index.asOf)}</>}
              {down > 0 && <> · {down} of {components.length} sources down</>}
            </p>
          </>
        ) : loading ? (
          <Skeleton className="skel-big" label="Loading the index" />
        ) : (
          <ErrorLine text={error || 'The index is not available right now.'} onRetry={retry} />
        )}
        <p className="lede">What compute costs right now, in one number.</p>
      </section>

      <section className="wrap section">
        <Reveal>
          <h2 className="title">What's inside</h2>
          <Pillars components={components} loading={loading} />
        </Reveal>
      </section>

      <section className="wrap section">
        <Reveal>
          <h2 className="title">Same chip. Different price.</h2>
          <p className="lede">Live rental offers, in USD per GPU-hour.</p>
          <GpuBoard gpus={data?.gpus ?? []} loading={loading} />
        </Reveal>
      </section>

      <section className="wrap section">
        <Reveal>
          <h2 className="title">The last 30 days</h2>
          <History />
        </Reveal>
      </section>

      <section className="wrap section">
        <Reveal>
          <h2 className="title">The people setting the price of compute.</h2>
          <People />
        </Reveal>
      </section>

      <section className="wrap section section-tight">
        <details ref={method} id="method" className="fold">
          <summary>Methodology</summary>
          <Method baseDate={index?.baseDate} version={index?.methodologyVersion} />
        </details>
        <details ref={credits} id="credits" className="fold">
          <summary>Image credits ({IMAGE_CREDITS.length})</summary>
          <p className="muted small">Images are cropped and scaled.</p>
          <Credits />
        </details>
        <p className="closing">
          <Link to={PATHS.trade} className="btn btn-lg">
            Start trading
          </Link>
        </p>
      </section>
    </>
  );
}

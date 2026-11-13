import { useEffect, useRef } from 'react';
import type { ComputeGpu } from '../lib/api';
import { IMAGE_CREDITS, SOURCES } from '../compute/content';
import {
  formatAsOf,
  formatChange,
  formatDay,
  formatLevel,
  formatPrice,
  formatSpread,
  formatUnit,
  gpuVenueColumns,
  isCheapestVenue,
  venueName,
} from '../compute/helpers';
import { IndexChart, useIndexHistory, type IndexHistory } from '../compute/IndexHistory';
import { NewsFeed } from '../compute/NewsFeed';
import { PillarCards } from '../compute/Pillars';
import { useComputeIndex } from '../compute/useComputeIndex';
import { PATHS } from '../lib/routes';
import { AreaChart } from '../ui/AreaChart';
import { ErrorLine, Reveal, Skeleton } from '../ui/bits';
import { Counter } from '../ui/Counter';
import { Glow } from '../ui/Glow';
import { Link, useHash } from '../ui/router';

const GPU_UNIT = '$/GPU-hour';
const HASH_UNIT = '$/TH/day';
const GAS_UNIT = '$/1M gas';

function GpuBoard({ gpus, loading }: { gpus: ComputeGpu[]; loading: boolean }) {
  const columns = gpuVenueColumns(gpus);
  if (loading && gpus.length === 0) return <Skeleton className="skel-block" label="Loading GPU prices" />;
  if (gpus.length === 0) return <p className="muted">GPU prices are not available right now.</p>;
  return (
    <div className="table-scroll terminal" role="region" aria-label="GPU prices by venue" tabIndex={0}>
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

function SourceHistory({ data }: { data: IndexHistory }) {
  const backfill = data.history.data?.backfill;
  if (!backfill) return null;
  return (
    <div className="chart-grid">
      <div className="card card-pad">
        <AreaChart
          title="Bitcoin hashprice"
          caption={`USD ${formatUnit(HASH_UNIT)}, from blockchain.info.`}
          points={backfill.btc_hashprice}
          format={(v) => formatPrice(HASH_UNIT, v)}
          formatTime={formatDay}
          height={150}
          empty="No data from this source right now."
        />
      </div>
      <div className="card card-pad">
        <AreaChart
          title="Ethereum blockspace"
          caption={`USD ${formatUnit(GAS_UNIT)}, at today's ETH price.`}
          points={backfill.blockspace}
          format={(v) => formatPrice(GAS_UNIT, v)}
          formatTime={formatDay}
          height={150}
          empty="No data from this source right now."
        />
      </div>
    </div>
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
            <dd>GPU, cloud and inference prices have no public history. Before real readings, the chart is a reconstruction from the two pillars that have one.</dd>
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
  const history = useIndexHistory(level !== null ? { level, asOf: index?.asOf } : null);

  return (
    <>
      <section className="page-hero">
        <Glow variant="soft" />
        <div className="wrap page-head">
          <p className="live-label">
            <span className={level !== null ? 'dot dot-live' : 'dot'} aria-hidden="true" />
            <span>Live</span>
            {index?.asOf && <span className="num">Â· {formatAsOf(index.asOf)}</span>}
          </p>
          <h1 className="display display-md">
            <span>Silica Compute Index.</span> <span className="lo">What compute costs, in one number.</span>
          </h1>
          {level !== null ? (
            <div className="head-stat">
              <p className="big-number num">
                <Counter value={level} from={base} splitFraction />
              </p>
              <p className="muted num">
                <span className={change.direction ?? ''}>{change.text}</span> since base {formatLevel(base, 0)}
                {down > 0 && <> Â· {down} of {components.length} sources down</>}
              </p>
            </div>
          ) : loading ? (
            <Skeleton className="skel-big" label="Loading the index" />
          ) : (
            <ErrorLine text={error || 'The index is not available right now.'} onRetry={retry} />
          )}
        </div>
      </section>

      <section className="wrap section section-first">
        <Reveal>
          <IndexChart data={history} height={400} />
        </Reveal>
      </section>

      <section className="wrap section">
        <Reveal>
          <div className="section-head">
            <h2 className="title">
              <span>Six pillars.</span> <span className="lo">Each a real market.</span>
            </h2>
          </div>
          <PillarCards components={components} loading={loading} detail />
        </Reveal>
      </section>

      <section className="wrap section">
        <Reveal>
          <div className="section-head">
            <h2 className="title">
              <span>Same chip.</span> <span className="lo">Different price.</span>
            </h2>
            <p className="section-aside muted">Live offers, USD per GPU-hour.</p>
          </div>
          <GpuBoard gpus={data?.gpus ?? []} loading={loading} />
        </Reveal>
      </section>

      <section className="wrap section">
        <Reveal>
          <div className="section-head">
            <h2 className="title">
              <span>Two pillars</span> <span className="lo">with public history.</span>
            </h2>
          </div>
          <SourceHistory data={history} />
        </Reveal>
      </section>

      <NewsFeed />

      <section className="wrap section">
        <details ref={method} id="method" className="fold">
          <summary>Methodology</summary>
          <Method baseDate={index?.baseDate} version={index?.methodologyVersion} />
        </details>
        <details ref={credits} id="credits" className="fold">
          <summary>Image credits ({IMAGE_CREDITS.length})</summary>
          <p className="muted small">Images are cropped and scaled.</p>
          <Credits />
        </details>
      </section>

      <section className="closing-band closing-band-plain">
        <Glow variant="band" />
        <div className="wrap closing-inner">
          <h2 className="title">
            <span>Seen enough?</span> <span className="lo">Take a side.</span>
          </h2>
          <p className="actions">
            <Link to={PATHS.trade} className="btn btn-lg">
              Start trading
            </Link>
          </p>
        </div>
      </section>
    </>
  );
}

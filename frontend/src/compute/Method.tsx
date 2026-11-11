import { IMAGE_CREDITS, SOURCES } from './content';
import { Reveal, SectionHead } from './Reveal';

export function Method({ baseDate, version }: { baseDate?: string; version?: string }) {
  return (
    <section id="method" className="cx-section">
      <div className="cx-wrap">
        <SectionHead eyebrow="Method" title="How it's built." />
        <div className="cx-method">
          <Reveal className="cx-method-col">
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
            {version && <p className="cx-method-version">Methodology v{version}</p>}
          </Reveal>

          <Reveal className="cx-method-col">
            <h3>Six sources</h3>
            <dl className="cx-sources">
              {SOURCES.map((s) => (
                <div key={s.id}>
                  <dt>{s.label}</dt>
                  <dd>{s.text}</dd>
                </div>
              ))}
            </dl>
          </Reveal>

          <Reveal className="cx-method-col">
            <h3>Limitations</h3>
            <ul className="cx-limits">
              <li><b>Unofficial endpoints.</b> Several feeds are public web endpoints, not licensed data products. They can change or vanish without notice.</li>
              <li><b>Spot, not contract.</b> These are spot and listed prices. Reserved capacity and negotiated contracts aren't captured.</li>
              <li><b>Short history.</b> GPU, cloud and inference prices have no public history, so the index only has history from its first recorded snapshot.</li>
              <li><b>Outliers are dropped.</b> A quote below 0.2x or above 5x its base is discarded rather than trusted.</li>
            </ul>
          </Reveal>
        </div>

        <Reveal className="cx-trade">
          <p>
            <span className="cx-up">Long</span> if you think compute gets more expensive.{' '}
            <span className="cx-down">Short</span> if you think it gets cheaper.
          </p>
          <button type="button" className="cx-btn cx-btn-trade" disabled>
            <b>Trade CCI</b>
            <span>Coming to NEAR</span>
          </button>
        </Reveal>
      </div>
    </section>
  );
}

export function Credits() {
  return (
    <section id="credits" className="cx-section cx-section-tight">
      <div className="cx-wrap">
        <details className="cx-credits">
          <summary>Image credits ({IMAGE_CREDITS.length})</summary>
          <p>Images are cropped, scaled and shown under dark gradients on this page.</p>
          <ul>
            {IMAGE_CREDITS.map((c) => (
              <li key={c.slug}>
                <a href={c.sourceUrl} target="_blank" rel="noreferrer">{c.title}</a>
                <span> by {c.author}, </span>
                {c.licenseUrl ? (
                  <a href={c.licenseUrl} target="_blank" rel="noreferrer license">{c.license}</a>
                ) : (
                  <span>{c.license}</span>
                )}
              </li>
            ))}
          </ul>
        </details>
      </div>
    </section>
  );
}

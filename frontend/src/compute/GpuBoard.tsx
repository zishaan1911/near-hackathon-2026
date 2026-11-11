import { motion } from 'motion/react';
import type { ComputeGpu } from '../lib/api';
import { formatAsOf, formatLevel, formatPrice, formatSpread, gpuVenueColumns, isCheapestVenue, venueName } from './helpers';
import { Reveal, SectionHead } from './Reveal';

const UNIT = '$/GPU-hour';

/** A price that dips in opacity for a moment when its value changes. */
function Tick({ value }: { value: string }) {
  return (
    <motion.span key={value} initial={{ opacity: 0.35 }} animate={{ opacity: 1 }}>
      {value}
    </motion.span>
  );
}

function Row({ gpu, columns }: { gpu: ComputeGpu; columns: string[] }) {
  return (
    <tr>
      <th scope="row">{gpu.label}</th>
      {columns.map((venue) => {
        const quote = gpu.venues?.find((v) => v.venue === venue);
        const price = quote?.price ?? null;
        const cheapest = price !== null && isCheapestVenue(gpu, venue);
        return (
          <td key={venue} className={cheapest ? 'cx-cheapest' : price === null ? 'cx-missing' : undefined}>
            <Tick value={formatPrice(UNIT, price)} />
            {cheapest && <small>Low</small>}
          </td>
        );
      })}
      <td><Tick value={formatPrice(UNIT, gpu.medianPrice)} /></td>
      <td><Tick value={formatLevel(gpu.level, 1)} /></td>
      <td className="cx-spread"><Tick value={formatSpread(gpu.spreadPct)} /></td>
    </tr>
  );
}

export function GpuBoard({
  gpus,
  asOf,
  loading,
}: {
  gpus: ComputeGpu[];
  asOf: string | undefined;
  loading: boolean;
}) {
  const columns = gpuVenueColumns(gpus);
  return (
    <section id="gpus" className="cx-section">
      <div className="cx-wrap">
        <SectionHead
          eyebrow="GPU board"
          title="Same chip. Different price."
          lede="Live hourly rental offers for the same GPU, side by side."
        />
        <Reveal className="cx-terminal">
          <div className="cx-terminal-bar">
            <span>USD per GPU-hour</span>
            {asOf && <time dateTime={asOf}>{formatAsOf(asOf)}</time>}
          </div>
          {loading ? (
            <div className="cx-terminal-loading" role="status" aria-label="Loading GPU prices">
              {[0, 1, 2].map((i) => <span key={i} className="cx-skel cx-skel-row" />)}
            </div>
          ) : gpus.length === 0 ? (
            <p className="cx-terminal-empty">GPU quotes are not available right now.</p>
          ) : (
            <div className="cx-terminal-scroll" role="region" aria-label="GPU prices by venue" tabIndex={0}>
              <table>
                <thead>
                  <tr>
                    <th scope="col">Chip</th>
                    {columns.map((v) => <th scope="col" key={v}>{venueName(v)}</th>)}
                    <th scope="col">Median</th>
                    <th scope="col">Level</th>
                    <th scope="col">Spread</th>
                  </tr>
                </thead>
                <tbody>
                  {gpus.map((gpu) => <Row key={gpu.id} gpu={gpu} columns={columns} />)}
                </tbody>
              </table>
            </div>
          )}
        </Reveal>
      </div>
    </section>
  );
}

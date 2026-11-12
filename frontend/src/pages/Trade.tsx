import { useMemo, useState } from 'react';
import { formatChange, formatLevel, formatPoints } from '../compute/helpers';
import { formatChartTime, RangePills } from '../compute/IndexHistory';
import {
  applyLiveCandle,
  applyLivePoint,
  candlesHaveBodies,
  cleanCandles,
  filterRange,
  latestTime,
  mergeIndexSeries,
  RANGES,
  toSeconds,
  type Range,
} from '../compute/series';
import { getCandles, getComputeHistory, prepareCancel, type MarketSnapshot } from '../lib/api';
import { formatSigned } from '../lib/format';
import { formatCountdown } from '../lib/market';
import { fromOnChainQuantity, referencePrice, tradePnl, tradeSide } from '../lib/trade';
import { usePolled } from '../lib/usePolled';
import { ErrorLine, Skeleton, useHint } from '../ui/bits';
import { Chart, type ChartMarker, type ChartSeries } from '../ui/Chart';
import { Counter } from '../ui/Counter';
import { useNow } from '../ui/useNow';
import { useAccountData, useMarket, type AccountData } from '../wallet/useAccountData';
import { useTx } from '../wallet/useTx';
import { Ticket } from './Ticket';

const CANDLE_SECONDS = 3600;
const CANDLE_LIMIT = 24 * 90;

function priceOf(snap: MarketSnapshot): number | null {
  return referencePrice({
    oracleHasPrice: snap.market.oracleHasPrice,
    oraclePrice: snap.market.oraclePrice,
    indexLevel: snap.index?.level,
  });
}

function SettleLine({ snap }: { snap: MarketSnapshot }) {
  const now = useNow(1000);
  const { market } = snap;
  if (market.settled) {
    return <span>Settled{market.settlementPrice !== null ? ` at ${formatPoints(market.settlementPrice)}` : ''}</span>;
  }
  const left = market.expiryMs !== undefined ? formatCountdown(market.expiryMs, now) : null;
  if (!left) return <span>Settling now</span>;
  return (
    <span>
      Settles in <span className="num">{left}</span>
    </span>
  );
}

function MarketHead({ snap }: { snap: MarketSnapshot }) {
  const price = priceOf(snap);
  const base = snap.index?.base ?? 1000;
  const change = formatChange(price, base);
  const hint = useHint(
    'What is this market?',
    `Each contract gains 1 tUSDC per index point the price rises by settlement, and loses the same if it falls. Short is the opposite. It settles every hour.`,
  );
  return (
    <header className="market-head">
      <p className="market-name">
        <span className={price !== null ? 'dot dot-live' : 'dot'} aria-hidden="true" />
        <span>{snap.market.label}</span>
        {hint.button}
      </p>
      {hint.panel}
      {price !== null ? (
        <p className="trade-price num">
          <Counter value={price} from={base} digits={Number.isInteger(price) ? 0 : 2} />
        </p>
      ) : (
        <p className="trade-price muted">n/a</p>
      )}
      <p className="muted num market-sub">
        <span>
          <span className={change.direction ?? ''}>{change.text}</span> since base {formatLevel(base, 0)}
        </span>
        <span aria-hidden="true">·</span>
        <SettleLine snap={snap} />
      </p>
    </header>
  );
}

/**
 * Hourly candles of the index. Without them, the same joined line as the
 * index page (back-cast, then on-chain settlements). The live level always
 * moves the newest point.
 */
function PriceChart({ snap }: { snap: MarketSnapshot }) {
  const candles = usePolled(() => getCandles(CANDLE_SECONDS, CANDLE_LIMIT), 60_000);
  const bars = useMemo(() => cleanCandles(candles.data), [candles.data]);
  const fallback = (candles.data !== null && bars.length < 2) || (candles.data === null && candles.error !== '');
  const history = usePolled(fallback ? () => getComputeHistory(90) : null, 10 * 60_000, fallback ? 'on' : 'off');
  const [chosen, setChosen] = useState<Range | null>(null);
  const [hover, setHover] = useState<{ time: number; value: number } | null>(null);

  const level = snap.index?.level ?? null;
  const asOf = snap.index?.asOfMs ?? null;
  const live = useMemo(
    () => (level !== null ? { time: toSeconds(asOf ?? Date.now()), value: level } : null),
    [level, asOf],
  );

  // Every range, as the series it would draw.
  const views = useMemo(() => {
    const out = new Map<Range, { series: ChartSeries[]; markers: ChartMarker[]; count: number }>();
    if (bars.length >= 2) {
      const all = applyLiveCandle(bars, live, CANDLE_SECONDS);
      const anchor = latestTime(all);
      for (const r of RANGES) {
        const inRange = filterRange(all, r, anchor);
        const series: ChartSeries[] = candlesHaveBodies(inRange)
          ? [{ id: 'bars', kind: 'candles', candles: inRange }]
          : [{ id: 'close', kind: 'area', tone: 'cyan', points: inRange.map((c) => ({ time: c.time, value: c.close })) }];
        out.set(r, { series, markers: [], count: inRange.length });
      }
      return out;
    }
    const data = history.data;
    if (!data) return out;
    const merged = mergeIndexSeries({
      backcast: data.backcast.points,
      recorded: data.persisted ? data.points : [],
      settlements: data.settlements,
    });
    const real = applyLivePoint(merged.measured, live);
    const anchor = latestTime(merged.reconstructed, real);
    for (const r of RANGES) {
      const rec = filterRange(merged.reconstructed, r, anchor);
      const mes = filterRange(real, r, anchor);
      const series: ChartSeries[] = [];
      if (rec.length) series.push({ id: 'rec', kind: 'area', tone: 'violet', points: mes[0] ? [...rec, mes[0]] : rec });
      if (mes.length) series.push({ id: 'real', kind: 'area', tone: 'cyan', points: mes });
      const markers: ChartMarker[] =
        merged.onchainFrom !== null && mes.some((p) => p.time === merged.onchainFrom)
          ? [{ seriesId: 'real', time: merged.onchainFrom, text: 'On-chain' }]
          : [];
      out.set(r, { series, markers, count: rec.length + mes.length });
    }
    return out;
  }, [bars, live, history.data]);

  const drawable = (r: Range) => (views.get(r)?.count ?? 0) >= 2;
  const range: Range =
    chosen ?? (drawable('1W') ? '1W' : [...RANGES].reverse().find((r) => drawable(r)) ?? '1W');
  const view = views.get(range);
  const intraday = range === '1D' || range === '1W';
  const waiting = candles.loading || (fallback && history.loading);

  return (
    <div className="chart-card chart-card-trade">
      <div className="chart-top">
        <p className="chart-mini num">
          {hover ? (
            <>
              <b>{formatLevel(hover.value)}</b>
              <span className="muted">{formatChartTime(hover.time, intraday)}</span>
            </>
          ) : (
            <span className="muted">{bars.length >= 2 ? 'Index, hourly' : 'Index, reconstructed then on-chain'}</span>
          )}
        </p>
        <RangePills
          value={range}
          onChange={(r) => {
            setChosen(r);
            setHover(null);
          }}
          isAvailable={drawable}
        />
      </div>
      {view && view.count >= 2 ? (
        <Chart
          series={view.series}
          markers={view.markers}
          height={360}
          intraday={intraday}
          label={`Silica Compute Index, ${range}`}
          onCrosshair={setHover}
        />
      ) : waiting ? (
        <Skeleton className="skel-chart" label="Loading the chart" />
      ) : (
        <p className="chart-empty muted">No price history yet. It fills in as markets settle.</p>
      )}
    </div>
  );
}

const BOOK_DEPTH = 5;

function Row({ price, size, side, max }: { price: number; size: number; side: 'ask' | 'bid'; max: number }) {
  return (
    <li className={`book-row book-${side}`}>
      <span className="book-depth" style={{ transform: `scaleX(${size / max})` }} aria-hidden="true" />
      <span className="book-price">{formatPoints(price)}</span>
      <span className="book-size">{formatLevel(fromOnChainQuantity(size), 2)}</span>
    </li>
  );
}

function Book({ snap }: { snap: MarketSnapshot }) {
  const asks = snap.orderbook.asks.slice(0, BOOK_DEPTH);
  const bids = snap.orderbook.bids.slice(0, BOOK_DEPTH);
  const max = Math.max(1, ...asks.map((l) => l.size), ...bids.map((l) => l.size));
  const empty = asks.length === 0 && bids.length === 0;

  return (
    <section className="card book" aria-label="Order book">
      <h2 className="label">Order book</h2>
      {empty ? (
        <p className="muted">No orders yet</p>
      ) : (
        <div className="book-cols num">
          <div>
            <p className="book-head small muted">
              <span>Sell</span>
              <span>Contracts</span>
            </p>
            <ol className="book-side">
              {asks.length === 0 && <li className="muted small">None</li>}
              {asks.map((l) => (
                <Row key={`a${l.price}`} price={l.price} size={l.size} side="ask" max={max} />
              ))}
            </ol>
          </div>
          <div>
            <p className="book-head small muted">
              <span>Buy</span>
              <span>Contracts</span>
            </p>
            <ol className="book-side">
              {bids.length === 0 && <li className="muted small">None</li>}
              {bids.map((l) => (
                <Row key={`b${l.price}`} price={l.price} size={l.size} side="bid" max={max} />
              ))}
            </ol>
          </div>
        </div>
      )}
    </section>
  );
}

function Pnl({ value }: { value: number }) {
  const cls = value > 0 ? 'up' : value < 0 ? 'down' : '';
  return <span className={`num ${cls}`}>{formatSigned(value)} tUSDC</span>;
}

function Positions({ snap, data }: { snap: MarketSnapshot; data: AccountData }) {
  const tx = useTx();
  const { accountId, account, refresh } = data;
  if (!accountId) return null;
  if (!account.data) {
    return account.error ? (
      <ErrorLine text={account.error} onRetry={() => void account.reload()} />
    ) : (
      <Skeleton className="skel-block" label="Loading your position" />
    );
  }

  const price = priceOf(snap);
  const mult = snap.market.contractMultiplier ?? Number.NaN;
  const current = snap.market.number;
  const trades = account.data.trades.filter((t) => current === null || t.marketId === current);
  const orders = account.data.openOrders.filter(
    (o) => o.owner === accountId && o.status === 'open' && (current === null || o.marketId === current),
  );
  const pnls = trades.map((t) =>
    price !== null && Number.isFinite(mult)
      ? tradePnl(tradeSide(t, accountId), t.price, t.quantity, price, mult)
      : Number.NaN,
  );
  const total = pnls.reduce((sum, v) => sum + (Number.isFinite(v) ? v : 0), 0);

  async function cancel(orderId: number) {
    if (!accountId) return;
    const ok = await tx.run(`cancel-${orderId}`, () => prepareCancel({ trader: accountId, orderId }));
    if (ok !== false) void refresh();
  }

  return (
    <div className="card positions">
      <div className="list-block">
        <div className="list-title">
          <h2 className="label">Your position</h2>
          {trades.length > 0 && <Pnl value={total} />}
        </div>
        {trades.length === 0 ? (
          <p className="muted">No position in this market yet.</p>
        ) : (
          <ul className="list">
            {trades.map((t, i) => {
              const side = tradeSide(t, accountId);
              const pnl = pnls[i] ?? Number.NaN;
              return (
                <li key={t.tradeId} className="list-row">
                  <span className={`side side-${side}`}>{side === 'long' ? 'Long' : 'Short'}</span>
                  <span className="num">
                    {formatLevel(fromOnChainQuantity(t.quantity), 2)} at {formatPoints(t.price)}
                  </span>
                  <span className="list-end">{Number.isFinite(pnl) ? <Pnl value={pnl} /> : 'n/a'}</span>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="list-block">
        <h2 className="label">Open orders</h2>
        {orders.length === 0 ? (
          <p className="muted">No open orders.</p>
        ) : (
          <ul className="list">
            {orders.map((o) => (
              <li key={o.orderId} className="list-row">
                <span className={`side side-${o.isBid ? 'long' : 'short'}`}>{o.isBid ? 'Long' : 'Short'}</span>
                <span className="num">
                  {formatLevel(fromOnChainQuantity(o.quantity), 2)} at {formatPoints(o.price)}
                </span>
                <span className="list-end">
                  <button
                    type="button"
                    className="btn btn-sm btn-quiet"
                    disabled={tx.busy !== null}
                    onClick={() => void cancel(o.orderId)}
                    aria-label={`Cancel ${o.isBid ? 'long' : 'short'} order at ${formatPoints(o.price)}`}
                  >
                    {tx.busy === `cancel-${o.orderId}` ? 'Cancelling' : 'Cancel'}
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
        {tx.error && <ErrorLine text={tx.error} />}
      </div>
    </div>
  );
}

export default function Trade() {
  const market = useMarket();
  const data = useAccountData();
  const snap = market.data;

  if (!snap) {
    return (
      <section className="wrap trade">
        <div className="market-head">
          {market.error && !market.loading ? (
            <ErrorLine text={market.error} onRetry={() => void market.reload()} />
          ) : (
            <Skeleton className="skel-big" label="Loading the market" />
          )}
        </div>
        <div className="trade-chart">
          <Skeleton className="skel-chart" />
        </div>
        <div className="ticket">
          <Skeleton className="skel-block" />
        </div>
      </section>
    );
  }

  return (
    <section className="wrap trade">
      {/* Grid areas put the ticket right under the price on phones. */}
      <MarketHead snap={snap} />
      <div className="trade-chart">
        <PriceChart snap={snap} />
      </div>
      <div className={data.accountId ? 'trade-below' : 'trade-below trade-below-solo'}>
        <Book snap={snap} />
        {data.accountId && <Positions snap={snap} data={data} />}
      </div>
      <Ticket snap={snap} price={priceOf(snap)} data={data} />
    </section>
  );
}

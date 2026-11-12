import { useEffect, useMemo, useState } from 'react';
import { formatChange, formatClock, formatLevel, formatPoints } from '../compute/helpers';
import { getCandles, prepareCancel, type MarketSnapshot } from '../lib/api';
import { formatSigned } from '../lib/format';
import { formatCountdown } from '../lib/market';
import { fromOnChainQuantity, referencePrice, tradePnl, tradeSide } from '../lib/trade';
import { usePolled } from '../lib/usePolled';
import { AreaChart } from '../ui/AreaChart';
import { ErrorLine, Skeleton, useHint } from '../ui/bits';
import { Counter } from '../ui/Counter';
import { useNow } from '../ui/useNow';
import { useAccountData, useMarket, type AccountData } from '../wallet/useAccountData';
import { useTx } from '../wallet/useTx';
import { Ticket } from './Ticket';

const CHART_WINDOW_MS = 12 * 3600_000;
const SESSION_POINTS = 240;

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
        <p className="big-number num">
          <Counter value={price} from={base} digits={Number.isInteger(price) ? 0 : 2} />
        </p>
      ) : (
        <p className="big-number muted">n/a</p>
      )}
      <p className="muted num market-sub">
        <span>
          {change.text} vs base {formatLevel(base, 0)}
        </span>
        <span aria-hidden="true">·</span>
        <SettleLine snap={snap} />
      </p>
    </header>
  );
}

/** Index candles when stored; otherwise the readings seen while this page is open. */
function PriceChart({ snap }: { snap: MarketSnapshot }) {
  const candles = usePolled(() => getCandles(300), 60_000);
  const [session, setSession] = useState<Array<{ t: string; value: number }>>([]);
  const level = snap.index?.level ?? null;

  useEffect(() => {
    if (level === null) return;
    setSession((list) => {
      const last = list[list.length - 1];
      if (last && last.value === level && Date.now() - Date.parse(last.t) < 30_000) return list;
      return [...list, { t: new Date().toISOString(), value: level }].slice(-SESSION_POINTS);
    });
  }, [level, snap]);

  const points = useMemo(() => {
    const cutoff = Date.now() - CHART_WINDOW_MS;
    const stored = (candles.data ?? [])
      .filter((c) => c.time * 1000 >= cutoff)
      .map((c) => ({ t: new Date(c.time * 1000).toISOString(), value: c.close }));
    return stored.length >= 2 ? stored : session;
  }, [candles.data, session]);

  return (
    <AreaChart
      label="Silica Compute Index"
      points={points}
      format={(v) => formatLevel(v)}
      formatTime={formatClock}
      height={200}
      empty="The chart fills in as new readings arrive."
    />
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
    <section className="book" aria-label="Order book">
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
    <div className="positions">
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
          <Skeleton className="skel-block" />
        </div>
        <div className="ticket">
          <Skeleton className="skel-block" />
        </div>
      </section>
    );
  }

  return (
    <>
      <section className="wrap trade">
        {/* Grid areas put the ticket right under the price on phones. */}
        <MarketHead snap={snap} />
        <div className="trade-chart">
          <PriceChart snap={snap} />
        </div>
        <Book snap={snap} />
        <Ticket snap={snap} price={priceOf(snap)} data={data} />
      </section>
      {data.accountId && (
        <section className="wrap section section-tight">
          <Positions snap={snap} data={data} />
        </section>
      )}
    </>
  );
}

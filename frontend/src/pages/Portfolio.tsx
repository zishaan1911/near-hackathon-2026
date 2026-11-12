import { useState, type FormEvent } from 'react';
import { formatLevel, formatPoints } from '../compute/helpers';
import {
  prepareClaim,
  prepareDeposit,
  prepareWithdraw,
  type MarketSnapshot,
  type TradeView,
} from '../lib/api';
import { formatSigned, formatTusdc, parseTokenAmount } from '../lib/format';
import { useNear } from '../lib/near';
import { PATHS } from '../lib/routes';
import { faucetTransaction } from '../lib/token';
import {
  batchPrepared,
  fromOnChainQuantity,
  isClaimable,
  isClaimed,
  referencePrice,
  toBig,
  tradePnl,
  tradeSide,
} from '../lib/trade';
import { ErrorLine, Skeleton } from '../ui/bits';
import { Glow } from '../ui/Glow';
import { Link } from '../ui/router';
import { useAccountData, useMarket, type AccountData } from '../wallet/useAccountData';
import { useTx, type TxRunner } from '../wallet/useTx';

function Balance({ label, value }: { label: string; value: bigint | null }) {
  return (
    <div className="stat">
      <dt className="stat-label">{label}</dt>
      <dd className="stat-value num">
        {value === null ? <Skeleton className="skel-text" /> : formatTusdc(value)}
        <span className="unit">tUSDC</span>
      </dd>
    </div>
  );
}

function AmountForm({
  id,
  title,
  action,
  max,
  tx,
  onSubmit,
}: {
  id: string;
  title: string;
  action: string;
  max: bigint;
  tx: TxRunner;
  onSubmit: (amount: string) => Promise<boolean>;
}) {
  const [text, setText] = useState('');
  const amount = parseTokenAmount(text);
  const error =
    text.trim() === ''
      ? ''
      : amount === null || toBig(amount) === 0n
        ? 'Enter an amount, like 100.'
        : toBig(amount) > max
          ? `You have ${formatTusdc(max)} tUSDC.`
          : '';

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!amount || error) return;
    if (await onSubmit(amount)) setText('');
  }

  return (
    <form className="card card-pad amount-form" onSubmit={(e) => void submit(e)} noValidate>
      <label className="label" htmlFor={id}>
        {title}
      </label>
      <div className="amount-row">
        <div className="amount-input">
          <input
            id={id}
            className="input num"
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.00"
            value={text}
            aria-invalid={error !== ''}
            onChange={(e) => setText(e.target.value)}
          />
          <button
            type="button"
            className="link small"
            onClick={() => setText(formatTusdc(max).replace(/,/g, ''))}
            disabled={max === 0n}
          >
            Max
          </button>
        </div>
        <button
          type="submit"
          className="btn"
          disabled={tx.busy !== null || !amount || error !== '' || toBig(amount) === 0n}
        >
          {tx.busy === id ? 'Confirm in wallet' : action}
        </button>
      </div>
      {error && <p className="field-note error-text">{error}</p>}
    </form>
  );
}

interface Row {
  trade: TradeView;
  side: 'long' | 'short';
  claimable: boolean;
  claimed: boolean;
  live: boolean;
  pnl: number | null;
}

function rows(snap: MarketSnapshot | null, accountId: string, trades: TradeView[]): Row[] {
  const current = snap?.market.number ?? null;
  const settled = snap?.market.settled ?? false;
  const price = snap
    ? referencePrice({
        oracleHasPrice: snap.market.oracleHasPrice,
        oraclePrice: snap.market.oraclePrice,
        indexLevel: snap.index?.level,
      })
    : null;
  const mult = snap?.market.contractMultiplier ?? Number.NaN;
  return [...trades]
    .sort((a, b) => b.tradeId - a.tradeId)
    .map((trade) => {
      const side = tradeSide(trade, accountId);
      const live = current !== null && trade.marketId === current && !settled;
      const settleAt = trade.marketId === current && settled ? snap?.market.settlementPrice ?? null : null;
      const mark = live ? price : settleAt;
      return {
        trade,
        side,
        claimable: isClaimable(trade, accountId, current, settled),
        claimed: isClaimed(trade, accountId),
        live,
        pnl:
          mark !== null && Number.isFinite(mult)
            ? tradePnl(side, trade.price, trade.quantity, mark, mult)
            : null,
      };
    });
}

function History({ data, snap }: { data: AccountData; snap: MarketSnapshot | null }) {
  const tx = useTx();
  const { accountId, account, refresh } = data;
  if (!accountId || !account.data) return null;
  const list = rows(snap, accountId, account.data.trades);
  const claimable = list.filter((r) => r.claimable);

  async function claim(ids: number[], key: string) {
    if (!accountId) return;
    const ok = await tx.run(key, async () =>
      batchPrepared(await Promise.all(ids.map((tradeId) => prepareClaim({ trader: accountId, tradeId })))),
    );
    if (ok !== false) {
      void refresh();
      window.setTimeout(() => void refresh(), 3000);
    }
  }

  return (
    <section className="wrap section">
      <div className="section-head section-head-sm">
        <h2 className="title title-sm">
          <span>History.</span> <span className="lo">Every trade, newest first.</span>
        </h2>
        {claimable.length > 1 && (
          <button
            type="button"
            className="btn btn-sm"
            disabled={tx.busy !== null}
            onClick={() => void claim(claimable.map((r) => r.trade.tradeId), 'all')}
          >
            {tx.busy === 'all' ? 'Confirm in wallet' : `Claim all (${claimable.length})`}
          </button>
        )}
      </div>
      {list.length === 0 ? (
        <p className="muted">
          No trades yet. <Link to={PATHS.trade}>Make your first trade</Link>
        </p>
      ) : (
        <ul className="card table-list">
          <li className="table-list-head small" aria-hidden="true">
            <span>Side</span>
            <span>Size and price</span>
            <span>P&amp;L</span>
          </li>
          {list.map((r) => {
            const t = r.trade;
            const key = `claim-${t.tradeId}`;
            return (
              <li key={t.tradeId} className="list-row">
                <span className={`side side-${r.side}`}>{r.side === 'long' ? 'Long' : 'Short'}</span>
                <span className="num">
                  {formatLevel(fromOnChainQuantity(t.quantity), 2)} at {formatPoints(t.price)}
                  <span className="muted small"> · Market {t.marketId}</span>
                </span>
                <span className="list-end num">
                  {r.pnl !== null && (
                    <span className={r.pnl > 0 ? 'up' : r.pnl < 0 ? 'down' : ''}>
                      {formatSigned(r.pnl)}
                    </span>
                  )}
                  {r.claimable ? (
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={tx.busy !== null}
                      onClick={() => void claim([t.tradeId], key)}
                    >
                      {tx.busy === key ? 'Confirm' : 'Claim'}
                    </button>
                  ) : r.claimed ? (
                    <span className="muted small">Claimed</span>
                  ) : r.live ? (
                    <span className="muted small">Open</span>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {tx.error && <ErrorLine text={tx.error} />}
    </section>
  );
}

export default function Portfolio() {
  const near = useNear();
  const data = useAccountData();
  const market = useMarket();
  const tx = useTx();
  const { accountId, account, wallet, balances, refresh } = data;

  if (!accountId) {
    return (
      <section className="page-hero">
        <Glow variant="soft" />
        <div className="wrap page-head">
        <h1 className="display display-md">
          <span>Portfolio.</span> <span className="lo">Connect a wallet to see it.</span>
        </h1>
        <p className="lede">Any NEAR testnet wallet works.</p>
        <p className="actions">
          <button type="button" className="btn btn-lg" onClick={near.connect} disabled={!near.ready}>
            {near.ready ? 'Connect wallet' : 'Loading wallet'}
          </button>
        </p>
        </div>
      </section>
    );
  }

  async function after(ok: string | null | false): Promise<boolean> {
    if (ok === false) return false;
    void refresh();
    window.setTimeout(() => void refresh(), 3000);
    return true;
  }

  const walletUnits = wallet.data !== null ? toBig(wallet.data) : null;

  return (
    <>
      <section className="page-hero">
        <Glow variant="soft" />
        <div className="wrap page-head">
        <h1 className="display display-md">
          <span>Portfolio.</span> <span className="lo">Balances and positions.</span>
        </h1>
        {account.error && !account.data ? (
          <ErrorLine text={account.error} onRetry={() => void account.reload()} />
        ) : (
          <dl className="stats stats-3">
            <Balance label="Available" value={account.data ? toBig(account.data.available) : null} />
            <Balance label="In positions" value={account.data ? toBig(account.data.locked) : null} />
            <Balance label="Wallet" value={walletUnits} />
          </dl>
        )}
        {wallet.error && wallet.data === null && (
          <ErrorLine text={wallet.error} onRetry={() => void wallet.reload()} />
        )}
        {walletUnits === 0n && (
          <p className="faucet">
            <button
              type="button"
              className="btn btn-quiet btn-sm"
              disabled={tx.busy !== null}
              onClick={async () => void after(await tx.run('fund', async () => faucetTransaction()))}
            >
              {tx.busy === 'fund' ? 'Confirm in wallet' : 'Get 1,000 test tUSDC'}
            </button>
          </p>
        )}
        </div>
      </section>

      <section className="wrap section section-first">
        <div className="forms">
          <AmountForm
            id="deposit"
            title="Deposit"
            action="Deposit"
            max={balances?.wallet ?? 0n}
            tx={tx}
            onSubmit={async (amount) =>
              after(await tx.run('deposit', () => prepareDeposit({ trader: accountId, amount })))
            }
          />
          <AmountForm
            id="withdraw"
            title="Withdraw"
            action="Withdraw"
            max={balances?.available ?? 0n}
            tx={tx}
            onSubmit={async (amount) =>
              after(await tx.run('withdraw', () => prepareWithdraw({ trader: accountId, amount })))
            }
          />
        </div>
        {tx.error && <ErrorLine text={tx.error} />}
      </section>

      {account.data ? (
        <History data={data} snap={market.data} />
      ) : (
        !account.error && (
          <section className="wrap section section-tight">
            <Skeleton className="skel-block" label="Loading your trades" />
          </section>
        )
      )}
    </>
  );
}

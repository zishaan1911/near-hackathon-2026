import { useCallback, useEffect, useState, type ChangeEvent, type FormEvent } from 'react';
import {
  getAccount,
  prepareCancel,
  prepareClaim,
  prepareDeposit,
  prepareWithdraw,
  type AccountView,
  type PreparedTransaction,
  type TradeView,
} from '../lib/api';
import { formatTokenAmount, parseTokenAmount } from '../lib/format';
import { useNear } from '../lib/near';
import { CONTRACT_SCALE } from './TradePage';

const POLL_INTERVAL_MS = 10_000;
const COLLATERAL_LABEL = 'tUSDC';

interface Notice {
  text: string;
  error: boolean;
}

function formatContracts(quantity: number): string {
  return (quantity / CONTRACT_SCALE).toFixed(2);
}

export function AccountPanel({ settled, currentMarketId }: { settled: boolean; currentMarketId?: string }) {
  const { accountId, signAndSend } = useNear();
  const [account, setAccount] = useState<AccountView | null>(null);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [depositInput, setDepositInput] = useState('');
  const [withdrawInput, setWithdrawInput] = useState('');

  const load = useCallback(async () => {
    if (!accountId) return;

    try {
      setAccount(await getAccount(accountId));
      setLoadError('');
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not load account');
    }
  }, [accountId]);

  useEffect(() => {
    if (!accountId) {
      setAccount(null);
      return;
    }

    void load();
    const timer = window.setInterval(() => void load(), POLL_INTERVAL_MS);

    return () => window.clearInterval(timer);
  }, [accountId, load]);

  if (!accountId) {
    return (
      <section className="card account-card">
        <div className="card-heading">
          <div>
            <span className="section-kicker">COLLATERAL</span>
            <h2>Account</h2>
          </div>
        </div>
        <div className="muted-empty">
          Connect a NEAR wallet to deposit collateral, manage orders and claim settlements.
        </div>
      </section>
    );
  }

  // Prepare through the gateway, have the wallet sign and send, then refresh.
  const run = async (
    key: string,
    prepare: () => Promise<PreparedTransaction>,
    done: string,
  ): Promise<boolean> => {
    setBusy(key);
    setNotice(null);

    try {
      const prepared = await prepare();
      setNotice({ text: 'Approved. Confirm the transaction in your NEAR wallet…', error: false });
      await signAndSend(prepared);
      setNotice({ text: done, error: false });
      await load();
      return true;
    } catch (err) {
      setNotice({ text: err instanceof Error ? err.message : 'Transaction failed', error: true });
      return false;
    } finally {
      setBusy(null);
    }
  };

  const handleDeposit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const amount = parseTokenAmount(depositInput);

    if (!amount || amount === '0') {
      setNotice({ text: `Enter a positive ${COLLATERAL_LABEL} amount with up to 6 decimals.`, error: true });
      return;
    }

    const ok = await run(
      'deposit',
      () => prepareDeposit({ trader: accountId, amount }),
      'Deposit submitted. Your balance updates once it is final.',
    );
    if (ok) setDepositInput('');
  };

  const handleWithdraw = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const amount = parseTokenAmount(withdrawInput);

    if (!amount || amount === '0') {
      setNotice({ text: `Enter a positive ${COLLATERAL_LABEL} amount with up to 6 decimals.`, error: true });
      return;
    }

    const ok = await run(
      'withdraw',
      () => prepareWithdraw({ trader: accountId, amount }),
      'Withdrawal submitted.',
    );
    if (ok) setWithdrawInput('');
  };

  const openOrders = account?.openOrders ?? [];
  const trades = account?.trades ?? [];

  return (
    <section className="card account-card">
      <div className="card-heading">
        <div>
          <span className="section-kicker">COLLATERAL</span>
          <h2>Account</h2>
        </div>
        <span className="section-note account-id" title={accountId}>{accountId}</span>
      </div>

      <div className="account-balances">
        <div>
          <span>Available</span>
          <strong>
            {account ? formatTokenAmount(account.available) : '—'} <small>{COLLATERAL_LABEL}</small>
          </strong>
        </div>
        <div>
          <span>Locked</span>
          <strong>
            {account ? formatTokenAmount(account.locked) : '—'} <small>{COLLATERAL_LABEL}</small>
          </strong>
        </div>
      </div>

      {loadError && <div className="inline-error">{loadError}</div>}

      <div className="account-forms">
        <form className="account-form" onSubmit={(event) => void handleDeposit(event)}>
          <label className="field">
            <span>Deposit <small>{COLLATERAL_LABEL}</small></span>
            <input
              inputMode="decimal"
              placeholder="0.00"
              value={depositInput}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setDepositInput(e.target.value)}
            />
          </label>
          <button className="button button-small button-primary" type="submit" disabled={busy !== null}>
            {busy === 'deposit' ? 'Processing…' : 'Deposit'}
          </button>
        </form>

        <form className="account-form" onSubmit={(event) => void handleWithdraw(event)}>
          <label className="field">
            <span>Withdraw <small>{COLLATERAL_LABEL}</small></span>
            <input
              inputMode="decimal"
              placeholder="0.00"
              value={withdrawInput}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setWithdrawInput(e.target.value)}
            />
          </label>
          <button className="button button-small" type="submit" disabled={busy !== null}>
            {busy === 'withdraw' ? 'Processing…' : 'Withdraw'}
          </button>
        </form>
      </div>

      <div className="account-list">
        <h3>Open orders</h3>
        {openOrders.length ? (
          <div className="positions-table-wrap">
            <table className="positions-table">
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Side</th>
                  <th>Price</th>
                  <th>Size</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {openOrders.map((order) => (
                  <tr key={order.orderId}>
                    <td>#{order.orderId}</td>
                    <td className={order.isBid ? 'positive-text' : 'negative-text'}>
                      {order.isBid ? 'Long' : 'Short'}
                    </td>
                    <td>{order.price}</td>
                    <td>{formatContracts(order.quantity)}</td>
                    <td>
                      <button
                        className="button button-small"
                        disabled={busy !== null}
                        onClick={() =>
                          void run(
                            `cancel-${order.orderId}`,
                            () => prepareCancel({ trader: accountId, orderId: order.orderId }),
                            'Cancel submitted.',
                          )
                        }
                      >
                        Cancel
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="positions-empty">
            <b>No open orders.</b>
          </div>
        )}
      </div>

      <div className="account-list">
        <h3>Trades</h3>
        {trades.length ? (
          <div className="positions-table-wrap">
            <table className="positions-table">
              <thead>
                <tr>
                  <th>Trade</th>
                  <th>Side</th>
                  <th>Price</th>
                  <th>Size</th>
                  <th>Settlement</th>
                </tr>
              </thead>
              <tbody>
                {trades.map((trade: TradeView) => {
                  const isBuyer = trade.buyer === accountId;
                  const claimed = isBuyer ? trade.buyerClaimed : trade.sellerClaimed;
                  // Trades from an earlier (rolled) market are claimable even
                  // though the current market is still live.
                  // currentMarketId is "<contract>#<n>"; trade.marketId is n.
                  const currentNumber = currentMarketId?.split('#').pop();
                  const fromEarlierMarket =
                    currentNumber !== undefined && String(trade.marketId) !== currentNumber;
                  const claimable = settled || fromEarlierMarket;

                  return (
                    <tr key={trade.tradeId}>
                      <td>#{trade.tradeId}</td>
                      <td className={isBuyer ? 'positive-text' : 'negative-text'}>
                        {isBuyer ? 'Long' : 'Short'}
                      </td>
                      <td>{trade.price}</td>
                      <td>{formatContracts(trade.quantity)}</td>
                      <td>
                        {claimed ? (
                          <span className="session-chip">Claimed</span>
                        ) : claimable ? (
                          <button
                            className="button button-small button-primary"
                            disabled={busy !== null}
                            onClick={() =>
                              void run(
                                `claim-${trade.tradeId}`,
                                () => prepareClaim({ trader: accountId, tradeId: trade.tradeId }),
                                'Claim submitted.',
                              )
                            }
                          >
                            Claim
                          </button>
                        ) : (
                          <span className="section-note">Awaiting settlement (this hour's market settles at expiry)</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="positions-empty">
            <b>No trades yet.</b>
          </div>
        )}
      </div>

      {notice && <div className={notice.error ? 'inline-error' : 'inline-message'}>{notice.text}</div>}
    </section>
  );
}

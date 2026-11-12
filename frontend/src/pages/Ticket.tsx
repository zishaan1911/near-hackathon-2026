import { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { formatClock, formatLevel, formatPoints } from '../compute/helpers';
import {
  getAccount,
  pokeMarket,
  prepareDeposit,
  prepareOrder,
  type MarketSnapshot,
} from '../lib/api';
import { formatTusdc } from '../lib/format';
import { txExplorerUrl, useNear } from '../lib/near';
import { buildDemoPlan, DEMO_MIN_TIME_LEFT_MS, demoDepositAmount, needsDemo } from '../lib/demo';
import { faucetTransaction, getWalletBalance } from '../lib/token';
import {
  defaultLimitPrice,
  findNewFill,
  formatContracts,
  GUIDED_STEPS,
  guidedState,
  isOnTick,
  marginBaseUnits,
  parseContracts,
  perPoint,
  stepSize,
  toOnChainQuantity,
  type GuidedStep,
  type Side,
} from '../lib/trade';
import { ErrorLine } from '../ui/bits';
import { SPRING_UI } from '../ui/motion';
import { useNow } from '../ui/useNow';
import type { AccountData } from '../wallet/useAccountData';
import { useTx } from '../wallet/useTx';

const FILL_POLL_MS = 5_000;
const FILL_WAIT_MS = 120_000;

const STEP_LABEL: Record<GuidedStep, string> = {
  connect: 'Connect',
  fund: 'Fund',
  deposit: 'Deposit',
  trade: 'Trade',
};

type Pending =
  | { status: 'waiting'; hash: string | null; known: Set<number>; started: number }
  | { status: 'filled'; hash: string | null; price: number }
  | { status: 'resting'; hash: string | null };

function Progress({ step }: { step: GuidedStep }) {
  const at = GUIDED_STEPS.indexOf(step);
  return (
    <ol className="progress" aria-label="Setup">
      {GUIDED_STEPS.map((s, i) => (
        <li
          key={s}
          className={i < at ? 'done' : i === at ? 'now' : undefined}
          aria-current={i === at ? 'step' : undefined}
        >
          <span className="progress-dot" aria-hidden="true" />
          <span className="progress-label">{STEP_LABEL[s]}</span>
        </li>
      ))}
    </ol>
  );
}

function TxLink({ hash }: { hash: string | null }) {
  if (!hash) return null;
  return (
    <a className="tx-link" href={txExplorerUrl(hash)} target="_blank" rel="noreferrer">
      View transaction
    </a>
  );
}

export function Ticket({
  snap,
  price: reference,
  data,
}: {
  snap: MarketSnapshot;
  price: number | null;
  data: AccountData;
}) {
  const near = useNear();
  const tx = useTx();
  const now = useNow(1000);
  const [side, setSide] = useState<Side>('long');
  const [sizeText, setSizeText] = useState('1');
  const [size, setSize] = useState(1);
  const [limitOpen, setLimitOpen] = useState(false);
  const [limitText, setLimitText] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);
  const [demoFailed, setDemoFailed] = useState(false);
  const limitInput = useRef<HTMLInputElement>(null);

  const { market, orderbook } = snap;
  const tick = market.tickSize ?? Number.NaN;
  const mult = market.contractMultiplier ?? Number.NaN;
  const rate = market.marginRate ?? Number.NaN;
  const autoPrice =
    reference === null
      ? null
      : defaultLimitPrice(side, reference, tick, {
          bestAsk: orderbook.asks[0]?.price,
          bestBid: orderbook.bids[0]?.price,
        });
  const typedLimit = Number(limitText.replace(/,/g, ''));
  const limitValid = limitOpen && limitText.trim() !== '' && isOnTick(typedLimit, tick);
  const price = limitOpen ? (limitValid ? typedLimit : null) : autoPrice;

  const margin = price !== null ? marginBaseUnits(price, size, mult, rate) : 0n;
  const pointValue = size * perPoint(mult);
  const expired = market.expiryMs !== undefined && market.expiryMs <= now;
  const open = !market.settled && !market.paused && !expired;
  const configured = [tick, mult, rate].every(Number.isFinite);

  const balances = data.balances;
  const refresh = data.refresh;
  const guided = guidedState({
    connected: near.accountId !== null,
    wallet: balances?.wallet ?? 0n,
    available: balances?.available ?? 0n,
    locked: balances?.locked ?? 0n,
    margin,
  });

  // Follow a signed order until it shows up in the account's trades.
  useEffect(() => {
    if (pending?.status !== 'waiting' || !near.accountId) return;
    const accountId = near.accountId;
    const { known, started, hash } = pending;
    let active = true;
    async function check() {
      void pokeMarket();
      try {
        const account = await getAccount(accountId);
        if (!active) return;
        const fill = findNewFill(account.trades, known, market.number);
        if (fill) {
          setPending({ status: 'filled', hash, price: fill.price });
          void refresh();
          return;
        }
      } catch {
        /* the next poll tries again */
      }
      if (active && Date.now() - started > FILL_WAIT_MS) setPending({ status: 'resting', hash });
    }
    const timer = window.setInterval(() => void check(), FILL_POLL_MS);
    void check();
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [pending, near.accountId, market.number, refresh]);

  function commitSize(text: string) {
    setSizeText(text);
    const parsed = parseContracts(text);
    if (parsed !== null) setSize(parsed);
  }

  function step(direction: 1 | -1) {
    const next = stepSize(size, direction);
    setSize(next);
    setSizeText(formatContracts(next));
  }

  function toggleLimit() {
    if (!limitOpen && autoPrice !== null) setLimitText(String(autoPrice));
    setLimitOpen((v) => !v);
    requestAnimationFrame(() => limitInput.current?.focus());
  }

  async function act() {
    const accountId = near.accountId;
    if (guided.step === 'connect' || !accountId) {
      near.connect();
      return;
    }
    if (guided.step === 'fund') {
      const ok = await tx.run('fund', async () => faucetTransaction());
      if (ok !== false) {
        void data.refresh();
        window.setTimeout(() => void data.refresh(), 3000);
      }
      return;
    }
    if (guided.step === 'deposit') {
      const amount = guided.deposit.toString();
      const ok = await tx.run('deposit', () => prepareDeposit({ trader: accountId, amount }));
      if (ok !== false) {
        void data.refresh();
        window.setTimeout(() => void data.refresh(), 3000);
      }
      return;
    }
    if (price === null) return;
    let known = new Set<number>();
    setPending(null);
    const hash = await tx.run('order', async () => {
      const before = await getAccount(accountId);
      known = new Set(before.trades.map((t) => t.tradeId));
      return prepareOrder({
        trader: accountId,
        isBid: side === 'long',
        price,
        quantity: toOnChainQuantity(size),
      });
    });
    if (hash === false) return;
    setPending({ status: 'waiting', hash, known, started: Date.now() });
    void data.refresh();
  }

  // The same default limit price the ticket uses for a long, whatever side is selected.
  const demoPrice =
    reference === null
      ? null
      : defaultLimitPrice('long', reference, tick, {
          bestAsk: orderbook.asks[0]?.price,
          bestBid: orderbook.bids[0]?.price,
        });
  const demoDeposit = demoPrice !== null ? demoDepositAmount(demoPrice, market) : '0';
  const demoBusy = tx.busy === 'demo';
  const showDemo =
    open &&
    configured &&
    !market.devMode &&
    (market.expiryMs === undefined || market.expiryMs - now > DEMO_MIN_TIME_LEFT_MS) &&
    demoPrice !== null &&
    demoDeposit !== '0' &&
    needsDemo(data.account.data, { connected: near.accountId !== null });

  async function demo() {
    const accountId = near.accountId;
    if (!accountId || demoPrice === null || demoDeposit === '0') return;
    let known = new Set<number>();
    setPending(null);
    setDemoFailed(false);
    const hash = await tx.run(
      'demo',
      async () => {
        const [before, walletBalance] = await Promise.all([getAccount(accountId), getWalletBalance(accountId)]);
        known = new Set(before.trades.map((t) => t.tradeId));
        const [depositTx, orderTx] = await Promise.all([
          prepareDeposit({ trader: accountId, amount: demoDeposit }),
          prepareOrder({ trader: accountId, isBid: true, price: demoPrice, quantity: toOnChainQuantity(1) }),
        ]);
        return buildDemoPlan({
          needsFaucet: BigInt(walletBalance) < BigInt(demoDeposit),
          faucetTx: faucetTransaction(),
          depositTx,
          orderTx,
        });
      },
      { batch: true },
    );
    if (hash === false) {
      setDemoFailed(true);
      return;
    }
    setPending({ status: 'waiting', hash, known, started: Date.now() });
    void data.refresh();
  }

  const loadingBalances = guided.step !== 'connect' && balances === null;
  let label: string;
  let tone = '';
  let disabled = tx.busy !== null;
  if (guided.step === 'connect') {
    label = near.ready ? 'Connect wallet' : 'Loading wallet';
    disabled = disabled || !near.ready;
  } else if (loadingBalances) {
    label = 'Checking balance';
    disabled = true;
  } else if (guided.step === 'fund') {
    label = tx.busy === 'fund' ? 'Confirm in your wallet' : 'Get 1,000 test tUSDC';
  } else if (guided.step === 'deposit') {
    label = tx.busy === 'deposit' ? 'Confirm in your wallet' : `Deposit ${formatTusdc(guided.deposit, true)} tUSDC`;
  } else if (!open) {
    label = market.settled ? 'Market settled' : 'Next market opens soon';
    disabled = true;
  } else {
    tone = side === 'long' ? 'btn-long' : 'btn-short';
    label = tx.busy === 'order' ? 'Confirm in your wallet' : side === 'long' ? 'Go long' : 'Go short';
    disabled = disabled || price === null || !configured;
  }

  const sizeError = parseContracts(sizeText) === null;
  const limitError = limitOpen && !limitValid;

  return (
    <aside className="ticket" aria-label="Order ticket">
      <div className="segmented" role="radiogroup" aria-label="Side">
        {(['long', 'short'] as const).map((s) => (
          <button
            key={s}
            type="button"
            role="radio"
            aria-checked={side === s}
            className={side === s ? 'on' : undefined}
            onClick={() => setSide(s)}
          >
            {side === s && (
              <motion.span layoutId="segment-pill" className="segment-pill" transition={SPRING_UI} />
            )}
            <span className="segment-text">{s === 'long' ? 'Long' : 'Short'}</span>
          </button>
        ))}
      </div>

      <div className="field">
        <label className="label" htmlFor="ticket-size">
          Size
        </label>
        <div className="stepper">
          <button type="button" onClick={() => step(-1)} aria-label="One contract less" disabled={size <= 1}>
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M3 8h10" />
            </svg>
          </button>
          <input
            id="ticket-size"
            className="num"
            inputMode="decimal"
            autoComplete="off"
            value={sizeText}
            aria-invalid={sizeError}
            aria-describedby="ticket-size-unit"
            onChange={(e) => commitSize(e.target.value)}
            onBlur={() => setSizeText(formatContracts(size))}
          />
          <span id="ticket-size-unit" className="stepper-unit muted">
            {size === 1 ? 'contract' : 'contracts'}
          </span>
          <button type="button" onClick={() => step(1)} aria-label="One contract more">
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M3 8h10M8 3v10" />
            </svg>
          </button>
        </div>
        {sizeError ? (
          <p className="field-note error-text">Use at least 0.01, with up to two decimals.</p>
        ) : size !== 1 ? (
          <p className="field-note muted">Demo liquidity fills 1-contract orders. Other sizes wait for a matching order.</p>
        ) : null}
      </div>

      <div className="field">
        <button type="button" className="row-button" aria-expanded={limitOpen} onClick={toggleLimit}>
          <span className="label">Limit price</span>
          <span className="num muted">{limitOpen ? 'Reset' : autoPrice !== null ? `${formatPoints(autoPrice)} · Edit` : 'n/a'}</span>
        </button>
        {limitOpen && (
          <>
            <input
              ref={limitInput}
              className="input num"
              inputMode="numeric"
              autoComplete="off"
              aria-label="Limit price"
              aria-invalid={limitError}
              value={limitText}
              onChange={(e) => setLimitText(e.target.value)}
            />
            {limitError && (
              <p className="field-note error-text">
                Use a multiple of {Number.isFinite(tick) ? formatPoints(tick) : 1}.
              </p>
            )}
          </>
        )}
      </div>

      <dl className="summary num">
        <div>
          <dt>Margin required</dt>
          <dd>{price !== null && configured ? `${formatTusdc(margin)} tUSDC` : 'n/a'}</dd>
        </div>
        <div>
          <dt>Gain/loss per index point</dt>
          <dd>{Number.isFinite(pointValue) ? `${formatLevel(pointValue, Number.isInteger(pointValue) ? 0 : 2)} tUSDC` : 'n/a'}</dd>
        </div>
        <div>
          <dt>Settles at</dt>
          <dd>{market.expiryMs !== undefined ? formatClock(market.expiryMs) : 'n/a'}</dd>
        </div>
      </dl>

      <button
        type="button"
        className={`btn btn-lg btn-block ${tone}`}
        disabled={disabled}
        onClick={() => void act()}
      >
        {label}
      </button>

      {showDemo && (
        <button
          type="button"
          className="btn btn-outline btn-block demo-trade"
          disabled={tx.busy !== null}
          onClick={() => void demo()}
        >
          Try a demo trade
        </button>
      )}

      <Progress step={guided.step} />

      <div className="ticket-status" aria-live="polite">
        {demoBusy && (
          <p className="status-line">
            <span className="spinner" aria-hidden="true" />
            Getting test tUSDC, depositing and going long 1 contract…
          </p>
        )}
        {tx.error && demoFailed && <ErrorLine text={tx.error} onRetry={() => void demo()} />}
        {tx.error && !demoFailed && <ErrorLine text={tx.error} />}
        {data.account.error && guided.step !== 'connect' && !data.account.data && (
          <ErrorLine text={data.account.error} onRetry={() => void data.refresh()} />
        )}
        {!tx.error && tx.done?.key === 'fund' && guided.step === 'fund' && (
          <p className="muted small">Tokens on the way. Your balance updates in a moment.</p>
        )}
        {pending?.status === 'waiting' && (
          <p className="status-line">
            <span className="spinner" aria-hidden="true" />
            Order placed. Waiting for a match. <TxLink hash={pending.hash} />
          </p>
        )}
        {pending?.status === 'filled' && (
          <p className="status-line">
            <span className="tick" aria-hidden="true" />
            Filled at {formatPoints(pending.price)}. <TxLink hash={pending.hash} />
          </p>
        )}
        {pending?.status === 'resting' && (
          <p className="status-line muted">
            Your order rests in the book until someone matches it. <TxLink hash={pending.hash} />
          </p>
        )}
      </div>
    </aside>
  );
}

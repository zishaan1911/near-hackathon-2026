/** Pure logic for the "Try a demo trade" button. No React, no network. */
import type { AccountView, PreparedTransaction } from './api';
import { marginBaseUnits, TOKEN_DECIMALS } from './trade';

const TOKEN_UNIT = 10n ** BigInt(TOKEN_DECIMALS);

/** The button hides this close to expiry. */
export const DEMO_MIN_TIME_LEFT_MS = 2 * 60_000;

/** Whether the account is brand new: nothing deposited, no orders, no trades. */
export function needsDemo(
  account: Pick<AccountView, 'available' | 'locked' | 'openOrders' | 'trades'> | null | undefined,
  wallet: { connected: boolean },
): boolean {
  if (!wallet.connected || !account) return false;
  const deposited = BigInt(/^\d+$/.test(account.available) ? account.available : '0') +
    BigInt(/^\d+$/.test(account.locked) ? account.locked : '0');
  return deposited === 0n && account.openOrders.length === 0 && account.trades.length === 0;
}

/**
 * Deposit for the demo, in base units: the margin of one contract plus a 5%
 * buffer, rounded up to a whole tUSDC. "0" when the margin is unknown.
 */
export function demoDepositAmount(
  price: number,
  market: { contractMultiplier?: number; marginRate?: number },
): string {
  const margin = marginBaseUnits(
    price,
    1,
    market.contractMultiplier ?? Number.NaN,
    market.marginRate ?? Number.NaN,
  );
  if (margin === 0n) return '0';
  const buffered = (margin * 105n + 99n) / 100n;
  return (((buffered + TOKEN_UNIT - 1n) / TOKEN_UNIT) * TOKEN_UNIT).toString();
}

/**
 * The transactions to sign: faucet and deposit share the token contract, so
 * they become one transaction with two actions; the order follows.
 */
export function buildDemoPlan(input: {
  needsFaucet: boolean;
  faucetTx: PreparedTransaction;
  depositTx: PreparedTransaction;
  orderTx: PreparedTransaction;
}): PreparedTransaction[] {
  const { needsFaucet, faucetTx, depositTx, orderTx } = input;
  if (!needsFaucet) return [depositTx, orderTx];
  if (faucetTx.receiverId !== depositTx.receiverId) return [faucetTx, depositTx, orderTx];
  return [
    {
      receiverId: depositTx.receiverId,
      actions: [...faucetTx.actions, ...depositTx.actions],
      summary: { ...faucetTx.summary, ...depositTx.summary },
    },
    orderTx,
  ];
}

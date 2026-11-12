import { useCallback } from 'react';
import { getAccount, getMarket, type AccountView, type MarketSnapshot } from '../lib/api';
import { useNear } from '../lib/near';
import { getWalletBalance } from '../lib/token';
import { toBig } from '../lib/trade';
import { usePolled, type Polled } from '../lib/usePolled';

const MARKET_MS = 5_000;
const ACCOUNT_MS = 10_000;
const WALLET_MS = 15_000;

export function useMarket(): Polled<MarketSnapshot> {
  return usePolled(getMarket, MARKET_MS);
}

export interface AccountData {
  accountId: string | null;
  account: Polled<AccountView>;
  /** Wallet tUSDC in base units; null until known. */
  wallet: Polled<string>;
  balances: { wallet: bigint; available: bigint; locked: bigint } | null;
  /** Re-reads the account and the wallet balance, e.g. after a transaction. */
  refresh: () => Promise<void>;
}

/** The connected account's deposits, orders, trades and wallet balance. */
export function useAccountData(): AccountData {
  const { accountId } = useNear();
  const account = usePolled(accountId ? () => getAccount(accountId) : null, ACCOUNT_MS, accountId ?? '');
  const wallet = usePolled(
    accountId ? () => getWalletBalance(accountId) : null,
    WALLET_MS,
    accountId ?? '',
  );
  const { reload: reloadAccount } = account;
  const { reload: reloadWallet } = wallet;
  const refresh = useCallback(async () => {
    await Promise.all([reloadAccount(), reloadWallet()]);
  }, [reloadAccount, reloadWallet]);

  const balances =
    account.data && wallet.data !== null
      ? {
          wallet: toBig(wallet.data),
          available: toBig(account.data.available),
          locked: toBig(account.data.locked),
        }
      : null;

  return { accountId, account, wallet, balances, refresh };
}

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  getActiveAccount,
  internalActionToNaj,
  setupWalletSelector,
} from '@near-wallet-selector/core';
import { setupModal } from '@near-wallet-selector/modal-ui';
import '@near-wallet-selector/modal-ui/styles.css';
import { setupHereWallet } from '@near-wallet-selector/here-wallet';
import { setupMeteorWallet } from '@near-wallet-selector/meteor-wallet';
import { setupMyNearWallet } from '@near-wallet-selector/my-near-wallet';
import type { PreparedTransaction } from './api';

export const NEAR_NETWORK: 'testnet' | 'mainnet' =
  import.meta.env.VITE_NEAR_NETWORK === 'mainnet' ? 'mainnet' : 'testnet';

const EXPLORER_HOST = NEAR_NETWORK === 'mainnet' ? 'nearblocks.io' : 'testnet.nearblocks.io';

export function txExplorerUrl(hash: string): string {
  return `https://${EXPLORER_HOST}/txns/${hash}`;
}

function createSelection() {
  return setupWalletSelector({
    network: NEAR_NETWORK,
    modules: [setupMyNearWallet(), setupMeteorWallet(), setupHereWallet()],
  }).then((selector) => ({
    selector,
    modal: setupModal(selector, {
      theme: 'auto',
      description: 'Connect a NEAR testnet wallet to trade on Silica.',
    }),
  }));
}

type Selection = Awaited<ReturnType<typeof createSelection>>;

// Wallet selector must only be initialised once per page, even though React
// StrictMode mounts the provider twice in development.
let selectionPromise: ReturnType<typeof createSelection> | undefined;

function loadSelection() {
  selectionPromise ??= createSelection();
  return selectionPromise;
}

interface NearContextValue {
  ready: boolean;
  accountId: string | null;
  connect: () => void;
  disconnect: () => Promise<void>;
  /** Resolves with the transaction hash when the wallet reports one. */
  signAndSend: (prepared: PreparedTransaction) => Promise<string | null>;
  /** Signs several transactions in one approval; resolves with the last hash when reported. */
  signAndSendMany: (prepared: PreparedTransaction[]) => Promise<string | null>;
}

const NearContext = createContext<NearContextValue | null>(null);

export function NearProvider({ children }: { children: ReactNode }) {
  const [selection, setSelection] = useState<Selection | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let subscription: { unsubscribe(): void } | undefined;

    loadSelection()
      .then((next) => {
        if (!active) return;
        setSelection(next);
        subscription = next.selector.store.observable.subscribe((state) => {
          setAccountId(getActiveAccount(state)?.accountId ?? null);
        });
      })
      .catch((error: unknown) => console.error('NEAR wallet setup failed', error));

    return () => {
      active = false;
      subscription?.unsubscribe();
    };
  }, []);

  const connect = useCallback(() => {
    selection?.modal.show();
  }, [selection]);

  const disconnect = useCallback(async () => {
    if (!selection) return;
    const wallet = await selection.selector.wallet();
    await wallet.signOut();
  }, [selection]);

  const signAndSend = useCallback(
    async (prepared: PreparedTransaction): Promise<string | null> => {
      if (!selection) throw new Error('The NEAR wallet is still loading. Try again in a moment.');

      const wallet = await selection.selector.wallet();
      const outcome = await wallet.signAndSendTransaction({
        receiverId: prepared.receiverId,
        actions: prepared.actions.map(internalActionToNaj),
      });

      if (!outcome) return null;
      const hash: unknown = outcome.transaction?.hash;
      return typeof hash === 'string' ? hash : null;
    },
    [selection],
  );

  const signAndSendMany = useCallback(
    async (prepared: PreparedTransaction[]): Promise<string | null> => {
      if (!selection) throw new Error('The NEAR wallet is still loading. Try again in a moment.');
      if (prepared.length === 0) return null;

      const wallet = await selection.selector.wallet();
      let outcomes;
      try {
        outcomes = await wallet.signAndSendTransactions({
          transactions: prepared.map((p) => ({
            receiverId: p.receiverId,
            actions: p.actions.map(internalActionToNaj),
          })),
        });
      } catch (error) {
        // Some wallets cannot batch; fall back to one approval per transaction.
        const text = error instanceof Error ? error.message : '';
        const unsupported =
          error instanceof TypeError || /not\s+(supported|implemented)|unsupported|does not support/i.test(text);
        if (!unsupported) throw error;
        let hash: string | null = null;
        for (const item of prepared) hash = await signAndSend(item);
        return hash;
      }

      const last = Array.isArray(outcomes) ? outcomes[outcomes.length - 1] : null;
      const hash: unknown = last?.transaction?.hash;
      return typeof hash === 'string' ? hash : null;
    },
    [selection, signAndSend],
  );

  const value = useMemo<NearContextValue>(
    () => ({
      ready: selection !== null,
      accountId,
      connect,
      disconnect,
      signAndSend,
      signAndSendMany,
    }),
    [selection, accountId, connect, disconnect, signAndSend, signAndSendMany],
  );

  return <NearContext.Provider value={value}>{children}</NearContext.Provider>;
}

export function useNear(): NearContextValue {
  const value = useContext(NearContext);
  if (!value) throw new Error('useNear must be used inside <NearProvider>');
  return value;
}

import { useCallback, useRef, useState } from 'react';
import type { PreparedTransaction } from '../lib/api';
import { useNear } from '../lib/near';
import { errorLine } from '../lib/trade';

export interface TxState {
  /** Key of the action in flight, or null. */
  busy: string | null;
  error: string;
  /** Key and hash of the last action that went through. */
  done: { key: string; hash: string | null } | null;
}

export interface TxRunner extends TxState {
  /**
   * Prepares and signs one or more transactions. Resolves with the last
   * hash (or null when the wallet reports none), or false when it failed.
   */
  run: (
    key: string,
    build: () => Promise<PreparedTransaction | PreparedTransaction[]>,
  ) => Promise<string | null | false>;
  clear: () => void;
}

/** One wallet action at a time, with its status and a short error line. */
export function useTx(): TxRunner {
  const { signAndSend } = useNear();
  const [state, setState] = useState<TxState>({ busy: null, error: '', done: null });
  const inFlight = useRef(false);

  const run = useCallback<TxRunner['run']>(
    async (key, build) => {
      if (inFlight.current) return false;
      inFlight.current = true;
      setState({ busy: key, error: '', done: null });
      try {
        const prepared = await build();
        let hash: string | null = null;
        for (const tx of Array.isArray(prepared) ? prepared : [prepared]) {
          hash = await signAndSend(tx);
        }
        setState({ busy: null, error: '', done: { key, hash } });
        return hash;
      } catch (e) {
        setState({ busy: null, error: errorLine(e, 'The wallet did not send it. Try again.'), done: null });
        return false;
      } finally {
        inFlight.current = false;
      }
    },
    [signAndSend],
  );

  const clear = useCallback(() => setState({ busy: null, error: '', done: null }), []);

  return { ...state, run, clear };
}

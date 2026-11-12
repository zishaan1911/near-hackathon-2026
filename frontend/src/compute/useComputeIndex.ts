import { useCallback, useEffect, useRef, useState } from 'react';
import { getComputeIndex, type ComputeIndexResponse } from '../lib/api';
import { errorLine } from '../lib/trade';

const POLL_MS = 30_000;

export interface ComputeIndexState {
  data: ComputeIndexResponse | null;
  loading: boolean;
  error: string;
  retry: () => void;
}

/** Polls the index. A failed poll keeps the last good data and reports the error. */
export function useComputeIndex(): ComputeIndexState {
  const [data, setData] = useState<ComputeIndexResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // Only the newest request may write state, so a slow response can't overwrite a newer one.
  const latest = useRef(0);

  const load = useCallback(async () => {
    const id = ++latest.current;
    try {
      const next = await getComputeIndex();
      if (id !== latest.current) return;
      setData(next);
      setError('');
    } catch (e) {
      if (id !== latest.current) return;
      setError(errorLine(e, 'The index did not load.'));
    } finally {
      if (id === latest.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => {
      window.clearInterval(timer);
      latest.current += 1;
    };
  }, [load]);

  const retry = useCallback(() => {
    setLoading(true);
    void load();
  }, [load]);

  return { data, loading, error, retry };
}

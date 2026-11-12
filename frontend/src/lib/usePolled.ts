import { useCallback, useEffect, useRef, useState } from 'react';
import { errorLine } from './trade';

export interface Polled<T> {
  data: T | null;
  loading: boolean;
  error: string;
  reload: () => Promise<void>;
}

/**
 * Loads a value and re-loads it on an interval. A failed poll keeps the last
 * good value and reports the error; only the newest request may write state.
 * Pass `null` as the loader to switch it off; change `key` to start afresh.
 */
export function usePolled<T>(
  load: (() => Promise<T>) | null,
  intervalMs: number,
  key = '',
): Polled<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(load !== null);
  const [error, setError] = useState('');
  const latest = useRef(0);
  const loader = useRef(load);
  loader.current = load;
  const enabled = load !== null;

  const reload = useCallback(async () => {
    const fn = loader.current;
    if (!fn) return;
    const id = ++latest.current;
    try {
      const next = await fn();
      if (id !== latest.current) return;
      setData(next);
      setError('');
    } catch (e) {
      if (id !== latest.current) return;
      setError(errorLine(e, 'Could not load. Check your connection.'));
    } finally {
      if (id === latest.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    setData(null);
    setError('');
    setLoading(enabled);
    if (!enabled) return;
    void reload();
    const timer = window.setInterval(() => {
      if (!document.hidden) void reload();
    }, intervalMs);
    return () => {
      window.clearInterval(timer);
      latest.current += 1;
    };
  }, [enabled, intervalMs, key, reload]);

  return { data, loading, error, reload };
}

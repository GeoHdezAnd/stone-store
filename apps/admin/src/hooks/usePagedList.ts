import { useCallback, useEffect, useRef, useState } from 'react';
import type { Page } from '../api/catalogApi';

export type ListStatus = 'loading' | 'ready' | 'error';

/**
 * Lista paginada por cursor. `fetchPage` debe ser estable (useCallback/useMemo).
 * Un fallo en la primera página deja `status: 'error'`; uno al cargar más conserva
 * lo ya cargado y solo llena `error`.
 */
export function usePagedList<T>(fetchPage: (cursor: string | null) => Promise<Page<T>>) {
  const [items, setItems] = useState<T[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<ListStatus>('loading');
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const run = useRef(0);

  const load = useCallback(
    async (from: string | null) => {
      const id = ++run.current;
      if (from === null) setStatus('loading');
      else setLoadingMore(true);
      try {
        const page = await fetchPage(from);
        if (id !== run.current) return;
        setItems((prev) => (from === null ? page.items : [...prev, ...page.items]));
        setCursor(page.nextCursor);
        setError(null);
        setStatus('ready');
      } catch (err) {
        if (id !== run.current) return;
        setError(err);
        if (from === null) setStatus('error');
      } finally {
        if (id === run.current) setLoadingMore(false);
      }
    },
    [fetchPage],
  );

  useEffect(() => {
    void load(null);
    return () => {
      run.current += 1; // descarta respuestas de peticiones viejas
    };
  }, [load]);

  return {
    items,
    status,
    error,
    loadingMore,
    hasMore: cursor !== null,
    loadMore: () => (cursor === null ? Promise.resolve() : load(cursor)),
    reload: () => load(null),
  };
}

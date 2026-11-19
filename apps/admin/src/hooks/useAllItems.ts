import { useEffect } from 'react';
import { useCatalogApi } from './useCatalogApi';
import { usePagedList } from './usePagedList';

/**
 * Carga TODAS las páginas de `/admin/<segment>` (para selectores que necesitan todas las
 * opciones). `status`: `loading` hasta tener todo; `error` si falla cualquier página.
 */
export function useAllItems<T>(segment: string) {
  const api = useCatalogApi<T>(segment);
  const list = usePagedList(api.list);
  const { status, hasMore, loadingMore, loadMore, error } = list;

  useEffect(() => {
    if (status === 'ready' && hasMore && !loadingMore && !error) void loadMore();
  }, [status, hasMore, loadingMore, loadMore, error]);

  const failed = status === 'error' || error !== null;
  return {
    items: list.items,
    status: failed
      ? ('error' as const)
      : status === 'loading' || hasMore
        ? ('loading' as const)
        : ('ready' as const),
    error,
    reload: list.reload,
  };
}

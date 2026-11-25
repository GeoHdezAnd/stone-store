import { useCallback, useEffect, useRef, useState } from 'react';

type State<T> =
  { status: 'loading' } | { status: 'ready'; data: T } | { status: 'error'; error: unknown };

/**
 * Carga un recurso al montar y cuando cambia `load` (debe ser estable: useCallback).
 * Descarta respuestas de cargas anteriores. `reload` reintenta.
 */
export function useAsyncResource<T>(load: () => Promise<T>) {
  const [state, setState] = useState<State<T>>({ status: 'loading' });
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<unknown>(null);
  const run = useRef(0);

  const start = useCallback(() => {
    const id = ++run.current;
    setRefreshing(false);
    setRefreshError(null);
    setState({ status: 'loading' });
    load().then(
      (data) => {
        if (id === run.current) setState({ status: 'ready', data });
      },
      (error: unknown) => {
        if (id === run.current) setState({ status: 'error', error });
      },
    );
  }, [load]);

  useEffect(() => {
    start();
    return () => {
      run.current += 1;
    };
  }, [start]);

  /**
   * Vuelve a cargar sin pasar por «cargando»: conserva lo mostrado hasta tener lo nuevo. Si falla
   * (p. ej. 429) NO lanza: deja el error en `refreshError` para que la pantalla lo avise, y lo
   * mostrado se conserva. `refreshing` es true mientras recarga (para desactivar el botón).
   */
  const refresh = useCallback(async () => {
    const id = ++run.current;
    setRefreshing(true);
    setRefreshError(null);
    try {
      const data = await load();
      if (id === run.current) setState({ status: 'ready', data });
    } catch (error) {
      if (id === run.current) setRefreshError(error);
    } finally {
      if (id === run.current) setRefreshing(false);
    }
  }, [load]);

  return { state, reload: start, refresh, refreshing, refreshError };
}

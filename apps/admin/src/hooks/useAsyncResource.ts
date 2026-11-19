import { useCallback, useEffect, useRef, useState } from 'react';

type State<T> =
  { status: 'loading' } | { status: 'ready'; data: T } | { status: 'error'; error: unknown };

/**
 * Carga un recurso al montar y cuando cambia `load` (debe ser estable: useCallback).
 * Descarta respuestas de cargas anteriores. `reload` reintenta.
 */
export function useAsyncResource<T>(load: () => Promise<T>) {
  const [state, setState] = useState<State<T>>({ status: 'loading' });
  const run = useRef(0);

  const start = useCallback(() => {
    const id = ++run.current;
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

  return { state, reload: start };
}

import { useCallback, useRef, useState } from 'react';

/**
 * Ejecuta una acción asíncrona evitando dobles envíos; expone `pending`.
 * Un `useRef` hace de candado real: dos clics en el mismo tick (antes de que el estado se
 * actualice) comparten la misma ejecución en lugar de lanzar la acción dos veces.
 */
export function useAsyncAction() {
  const [pending, setPending] = useState(false);
  const inflight = useRef<Promise<unknown> | null>(null);

  const run = useCallback(<R>(action: () => Promise<R>): Promise<R> => {
    if (inflight.current) return inflight.current as Promise<R>;
    setPending(true);
    const promise = (async () => {
      try {
        return await action();
      } finally {
        inflight.current = null;
        setPending(false);
      }
    })();
    inflight.current = promise;
    return promise;
  }, []);
  return { pending, run };
}

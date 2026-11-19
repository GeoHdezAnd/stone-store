import { useCallback, useState } from 'react';

/** Ejecuta una acción asíncrona evitando dobles envíos; expone `pending`. */
export function useAsyncAction() {
  const [pending, setPending] = useState(false);
  const run = useCallback(async <R>(action: () => Promise<R>): Promise<R> => {
    setPending(true);
    try {
      return await action();
    } finally {
      setPending(false);
    }
  }, []);
  return { pending, run };
}

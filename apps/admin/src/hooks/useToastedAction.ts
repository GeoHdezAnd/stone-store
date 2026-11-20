import { useCallback, useRef } from 'react';
import { describeError } from '../api/errors';
import { useToast } from '../toast/ToastContext';
import { useAsyncAction } from './useAsyncAction';

interface ToastedMessages<R> {
  /** Texto mientras la petición está en curso. */
  loading: string;
  /** Texto de éxito; puede depender del resultado. */
  success: string | ((result: R) => string);
  /** Texto de error si el de por defecto (`describeError`) no es el adecuado. */
  error?: (err: unknown) => string;
}

/**
 * Ejecuta una acción mostrando un toast que pasa de «cargando» a éxito o error.
 * Si falla, el error se relanza para que quien llama lo muestre donde corresponda (p. ej. campos).
 */
export function useToastedAction() {
  const { notify, update } = useToast();
  const { pending, run } = useAsyncAction();
  // Candado contra dobles envíos: un segundo clic comparte la ejecución (y el toast) en curso.
  const inflight = useRef<Promise<unknown> | null>(null);

  const runToasted = useCallback(
    <R>(action: () => Promise<R>, messages: ToastedMessages<R>): Promise<R> => {
      if (inflight.current) return inflight.current as Promise<R>;
      const promise = (async () => {
        const id = notify({ kind: 'loading', message: messages.loading });
        try {
          const result = await run(action);
          update(id, {
            kind: 'success',
            message:
              typeof messages.success === 'function' ? messages.success(result) : messages.success,
          });
          return result;
        } catch (err) {
          update(id, { kind: 'error', message: (messages.error ?? describeError)(err) });
          throw err;
        } finally {
          inflight.current = null;
        }
      })();
      inflight.current = promise;
      return promise;
    },
    [notify, update, run],
  );

  return { pending, run: runToasted };
}

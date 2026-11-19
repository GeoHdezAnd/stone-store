import { createContext, useCallback, useContext, useMemo, useReducer, useRef } from 'react';
import type { ReactNode } from 'react';
import { Toaster } from '../components/Toaster';
import { resolveToast, toastReducer } from './toastReducer';
import type { ToastInput } from './toastReducer';

interface ToastApi {
  /** Muestra un toast y devuelve su id. */
  notify: (input: ToastInput) => number;
  /**
   * Reemplaza el contenido de un toast (p. ej. de «cargando» a éxito o error). Si la persona
   * ya lo cerró, el resultado se muestra como un toast nuevo con el mismo id.
   */
  update: (id: number, input: ToastInput) => void;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

/** Estado global de toasts. Va por encima del router para sobrevivir a la navegación. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, dispatch] = useReducer(toastReducer, []);
  const nextId = useRef(1);

  const notify = useCallback((input: ToastInput) => {
    const id = nextId.current++;
    dispatch({ type: 'upsert', toast: resolveToast(id, input) });
    return id;
  }, []);
  const update = useCallback(
    (id: number, input: ToastInput) => dispatch({ type: 'upsert', toast: resolveToast(id, input) }),
    [],
  );
  const dismiss = useCallback((id: number) => dispatch({ type: 'dismiss', id }), []);

  const api = useMemo(() => ({ notify, update, dismiss }), [notify, update, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <Toaster toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast debe usarse dentro de <ToastProvider>.');
  return ctx;
}

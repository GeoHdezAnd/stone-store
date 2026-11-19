import { useCallback, useEffect, useRef } from 'react';
import { ToastIcon } from './ToastIcon';
import type { ToastItem } from '../toast/toastReducer';

interface ToasterProps {
  toasts: readonly ToastItem[];
  onDismiss: (id: number) => void;
  dismissLabel?: string;
}

/**
 * Presentación de los toasts. Las regiones viven siempre en el DOM (requisito para que los
 * lectores de pantalla anuncien los cambios): `status` para éxito/info y `alert` para errores.
 * No roba el foco.
 */
export function Toaster({ toasts, onDismiss, dismissLabel = 'Cerrar aviso' }: ToasterProps) {
  const polite = toasts.filter((t) => t.kind !== 'error');
  const errors = toasts.filter((t) => t.kind === 'error');
  return (
    <div className="toaster">
      <div role="status" aria-live="polite">
        {polite.map((t) => (
          <Toast
            key={`${t.id}-${t.kind}`}
            toast={t}
            onDismiss={onDismiss}
            dismissLabel={dismissLabel}
          />
        ))}
      </div>
      <div role="alert">
        {errors.map((t) => (
          <Toast
            key={`${t.id}-${t.kind}`}
            toast={t}
            onDismiss={onDismiss}
            dismissLabel={dismissLabel}
          />
        ))}
      </div>
    </div>
  );
}

function Toast({
  toast,
  onDismiss,
  dismissLabel,
}: {
  toast: ToastItem;
  onDismiss: (id: number) => void;
  dismissLabel: string;
}) {
  const remaining = useRef(toast.durationMs ?? 0);
  const startedAt = useRef(0);
  const timer = useRef<number | undefined>(undefined);

  const resume = useCallback(() => {
    if (timer.current !== undefined || toast.durationMs === null) return;
    startedAt.current = Date.now();
    timer.current = window.setTimeout(() => onDismiss(toast.id), remaining.current);
  }, [onDismiss, toast.id, toast.durationMs]);

  const pause = useCallback(() => {
    if (timer.current === undefined) return;
    window.clearTimeout(timer.current);
    timer.current = undefined;
    // Al reanudar queda al menos 1 s para poder leerlo.
    remaining.current = Math.max(1000, remaining.current - (Date.now() - startedAt.current));
  }, []);

  useEffect(() => {
    resume();
    return () => {
      window.clearTimeout(timer.current);
      timer.current = undefined;
    };
  }, [resume]);

  return (
    <div
      className={`toast toast-${toast.kind}`}
      onMouseEnter={pause}
      onMouseLeave={resume}
      onFocus={pause}
      onBlur={resume}
    >
      <span className="toast-badge">
        <ToastIcon kind={toast.kind} />
      </span>
      <div className="toast-body">
        <p className="toast-title">{toast.title}</p>
        {toast.message ? <p className="toast-message">{toast.message}</p> : null}
      </div>
      <button
        type="button"
        className="toast-close"
        aria-label={dismissLabel}
        onClick={() => onDismiss(toast.id)}
      >
        ×
      </button>
    </div>
  );
}

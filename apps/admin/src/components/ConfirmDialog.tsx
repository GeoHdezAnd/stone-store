import { useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Diálogo de confirmación modal sobre <dialog>: el navegador atrapa el foco, cierra con Esc
 * y lo devuelve al elemento que lo abrió. El foco inicial va a «Cancelar» (acción segura).
 */
export function ConfirmDialog(props: ConfirmDialogProps) {
  return props.open ? <OpenDialog {...props} /> : null;
}

function OpenDialog({
  title,
  children,
  confirmLabel,
  cancelLabel = 'Cancelar',
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault(); // el padre decide si se cierra
        if (!busy) onCancel();
      }}
    >
      <h2 className="dialog-title" id={titleId}>
        {title}
      </h2>
      <div className="dialog-body">{children}</div>
      <div className="dialog-actions">
        <button
          type="button"
          className="btn btn-secondary"
          autoFocus
          onClick={onCancel}
          disabled={busy}
        >
          {cancelLabel}
        </button>
        <button type="button" className="btn btn-primary" onClick={onConfirm} disabled={busy}>
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}

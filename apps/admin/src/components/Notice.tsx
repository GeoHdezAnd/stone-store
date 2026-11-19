import type { ReactNode } from 'react';

/** Aviso de resultado. Los errores se anuncian con `alert`; el resto con `status`. */
export function Notice({
  tone = 'info',
  children,
  onDismiss,
  dismissLabel = 'Cerrar aviso',
}: {
  tone?: 'info' | 'error';
  children: ReactNode;
  onDismiss?: () => void;
  dismissLabel?: string;
}) {
  return (
    <div
      className={tone === 'error' ? 'notice notice-error' : 'notice'}
      role={tone === 'error' ? 'alert' : 'status'}
    >
      <span>{children}</span>
      {onDismiss ? (
        <button type="button" className="link-btn" onClick={onDismiss} aria-label={dismissLabel}>
          ×
        </button>
      ) : null}
    </div>
  );
}

import type { ToastKind } from '../toast/toastReducer';

/** Ícono del tipo de toast. Decorativo: el significado también va en el título. */
export function ToastIcon({ kind }: { kind: ToastKind }) {
  const common = {
    width: 18,
    height: 18,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2.5,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    focusable: false,
  };
  switch (kind) {
    case 'success':
      return (
        <svg {...common}>
          <path d="M5 12.5l4.5 4.5L19 7.5" />
        </svg>
      );
    case 'error':
      return (
        <svg {...common}>
          <path d="M12 5v9" />
          <path d="M12 19h.01" />
        </svg>
      );
    case 'info':
      return (
        <svg {...common}>
          <path d="M12 11v8" />
          <path d="M12 5h.01" />
        </svg>
      );
    case 'loading':
      // Con reduced-motion el CSS no anima y queda como un arco estático.
      return (
        <svg {...common} className="toast-spinner">
          <path d="M12 3a9 9 0 1 0 9 9" />
        </svg>
      );
  }
}

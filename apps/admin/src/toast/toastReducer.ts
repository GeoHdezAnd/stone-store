export type ToastKind = 'success' | 'error' | 'info' | 'loading';

export interface ToastInput {
  kind: ToastKind;
  /** Si falta se usa el título por defecto del tipo. */
  title?: string;
  message?: string;
  /** Milisegundos hasta el autocierre. `loading` nunca se cierra solo. */
  durationMs?: number;
}

export interface ToastItem {
  id: number;
  kind: ToastKind;
  title: string;
  message?: string;
  /** `null` = sin autocierre. */
  durationMs: number | null;
}

export type ToastAction = { type: 'upsert'; toast: ToastItem } | { type: 'dismiss'; id: number };

/** Máximo de toasts visibles; al pasarse se descartan los más antiguos. */
export const MAX_VISIBLE = 3;

export const DEFAULT_TITLE: Record<ToastKind, string> = {
  success: 'Éxito',
  error: 'Error',
  info: 'Información',
  loading: 'Cargando…',
};

const DEFAULT_DURATION_MS: Record<ToastKind, number | null> = {
  success: 4000,
  info: 4000,
  error: 8000,
  loading: null,
};

export function resolveToast(id: number, input: ToastInput): ToastItem {
  const item: ToastItem = {
    id,
    kind: input.kind,
    title: input.title ?? DEFAULT_TITLE[input.kind],
    durationMs:
      input.kind === 'loading' ? null : (input.durationMs ?? DEFAULT_DURATION_MS[input.kind]),
  };
  if (input.message !== undefined) item.message = input.message;
  return item;
}

export function toastReducer(state: readonly ToastItem[], action: ToastAction): ToastItem[] {
  switch (action.type) {
    case 'upsert': {
      // Si ya existe se reemplaza en su lugar (p. ej. loading -> éxito); si no, se agrega.
      const exists = state.some((t) => t.id === action.toast.id);
      const next = exists
        ? state.map((t) => (t.id === action.toast.id ? action.toast : t))
        : [...state, action.toast];
      return next.slice(-MAX_VISIBLE);
    }
    case 'dismiss':
      return state.filter((t) => t.id !== action.id);
  }
}

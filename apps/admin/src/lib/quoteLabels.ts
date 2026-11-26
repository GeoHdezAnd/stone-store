import type { IvaPct, LostReason, QuoteStatus } from '@canteras/shared';

export { formatMxn } from './freightLabels';
export { formatDateTime } from './publishLabels';

export const STATUS_LABELS: Record<QuoteStatus, string> = {
  nueva: 'Nueva',
  en_revision: 'En revisión',
  cotizada: 'Cotizada',
  enviada: 'Enviada',
  ganada: 'Ganada',
  perdida: 'Perdida',
  cancelada: 'Cancelada',
};

export const statusLabel = (status: string) => STATUS_LABELS[status as QuoteStatus] ?? status;

export const STATUS_TONES: Record<QuoteStatus, 'ink' | 'outline' | 'accent'> = {
  nueva: 'accent',
  en_revision: 'ink',
  cotizada: 'ink',
  enviada: 'ink',
  ganada: 'ink',
  perdida: 'outline',
  cancelada: 'outline',
};

export const LOST_REASON_LABELS: Record<LostReason, string> = {
  precio_piedra: 'Precio de la piedra',
  precio_flete: 'Precio del flete',
  tiempo_entrega: 'Tiempo de entrega',
  otro_proveedor: 'Eligió otro proveedor',
  sin_respuesta: 'Sin respuesta',
  otro: 'Otro',
};

export const lostReasonLabel = (reason: string) =>
  LOST_REASON_LABELS[reason as LostReason] ?? reason;

/** Opciones del selector de IVA («Sin IVA» = valor vacío = `null`). */
export const IVA_CHOICES: readonly { value: string; label: string }[] = [
  { value: '', label: 'Sin IVA' },
  { value: '8', label: '8 %' },
  { value: '16', label: '16 %' },
];

export const ivaPctToText = (pct: IvaPct | undefined): string => (pct == null ? '' : String(pct));
export const parseIvaPct = (text: string): IvaPct => (text === '8' ? 8 : text === '16' ? 16 : null);
export const ivaPctLabel = (pct: IvaPct | undefined): string =>
  pct == null ? 'Sin IVA' : `${pct} %`;

/** Aclaración del total: el IVA va solo sobre la piedra y el flete no lleva IVA. */
export const totalNote = (pct: IvaPct | undefined): string =>
  pct == null ? 'sin IVA' : `con IVA del ${pct} % sobre la piedra; el flete no lleva IVA`;

/** Meta del sitio: responder en menos de 48 h (CLAUDE.md 5.1). */
export const RESPONSE_GOAL_HOURS = 48;

export function hoursSince(iso: string, now = Date.now()): number {
  return (now - new Date(iso).getTime()) / 3_600_000;
}

/** «hace 3 h», «hace 2 d». */
export function ageLabel(iso: string, now = Date.now()): string {
  const hours = hoursSince(iso, now);
  if (!Number.isFinite(hours) || hours < 0) return '—';
  if (hours < 1) return 'hace menos de 1 h';
  if (hours < 48) return `hace ${Math.floor(hours)} h`;
  return `hace ${Math.floor(hours / 24)} d`;
}

/** Alerta: lleva más de 48 h sin responderse y sigue en preparación. */
export function isOverdue(status: string, createdAt: string, now = Date.now()): boolean {
  return (
    (status === 'nueva' || status === 'en_revision') &&
    hoursSince(createdAt, now) > RESPONSE_GOAL_HOURS
  );
}

import type { LostReason, QuoteStatus } from '@canteras/shared';

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

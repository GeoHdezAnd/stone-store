import { z } from 'zod';

export const QUOTE_STATUSES = [
  'nueva',
  'en_revision',
  'cotizada',
  'enviada',
  'ganada',
  'perdida',
  'cancelada',
] as const;

export const QuoteStatusSchema = z.enum(QUOTE_STATUSES);
export type QuoteStatus = z.infer<typeof QuoteStatusSchema>;

// CLAUDE.md 5.4: nueva -> en_revision -> cotizada -> enviada -> ganada | perdida | cancelada.
// SUPUESTO: solo se implementa la cadena documentada. Cancelar desde estados
// anteriores o retroceder (p. ej. enviada -> en_revision) aún NO está especificado.
const TRANSITIONS: Record<QuoteStatus, readonly QuoteStatus[]> = {
  nueva: ['en_revision'],
  en_revision: ['cotizada'],
  cotizada: ['enviada'],
  enviada: ['ganada', 'perdida', 'cancelada'],
  ganada: [],
  perdida: [],
  cancelada: [],
};

export function isQuoteStatus(value: unknown): value is QuoteStatus {
  return QuoteStatusSchema.safeParse(value).success;
}

// Acepta `unknown` a propósito: llega de la red o de la base de datos sin validar.
// Cualquier valor desconocido devuelve false en lugar de lanzar un TypeError.
export function canTransition(from: unknown, to: unknown): boolean {
  if (!isQuoteStatus(from) || !isQuoteStatus(to)) return false;
  return TRANSITIONS[from].includes(to);
}

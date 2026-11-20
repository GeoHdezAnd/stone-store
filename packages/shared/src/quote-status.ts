import { z } from 'zod';
import type { Role } from './auth';

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

// CLAUDE.md 5.4 con las decisiones asumidas por el dueño (fase 3.3a):
// - `cancelada` desde cualquier estado no final (nueva, en_revision, cotizada, enviada);
// - `cotizada -> en_revision` para corregir precios;
// - `enviada` solo se alcanza con la acción de envío (3.3b), nunca por PATCH de estado (eso lo
//   impone el esquema del PATCH; aquí la transición cotizada -> enviada sigue siendo válida);
// - ganada, perdida y cancelada son finales.
const TRANSITIONS: Record<QuoteStatus, readonly QuoteStatus[]> = {
  nueva: ['en_revision', 'cancelada'],
  en_revision: ['cotizada', 'cancelada'],
  cotizada: ['en_revision', 'enviada', 'cancelada'],
  enviada: ['ganada', 'perdida', 'cancelada'],
  ganada: [],
  perdida: [],
  cancelada: [],
};

// Transiciones de preparación que también puede hacer `staff`; el resto es solo de `owner`.
const STAFF_TRANSITIONS: ReadonlyArray<readonly [QuoteStatus, QuoteStatus]> = [
  ['nueva', 'en_revision'],
  ['en_revision', 'cotizada'],
  ['cotizada', 'en_revision'],
];

export function isQuoteStatus(value: unknown): value is QuoteStatus {
  return QuoteStatusSchema.safeParse(value).success;
}

// Acepta `unknown` a propósito: llega de la red o de la base de datos sin validar.
// Cualquier valor desconocido devuelve false en lugar de lanzar un TypeError.
export function canTransition(from: unknown, to: unknown): boolean {
  if (!isQuoteStatus(from) || !isQuoteStatus(to)) return false;
  return TRANSITIONS[from].includes(to);
}

/** Estados finales: no admiten ninguna transición. */
export function isFinalStatus(value: unknown): boolean {
  return isQuoteStatus(value) && TRANSITIONS[value].length === 0;
}

/** Roles que pueden hacer la transición (lista vacía si la transición no es válida). */
export function rolesForTransition(from: unknown, to: unknown): readonly Role[] {
  if (!canTransition(from, to)) return [];
  const staff = STAFF_TRANSITIONS.some(([f, t]) => f === from && t === to);
  return staff ? ['owner', 'staff'] : ['owner'];
}

export function canRoleTransition(role: Role, from: unknown, to: unknown): boolean {
  return rolesForTransition(from, to).includes(role);
}

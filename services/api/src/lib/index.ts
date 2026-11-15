import { canTransition, type QuoteStatus } from '@canteras/shared';

// Marcador de posición: los clientes de AWS y los handlers llegan en tareas posteriores.
export function isValidStatusChange(from: QuoteStatus, to: QuoteStatus): boolean {
  return canTransition(from, to);
}

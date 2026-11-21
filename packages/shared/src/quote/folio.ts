// Folio de una solicitud (`CN-AAAA-NNNNN`, CLAUDE.md 6.2): el número sale de un contador atómico por
// año en la tabla `Counters`. Dominio puro: aquí solo van los nombres y los topes.

/** Último número que cabe en el folio (5 dígitos). Pasado esto no se admiten más solicitudes. */
export const MAX_FOLIO_NUMBER = 99_999;

/** Nombre del contador de folios de un año en la tabla `Counters` (`folio#2026`). */
export function folioCounterName(year: number): string {
  if (!Number.isInteger(year) || year < 2000 || year > 9999) throw new RangeError('Año inválido.');
  return `folio#${year}`;
}

/**
 * Año del folio: el de `createdAt` en UTC. Así el folio siempre coincide con la fecha guardada y con
 * el seed (que también usa UTC). Cerca del 1 de enero un pedido de la noche del 31 en México recibe
 * el año nuevo: es una decisión consciente.
 */
export function folioYear(now: Date): number {
  return now.getUTCFullYear();
}

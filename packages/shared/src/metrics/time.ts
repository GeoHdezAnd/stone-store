// Calendario de las métricas (CLAUDE.md 5.3 y 5.5). Dominio puro, sin librerías ni `Intl`.
//
// Decisión del dueño: huso `America/Mexico_City`. México eliminó el horario de verano en 2022, así
// que el huso es UTC-6 FIJO y basta un desplazamiento constante. Si el país lo restableciera, esta
// constante dejaría de bastar (habría que cambiar a una función de huso real).

export const MEXICO_CITY_TIMEZONE = 'America/Mexico_City';
export const MEXICO_CITY_UTC_OFFSET_HOURS = -6;

const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;
const OFFSET_MS = MEXICO_CITY_UTC_OFFSET_HOURS * HOUR_MS;

/** Desplaza el instante para que los getters UTC devuelvan la hora de pared de Ciudad de México. */
const toWall = (utcMs: number): Date => new Date(utcMs + OFFSET_MS);
const fromWall = (wallMs: number): number => wallMs - OFFSET_MS;

/** Instante UTC (ms) en que empieza el día local que contiene a `utcMs`. */
export function localStartOfDay(utcMs: number): number {
  const w = toWall(utcMs);
  return fromWall(Date.UTC(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate()));
}

/** Inicio del mes calendario local. */
export function localStartOfMonth(utcMs: number): number {
  const w = toWall(utcMs);
  return fromWall(Date.UTC(w.getUTCFullYear(), w.getUTCMonth(), 1));
}

/** Inicio de la semana local; la semana empieza el LUNES. */
export function localStartOfWeek(utcMs: number): number {
  const w = toWall(utcMs);
  const sinceMonday = (w.getUTCDay() + 6) % 7; // domingo (0) -> 6, lunes (1) -> 0
  return fromWall(Date.UTC(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate() - sinceMonday));
}

/** Suma `days` días completos a un instante que ya es inicio de día local (sin horario de verano). */
export function addLocalDays(startOfDayMs: number, days: number): number {
  return startOfDayMs + days * DAY_MS;
}

/** Fecha local `YYYY-MM-DD`. */
export function localDateString(utcMs: number): string {
  return toWall(utcMs).toISOString().slice(0, 10);
}

const MONTHS_ES = [
  'ene',
  'feb',
  'mar',
  'abr',
  'may',
  'jun',
  'jul',
  'ago',
  'sep',
  'oct',
  'nov',
  'dic',
];

/** Etiqueta corta de un día local: `23 nov`. */
export function localShortLabel(utcMs: number): string {
  const w = toWall(utcMs);
  return `${w.getUTCDate()} ${MONTHS_ES[w.getUTCMonth()]}`;
}

import { HttpError } from './http';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * Límite de un rango de fechas en la query string: `YYYY-MM-DD` (día completo en UTC) o ISO con
 * milisegundos. Devuelve el instante ISO; cualquier otra cosa es 400 `invalid_query`.
 */
export function parseBound(raw: string, edge: 'from' | 'to'): string {
  let iso: string;
  if (DATE_RE.test(raw)) iso = edge === 'from' ? `${raw}T00:00:00.000Z` : `${raw}T23:59:59.999Z`;
  else if (ISO_RE.test(raw)) iso = raw;
  else throw new HttpError(400, 'invalid_query');
  const t = Date.parse(iso);
  if (Number.isNaN(t) || new Date(t).toISOString() !== iso)
    throw new HttpError(400, 'invalid_query');
  return iso;
}

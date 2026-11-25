import type { StoredQuote } from '../lib/quotes-query';
import { BATCH_GET_MAX_KEYS, type ListQuery, type MetricsRepository } from './repository';

// Carga de datos del resumen con TOPES DUROS (nunca Scan, nunca sin límite):
// - Cada consulta pagina de 200 en 200 y se detiene a las 10 páginas (2 000 filas por consulta).
//   Hay 3 consultas en paralelo (nuevas, en revisión y por fecha): máximo 6 000 filas en memoria.
//   Si queda una página por leer, la respuesta lleva `truncated: true`.
// - Zonas: a lo más 300 CP distintos (3 lotes de `BatchGetItem` de 100). Las claves que DynamoDB
//   devuelva sin procesar se reintentan con backoff exponencial y jitter completo (hasta 4 intentos,
//   espera máxima 400 ms); lo que siga pendiente cuenta como «Sin dato» y marca parcial.

export const PAGE_SIZE = 200;
export const MAX_PAGES_PER_QUERY = 10;
export const POSTAL_BATCH_SIZE = BATCH_GET_MAX_KEYS;
export const MAX_ZONE_CPS = 300;
export const BATCH_MAX_ATTEMPTS = 4;
export const BACKOFF_BASE_MS = 50;
export const BACKOFF_MAX_MS = 400;

/** Reloj y azar inyectables (las pruebas no esperan de verdad). */
export interface RetryOptions {
  sleep?: (ms: number) => Promise<void>;
  /** Devuelve un número en [0, 1). */
  random?: () => number;
}

/** Espera antes del reintento n (n ≥ 1): jitter completo en [0, min(tope, base·2^(n-1))]. */
export function backoffDelay(attempt: number, random: () => number): number {
  return random() * Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1));
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type QueryBase = Omit<ListQuery, 'limit' | 'exclusiveStartKey'>;

async function collectOne(
  repo: MetricsRepository,
  base: QueryBase,
  pageSize: number,
  maxPages: number,
): Promise<{ rows: StoredQuote[]; truncated: boolean }> {
  const rows: StoredQuote[] = [];
  let start: ListQuery['exclusiveStartKey'];
  for (let page = 0; page < maxPages; page++) {
    const res = await repo.queryQuotes({
      ...base,
      limit: pageSize,
      ...(start ? { exclusiveStartKey: start } : {}),
    });
    rows.push(...res.items);
    if (res.lastKey === null) return { rows, truncated: false };
    start = res.lastKey;
  }
  return { rows, truncated: true };
}

export async function collectQuotes(
  repo: MetricsRepository,
  queries: readonly QueryBase[],
  limits: { pageSize?: number; maxPages?: number } = {},
): Promise<{ rows: StoredQuote[]; truncated: boolean }> {
  const pageSize = limits.pageSize ?? PAGE_SIZE;
  const maxPages = limits.maxPages ?? MAX_PAGES_PER_QUERY;
  const results = await Promise.all(queries.map((q) => collectOne(repo, q, pageSize, maxPages)));
  return {
    rows: results.flatMap((r) => r.rows),
    truncated: results.some((r) => r.truncated),
  };
}

const validState = (s: string): boolean => s.trim() !== '' && s.length <= 80;

export async function resolveZones(
  repo: MetricsRepository,
  codes: readonly string[],
  retry: RetryOptions = {},
): Promise<{ zoneByCp: Record<string, string>; partial: boolean }> {
  const sleep = retry.sleep ?? realSleep;
  const random = retry.random ?? Math.random;
  const zoneByCp: Record<string, string> = {};
  let partial = false;
  const unique = [...new Set(codes)];
  for (let i = 0; i < unique.length; i += POSTAL_BATCH_SIZE) {
    let pending = unique.slice(i, i + POSTAL_BATCH_SIZE);
    for (let attempt = 0; attempt < BATCH_MAX_ATTEMPTS && pending.length > 0; attempt++) {
      if (attempt > 0) {
        await sleep(backoffDelay(attempt, random));
      }
      const res = await repo.getPostalStates(pending);
      for (const [cp, estado] of Object.entries(res.states)) {
        if (validState(estado)) zoneByCp[cp] = estado.trim();
      }
      pending = res.unprocessed;
    }
    if (pending.length > 0) partial = true;
  }
  return { zoneByCp, partial };
}

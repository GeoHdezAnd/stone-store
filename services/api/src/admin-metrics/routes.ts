import {
  computeMetrics,
  MEXICO_CITY_TIMEZONE,
  metricsResponseSchema,
  parseQuoteRows,
  zonePostalCodes,
  type MetricsResponse,
} from '@canteras/shared';
import { HttpError, jsonResponse } from '../lib/http';
import { createRouter, route, type Route, type RouterOptions } from '../lib/router';
import type { StoredQuote } from '../lib/quotes-query';
import { collectQuotes, MAX_ZONE_CPS, resolveZones, type RetryOptions } from './collect';
import type { MetricsRepository } from './repository';

export interface MetricsDeps {
  repo: MetricsRepository;
  /** Para pruebas: reloj. */
  now?: () => Date;
  /** Para pruebas: topes de paginación (por defecto los de `collect.ts`). */
  limits?: { pageSize?: number; maxPages?: number };
  /** Para pruebas: espera y azar de los reintentos de `PostalCodes`. */
  retry?: RetryOptions;
}

const DAY_MS = 86_400_000;
// Se cargan las solicitudes creadas en los últimos 120 días. Cubre las 8 semanas de la gráfica (56
// días como máximo), los 30 días de piedras/zonas y el mes en curso. Límite conocido: una solicitud
// creada hace MÁS de 120 días que se cotiza o gana este mes no entra en esos conteos (las abiertas,
// nueva/en revisión, se cargan siempre completas, sin límite de antigüedad).
//
// La ruta NO acepta `from`/`to` (ni ningún parámetro): la pantalla no los manda y cambiar el
// instante de referencia o el rango de carga daba cifras engañosas (mes y semana «a medias»). El
// instante de referencia es siempre «ahora» del servidor y cualquier parámetro es 400.
const LOOKBACK_DAYS = 120;
// Estados «abiertos» (el cliente sigue esperando: nueva, en revisión y cotizada sin enviar): se
// consultan de cualquier antigüedad. Los cerrados llevan rango en `gsi1sk` (últimos 120 días) y
// cada consulta su propio tope, así unas no gastan el cupo de las otras.
const OPEN_STATUSES = ['nueva', 'en_revision', 'cotizada'] as const;
const CLOSED_STATUSES = ['enviada', 'ganada', 'perdida', 'cancelada'] as const;

const bad = (): never => {
  throw new HttpError(400, 'invalid_query');
};

export function createMetricsRoutes(deps: MetricsDeps): Route[] {
  const { repo } = deps;
  const now = deps.now ?? (() => new Date());

  return [
    // Solo lectura y sin auditoría (no cambia nada). owner y staff: el resumen es agregado y los
    // únicos datos personales son folio, nombre y obra de las solicitudes que esperan respuesta.
    route('GET', '/admin/metrics', ['owner', 'staff'], async (ctx) => {
      if (Object.keys(ctx.query).length > 0) bad();
      const nowMs = now().getTime();
      const refIso = new Date(nowMs).toISOString();
      const fromIso = new Date(nowMs - LOOKBACK_DAYS * DAY_MS).toISOString();
      // Clave de orden = `createdAt#quoteId`: el tope superior usa `#~` (~ > cualquier letra de ULID).
      const upper = `${refIso}#~`;

      // 7 consultas por `byStatus` (nunca `byDate`, nunca Scan), cada una con su propio tope.
      const collected = await collectQuotes(
        repo,
        [
          ...OPEN_STATUSES.map((status) => ({ index: 'status' as const, status, to: upper })),
          ...CLOSED_STATUSES.map((status) => ({
            index: 'status' as const,
            status,
            from: fromIso,
            to: upper,
          })),
        ],
        deps.limits,
      );

      // Defensa: una fila repetida (p. ej. un cambio de estado entre dos consultas) se cuenta una vez.
      const byId = new Map<string, StoredQuote>();
      const noId: StoredQuote[] = [];
      for (const raw of collected.rows) {
        const key = raw['quoteId'];
        if (typeof key !== 'string') noId.push(raw);
        else if (!byId.has(key)) byId.set(key, raw);
      }
      const { quotes, invalidIds } = parseQuoteRows([...byId.values(), ...noId]);
      if (invalidIds.length > 0) {
        // Solo ids (nunca datos del cliente) y como máximo 5.
        ctx.log.warn('invalid_stored_items', { entity: 'quote', ids: invalidIds.slice(0, 5) });
      }

      const wanted = zonePostalCodes(quotes, nowMs, MAX_ZONE_CPS);
      const zones = await resolveZones(repo, wanted.codes, deps.retry);
      const computed = computeMetrics({ quotes, now: nowMs, zoneByCp: zones.zoneByCp });

      const response: MetricsResponse = {
        generatedAt: refIso,
        timezone: MEXICO_CITY_TIMEZONE,
        range: { from: fromIso, to: refIso },
        truncated: collected.truncated,
        zonesPartial: zones.partial || wanted.capped,
        skipped: invalidIds.length,
        ...computed,
      };
      // Defensa en profundidad: lo que sale cumple el contrato estricto (sin claves de más).
      if (!metricsResponseSchema.safeParse(response).success) {
        ctx.log.error('invalid_metrics_response');
        throw new HttpError(500, 'internal_error');
      }
      // Solo conteos: nunca nombres, teléfonos, correos ni folios.
      ctx.log.info('metrics_computed', {
        rows: byId.size + noId.length,
        skipped: invalidIds.length,
        truncated: collected.truncated,
        userId: ctx.userId,
      });
      return jsonResponse(200, response);
    }),
  ];
}

export function createMetricsRouter(deps: MetricsDeps, options: RouterOptions = {}) {
  return createRouter(createMetricsRoutes(deps), options);
}

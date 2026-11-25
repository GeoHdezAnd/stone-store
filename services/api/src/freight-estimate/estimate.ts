import {
  FreightError,
  freightConfigSchema,
  parseFreightEstimateRequest,
  stoneSchema,
  type FreightItem,
  type FreightEstimateRequest,
  type Stone,
} from '@canteras/shared';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { HttpError, jsonResponse } from '../lib/http';
import { createLogger, type Logger, type LogSink } from '../lib/logger';
import {
  computeFreightEstimate,
  NEGATIVE_ROUTE_CACHE_TTL_SECONDS,
  ROUTE_CACHE_TTL_DAYS,
} from '../lib/freight-quote';
import type { RouteProvider } from '../lib/route-provider';
import type { FreightEstimateRepository } from './repository';

/**
 * `POST /freight/estimate` (CLAUDE.md 7.1): ruta PÚBLICA (sin authorizer) que puede disparar una
 * llamada de PAGO (Location Service). No usa `createRouter`.
 *
 * Orden fijo, de lo más barato a lo más caro y SIN gastar la ruta hasta que lo demás es válido:
 *   método, tipo de contenido, tamaño (bytes, ANTES de parsear), JSON, esquema, tarifa activa,
 *   piedras, CP, validación completa del pedido (con distancia 0: zona, piedras, unidades, peso),
 *   caché de ruta o proveedor, cálculo final. El peso lo calcula SIEMPRE el servidor.
 */

/** Tope del cuerpo: un pedido normal pesa menos de 1 KB. */
export const MAX_BODY_BYTES = 8 * 1024;

// Constantes de la caché: viven en `lib/freight-quote` (las comparte `POST /quotes`); se reexportan
// aquí para no romper a quien ya las importa de este módulo.
export { NEGATIVE_ROUTE_CACHE_TTL_SECONDS, ROUTE_CACHE_TTL_DAYS };

export interface FreightEstimateDeps {
  repo: FreightEstimateRepository;
  routes: RouteProvider;
  now?: () => Date;
  /** Para pruebas: destino de los logs. */
  logSink?: LogSink;
}

const JSON_TYPE_RE = /^application\/json\s*(?:;|$)/i;

function header(event: APIGatewayProxyEventV2, name: string): string | undefined {
  for (const [k, v] of Object.entries(event.headers ?? {})) {
    if (k.toLowerCase() === name && typeof v === 'string') return v;
  }
  return undefined;
}

const errorName = (err: unknown): string => (err instanceof Error ? err.name : 'unknown');

/** Estado HTTP de un error del cálculo: zona y tamaño 422, distancia 502, el resto 400. */
function freightErrorResponse(err: FreightError): APIGatewayProxyStructuredResultV2 {
  if (err.code === 'invalid_distance') return jsonResponse(502, { error: 'route_unavailable' });
  const status = err.code === 'out_of_zone' || err.code === 'too_large' ? 422 : 400;
  return jsonResponse(status, { error: err.code, message: err.message });
}

export function createFreightEstimateHandler(deps: FreightEstimateDeps) {
  const { repo, routes } = deps;
  const now = deps.now ?? (() => new Date());

  async function handleRequest(
    event: APIGatewayProxyEventV2,
    log: Logger,
  ): Promise<APIGatewayProxyStructuredResultV2> {
    if (event.requestContext?.http?.method !== 'POST')
      throw new HttpError(405, 'method_not_allowed');
    if (!JSON_TYPE_RE.test(header(event, 'content-type') ?? '')) {
      throw new HttpError(415, 'unsupported_media_type');
    }

    // Tamaño real en bytes (UTF-8 o ya decodificado de base64), ANTES de parsear nada.
    const rawBody = typeof event.body === 'string' ? event.body : '';
    const base64 = event.isBase64Encoded === true;
    if (Buffer.byteLength(rawBody, base64 ? 'base64' : 'utf8') > MAX_BODY_BYTES) {
      throw new HttpError(413, 'payload_too_large');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(base64 ? Buffer.from(rawBody, 'base64').toString('utf8') : rawBody);
    } catch {
      throw new HttpError(400, 'invalid_json');
    }
    const body = parseFreightEstimateRequest(parsed);
    if (!body.ok) {
      return jsonResponse(400, {
        error: 'validation_error',
        issues: body.errors.map((message) => ({ message })),
      });
    }
    const request: FreightEstimateRequest = body.data;
    const cp = request.codigoPostal;
    const cpPrefix = cp.slice(0, 2);

    // Tarifa ACTIVA (de ahí salen camiones, merma, zonas, origen y maxKm).
    const freightRow = await repo.getActiveFreightRow();
    if (freightRow === null) {
      log.error('freight_config_missing');
      throw new HttpError(503, 'freight_unavailable');
    }
    const freight = freightConfigSchema.safeParse(freightRow);
    if (!freight.success) {
      log.error('invalid_stored_item', { entity: 'freight-config' });
      throw new HttpError(503, 'freight_unavailable');
    }
    const config = freight.data;

    const stoneRows = await repo.getStones(request.items.map((i) => i.stoneId));
    const stones: Stone[] = [];
    for (const row of stoneRows) {
      const stone = stoneSchema.safeParse(row);
      if (!stone.success) {
        log.error('invalid_stored_item', {
          entity: 'stone',
          id: typeof row['id'] === 'string' ? row['id'] : undefined,
        });
        throw new HttpError(503, 'freight_unavailable');
      }
      stones.push(stone.data);
    }

    // `espesorCm` opcional del esquema zod vs. `exactOptionalPropertyTypes` de `FreightItem`: misma forma
    // que usa el simulador de `admin-freight`.
    const estimate = await computeFreightEstimate(
      { store: repo, routes },
      { codigoPostal: cp, items: request.items as FreightItem[], stones, config, at: now(), log },
    );

    log.info('freight_estimated', {
      cpPrefix,
      viajes: estimate.viajes,
      versionTarifa: estimate.versionTarifa,
    });
    return jsonResponse(200, estimate);
  }

  async function handle(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
    const requestId =
      typeof event?.requestContext?.requestId === 'string' && event.requestContext.requestId !== ''
        ? event.requestContext.requestId
        : 'unknown';
    const log = createLogger({ requestId }, deps.logSink);
    try {
      return await handleRequest(event, log);
    } catch (err) {
      if (err instanceof HttpError) return jsonResponse(err.status, { error: err.code });
      if (err instanceof FreightError) {
        log.info('freight_error', { code: err.code });
        return freightErrorResponse(err);
      }
      // Nunca el mensaje ni el stack: pueden traer datos del cliente. Solo el nombre del error.
      log.error('unhandled_error', { errName: errorName(err) });
      return jsonResponse(500, { error: 'internal_error', requestId });
    }
  }

  return { handle };
}

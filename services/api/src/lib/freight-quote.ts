import {
  estimateFreight,
  FreightError,
  postalCodeSchema,
  type FreightConfig,
  type FreightEstimate,
  type FreightItem,
  type PostalCode,
  type Stone,
} from '@canteras/shared';
import { HttpError } from './http';
import type { Logger } from './logger';
import { NO_ROUTE_REASON, RouteProviderError, type RouteProvider } from './route-provider';

/**
 * Cálculo del estimado de flete que `POST /quotes` guarda en la solicitud (la lógica de dominio es la
 * misma de `packages/shared` que usa el simulador del dashboard), con caché de rutas y defensas de costo.
 * Orden fijo, de lo más barato a lo más caro y SIN gastar la ruta hasta que lo demás es válido:
 *   CP en `PostalCodes`, validación completa del pedido (con distancia 0: zona, piedras, unidades,
 *   peso y viajes), caché de ruta o proveedor, cálculo final. El peso lo calcula SIEMPRE el servidor.
 */

/** Vigencia de una distancia guardada en `RouteCache` (CLAUDE.md 7.2, paso 3). */
export const ROUTE_CACHE_TTL_DAYS = 90;

/**
 * Vigencia de la caché NEGATIVA (Location respondió 200 pero sin ruta): corta, porque el mapa o las
 * coordenadas pueden corregirse, pero suficiente para que reintentos seguidos no vuelvan a cobrar.
 * Solo se cachea ese caso: nunca timeouts, throttling, 5xx ni errores de red.
 */
export const NEGATIVE_ROUTE_CACHE_TTL_SECONDS = 3600;

// Límite conocido (aceptado): la caché negativa dura 1 h, así que un CP sin ruta puede volver a
// cobrarse hasta ~24 veces al día. El costo queda acotado por el número de CP distintos (y por el
// throttle de la ruta), no por el número de peticiones.

/** Valor de `fallo` en las filas negativas de `RouteCache`. */
const NEGATIVE_FAILURE = 'sin_ruta';

export const OUT_OF_ZONE_MESSAGE =
  'Esa ubicación queda fuera de nuestra zona de entrega: consúltenos por WhatsApp.';

/** Lo mínimo que se necesita leer y escribir para estimar (mínimo privilegio en IAM). */
export interface FreightLookupStore {
  /** Fila de `PostalCodes` por CP, o `null`. */
  getPostalCode(cp: string): Promise<Record<string, unknown> | null>;
  /** Fila de `RouteCache` por CP, o `null`. */
  getRouteCache(cp: string): Promise<Record<string, unknown> | null>;
  /** Guarda (o sobrescribe) la distancia calculada de un CP. */
  putRouteCache(item: Record<string, unknown>): Promise<void>;
}

export interface FreightQuoteDeps {
  store: FreightLookupStore;
  routes: RouteProvider;
}

export interface FreightQuoteInput {
  codigoPostal: string;
  items: readonly FreightItem[];
  stones: readonly Stone[];
  config: FreightConfig;
  at: Date;
  log: Logger;
}

const errorName = (err: unknown): string => (err instanceof Error ? err.name : 'unknown');

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Fila de `RouteCache` vigente del CP, solo si se calculó entre el MISMO origen y el MISMO destino
 * (si el dueño corrige las coordenadas del CP o cambia el patio, se recalcula). Dos formas:
 * positiva (`distanciaKm`) o negativa (`fallo: 'sin_ruta'`, sin `distanciaKm`). Una fila vencida,
 * vieja, ambigua o inválida es un miss.
 */
async function cachedRoute(
  store: FreightLookupStore,
  cp: string,
  origin: FreightConfig['origen'],
  destination: PostalCode,
  nowSeconds: number,
): Promise<{ km: number } | { noRoute: true } | null> {
  const row = await store.getRouteCache(cp);
  if (row === null) return null;
  const point = (v: unknown): Record<string, unknown> | null =>
    typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
  const from = point(row['origen']);
  const to = point(row['destino']);
  const ttl = row['ttl'];
  if (
    from === null ||
    from['lat'] !== origin.lat ||
    from['lng'] !== origin.lng ||
    to === null ||
    to['lat'] !== destination.lat ||
    to['lng'] !== destination.lng ||
    !isFiniteNumber(ttl) ||
    ttl <= nowSeconds
  ) {
    return null;
  }
  const km = row['distanciaKm'];
  const failure = row['fallo'];
  if (failure === undefined && isFiniteNumber(km) && km >= 0) return { km };
  if (failure === NEGATIVE_FAILURE && km === undefined) return { noRoute: true };
  return null;
}

/** Best-effort: un fallo de la caché solo cuesta una llamada de más la próxima vez. */
async function putCache(
  store: FreightLookupStore,
  item: Record<string, unknown>,
  log: Logger,
): Promise<void> {
  try {
    await store.putRouteCache(item);
  } catch (err) {
    log.warn('route_cache_write_failed', { errName: errorName(err) });
  }
}

async function resolveDistance(
  deps: FreightQuoteDeps,
  cp: string,
  postal: PostalCode,
  origin: FreightConfig['origen'],
  at: Date,
  log: Logger,
): Promise<number> {
  const { store, routes } = deps;
  const nowSeconds = Math.floor(at.getTime() / 1000);
  const hit = await cachedRoute(store, cp, origin, postal, nowSeconds);
  if (hit !== null) {
    if ('noRoute' in hit) {
      log.info('route_negative_cache_hit', { cpPrefix: cp.slice(0, 2) });
      throw new HttpError(502, 'route_unavailable');
    }
    return hit.km;
  }

  // Límite conocido (aceptado): sin candado, N peticiones simultáneas al MISMO CP sin caché hacen N
  // llamadas de pago antes de que la primera guarde. El throttle de la ruta (5/10) lo acota.
  let km: number;
  try {
    km = await routes.getDistanceKm(
      { lat: origin.lat, lng: origin.lng },
      { lat: postal.lat, lng: postal.lng },
    );
  } catch (err) {
    log.warn('route_provider_failed', {
      errName: errorName(err),
      reason: err instanceof RouteProviderError ? err.reason : undefined,
      cpPrefix: cp.slice(0, 2),
    });
    // Solo «200 sin ruta» se recuerda (así 5 reintentos seguidos cuestan 1 llamada). Best-effort.
    if (err instanceof RouteProviderError && err.reason === NO_ROUTE_REASON) {
      await putCache(
        store,
        {
          cp,
          fallo: NEGATIVE_FAILURE,
          origen: { lat: origin.lat, lng: origin.lng },
          destino: { lat: postal.lat, lng: postal.lng },
          calculadoAt: at.toISOString(),
          ttl: nowSeconds + NEGATIVE_ROUTE_CACHE_TTL_SECONDS,
        },
        log,
      );
    }
    throw new HttpError(502, 'route_unavailable');
  }
  if (!isFiniteNumber(km) || km < 0) {
    log.error('route_provider_invalid_distance', { cpPrefix: cp.slice(0, 2) });
    throw new HttpError(502, 'route_unavailable');
  }

  await putCache(
    store,
    {
      cp,
      distanciaKm: km,
      origen: { lat: origin.lat, lng: origin.lng },
      destino: { lat: postal.lat, lng: postal.lng },
      calculadoAt: at.toISOString(),
      ttl: nowSeconds + ROUTE_CACHE_TTL_DAYS * 24 * 3600,
    },
    log,
  );
  return km;
}

/**
 * Estimado de flete de un pedido ya validado en forma (CP de 5 dígitos, piedras cargadas, tarifa
 * activa válida). Lanza `FreightError` (CP fuera de zona o sin registro, pedido inválido o demasiado
 * grande) o `HttpError` (502 sin ruta, 503 dato guardado inválido).
 */
export async function computeFreightEstimate(
  deps: FreightQuoteDeps,
  input: FreightQuoteInput,
): Promise<FreightEstimate> {
  const { codigoPostal: cp, items, stones, config, at, log } = input;
  const cpPrefix = cp.slice(0, 2);

  const postalRow = await deps.store.getPostalCode(cp);
  if (postalRow === null) {
    log.info('postal_code_unknown', { cpPrefix });
    throw new FreightError('out_of_zone', OUT_OF_ZONE_MESSAGE);
  }
  const postal = postalCodeSchema.safeParse(postalRow);
  if (!postal.success) {
    log.error('invalid_stored_item', { entity: 'postal-code', cpPrefix });
    throw new HttpError(503, 'freight_unavailable');
  }

  const base = { codigoPostal: cp, items, stones, config };
  // Validación completa ANTES de la llamada de pago: con distancia 0 se comprueban la zona de
  // cobertura, las piedras, unidades y espesores, el peso y los viajes. Un pedido inválido nunca
  // cuesta una consulta a Location Service.
  estimateFreight({ ...base, distanciaKm: 0 });

  const distanciaKm = await resolveDistance(deps, cp, postal.data, config.origen, at, log);
  return estimateFreight({ ...base, distanciaKm });
}

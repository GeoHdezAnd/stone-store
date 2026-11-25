import { CalculateRoutesCommand } from '@aws-sdk/client-geo-routes';

/**
 * Distancia por carretera entre el patio y el destino (CLAUDE.md 7.2, paso 3).
 *
 * Fuentes oficiales consultadas (AWS Documentation MCP, noviembre 2026):
 * - Operación y petición: https://docs.aws.amazon.com/location/latest/APIReference/API_CalculateRoutes.html
 *   (cliente del SDK v3: `@aws-sdk/client-geo-routes`, `GeoRoutesClient` + `CalculateRoutesCommand`;
 *   `Origin` y `Destination` son `[longitud, latitud]`; `TravelMode` admite `Truck`; el resumen de
 *   cada pierna solo viene si se pide `LegAdditionalFeatures: ['Summary']`).
 * - Respuesta: `Routes[].Legs[].VehicleLegDetails.Summary.Overview.Distance` y, sin resumen,
 *   `VehicleLegDetails.TravelSteps[].Distance`. Ambas distancias están en METROS:
 *   https://docs.aws.amazon.com/location/latest/APIReference/API_RouteVehicleOverviewSummary.html
 * - IAM: acción `geo-routes:CalculateRoutes` sobre `arn:aws:geo-routes:<región>::provider/default`:
 *   https://docs.aws.amazon.com/service-authorization/latest/reference/list_geo-routes.html
 * La API no ofrece una opción para omitir la geometría de las piernas (solo elegir su formato),
 * así que se acepta el payload extra; no se piden peajes ni instrucciones.
 */

export interface LatLng {
  lat: number;
  lng: number;
}

export interface RouteProvider {
  /** Kilómetros por carretera (a 0.1 km) del origen al destino. Lanza `RouteProviderError`. */
  getDistanceKm(origin: LatLng, destination: LatLng): Promise<number>;
}

/**
 * Cualquier fallo al resolver la distancia (SDK, permisos, respuesta inesperada, coordenadas
 * inválidas). El mensaje es fijo y NO reproduce el error original: puede traer ARNs o datos del
 * cliente. Solo se conserva el nombre del error del SDK en `reason`, para los logs.
 */
/** Motivo de `RouteProviderError` cuando Location responde 200 pero sin ruta (ni piernas). */
export const NO_ROUTE_REASON = 'no_route';

export class RouteProviderError extends Error {
  readonly reason: string;

  constructor(reason = 'unknown') {
    super('No se pudo calcular la distancia de la ruta.');
    this.name = 'RouteProviderError';
    this.reason = reason;
  }
}

const roundKm = (km: number): number => Math.round(km * 10) / 10;

function assertCoordinates(...points: LatLng[]): void {
  for (const p of points) {
    const ok =
      typeof p?.lat === 'number' &&
      typeof p?.lng === 'number' &&
      Number.isFinite(p.lat) &&
      Number.isFinite(p.lng) &&
      Math.abs(p.lat) <= 90 &&
      Math.abs(p.lng) <= 180;
    if (!ok) throw new RouteProviderError('invalid_coordinates');
  }
}

/** Radio medio de la Tierra (km). */
const EARTH_RADIUS_KM = 6371.0088;

/**
 * Las carreteras no son línea recta: la distancia en línea recta se multiplica por este factor.
 * Valor de ejemplo para el emulador, NO calibrado con rutas reales.
 */
export const HAVERSINE_ROAD_FACTOR = 1.3;

const toRad = (deg: number): number => (deg * Math.PI) / 180;

/**
 * SOLO PARA EMULADOR (Floci no tiene Location Service): distancia en línea recta (Haversine) ×
 * `HAVERSINE_ROAD_FACTOR`. Es una APROXIMACIÓN; en AWS real se usa `LocationRouteProvider`.
 */
export class HaversineRouteProvider implements RouteProvider {
  async getDistanceKm(origin: LatLng, destination: LatLng): Promise<number> {
    assertCoordinates(origin, destination);
    const dLat = toRad(destination.lat - origin.lat);
    const dLng = toRad(destination.lng - origin.lng);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(origin.lat)) * Math.cos(toRad(destination.lat)) * Math.sin(dLng / 2) ** 2;
    const straightKm = 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
    return roundKm(straightKm * HAVERSINE_ROAD_FACTOR);
  }
}

/** Lo mínimo que se usa de `GeoRoutesClient` (se inyecta para probar sin AWS). */
export interface GeoRoutesLike {
  send(command: CalculateRoutesCommand): Promise<unknown>;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isMeters = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** Metros de una pierna: `Summary.Overview.Distance` o, sin resumen, la suma de los pasos. */
function legMeters(leg: unknown): number {
  const details = isRecord(leg) ? leg['VehicleLegDetails'] : undefined;
  if (!isRecord(details)) throw new RouteProviderError('bad_response');
  const summary = details['Summary'];
  if (isRecord(summary) && isRecord(summary['Overview'])) {
    const d = summary['Overview']['Distance'];
    if (!isMeters(d)) throw new RouteProviderError('bad_response');
    return d;
  }
  const steps = details['TravelSteps'];
  if (!Array.isArray(steps) || steps.length === 0) throw new RouteProviderError('bad_response');
  let total = 0;
  for (const step of steps) {
    const d = isRecord(step) ? step['Distance'] : undefined;
    if (!isMeters(d)) throw new RouteProviderError('bad_response');
    total += d;
  }
  return total;
}

/** Amazon Location Service (Routes v2): ruta en modo camión. Cuesta por solicitud: usar con caché. */
export class LocationRouteProvider implements RouteProvider {
  constructor(private readonly client: GeoRoutesLike) {}

  async getDistanceKm(origin: LatLng, destination: LatLng): Promise<number> {
    assertCoordinates(origin, destination);
    let response: unknown;
    try {
      response = await this.client.send(
        new CalculateRoutesCommand({
          Origin: [origin.lng, origin.lat],
          Destination: [destination.lng, destination.lat],
          TravelMode: 'Truck',
          LegAdditionalFeatures: ['Summary'],
        }),
      );
    } catch (err) {
      throw new RouteProviderError(err instanceof Error ? err.name : 'unknown');
    }
    const routes = isRecord(response) ? response['Routes'] : undefined;
    const legs = Array.isArray(routes) && isRecord(routes[0]) ? routes[0]['Legs'] : undefined;
    if (!Array.isArray(legs) || legs.length === 0) throw new RouteProviderError(NO_ROUTE_REASON);
    const meters = legs.reduce<number>((sum, leg) => sum + legMeters(leg), 0);
    return roundKm(meters / 1000);
  }
}

export interface RouteProviderDeps {
  /** Se llama solo si `ROUTE_PROVIDER=location` (thunk: el emulador nunca crea el cliente). */
  geoRoutes: () => GeoRoutesLike;
}

/**
 * Elige el proveedor por entorno: `ROUTE_PROVIDER=location` (AWS real) o `haversine` (emulador).
 * Sin el valor, o con otro, falla al arrancar con un mensaje claro (nunca cae a uno por defecto).
 */
export function createRouteProvider(
  env: Record<string, string | undefined>,
  deps: RouteProviderDeps,
): RouteProvider {
  const kind = env['ROUTE_PROVIDER'];
  if (kind === undefined || kind === '') {
    throw new Error('Falta la variable de entorno ROUTE_PROVIDER ("location" o "haversine").');
  }
  if (kind === 'location') return new LocationRouteProvider(deps.geoRoutes());
  if (kind === 'haversine') return new HaversineRouteProvider();
  throw new Error(`ROUTE_PROVIDER no válido: "${kind}" (usa "location" o "haversine").`);
}

/**
 * Configuración del `GeoRoutesClient` para que el 502 `route_unavailable` salga ANTES del timeout
 * de 10 s de la Lambda (sin ella, el SDK espera sin límite y reintenta 3 veces). Peor caso:
 * 2 intentos × (1 s de conexión + 3 s de petición) = 8 s.
 * Fuente: `GeoRoutesClientConfig.requestHandler` y `maxAttempts` en
 * `@aws-sdk/client-geo-routes/dist-types/GeoRoutesClient.d.ts`; `requestTimeout` y
 * `connectionTimeout` son opciones de `NodeHttpHandlerOptions` (`@smithy/node-http-handler`), que el
 * cliente instancia cuando `requestHandler` es un objeto de opciones.
 */
export const GEO_ROUTES_CLIENT_CONFIG = {
  maxAttempts: 2,
  requestHandler: { requestTimeout: 3000, connectionTimeout: 1000 },
} as const;

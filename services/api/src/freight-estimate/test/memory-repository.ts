// Repositorio en memoria: SOLO para pruebas. Registra el orden de las llamadas y permite inyectar
// un error por método para probar los caminos de fallo.
import type { RouteProvider, LatLng } from '../../lib/route-provider';
import type { FreightEstimateRepository } from '../repository';

export type MemoryMethod =
  'getActiveFreightRow' | 'getStones' | 'getPostalCode' | 'getRouteCache' | 'putRouteCache';

export class MemoryFreightEstimateRepository implements FreightEstimateRepository {
  readonly calls: string[] = [];
  readonly stones = new Map<string, Record<string, unknown>>();
  readonly postalCodes = new Map<string, Record<string, unknown>>();
  readonly routeCache = new Map<string, Record<string, unknown>>();
  activeFreight: Record<string, unknown> | null = null;
  readonly failOn = new Map<MemoryMethod, Error>();

  private enter(method: MemoryMethod): void {
    this.calls.push(method);
    const err = this.failOn.get(method);
    if (err) throw err;
  }

  async getActiveFreightRow(): Promise<Record<string, unknown> | null> {
    this.enter('getActiveFreightRow');
    return this.activeFreight ? structuredClone(this.activeFreight) : null;
  }

  async getStones(ids: readonly string[]): Promise<Record<string, unknown>[]> {
    this.enter('getStones');
    return [...new Set(ids)].flatMap((id) =>
      this.stones.has(id) ? [structuredClone(this.stones.get(id) as Record<string, unknown>)] : [],
    );
  }

  async getPostalCode(cp: string): Promise<Record<string, unknown> | null> {
    this.enter('getPostalCode');
    const row = this.postalCodes.get(cp);
    return row ? structuredClone(row) : null;
  }

  async getRouteCache(cp: string): Promise<Record<string, unknown> | null> {
    this.enter('getRouteCache');
    const row = this.routeCache.get(cp);
    return row ? structuredClone(row) : null;
  }

  async putRouteCache(item: Record<string, unknown>): Promise<void> {
    this.enter('putRouteCache');
    this.routeCache.set(String(item['cp']), structuredClone(item));
  }
}

/** Proveedor de rutas falso: devuelve una distancia fija y registra con qué se le llamó. */
export class FakeRouteProvider implements RouteProvider {
  readonly calls: { origin: LatLng; destination: LatLng }[] = [];
  error: Error | null = null;

  constructor(public km: number = 62) {}

  async getDistanceKm(origin: LatLng, destination: LatLng): Promise<number> {
    this.calls.push({ origin, destination });
    if (this.error) throw this.error;
    return this.km;
  }
}

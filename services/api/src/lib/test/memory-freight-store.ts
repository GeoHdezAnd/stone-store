// Almacén en memoria de `computeFreightEstimate`: SOLO para pruebas. Registra las llamadas y permite
// inyectar un error por método para probar los caminos de fallo.
import type { FreightLookupStore } from '../freight-quote';

export type MemoryStoreMethod = 'getPostalCode' | 'getRouteCache' | 'putRouteCache';

export class MemoryFreightStore implements FreightLookupStore {
  readonly calls: MemoryStoreMethod[] = [];
  readonly postalCodes = new Map<string, Record<string, unknown>>();
  readonly routeCache = new Map<string, Record<string, unknown>>();
  readonly failOn = new Map<MemoryStoreMethod, Error>();

  private enter(method: MemoryStoreMethod): void {
    this.calls.push(method);
    const err = this.failOn.get(method);
    if (err) throw err;
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

// Proveedor de rutas falso: SOLO para pruebas. Devuelve una distancia fija y registra con qué se le llamó.
import type { RouteProvider, LatLng } from '../../lib/route-provider';

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

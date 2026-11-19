import { toCents, type FreightConfig, type Truck } from './config';

export interface TruckPlan {
  camion: Truck;
  viajes: number;
  /** Costo de UN viaje, en centavos enteros (sin ida y vuelta ni recargo). */
  costoViajeCentavos: number;
}

/** Costo de un viaje en centavos: max(mínimo, base + km × porKm). */
export function tripCostCents(truck: Truck, distanciaKm: number): number {
  const variable = toCents(truck.base) + Math.round(toCents(truck.porKm) * distanciaKm);
  return Math.max(toCents(truck.minimo), variable);
}

/**
 * Elige el camión de menor costo que cubra el peso en un viaje (peso == capacidad cabe).
 * Empate de costo: gana el de menor capacidad. Si el peso excede al camión más grande, se
 * usan viajes del camión más grande (decisión simple: no se mezcla un último viaje más barato).
 */
export function pickTrucks(
  pesoKg: number,
  distanciaKm: number,
  config: Pick<FreightConfig, 'camiones'>,
): TruckPlan {
  let best: TruckPlan | null = null;
  for (const t of config.camiones) {
    if (t.capacidadKg < pesoKg) continue;
    const cost = tripCostCents(t, distanciaKm);
    if (
      best === null ||
      cost < best.costoViajeCentavos ||
      (cost === best.costoViajeCentavos && t.capacidadKg < best.camion.capacidadKg)
    ) {
      best = { camion: t, viajes: 1, costoViajeCentavos: cost };
    }
  }
  if (best) return best;

  // Camión más grande; si hay empate de capacidad, el de menor costo por viaje.
  const largest = config.camiones.reduce((a, b) => {
    if (b.capacidadKg !== a.capacidadKg) return b.capacidadKg > a.capacidadKg ? b : a;
    return tripCostCents(b, distanciaKm) < tripCostCents(a, distanciaKm) ? b : a;
  });
  return {
    camion: largest,
    viajes: Math.ceil(pesoKg / largest.capacidadKg),
    costoViajeCentavos: tripCostCents(largest, distanciaKm),
  };
}

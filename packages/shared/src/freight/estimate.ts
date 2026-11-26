import { toCents, type FreightConfig } from './config';
import { FreightError } from './errors';
import { pickTrucks } from './trucks';
import { computeWeightKg, type FreightItem } from './weight';
import type { Stone } from '../catalog/stone';

export const FREIGHT_NOTICE = 'Estimado sujeto a confirmación.';

/** Paso de redondeo del rango, en centavos ($50). */
const STEP_CENTS = 5000;

/** Tope de viajes por estimado; más allá → `too_large` («consúltenos por WhatsApp»). */
export const MAX_TRIPS = 100;

interface FreightEstimateBase {
  /** Distancia por carretera ya resuelta (km). */
  distanciaKm: number;
  items: readonly FreightItem[];
  stones: readonly Stone[];
  config: FreightConfig;
}

/**
 * - Flujo público (`POST /quotes`): `codigoPostal` OBLIGATORIO; se valida
 *   formato y zona de cobertura.
 * - Simulador del dashboard: `skipZoneCheck: true` (bandera EXPLÍCITA) permite omitir el CP y
 *   salta SOLO la verificación de zona. Si aun así se da un CP, se valida su formato. `maxKm`
 *   siempre aplica.
 */
export type FreightEstimateInput =
  | (FreightEstimateBase & { codigoPostal: string; skipZoneCheck?: false })
  | (FreightEstimateBase & { codigoPostal?: string; skipZoneCheck: true });

export interface FreightEstimate {
  estimadoMin: number;
  estimadoMax: number;
  moneda: 'MXN';
  pesoTotalKg: number;
  distanciaKm: number;
  camion: string;
  viajes: number;
  versionTarifa: string;
  ejemplo?: true;
  aviso: string;
}

const OUT_OF_ZONE_MSG =
  'Esa ubicación queda fuera de nuestra zona de entrega: consúltenos por WhatsApp.';

/**
 * Estimado de flete (CLAUDE.md 7.2, pasos 1, 4, 5, 6, 7 y 8; la distancia llega resuelta).
 * costo = (max(mínimo, base + km × porKm) × viajes × (idaYVuelta ? 2 : 1)) + recargoDescarga;
 * rango = costo ± margenRango, min hacia abajo y max hacia arriba a múltiplos de $50.
 * Todo en centavos enteros. Lanza `FreightError`.
 */
export function estimateFreight(input: FreightEstimateInput): FreightEstimate {
  const { codigoPostal, distanciaKm, items, stones, config } = input;
  // Solo el literal `true` salta la zona (un JS permisivo con 1 o "true" no cuenta).
  const skipZone = input.skipZoneCheck === true;

  if (codigoPostal === undefined) {
    if (!skipZone) {
      throw new FreightError('invalid_postal_code', 'El código postal debe tener 5 dígitos.');
    }
  } else {
    if (typeof codigoPostal !== 'string' || !/^\d{5}$/.test(codigoPostal)) {
      throw new FreightError('invalid_postal_code', 'El código postal debe tener 5 dígitos.');
    }
    if (!skipZone && !config.zonasCubiertas.some((z) => codigoPostal.startsWith(z))) {
      throw new FreightError('out_of_zone', OUT_OF_ZONE_MSG);
    }
  }
  if (typeof distanciaKm !== 'number' || !Number.isFinite(distanciaKm) || distanciaKm < 0) {
    throw new FreightError('invalid_distance', 'La distancia no es válida.');
  }
  if (distanciaKm > config.maxKm) {
    throw new FreightError('out_of_zone', OUT_OF_ZONE_MSG);
  }

  const pesoKg = computeWeightKg(items, stones, config);
  const plan = pickTrucks(pesoKg, distanciaKm, config);
  if (plan.viajes > MAX_TRIPS) {
    throw new FreightError(
      'too_large',
      'El pedido requiere demasiados viajes para estimarlo en línea: consúltenos por WhatsApp.',
    );
  }

  const totalCents =
    plan.costoViajeCentavos * plan.viajes * (config.idaYVuelta ? 2 : 1) +
    toCents(config.recargoDescarga);

  const minCents =
    Math.floor(Math.round(totalCents * (1 - config.margenRango)) / STEP_CENTS) * STEP_CENTS;
  const maxCents =
    Math.ceil(Math.round(totalCents * (1 + config.margenRango)) / STEP_CENTS) * STEP_CENTS;

  return {
    estimadoMin: minCents / 100,
    estimadoMax: maxCents / 100,
    moneda: 'MXN',
    // Hacia arriba: el peso mostrado nunca contradice el camión elegido (3500.01 → 3501).
    pesoTotalKg: Math.ceil(pesoKg),
    distanciaKm,
    camion: plan.camion.nombre,
    viajes: plan.viajes,
    versionTarifa: config.version,
    ...(config.ejemplo === true ? { ejemplo: true as const } : {}),
    aviso: FREIGHT_NOTICE,
  };
}

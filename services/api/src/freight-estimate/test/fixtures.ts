// Datos de EJEMPLO para las pruebas (solo soporte de tests; no se empaqueta en la Lambda).
import { configBody, stoneRow, storedRow } from '../../admin-freight/test/fixtures';
import { MemoryFreightEstimateRepository } from './memory-repository';

export const NOW = new Date('2026-11-20T15:30:00.000Z');
export const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);

/** Origen de `configBody()` (el patio de ejemplo). */
export const ORIGIN = { lat: 19.1, lng: -97.62 };

/** Coordenadas del CP 72810 sembrado. */
export const DESTINO = { lat: 19.05, lng: -98.3 };

/** Cuerpo válido de `POST /freight/estimate`: 1 m² de arenisca a 5 cm (110 kg). */
export function validBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    codigoPostal: '72810',
    items: [{ stoneId: 'arenisca', cantidad: 1, unidad: 'm2', espesorCm: 5 }],
    ...over,
  };
}

/**
 * Siembra tarifa activa (camioneta 3500 kg, torton 12 t, tráiler 25 t; zonas 72/73/74; maxKm 350),
 * piedras (arenisca m²/tonelada, caliza tonelada, travertino inactivo) y los CP 72810, 74000 y
 * 90000 (este último fuera de las zonas cubiertas).
 */
export function seedRepo(repo: MemoryFreightEstimateRepository): void {
  repo.activeFreight = storedRow('t0002', configBody());
  repo.stones.set('arenisca', stoneRow({ vendidaPor: ['m2', 'tonelada'], espesoresCm: [3, 5] }));
  repo.stones.set(
    'caliza',
    stoneRow({
      id: 'caliza',
      nombre: 'Caliza',
      acabados: ['Cepillado'],
      vendidaPor: ['tonelada'],
      densidadKgM3: 2400,
    }),
  );
  repo.stones.set(
    'travertino',
    stoneRow({ id: 'travertino', nombre: 'Travertino', activa: false }),
  );
  const cp = (code: string, lat: number, lng: number) => ({
    cp: code,
    estado: 'Puebla',
    municipio: 'Municipio (ejemplo)',
    colonia: 'Colonia (ejemplo)',
    lat,
    lng,
  });
  repo.postalCodes.set('72810', cp('72810', DESTINO.lat, DESTINO.lng));
  repo.postalCodes.set('74000', cp('74000', 19.16, -98.4));
  repo.postalCodes.set('90000', { ...cp('90000', 19.318, -98.238), estado: 'Tlaxcala' });
}

export interface EventOptions {
  headers?: Record<string, string | undefined>;
  method?: string;
  isBase64Encoded?: boolean;
  requestId?: string;
}

/** Evento payload v2 mínimo. `body` objeto -> JSON; texto -> tal cual. */
export function event(body: unknown, opts: EventOptions = {}): never {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    rawPath: '/freight/estimate',
    headers: { 'content-type': 'application/json', ...opts.headers },
    body: raw,
    isBase64Encoded: opts.isBase64Encoded ?? false,
    requestContext: {
      requestId: opts.requestId ?? 'req-1',
      http: { method: opts.method ?? 'POST', sourceIp: '203.0.113.7' },
    },
  } as never;
}

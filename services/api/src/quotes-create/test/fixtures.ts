// Datos de EJEMPLO para las pruebas (solo soporte de tests; no se empaqueta en la Lambda).
import { PUBLIC_ROW } from '../../admin-quotes/test/fixtures';
import { configBody, stoneRow, storedRow } from '../../admin-freight/test/fixtures';
import { MemoryQuotesCreateRepository } from './memory-repository';

export const NOW = new Date('2026-11-20T15:30:00.000Z');

/** Cuerpo válido de `POST /quotes`. Los valores `SENTINEL_*` sirven para buscar fugas en logs. */
export const SENTINEL = {
  nombre: 'Marisol Quintanilla',
  correo: 'marisol.quintanilla@cliente-ejemplo.mx',
  telefono: '2225550148',
  lugar: 'Rancho Los Álamos, Calle Secreta 77',
  notas: 'Llamar después de las 6 pm al portón azul',
  token: 'tok-secreto-del-captcha-9f8e7d',
} as const;

export function validBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    customer: {
      nombre: SENTINEL.nombre,
      telefono: SENTINEL.telefono,
      correo: SENTINEL.correo,
    },
    works: {
      lugar: SENTINEL.lugar,
      codigoPostal: '72810',
      uso: 'Fachada',
      notas: SENTINEL.notas,
    },
    items: [
      { stoneId: 'arenisca', acabado: 'Labrado', cantidad: 10, unidad: 'm2', espesorCm: 5 },
      { stoneId: 'caliza', cantidad: 2, unidad: 'tonelada' },
    ],
    consent: true,
    website: '',
    turnstileToken: 'test-pass',
    ...over,
  };
}

/** Siembra tarifa activa (merma 5 %), 3 piedras (una inactiva) y la fila PUBLIC de Settings. */
export function seedRepo(repo: MemoryQuotesCreateRepository): void {
  repo.activeFreight = storedRow('t0002', { ...configBody(), mermaPct: 5 });
  repo.stones.set('arenisca', stoneRow({ vendidaPor: ['m2', 'tonelada'], espesoresCm: [3, 5] }));
  repo.stones.set(
    'caliza',
    stoneRow({
      id: 'caliza',
      nombre: 'Caliza',
      acabados: ['Cepillado'],
      vendidaPor: ['m2', 'tonelada', 'pieza'],
      pesoKgPorPieza: 35,
      densidadKgM3: 2400,
    }),
  );
  repo.stones.set(
    'travertino',
    stoneRow({ id: 'travertino', nombre: 'Travertino', activa: false }),
  );
  repo.publicSettings = structuredClone(PUBLIC_ROW);
}

export interface EventOptions {
  headers?: Record<string, string | undefined>;
  method?: string;
  isBase64Encoded?: boolean;
  sourceIp?: string | null;
  requestId?: string;
}

/** Evento payload v2 mínimo. `body` objeto -> JSON; texto -> tal cual. */
export function event(body: unknown, opts: EventOptions = {}): never {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const sourceIp = opts.sourceIp === undefined ? '203.0.113.7' : opts.sourceIp;
  return {
    rawPath: '/quotes',
    headers: {
      'content-type': 'application/json',
      'user-agent': 'Mozilla/5.0 (pruebas)',
      referer: 'https://sitio.ejemplo.mx/contacto?correo=x@example.com',
      ...opts.headers,
    },
    body: raw,
    isBase64Encoded: opts.isBase64Encoded ?? false,
    requestContext: {
      requestId: opts.requestId ?? 'req-1',
      http: {
        method: opts.method ?? 'POST',
        ...(sourceIp === null ? {} : { sourceIp }),
      },
    },
  } as never;
}

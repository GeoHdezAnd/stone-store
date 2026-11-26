import {
  FreightError,
  freightConfigSchema,
  stoneSchema,
  type FreightConfig,
  type FreightItem,
  type Stone,
} from '@canteras/shared';
import { describe, expect, it } from 'vitest';
import { configBody, stoneRow, storedRow } from '../../admin-freight/test/fixtures';
import { FakeRouteProvider } from '../../quotes-create/test/fake-route-provider';
import {
  computeFreightEstimate,
  NEGATIVE_ROUTE_CACHE_TTL_SECONDS,
  ROUTE_CACHE_TTL_DAYS,
} from '../freight-quote';
import { HttpError } from '../http';
import { createLogger } from '../logger';
import { NO_ROUTE_REASON, RouteProviderError } from '../route-provider';
import { MemoryFreightStore } from './memory-freight-store';

const NOW = new Date('2026-11-20T15:30:00.000Z');
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);
const ORIGIN = { lat: 19.1, lng: -97.62 };
const DESTINO = { lat: 19.05, lng: -98.3 };

const config: FreightConfig = freightConfigSchema.parse(storedRow('t0002', configBody()));
const arenisca: Stone = stoneSchema.parse(
  stoneRow({ vendidaPor: ['m2', 'tonelada'], espesoresCm: [3, 5] }),
);
const oneSquareMeter: FreightItem[] = [
  { stoneId: 'arenisca', cantidad: 1, unidad: 'm2', espesorCm: 5 },
];

const postal = (cp: string, lat: number, lng: number) => ({
  cp,
  estado: 'Puebla',
  municipio: 'Municipio (ejemplo)',
  colonia: 'Colonia (ejemplo)',
  lat,
  lng,
});

function setup() {
  const store = new MemoryFreightStore();
  store.postalCodes.set('72810', postal('72810', DESTINO.lat, DESTINO.lng));
  store.postalCodes.set('90000', postal('90000', 19.318, -98.238));
  const routes = new FakeRouteProvider(62);
  const logs: string[] = [];
  const log = createLogger({ requestId: 'req-1' }, (l) => logs.push(l));
  const run = (over: { codigoPostal?: string; items?: FreightItem[] } = {}) =>
    computeFreightEstimate(
      { store, routes },
      {
        codigoPostal: over.codigoPostal ?? '72810',
        items: over.items ?? oneSquareMeter,
        stones: [arenisca],
        config,
        at: NOW,
        log,
      },
    );
  return { store, routes, logs, run };
}

const positive = (over: Record<string, unknown> = {}) => ({
  cp: '72810',
  distanciaKm: 40,
  origen: { ...ORIGIN },
  destino: { ...DESTINO },
  calculadoAt: '2026-11-01T00:00:00.000Z',
  ttl: NOW_SECONDS + 1000,
  ...over,
});

const negative = (over: Record<string, unknown> = {}) => ({
  cp: '72810',
  fallo: 'sin_ruta',
  origen: { ...ORIGIN },
  destino: { ...DESTINO },
  calculadoAt: '2026-11-20T15:00:00.000Z',
  ttl: NOW_SECONDS + 1000,
  ...over,
});

const noRoute = () => new RouteProviderError(NO_ROUTE_REASON);

describe('RouteCache positiva', () => {
  it('miss: calcula con el proveedor desde el origen de la tarifa y guarda la fila exacta', async () => {
    const { run, store, routes } = setup();
    const estimate = await run();
    expect(estimate.distanciaKm).toBe(62);
    expect(routes.calls).toEqual([{ origin: ORIGIN, destination: DESTINO }]);
    expect(ROUTE_CACHE_TTL_DAYS).toBe(90);
    expect(store.routeCache.get('72810')).toEqual({
      cp: '72810',
      distanciaKm: 62,
      origen: ORIGIN,
      destino: DESTINO,
      calculadoAt: NOW.toISOString(),
      ttl: NOW_SECONDS + 90 * 24 * 3600,
    });
  });

  it('hit vigente: usa la distancia guardada, no llama al proveedor ni escribe', async () => {
    const { run, store, routes } = setup();
    store.routeCache.set('72810', positive());
    expect((await run()).distanciaKm).toBe(40);
    expect(routes.calls).toHaveLength(0);
    expect(store.calls).not.toContain('putRouteCache');
  });

  it('el origen de la tarifa cambió (lat o lng): recalcula y sobrescribe', async () => {
    for (const origen of [
      { lat: 19.2, lng: ORIGIN.lng },
      { lat: ORIGIN.lat, lng: -97.7 },
    ]) {
      const { run, store, routes } = setup();
      store.routeCache.set('72810', positive({ origen }));
      expect((await run()).distanciaKm).toBe(62);
      expect(routes.calls).toHaveLength(1);
      expect(store.routeCache.get('72810')?.['origen']).toEqual(ORIGIN);
    }
  });

  it('el destino del CP cambió (lat o lng): recalcula y sobrescribe', async () => {
    for (const destino of [
      { lat: 19.06, lng: DESTINO.lng },
      { lat: DESTINO.lat, lng: -98.31 },
    ]) {
      const { run, store, routes } = setup();
      store.routeCache.set('72810', positive({ destino }));
      expect((await run()).distanciaKm).toBe(62);
      expect(routes.calls).toHaveLength(1);
      expect(store.routeCache.get('72810')?.['destino']).toEqual(DESTINO);
    }
  });

  it('un ttl vencido (igual o menor que ahora) se ignora y se recalcula', async () => {
    for (const ttl of [NOW_SECONDS, NOW_SECONDS - 5]) {
      const { run, store, routes } = setup();
      store.routeCache.set('72810', positive({ ttl }));
      expect((await run()).distanciaKm).toBe(62);
      expect(routes.calls).toHaveLength(1);
    }
  });

  it('un ttl que vence un segundo después todavía sirve', async () => {
    const { run, store, routes } = setup();
    store.routeCache.set('72810', positive({ ttl: NOW_SECONDS + 1 }));
    expect((await run()).distanciaKm).toBe(40);
    expect(routes.calls).toHaveLength(0);
  });

  it('filas corruptas o ambiguas se tratan como miss', async () => {
    const malas = [
      positive({ distanciaKm: 'x' }),
      positive({ distanciaKm: -1 }),
      positive({ distanciaKm: Number.NaN }),
      positive({ distanciaKm: Number.POSITIVE_INFINITY }),
      positive({ distanciaKm: undefined }),
      positive({ origen: undefined }),
      positive({ destino: undefined }),
      positive({ origen: { lat: 'a', lng: 'b' } }),
      positive({ destino: { lat: 'a', lng: 'b' } }),
      positive({ origen: 'x' }),
      positive({ ttl: undefined }),
      positive({ ttl: '9999999999' }),
      positive({ ttl: Number.NaN }),
      positive({ fallo: 'sin_ruta' }),
      positive({ fallo: 'otra_cosa' }),
    ];
    for (const row of malas) {
      const { run, store, routes } = setup();
      store.routeCache.set('72810', row);
      expect((await run()).distanciaKm, JSON.stringify(row)).toBe(62);
      expect(routes.calls, JSON.stringify(row)).toHaveLength(1);
    }
  });

  it('distancia 0 guardada es válida (mismo punto)', async () => {
    const { run, store, routes } = setup();
    store.routeCache.set('72810', positive({ distanciaKm: 0 }));
    await run();
    expect(routes.calls).toHaveLength(0);
  });

  it('el Put es best-effort: si falla, el estimado sigue y se registra sin el mensaje', async () => {
    const { run, store, logs } = setup();
    store.failOn.set('putRouteCache', new Error('detalle-interno-secreto'));
    expect((await run()).distanciaKm).toBe(62);
    const warn = logs
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((l) => l['level'] === 'warn');
    expect(warn).toMatchObject({ msg: 'route_cache_write_failed', errName: 'Error' });
    expect(logs.join('\n')).not.toContain('detalle-interno-secreto');
  });

  it('una distancia inválida del proveedor responde 502 y no se guarda', async () => {
    for (const km of [-3, Number.NaN, Number.POSITIVE_INFINITY]) {
      const { run, store, routes } = setup();
      routes.km = km;
      await expect(run()).rejects.toMatchObject({ status: 502 });
      expect(store.routeCache.size).toBe(0);
      expect(store.calls).not.toContain('putRouteCache');
    }
  });
});

describe('errores del proveedor', () => {
  it('errores transitorios NO se guardan como caché negativa y propagan 502 en cada intento', async () => {
    for (const err of [
      new RouteProviderError('TimeoutError'),
      new RouteProviderError('ThrottlingException'),
      new RouteProviderError('InternalServerException'),
      new RouteProviderError('bad_response'),
      new Error('socket hang up'),
    ]) {
      const { run, routes, store } = setup();
      routes.error = err;
      for (let i = 0; i < 3; i++) {
        const failure = await run().catch((e: unknown) => e);
        expect(failure).toBeInstanceOf(HttpError);
        expect(failure).toMatchObject({ status: 502 });
      }
      expect(routes.calls, String(err)).toHaveLength(3);
      expect(store.routeCache.size).toBe(0);
      expect(store.calls).not.toContain('putRouteCache');
    }
  });

  it('el fallo del proveedor se registra con el motivo y sin el CP completo', async () => {
    const { run, routes, logs } = setup();
    routes.error = new RouteProviderError('AccessDeniedException');
    await expect(run()).rejects.toMatchObject({ status: 502 });
    const line = logs.find((l) => l.includes('route_provider_failed'))!;
    expect(line).toContain('AccessDeniedException');
    expect(line).not.toContain('72810');
  });
});

describe('RouteCache negativa («Location respondió 200 pero sin ruta»)', () => {
  it('el TTL negativo es de 1 hora', () => {
    expect(NEGATIVE_ROUTE_CACHE_TTL_SECONDS).toBe(3600);
  });

  it('«sin ruta» se guarda con su ttl corto y el resto de intentos NO llama al proveedor', async () => {
    const { run, routes, store } = setup();
    routes.error = noRoute();
    for (let i = 0; i < 5; i++) {
      await expect(run()).rejects.toMatchObject({ status: 502 });
    }
    expect(routes.calls).toHaveLength(1);
    expect(store.routeCache.get('72810')).toEqual({
      cp: '72810',
      fallo: 'sin_ruta',
      origen: ORIGIN,
      destino: DESTINO,
      calculadoAt: NOW.toISOString(),
      ttl: NOW_SECONDS + 3600,
    });
  });

  it('un acierto negativo vigente no escribe y no registra el CP completo', async () => {
    const { run, store, routes, logs } = setup();
    store.routeCache.set('72810', negative());
    await expect(run()).rejects.toMatchObject({ status: 502 });
    expect(routes.calls).toHaveLength(0);
    expect(store.calls).not.toContain('putRouteCache');
    expect(logs.join('\n')).not.toContain('72810');
  });

  it('una negativa vencida (ttl igual o menor que ahora) se recalcula y la sobrescribe', async () => {
    for (const ttl of [NOW_SECONDS, NOW_SECONDS - 1]) {
      const { run, store, routes } = setup();
      store.routeCache.set('72810', negative({ ttl }));
      expect((await run()).distanciaKm).toBe(62);
      expect(routes.calls).toHaveLength(1);
      expect(store.routeCache.get('72810')?.['distanciaKm']).toBe(62);
      expect(store.routeCache.get('72810')).not.toHaveProperty('fallo');
    }
  });

  it('una negativa con origen o destino distinto se recalcula', async () => {
    for (const over of [
      { origen: { lat: 19.2, lng: ORIGIN.lng } },
      { origen: { lat: ORIGIN.lat, lng: -97.7 } },
      { destino: { lat: 19.06, lng: DESTINO.lng } },
      { destino: { lat: DESTINO.lat, lng: -98.31 } },
      { origen: undefined },
      { destino: undefined },
    ]) {
      const { run, store, routes } = setup();
      store.routeCache.set('72810', negative(over));
      expect((await run()).distanciaKm, JSON.stringify(over)).toBe(62);
      expect(routes.calls).toHaveLength(1);
    }
  });

  it('filas ambiguas o viejas no cuentan como negativa', async () => {
    const malas = [
      negative({ fallo: 'otra_cosa' }),
      negative({ fallo: 'otra_cosa', distanciaKm: 40 }),
      negative({ distanciaKm: 40 }),
      negative({ ttl: '9999999999' }),
      negative({ ttl: undefined }),
    ];
    for (const row of malas) {
      const { run, store, routes } = setup();
      store.routeCache.set('72810', row);
      const estimate = await run().catch((e: unknown) => e);
      // Las ambiguas con distanciaKm válida y fallo ajeno son miss; ninguna responde 502 desde caché.
      expect(estimate, JSON.stringify(row)).toMatchObject({ distanciaKm: 62 });
      expect(routes.calls).toHaveLength(1);
    }
  });

  it('el Put de la negativa es best-effort: sigue el 502 y se registra sin el mensaje', async () => {
    const { run, routes, store, logs } = setup();
    routes.error = noRoute();
    store.failOn.set('putRouteCache', new Error('detalle-interno-secreto'));
    await expect(run()).rejects.toMatchObject({ status: 502 });
    expect(logs.join('\n')).toContain('route_cache_write_failed');
    expect(logs.join('\n')).not.toContain('detalle-interno-secreto');
  });
});

describe('antes de pagar la ruta', () => {
  it('un CP fuera de las zonas cubiertas lanza FreightError y no consulta ni escribe la caché', async () => {
    const { run, store, routes } = setup();
    routes.error = noRoute();
    await expect(run({ codigoPostal: '90000' })).rejects.toBeInstanceOf(FreightError);
    expect(routes.calls).toHaveLength(0);
    expect(store.calls).not.toContain('getRouteCache');
    expect(store.calls).not.toContain('putRouteCache');
    expect(store.routeCache.size).toBe(0);
  });

  it('un CP ausente de PostalCodes lanza FreightError out_of_zone sin pagar ruta', async () => {
    const { run, store, routes } = setup();
    store.postalCodes.clear();
    await expect(run()).rejects.toMatchObject({ code: 'out_of_zone' });
    expect(routes.calls).toHaveLength(0);
  });

  it('una fila inválida de PostalCodes responde 503', async () => {
    const { run, store, routes } = setup();
    store.postalCodes.set('72810', { cp: '72810' });
    await expect(run()).rejects.toMatchObject({ status: 503 });
    expect(routes.calls).toHaveLength(0);
  });

  it('un pedido inválido (piedra inexistente) no paga ruta', async () => {
    const { run, routes, store } = setup();
    await expect(
      run({ items: [{ stoneId: 'no-existe', cantidad: 1, unidad: 'm2', espesorCm: 5 }] }),
    ).rejects.toBeInstanceOf(FreightError);
    expect(routes.calls).toHaveLength(0);
    expect(store.calls).not.toContain('getRouteCache');
  });

  it('una distancia mayor a maxKm lanza out_of_zone, exactamente maxKm se atiende', async () => {
    const lejos = setup();
    lejos.routes.km = config.maxKm + 1;
    await expect(lejos.run()).rejects.toMatchObject({ code: 'out_of_zone' });
    const justo = setup();
    justo.routes.km = config.maxKm;
    expect((await justo.run()).distanciaKm).toBe(config.maxKm);
  });
});

describe('cálculo', () => {
  it('1 m² de arenisca a 5 cm: 110 kg, camioneta, rango redondeado a $50', async () => {
    const { run } = setup();
    // camioneta: 800 + 62 × 12 = 1544, + 500 de descarga = 2044; ±10 % = 1839.6 / 2248.4
    expect(await run()).toMatchObject({
      estimadoMin: 1800,
      estimadoMax: 2250,
      pesoTotalKg: 110,
      distanciaKm: 62,
      camion: 'Camioneta',
      viajes: 1,
      versionTarifa: 't0002',
    });
  });
});

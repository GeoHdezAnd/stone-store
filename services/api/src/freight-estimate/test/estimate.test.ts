import { describe, expect, it } from 'vitest';
import { RouteProviderError } from '../../lib/route-provider';
import {
  createFreightEstimateHandler,
  MAX_BODY_BYTES,
  NEGATIVE_ROUTE_CACHE_TTL_SECONDS,
  ROUTE_CACHE_TTL_DAYS,
  type FreightEstimateDeps,
} from '../estimate';
import {
  event,
  NOW,
  NOW_SECONDS,
  DESTINO,
  ORIGIN,
  seedRepo,
  validBody,
  type EventOptions,
} from './fixtures';
import { FakeRouteProvider, MemoryFreightEstimateRepository } from './memory-repository';

function setup(over: Partial<FreightEstimateDeps> = {}) {
  const repo = new MemoryFreightEstimateRepository();
  seedRepo(repo);
  const routes = new FakeRouteProvider(62);
  const logs: string[] = [];
  const handler = createFreightEstimateHandler({
    repo,
    routes,
    now: () => NOW,
    logSink: (l) => logs.push(l),
    ...over,
  });
  const call = (body: unknown, opts?: EventOptions) => handler.handle(event(body, opts));
  return { repo, routes, logs, call };
}

const json = (res: { body?: string | undefined }): Record<string, unknown> =>
  JSON.parse(res.body as string) as Record<string, unknown>;

const item = (stoneId: string, cantidad: number, unidad: string, espesorCm?: number) => ({
  stoneId,
  cantidad,
  unidad,
  ...(espesorCm === undefined ? {} : { espesorCm }),
});

describe('éxito: contrato de CLAUDE.md 7.1', () => {
  it('1 m² de arenisca a 5 cm: 110 kg, camioneta, rango redondeado a $50', async () => {
    const { call } = setup();
    const res = await call(validBody());
    expect(res.statusCode).toBe(200);
    // camioneta: 800 + 62 × 12 = 1544, + 500 de descarga = 2044; ±10 % = 1839.6 / 2248.4
    expect(json(res)).toEqual({
      estimadoMin: 1800,
      estimadoMax: 2250,
      moneda: 'MXN',
      pesoTotalKg: 110,
      distanciaKm: 62,
      camion: 'Camioneta',
      viajes: 1,
      versionTarifa: 't0002',
      ejemplo: true,
      aviso: 'Estimado sujeto a confirmación.',
    });
    expect(res.headers).toMatchObject({
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
  });

  it('210 m² (23 100 kg): un tráiler al mínimo de $6 000 + descarga', async () => {
    const { call } = setup();
    const res = await call(validBody({ items: [item('arenisca', 210, 'm2', 5)] }));
    expect(json(res)).toMatchObject({
      pesoTotalKg: 23100,
      camion: 'Tráiler',
      viajes: 1,
      estimadoMin: 5850, // (6000 + 500) × 0.9
      estimadoMax: 7150,
    });
  });

  it('60 toneladas: varios viajes del camión mayor', async () => {
    const { call } = setup();
    const res = await call(validBody({ items: [item('arenisca', 60, 'tonelada')] }));
    // 60 000 kg / 25 000 = 3 viajes × 6 000 + 500 = 18 500; ±10 %
    expect(json(res)).toMatchObject({
      pesoTotalKg: 60000,
      camion: 'Tráiler',
      viajes: 3,
      estimadoMin: 16650,
      estimadoMax: 20350,
    });
  });

  it('2 toneladas = 2 000 kg', async () => {
    const { call } = setup();
    const res = await call(validBody({ items: [item('arenisca', 2, 'tonelada')] }));
    expect(json(res)).toMatchObject({ pesoTotalKg: 2000, camion: 'Camioneta', viajes: 1 });
  });

  it('mezcla de piedras: suma los pesos (1 100 + 1 000 kg)', async () => {
    const { call } = setup();
    const res = await call(
      validBody({ items: [item('arenisca', 10, 'm2', 5), item('caliza', 1, 'tonelada')] }),
    );
    expect(json(res)).toMatchObject({ pesoTotalKg: 2100, camion: 'Camioneta', viajes: 1 });
  });

  it('límite exacto del camión: 3 500 kg caben en la camioneta; 3 510 kg pasan al torton', async () => {
    const { call } = setup();
    expect(
      json(await call(validBody({ items: [item('arenisca', 3.5, 'tonelada')] }))),
    ).toMatchObject({ pesoTotalKg: 3500, camion: 'Camioneta' });
    expect(
      json(await call(validBody({ items: [item('arenisca', 3.51, 'tonelada')] }))),
    ).toMatchObject({ pesoTotalKg: 3510, camion: 'Torton' });
  });

  it('tarifa mínima: a 10 km la camioneta cobra $1 500 (no 800 + 120)', async () => {
    const { call, routes } = setup();
    routes.km = 10;
    const res = await call(validBody());
    // (1500 + 500) ± 10 % = 1800 / 2200
    expect(json(res)).toMatchObject({ estimadoMin: 1800, estimadoMax: 2200, distanciaKm: 10 });
  });

  it('el peso lo calcula el servidor: un `pesoKg` del cliente se rechaza', async () => {
    const { call, routes } = setup();
    const res = await call(validBody({ pesoKg: 1 }));
    expect(res.statusCode).toBe(400);
    expect(routes.calls).toHaveLength(0);
  });

  it('usa la tarifa ACTIVA y la distancia desde el origen de ESA tarifa hasta el CP', async () => {
    const { call, routes } = setup();
    await call(validBody());
    expect(routes.calls).toEqual([{ origin: ORIGIN, destination: { lat: 19.05, lng: -98.3 } }]);
  });
});

describe('RouteCache', () => {
  const cached = (over: Record<string, unknown> = {}) => ({
    cp: '72810',
    distanciaKm: 40,
    origen: { ...ORIGIN },
    destino: { ...DESTINO },
    calculadoAt: '2026-11-01T00:00:00.000Z',
    ttl: NOW_SECONDS + 1000,
    ...over,
  });

  it('miss: calcula con el proveedor y guarda cp, distancia, origen, fecha y ttl a 90 días', async () => {
    const { call, repo, routes } = setup();
    const res = await call(validBody());
    expect(res.statusCode).toBe(200);
    expect(routes.calls).toHaveLength(1);
    expect(ROUTE_CACHE_TTL_DAYS).toBe(90);
    expect(repo.routeCache.get('72810')).toEqual({
      cp: '72810',
      distanciaKm: 62,
      origen: ORIGIN,
      destino: DESTINO,
      calculadoAt: NOW.toISOString(),
      ttl: NOW_SECONDS + 90 * 24 * 3600,
    });
  });

  it('hit: usa la distancia guardada y NO llama al proveedor ni escribe', async () => {
    const { call, repo, routes } = setup();
    repo.routeCache.set('72810', cached());
    const res = await call(validBody());
    expect(json(res)['distanciaKm']).toBe(40);
    expect(routes.calls).toHaveLength(0);
    expect(repo.calls).not.toContain('putRouteCache');
  });

  it('el origen de la tarifa cambió (lat o lng): recalcula y sobrescribe', async () => {
    for (const origen of [
      { lat: 19.2, lng: ORIGIN.lng },
      { lat: ORIGIN.lat, lng: -97.7 },
    ]) {
      const { call, repo, routes } = setup();
      repo.routeCache.set('72810', cached({ origen }));
      const res = await call(validBody());
      expect(json(res)['distanciaKm']).toBe(62);
      expect(routes.calls).toHaveLength(1);
      expect(repo.routeCache.get('72810')?.['origen']).toEqual(ORIGIN);
    }
  });

  it('el destino del CP cambió (lat o lng): recalcula y sobrescribe', async () => {
    for (const destino of [
      { lat: 19.06, lng: DESTINO.lng },
      { lat: DESTINO.lat, lng: -98.31 },
    ]) {
      const { call, repo, routes } = setup();
      repo.routeCache.set('72810', cached({ destino }));
      const res = await call(validBody());
      expect(json(res)['distanciaKm']).toBe(62);
      expect(routes.calls).toHaveLength(1);
      expect(repo.routeCache.get('72810')?.['destino']).toEqual(DESTINO);
    }
  });

  it('corregir las coordenadas del CP tras un 422 cacheado recalcula en vez de repetir el error', async () => {
    const { call, repo, routes } = setup();
    // Coordenadas equivocadas: la ruta sale de 400 km y se cachea con ESE destino.
    repo.postalCodes.set('72810', { ...repo.postalCodes.get('72810')!, lat: 17.0, lng: -92.0 });
    routes.km = 400;
    expect((await call(validBody())).statusCode).toBe(422);
    expect(repo.routeCache.get('72810')?.['distanciaKm']).toBe(400);
    // El dueño corrige el CP: la caché vieja ya no vale.
    repo.postalCodes.set('72810', {
      ...repo.postalCodes.get('72810')!,
      lat: DESTINO.lat,
      lng: DESTINO.lng,
    });
    routes.km = 62;
    const res = await call(validBody());
    expect(res.statusCode).toBe(200);
    expect(json(res)['distanciaKm']).toBe(62);
  });

  it('un ttl vencido (DynamoDB tarda en borrar) se ignora y se recalcula', async () => {
    for (const ttl of [NOW_SECONDS, NOW_SECONDS - 5]) {
      const { call, repo, routes } = setup();
      repo.routeCache.set('72810', cached({ ttl }));
      await call(validBody());
      expect(routes.calls).toHaveLength(1);
    }
  });

  it('filas de caché corruptas se tratan como miss', async () => {
    const malas = [
      cached({ distanciaKm: 'x' }),
      cached({ distanciaKm: -1 }),
      cached({ distanciaKm: Number.NaN }),
      cached({ origen: undefined }),
      cached({ destino: undefined }),
      cached({ destino: { lat: 'a', lng: 'b' } }),
      cached({ origen: { lat: 'a', lng: 'b' } }),
      cached({ ttl: undefined }),
      cached({ ttl: '9999999999' }),
    ];
    for (const row of malas) {
      const { call, repo, routes } = setup();
      repo.routeCache.set('72810', row);
      const res = await call(validBody());
      expect(res.statusCode).toBe(200);
      expect(routes.calls, JSON.stringify(row)).toHaveLength(1);
    }
  });

  it('el Put es best-effort: si falla, la respuesta sigue siendo 200 y se registra sin el mensaje', async () => {
    const { call, repo, logs } = setup();
    repo.failOn.set('putRouteCache', new Error('detalle-interno-secreto'));
    const res = await call(validBody());
    expect(res.statusCode).toBe(200);
    expect(json(res)['distanciaKm']).toBe(62);
    const warn = logs
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((l) => l['level'] === 'warn');
    expect(warn).toMatchObject({ msg: 'route_cache_write_failed', errName: 'Error' });
    expect(logs.join('\n')).not.toContain('detalle-interno-secreto');
  });

  it('una distancia inválida del proveedor no se guarda en la caché', async () => {
    const { call, repo, routes } = setup();
    routes.km = -3;
    const res = await call(validBody());
    expect(res.statusCode).toBe(502);
    expect(repo.routeCache.size).toBe(0);
  });
});

describe('errores de entrada, en orden', () => {
  it('405 con otro método, antes de leer nada', async () => {
    const { call, repo } = setup();
    const res = await call(validBody(), { method: 'GET' });
    expect(res.statusCode).toBe(405);
    expect(json(res)).toEqual({ error: 'method_not_allowed' });
    expect(repo.calls).toEqual([]);
  });

  it('415 si no es application/json', async () => {
    const { call, repo } = setup();
    for (const ct of ['text/plain', undefined, 'application/jsonx']) {
      const res = await call(validBody(), { headers: { 'content-type': ct } });
      expect(res.statusCode, String(ct)).toBe(415);
    }
    expect(repo.calls).toEqual([]);
  });

  it('acepta application/json con charset y cabecera en otras mayúsculas', async () => {
    const { call } = setup();
    const res = await call(validBody(), {
      headers: { 'content-type': undefined, 'Content-Type': 'application/json; charset=utf-8' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('413 si el cuerpo pasa de 8 KB (en bytes, antes de parsear)', async () => {
    const { call, repo } = setup();
    expect(MAX_BODY_BYTES).toBe(8 * 1024);
    const res = await call('x'.repeat(MAX_BODY_BYTES + 1));
    expect(res.statusCode).toBe(413);
    expect(json(res)).toEqual({ error: 'payload_too_large' });
    // 4 097 caracteres de 2 bytes = 8 194 bytes
    expect((await call('ñ'.repeat(4097))).statusCode).toBe(413);
    // base64: se mide ya decodificado
    const big = Buffer.from('y'.repeat(MAX_BODY_BYTES + 1)).toString('base64');
    expect((await call(big, { isBase64Encoded: true })).statusCode).toBe(413);
    expect(repo.calls).toEqual([]);
  });

  it('400 invalid_json con JSON roto; también decodifica base64', async () => {
    const { call } = setup();
    const res = await call('{no es json');
    expect(res.statusCode).toBe(400);
    expect(json(res)).toEqual({ error: 'invalid_json' });
    const ok = await call(Buffer.from(JSON.stringify(validBody())).toString('base64'), {
      isBase64Encoded: true,
    });
    expect(ok.statusCode).toBe(200);
  });

  it('400 con CP inválido, sin leer la base ni llamar al proveedor, y sin eco de lo enviado', async () => {
    const { call, repo, routes } = setup();
    for (const cp of ['7281', '728100', 'abcde', 72810, null, '72810\n']) {
      const res = await call(validBody({ codigoPostal: cp }));
      expect(res.statusCode, String(cp)).toBe(400);
      expect(json(res)['error']).toBe('validation_error');
      expect(res.body).not.toContain('abcde');
    }
    expect(repo.calls).toEqual([]);
    expect(routes.calls).toHaveLength(0);
  });

  it('400 con cantidad inválida, unidad inválida, items vacíos o campos de más', async () => {
    const { call } = setup();
    const malos = [
      { items: [item('arenisca', 0, 'm2', 5)] },
      { items: [item('arenisca', -1, 'm2', 5)] },
      { items: [item('arenisca', 1e9, 'm2', 5)] },
      { items: [item('arenisca', 1, 'litro')] },
      { items: [] },
      { items: [{ ...item('arenisca', 1, 'm2', 5), precio: 1 }] },
      { distanciaKm: 1 },
    ];
    for (const patch of malos) {
      const res = await call(validBody(patch));
      expect(res.statusCode, JSON.stringify(patch)).toBe(400);
    }
    expect((await call([1, 2])).statusCode).toBe(400);
    expect((await call('null')).statusCode).toBe(400);
  });

  it('el 400 trae `issues` con mensajes en español', async () => {
    const { call } = setup();
    const body = json(await call(validBody({ codigoPostal: '1' })));
    expect(body['issues']).toEqual([{ message: 'El código postal debe tener 5 dígitos' }]);
  });
});

describe('datos del negocio', () => {
  it('sin tarifa activa: 503 freight_unavailable', async () => {
    const { call, repo, routes } = setup();
    repo.activeFreight = null;
    const res = await call(validBody());
    expect(res.statusCode).toBe(503);
    expect(json(res)).toEqual({ error: 'freight_unavailable' });
    expect(routes.calls).toHaveLength(0);
  });

  it('tarifa guardada inválida: 503 y se registra sin datos', async () => {
    const { call, repo, logs } = setup();
    repo.activeFreight = { version: 't0002', camiones: 'roto' };
    const res = await call(validBody());
    expect(res.statusCode).toBe(503);
    expect(json(res)).toEqual({ error: 'freight_unavailable' });
    expect(logs.join('\n')).toContain('invalid_stored_item');
  });

  it('piedra guardada inválida: 503', async () => {
    const { call, repo } = setup();
    repo.stones.set('arenisca', { id: 'arenisca' });
    const res = await call(validBody());
    expect(res.statusCode).toBe(503);
    expect(json(res)).toEqual({ error: 'freight_unavailable' });
  });

  it('piedra inexistente o inactiva: 400, sin llamar al proveedor (no se paga por una petición inválida)', async () => {
    for (const id of ['no-existe', 'travertino']) {
      const { call, routes } = setup();
      const res = await call(validBody({ items: [item(id, 1, 'm2', 5)] }));
      expect(res.statusCode, id).toBe(400);
      expect(['unknown_stone', 'inactive_stone']).toContain(json(res)['error']);
      expect(routes.calls, id).toHaveLength(0);
    }
  });

  it('unidad que la piedra no vende o espesor no disponible: 400 sin llamar al proveedor', async () => {
    const { call, routes } = setup();
    const unidad = await call(validBody({ items: [item('caliza', 1, 'm2', 5)] }));
    expect(unidad.statusCode).toBe(400);
    expect(json(unidad)['error']).toBe('unit_not_sold');
    const espesor = await call(validBody({ items: [item('arenisca', 1, 'm2', 99)] }));
    expect(espesor.statusCode).toBe(400);
    expect(json(espesor)['error']).toBe('thickness_not_available');
    expect(routes.calls).toHaveLength(0);
  });
});

describe('zona de cobertura', () => {
  const MSG = 'consúltenos por WhatsApp';

  it('CP ausente de PostalCodes: 422 out_of_zone con «consúltenos por WhatsApp»', async () => {
    const { call, routes } = setup();
    const res = await call(validBody({ codigoPostal: '72999' }));
    expect(res.statusCode).toBe(422);
    expect(json(res)['error']).toBe('out_of_zone');
    expect(String(json(res)['message'])).toContain(MSG);
    expect(routes.calls).toHaveLength(0);
  });

  it('CP existente pero fuera de zonasCubiertas: 422 y NO se paga la ruta', async () => {
    const { call, routes, repo } = setup();
    const res = await call(validBody({ codigoPostal: '90000' }));
    expect(res.statusCode).toBe(422);
    expect(json(res)['error']).toBe('out_of_zone');
    expect(String(json(res)['message'])).toContain(MSG);
    expect(routes.calls).toHaveLength(0);
    expect(repo.calls).not.toContain('getRouteCache');
    expect(repo.calls).not.toContain('putRouteCache');
  });

  it('distancia mayor a maxKm: 422 out_of_zone', async () => {
    const { call, routes } = setup();
    routes.km = 351;
    const res = await call(validBody());
    expect(res.statusCode).toBe(422);
    expect(json(res)['error']).toBe('out_of_zone');
    expect(String(json(res)['message'])).toContain(MSG);
  });

  it('exactamente maxKm todavía se atiende', async () => {
    const { call, routes } = setup();
    routes.km = 350;
    expect((await call(validBody())).statusCode).toBe(200);
  });

  it('pedido demasiado grande: 422 too_large sin llamar al proveedor', async () => {
    const { call, routes } = setup();
    const res = await call(validBody({ items: [item('arenisca', 600, 'tonelada')] }));
    expect(res.statusCode).toBe(422);
    expect(json(res)['error']).toBe('too_large');
    expect(String(json(res)['message'])).toContain(MSG);
    expect(routes.calls).toHaveLength(0);
  });

  it('fila de PostalCodes inválida: 503', async () => {
    const { call, repo } = setup();
    repo.postalCodes.set('72810', { cp: '72810', lat: 'x' });
    const res = await call(validBody());
    expect(res.statusCode).toBe(503);
    expect(json(res)).toEqual({ error: 'freight_unavailable' });
  });
});

describe('proveedor de rutas', () => {
  it('RouteProviderError: 502 route_unavailable sin detalles', async () => {
    const { call, routes } = setup();
    routes.error = new RouteProviderError('AccessDeniedException');
    const res = await call(validBody());
    expect(res.statusCode).toBe(502);
    expect(json(res)).toEqual({ error: 'route_unavailable' });
  });

  it('el fallo se registra con el motivo pero sin el CP completo', async () => {
    const { call, routes, logs } = setup();
    routes.error = new RouteProviderError('AccessDeniedException');
    await call(validBody());
    const text = logs.join('\n');
    expect(text).toContain('route_provider_failed');
    expect(text).toContain('AccessDeniedException');
    expect(text).not.toContain('72810');
  });

  it('distancia inválida del proveedor (invalid_distance): 502', async () => {
    for (const km of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const { call, routes } = setup();
      routes.km = km;
      const res = await call(validBody());
      expect(res.statusCode, String(km)).toBe(502);
    }
  });

  it('un error inesperado de la base: 500 internal_error con requestId y sin detalles', async () => {
    const { call, repo, logs } = setup();
    repo.failOn.set('getStones', new Error('conexión secreta rota'));
    const res = await call(validBody(), { requestId: 'req-xyz' });
    expect(res.statusCode).toBe(500);
    expect(json(res)).toEqual({ error: 'internal_error', requestId: 'req-xyz' });
    expect(res.body).not.toContain('secreta');
    expect(logs.join('\n')).not.toContain('secreta');
  });
});

describe('registros', () => {
  it('JSON con requestId; del CP solo los 2 primeros dígitos; sin piedras ni cantidades del cliente', async () => {
    const { call, logs } = setup();
    await call(validBody(), { requestId: 'req-42' });
    expect(logs.length).toBeGreaterThan(0);
    for (const line of logs) {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      expect(parsed['requestId']).toBe('req-42');
    }
    const text = logs.join('\n');
    expect(text).not.toContain('72810');
    expect(text).toContain('72');
  });
});

describe('RouteCache negativa («Location respondió 200 pero sin ruta»)', () => {
  const noRoute = () => new RouteProviderError('no_route');
  const negative = (over: Record<string, unknown> = {}) => ({
    cp: '72810',
    fallo: 'sin_ruta',
    origen: { ...ORIGIN },
    destino: { ...DESTINO },
    calculadoAt: '2026-11-20T15:00:00.000Z',
    ttl: NOW_SECONDS + 1000,
    ...over,
  });

  it('el TTL negativo es de 1 hora, mucho menor que el positivo', () => {
    expect(NEGATIVE_ROUTE_CACHE_TTL_SECONDS).toBe(3600);
  });

  it('5 peticiones seguidas sin ruta: 5 × 502 y UNA sola llamada de pago', async () => {
    const { call, routes, repo } = setup();
    routes.error = noRoute();
    for (let i = 0; i < 5; i++) {
      const res = await call(validBody());
      expect(res.statusCode).toBe(502);
      expect(json(res)).toEqual({ error: 'route_unavailable' });
    }
    expect(routes.calls).toHaveLength(1);
    expect(repo.routeCache.get('72810')).toEqual({
      cp: '72810',
      fallo: 'sin_ruta',
      origen: ORIGIN,
      destino: DESTINO,
      calculadoAt: NOW.toISOString(),
      ttl: NOW_SECONDS + 3600,
    });
  });

  it('errores de red, timeouts, throttling o 5xx NO se cachean: cada intento vuelve a llamar', async () => {
    for (const err of [
      new RouteProviderError('TimeoutError'),
      new RouteProviderError('ThrottlingException'),
      new RouteProviderError('InternalServerException'),
      new RouteProviderError('bad_response'),
      new Error('socket hang up'),
    ]) {
      const { call, routes, repo } = setup();
      routes.error = err;
      for (let i = 0; i < 3; i++) expect((await call(validBody())).statusCode).toBe(502);
      expect(routes.calls, String(err)).toHaveLength(3);
      expect(repo.routeCache.size).toBe(0);
    }
  });

  it('una negativa vencida se ignora y se recalcula (y si ahora hay ruta, responde 200)', async () => {
    for (const ttl of [NOW_SECONDS, NOW_SECONDS - 1]) {
      const { call, repo, routes } = setup();
      repo.routeCache.set('72810', negative({ ttl }));
      const res = await call(validBody());
      expect(res.statusCode).toBe(200);
      expect(routes.calls).toHaveLength(1);
      expect(repo.routeCache.get('72810')?.['distanciaKm']).toBe(62);
      expect(repo.routeCache.get('72810')).not.toHaveProperty('fallo');
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
      const { call, repo, routes } = setup();
      repo.routeCache.set('72810', negative(over));
      const res = await call(validBody());
      expect(res.statusCode, JSON.stringify(over)).toBe(200);
      expect(routes.calls).toHaveLength(1);
    }
  });

  it('filas ambiguas o viejas se tratan como miss (no como negativa)', async () => {
    const malas = [
      negative({ fallo: 'otra_cosa' }),
      negative({ fallo: 'otra_cosa', distanciaKm: 40 }),
      negative({ distanciaKm: 40 }),
      negative({ ttl: '9999999999' }),
      negative({ ttl: undefined }),
    ];
    for (const row of malas) {
      const { call, repo, routes } = setup();
      repo.routeCache.set('72810', row);
      const res = await call(validBody());
      expect(res.statusCode, JSON.stringify(row)).toBe(200);
      expect(routes.calls).toHaveLength(1);
    }
  });

  it('un 422 por zona o tamaño no consulta ni escribe la caché negativa', async () => {
    const { call, repo, routes } = setup();
    routes.error = noRoute();
    expect((await call(validBody({ codigoPostal: '90000' }))).statusCode).toBe(422);
    expect(routes.calls).toHaveLength(0);
    expect(repo.routeCache.size).toBe(0);
  });

  it('el Put de la negativa es best-effort: sigue el 502 y se registra sin el mensaje', async () => {
    const { call, repo, routes, logs } = setup();
    routes.error = noRoute();
    repo.failOn.set('putRouteCache', new Error('detalle-interno-secreto'));
    const res = await call(validBody());
    expect(res.statusCode).toBe(502);
    expect(json(res)).toEqual({ error: 'route_unavailable' });
    expect(logs.join('\n')).toContain('route_cache_write_failed');
    expect(logs.join('\n')).not.toContain('detalle-interno-secreto');
  });

  it('un acierto negativo no escribe y no registra el CP completo', async () => {
    const { call, repo, logs } = setup();
    repo.routeCache.set('72810', negative());
    const res = await call(validBody());
    expect(res.statusCode).toBe(502);
    expect(repo.calls).not.toContain('putRouteCache');
    expect(logs.join('\n')).not.toContain('72810');
  });
});

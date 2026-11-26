import { generateUlid, quoteSchema, stripStorageKeys } from '@canteras/shared';
import { describe, expect, it } from 'vitest';
import { FakeRouteProvider } from './fake-route-provider';
import { NEGATIVE_ROUTE_CACHE_TTL_SECONDS, ROUTE_CACHE_TTL_DAYS } from '../../lib/freight-quote';
import { NO_ROUTE_REASON, RouteProviderError, type RouteProvider } from '../../lib/route-provider';
import { FakeCaptchaVerifier } from '../captcha';
import { createQuotesCreateHandler, type QuotesCreateDeps } from '../create';
import { event, NOW, seedRepo, SENTINEL, validBody, type EventOptions } from './fixtures';
import { MemoryQuotesCreateRepository } from './memory-repository';

const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);

function setup(over: Partial<QuotesCreateDeps> = {}, km = 62) {
  const repo = new MemoryQuotesCreateRepository();
  seedRepo(repo);
  const routes = new FakeRouteProvider(km);
  const logs: string[] = [];
  let n = 0;
  const handler = createQuotesCreateHandler({
    repo,
    captcha: new FakeCaptchaVerifier(),
    mailer: null,
    routes,
    now: () => NOW,
    newQuoteId: () => generateUlid(NOW.getTime() + n++, () => 0.1),
    random: () => 0.5,
    logSink: (l) => logs.push(l),
    ...over,
  });
  const call = (body: unknown, opts?: EventOptions) => handler.handle(event(body, opts));
  return { repo, routes, logs, call };
}

const stored = (repo: MemoryQuotesCreateRepository) => [...repo.quotes.values()][0]!;

describe('estimado de flete en la solicitud: guardado', () => {
  it('guarda `freight` recalculado en el servidor con los 9 campos de CLAUDE.md 6.2', async () => {
    const { call, repo, routes } = setup();
    const res = await call(validBody());
    expect(res.statusCode).toBe(201);
    expect(routes.calls).toHaveLength(1);
    const freight = stored(repo)['freight'] as Record<string, unknown>;
    expect(Object.keys(freight).sort()).toEqual(
      [
        'calculadoAt',
        'camion',
        'distanciaKm',
        'estimadoMax',
        'estimadoMin',
        'moneda',
        'pesoTotalKg',
        'versionTarifa',
        'viajes',
      ].sort(),
    );
    expect(freight).toMatchObject({
      moneda: 'MXN',
      distanciaKm: 62,
      versionTarifa: 't0002',
      calculadoAt: NOW.toISOString(),
    });
    expect(freight['estimadoMin'] as number).toBeGreaterThan(0);
    expect(freight['estimadoMax'] as number).toBeGreaterThanOrEqual(
      freight['estimadoMin'] as number,
    );
    expect(freight['viajes'] as number).toBeGreaterThanOrEqual(1);
  });

  it('el documento guardado sigue pasando quoteSchema', async () => {
    const { call, repo } = setup();
    await call(validBody());
    const r = quoteSchema.safeParse(stripStorageKeys(stored(repo)));
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
  });

  it('el peso del estimado es la suma de los pesos de los renglones guardados (con merma)', async () => {
    const { call, repo } = setup();
    await call(validBody());
    const q = stored(repo) as { items: { pesoKg: number }[]; freight: { pesoTotalKg: number } };
    const suma = q.items.reduce((acc, i) => acc + i.pesoKg, 0);
    expect(q.freight.pesoTotalKg).toBeCloseTo(suma, 1);
  });

  it('un `freight` mandado por el navegador se rechaza (422) y no se guarda nada ni se paga ruta', async () => {
    const { call, repo, routes } = setup();
    const res = await call(
      validBody({
        freight: {
          estimadoMin: 1,
          estimadoMax: 2,
          moneda: 'MXN',
          pesoTotalKg: 1,
          distanciaKm: 1,
          camion: 'x',
          viajes: 1,
          versionTarifa: 't0001',
          calculadoAt: NOW.toISOString(),
        },
      }),
    );
    expect(res.statusCode).toBe(422);
    expect(repo.quotes.size).toBe(0);
    expect(routes.calls).toHaveLength(0);
  });

  it('los campos sueltos del navegador (distanciaKm, estimado) tampoco pasan', async () => {
    const { call, routes } = setup();
    for (const extra of [{ distanciaKm: 1 }, { estimado: 10 }, { pesoKg: 5 }]) {
      const res = await call(validBody(extra));
      expect(res.statusCode).toBe(422);
    }
    expect(routes.calls).toHaveLength(0);
  });
});

describe('estimado de flete: si falla, la solicitud se guarda igual sin `freight`', () => {
  async function sinFreight(
    over: Partial<QuotesCreateDeps>,
    prepare?: (repo: MemoryQuotesCreateRepository) => void,
    body: Record<string, unknown> = validBody(),
  ) {
    const ctx = setup(over);
    prepare?.(ctx.repo);
    const res = await ctx.call(body);
    expect(res.statusCode).toBe(201);
    expect(ctx.repo.quotes.size).toBe(1);
    expect('freight' in stored(ctx.repo)).toBe(false);
    return ctx;
  }

  it('CP ausente de PostalCodes: sin freight y SIN llamar al proveedor', async () => {
    const { routes, logs } = await sinFreight({}, (repo) => repo.postalCodes.clear());
    expect(routes.calls).toHaveLength(0);
    expect(logs.some((l) => l.includes('freight_estimate_skipped'))).toBe(true);
  });

  it('CP fuera de las zonas cubiertas: sin freight y SIN llamar al proveedor', async () => {
    const { routes } = await sinFreight(
      {},
      undefined,
      validBody({ works: { lugar: 'Obra', codigoPostal: '90000', uso: '', notas: '' } }),
    );
    expect(routes.calls).toHaveLength(0);
  });

  it('el proveedor falla (RouteProviderError): sin freight y log sin PII', async () => {
    const provider = new FakeRouteProvider();
    provider.error = new RouteProviderError('AccessDeniedException');
    const { logs } = await sinFreight({ routes: provider });
    const line = logs.find((l) => l.includes('freight_estimate_failed'));
    expect(line).toBeDefined();
    expect(line).toContain('"requestId"');
    for (const secreto of [
      '72810',
      SENTINEL.correo,
      SENTINEL.nombre,
      SENTINEL.telefono,
      SENTINEL.lugar,
    ]) {
      expect(logs.join('\n')).not.toContain(secreto);
    }
  });

  it('un error inesperado del proveedor (no tipado) tampoco rompe la solicitud', async () => {
    const provider = new FakeRouteProvider();
    provider.error = new TypeError('boom con 72810 y marisol.quintanilla@cliente-ejemplo.mx');
    const { logs } = await sinFreight({ routes: provider });
    expect(logs.join('\n')).not.toContain('boom');
    expect(logs.join('\n')).not.toContain(SENTINEL.correo);
  });

  it('proveedor lento: pasado el plazo se guarda sin freight (no agota los 10 s de la Lambda)', async () => {
    const lento: RouteProvider = { getDistanceKm: () => new Promise<number>(() => undefined) };
    const t0 = Date.now();
    await sinFreight({ routes: lento, freightTimeoutMs: 25 });
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('lectura de PostalCodes o RouteCache caída: sin freight', async () => {
    await sinFreight({}, (repo) => repo.failOn.set('getPostalCode', new Error('db')));
    await sinFreight({}, (repo) => repo.failOn.set('getRouteCache', new Error('db')));
  });

  it('sin proveedor configurado (`routes` ausente): no se estima ni se lee PostalCodes', async () => {
    const { repo } = await sinFreight({ routes: undefined });
    expect(repo.calls).not.toContain('getPostalCode');
  });

  it('distancia absurda del proveedor (más allá de maxKm): se guarda sin freight, no tumba la solicitud', async () => {
    const provider = new FakeRouteProvider(1e9);
    await sinFreight({ routes: provider });
  });

  it('no hay tarifa activa: la solicitud sigue fallando como antes (503), sin estimar', async () => {
    const { call, repo, routes } = setup();
    repo.activeFreight = null;
    const res = await call(validBody());
    expect(res.statusCode).toBe(503);
    expect(routes.calls).toHaveLength(0);
  });

  it('un fallo al guardar la caché (best-effort) no impide el freight', async () => {
    const { call, repo } = setup();
    repo.failOn.set('putRouteCache', new Error('db'));
    const res = await call(validBody());
    expect(res.statusCode).toBe(201);
    expect('freight' in stored(repo)).toBe(true);
  });
});

describe('estimado de flete: costo y abuso (misma validación y mismo caché)', () => {
  it('captcha inválido: 403 y NO se paga ruta ni se lee PostalCodes', async () => {
    const { call, routes, repo } = setup();
    const res = await call(validBody({ turnstileToken: 'malo' }));
    expect(res.statusCode).toBe(403);
    expect(routes.calls).toHaveLength(0);
    expect(repo.calls).not.toContain('getPostalCode');
  });

  it('honeypot lleno: 201 señuelo sin pagar ruta', async () => {
    const { call, routes } = setup();
    const res = await call(validBody({ website: 'http://spam' }));
    expect(res.statusCode).toBe(201);
    expect(routes.calls).toHaveLength(0);
  });

  it('pedido inválido para el dominio (422, piedra inexistente): sin pagar ruta', async () => {
    const { call, routes } = setup();
    const res = await call(
      validBody({ items: [{ stoneId: 'no-existe', cantidad: 1, unidad: 'm2' }] }),
    );
    expect(res.statusCode).toBe(422);
    expect(routes.calls).toHaveLength(0);
  });

  it('esquema inválido (422): sin pagar ruta', async () => {
    const { call, routes } = setup();
    const res = await call(validBody({ consent: false }));
    expect(res.statusCode).toBe(422);
    expect(routes.calls).toHaveLength(0);
  });

  it('límite por correo alcanzado (429): la 6.ª solicitud NO paga ruta', async () => {
    const { call, routes, repo } = setup();
    for (let i = 0; i < 5; i++) expect((await call(validBody())).statusCode).toBe(201);
    const llamadasAntes = routes.calls.length;
    // La caché ya tiene el CP: por eso se comprueba que ni siquiera se LEYERON las tablas del
    // estimado tras el 429 (si el estimado corriera antes del límite, aparecerían aquí).
    repo.calls.length = 0;
    const res = await call(validBody());
    expect(res.statusCode).toBe(429);
    expect(routes.calls).toHaveLength(llamadasAntes);
    expect(repo.calls).not.toContain('getPostalCode');
    expect(repo.calls).not.toContain('getRouteCache');
    expect(repo.calls).not.toContain('putRouteCache');
    expect(repo.calls).not.toContain('reserveFolioNumber');
  });

  it('el estimado se calcula DESPUÉS del límite y ANTES de reservar folio y guardar', async () => {
    const { call, repo } = setup();
    await call(validBody());
    const calls = repo.calls;
    expect(calls.indexOf('consumeRateLimit')).toBeLessThan(calls.indexOf('getPostalCode'));
    expect(calls.indexOf('getPostalCode')).toBeLessThan(calls.indexOf('reserveFolioNumber'));
    expect(calls.indexOf('reserveFolioNumber')).toBeLessThan(calls.indexOf('putQuote'));
  });

  it('caché positiva: la segunda solicitud al mismo CP reutiliza la distancia (1 sola llamada)', async () => {
    const { call, routes, repo } = setup();
    await call(validBody());
    expect(routes.calls).toHaveLength(1);
    expect(repo.routeCache.get('72810')).toMatchObject({
      cp: '72810',
      distanciaKm: 62,
      ttl: NOW_SECONDS + ROUTE_CACHE_TTL_DAYS * 24 * 3600,
    });
    await call(
      validBody({
        customer: { nombre: 'Otra', telefono: '2225550111', correo: 'otra@cliente-ejemplo.mx' },
      }),
    );
    expect(routes.calls).toHaveLength(1);
    const todas = [...repo.quotes.values()];
    expect(todas).toHaveLength(2);
    for (const q of todas) expect((q['freight'] as { distanciaKm: number }).distanciaKm).toBe(62);
  });

  it('caché negativa («sin ruta»): reintentos seguidos cuestan UNA llamada y se guardan sin freight', async () => {
    const provider = new FakeRouteProvider();
    provider.error = new RouteProviderError(NO_ROUTE_REASON);
    const { call, repo } = setup({ routes: provider });
    await call(validBody());
    await call(
      validBody({
        customer: { nombre: 'Otra', telefono: '2225550111', correo: 'otra@cliente-ejemplo.mx' },
      }),
    );
    expect(provider.calls).toHaveLength(1);
    expect(repo.routeCache.get('72810')).toMatchObject({
      fallo: 'sin_ruta',
      ttl: NOW_SECONDS + NEGATIVE_ROUTE_CACHE_TTL_SECONDS,
    });
    for (const q of repo.quotes.values()) expect('freight' in q).toBe(false);
  });

  it('el estimado no cambia el status ni el cuerpo de la respuesta (solo el folio)', async () => {
    const { call } = setup();
    const res = await call(validBody());
    expect(JSON.parse(res.body as string)).toEqual({ folio: 'CN-2026-00001' });
  });
});

describe('estimado de flete en el correo de confirmación', () => {
  it('con estimado, el correo al cliente lo incluye con «sujeto a confirmación»; sin él, no', async () => {
    const sent: { to?: unknown; text?: string; html?: string }[] = [];
    const mailer = {
      send: async (m: never) => {
        sent.push(m);
        return { messageId: 'm' };
      },
    };
    const con = setup({ mailer });
    await con.call(validBody());
    const textos = sent.map((m) => `${m.text ?? ''}${m.html ?? ''}`).join('\n');
    expect(textos).toContain('Estimado de flete');
    expect(textos).toContain('sujeto a confirmación');

    sent.length = 0;
    const sin = setup({ mailer, routes: undefined });
    await sin.call(validBody());
    expect(sent.map((m) => `${m.text ?? ''}${m.html ?? ''}`).join('\n')).not.toContain(
      'Estimado de flete',
    );
  });
});

describe('estimado de flete: registros', () => {
  it('éxito: registra solo el prefijo del CP, nunca el CP completo ni datos del cliente', async () => {
    const { call, logs } = setup();
    await call(validBody());
    const todo = logs.join('\n');
    expect(todo).not.toContain('72810');
    for (const s of [SENTINEL.correo, SENTINEL.nombre, SENTINEL.telefono, SENTINEL.lugar]) {
      expect(todo).not.toContain(s);
    }
  });
});

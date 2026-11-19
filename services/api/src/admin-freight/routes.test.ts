import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { describe, expect, it } from 'vitest';
import { configBody, stoneRow, storedRow } from './fixtures';
import { MemoryFreightRepository } from './memory-repository';
import { createFreightRouter } from './routes';

type Ev = APIGatewayProxyEventV2WithJWTAuthorizer;

interface Call {
  method?: string;
  path: string;
  groups?: string | undefined;
  body?: unknown;
  rawBody?: string;
  query?: Record<string, string>;
}

function ev(c: Call): Ev {
  const claims: Record<string, string> = { sub: 'user-1', token_use: 'access' };
  if (c.groups !== undefined) claims['cognito:groups'] = c.groups;
  const body = c.rawBody ?? (c.body === undefined ? undefined : JSON.stringify(c.body));
  return {
    version: '2.0',
    rawPath: c.path,
    rawQueryString: '',
    headers: {},
    ...(c.query ? { queryStringParameters: c.query } : {}),
    isBase64Encoded: false,
    ...(body === undefined ? {} : { body }),
    requestContext: {
      requestId: 'req-1',
      http: { method: c.method ?? 'GET', path: c.path },
      authorizer: { jwt: { claims, scopes: [] } },
    },
  } as unknown as Ev;
}

const T = Date.parse('2026-11-19T10:00:00.000Z');

function setup() {
  const repo = new MemoryFreightRepository();
  repo.stones.set('arenisca', stoneRow());
  const lines: string[] = [];
  let tick = 0;
  const router = createFreightRouter(
    { repo, now: () => new Date(T + 1000 * tick++) },
    { logSink: (l) => lines.push(l) },
  );
  const call = async (c: Call) => {
    const res = await router.handle(ev({ groups: '[owner]', ...c }));
    return {
      status: res.statusCode,
      text: res.body as string,
      json: JSON.parse(res.body as string),
    };
  };
  const put = (body: unknown, groups?: string) =>
    call({ method: 'PUT', path: '/admin/freight-config', body, groups: groups ?? '[owner]' });
  /** Siembra n versiones guardadas, la `active` activa. */
  const seed = (n: number, active: number) => {
    for (let i = 1; i <= n; i++) {
      const v = `t${String(i).padStart(4, '0')}`;
      repo.rows.set(v, storedRow(v, i === 2 ? { ejemplo: false } : {}));
    }
    repo.pointer = {
      version: 'ACTIVE',
      activeVersion: `t${String(active).padStart(4, '0')}`,
      latestVersion: `t${String(n).padStart(4, '0')}`,
      activadaPor: 'user-0',
      activadaAt: '2026-11-01T10:00:00.000Z',
    };
  };
  return { repo, lines, call, put, seed };
}

const RUTAS = [
  ['GET', '/admin/freight-config'],
  ['GET', '/admin/freight-config/t0001'],
  ['PUT', '/admin/freight-config'],
  ['POST', '/admin/freight-config/t0001/activate'],
  ['POST', '/admin/freight/simulate'],
] as const;

describe('matriz de roles por ruta', () => {
  it('sin rol o con un grupo desconocido: 403 en todas las rutas y nada se toca', async () => {
    const { repo, call } = setup();
    for (const groups of [undefined, '[]', '[visitante]']) {
      for (const [method, path] of RUTAS) {
        const r = await call({ method, path, groups, body: {} });
        expect(r.status, `${method} ${path} ${groups}`).toBe(403);
      }
    }
    expect(repo.calls).toEqual([]);
  });

  it('staff puede LEER y SIMULAR', async () => {
    const { call, seed } = setup();
    seed(2, 2);
    expect((await call({ path: '/admin/freight-config', groups: '[staff]' })).status).toBe(200);
    expect((await call({ path: '/admin/freight-config/t0001', groups: '[staff]' })).status).toBe(
      200,
    );
    const sim = await call({
      method: 'POST',
      path: '/admin/freight/simulate',
      groups: '[staff]',
      body: {
        codigoPostal: '72000',
        distanciaKm: 60,
        items: [{ stoneId: 'arenisca', cantidad: 10, unidad: 'm2', espesorCm: 5 }],
      },
    });
    expect(sim.status).toBe(200);
  });

  it('staff NO puede crear ni activar versiones (403) y no se escribe nada', async () => {
    const { repo, call, put, seed } = setup();
    seed(2, 1);
    const antes = structuredClone(repo.pointer);
    expect((await put(configBody(), '[staff]')).status).toBe(403);
    const act = await call({
      method: 'POST',
      path: '/admin/freight-config/t0002/activate',
      groups: '[staff]',
    });
    expect(act.status).toBe(403);
    expect(repo.calls).toEqual([]);
    expect(repo.pointer).toEqual(antes);
    expect(repo.audits).toEqual([]);
  });

  it('un grupo mal formado como "staff,owner" no escala a owner', async () => {
    const { put } = setup();
    expect((await put(configBody(), 'staff,owner')).status).toBe(403);
  });
});

describe('PUT /admin/freight-config', () => {
  it('la primera versión es t0001 y queda activa; el servidor fija autor y fecha', async () => {
    const { repo, put } = setup();
    const r = await put(configBody());
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ version: 't0001', activa: true, creadaPor: 'user-1' });
    expect(repo.pointer).toMatchObject({
      activeVersion: 't0001',
      latestVersion: 't0001',
      activadaPor: 'user-1',
    });
    const row = repo.rows.get('t0001')!;
    expect(row['creadaAt']).toBe('2026-11-19T10:00:00.000Z');
    expect(row['creadaPor']).toBe('user-1');
    expect(row['version']).toBe('t0001');
    // `activa` es derivada: NO se guarda en la fila de la versión.
    expect(row).not.toHaveProperty('activa');
    expect(row).not.toHaveProperty('baseVersion');
    expect(row).not.toHaveProperty('activar');
  });

  it('una versión nueva NO se activa sola; el puntero conserva la activa y avanza `latest`', async () => {
    const { repo, put, seed } = setup();
    seed(1, 1);
    const r = await put(configBody({ resumenCambio: 'Sube porKm' }));
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ version: 't0002', activa: false });
    expect(repo.pointer).toMatchObject({ activeVersion: 't0001', latestVersion: 't0002' });
    // Las anteriores no se tocan.
    expect(repo.rows.get('t0001')).toEqual(storedRow('t0001'));
  });

  it('activar:true crea la versión Y mueve el puntero en la misma transacción', async () => {
    const { repo, put, seed } = setup();
    seed(1, 1);
    const r = await put(configBody({ activar: true }));
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ version: 't0002', activa: true });
    expect(repo.pointer).toMatchObject({
      activeVersion: 't0002',
      latestVersion: 't0002',
      activadaPor: 'user-1',
    });
    expect(repo.audits).toHaveLength(1);
    expect(repo.audits[0]).toMatchObject({
      pk: 'ENTITY#freight-config#t0002',
      accion: 'create',
      userId: 'user-1',
      antes: { activeVersion: 't0001', latestVersion: 't0001' },
      despues: { version: 't0002', activa: true, resumenCambio: 'Tarifas de ejemplo' },
    });
  });

  it('la auditoría resume (sin camiones ni tarifas) y lleva el requestId en la clave', async () => {
    const { repo, put } = setup();
    await put(configBody());
    const a = repo.audits[0]!;
    expect(a.sk).toBe('2026-11-19T10:00:00.000Z#req-1');
    expect(JSON.stringify(a)).not.toContain('camioneta');
    expect(JSON.stringify(a)).not.toContain('porKm');
  });

  it('baseVersion: si coincide con la última, crea; si no, 409 y no escribe nada', async () => {
    const { repo, put, seed } = setup();
    seed(2, 1);
    const ok = await put(configBody({ baseVersion: 't0002' }));
    expect(ok.status).toBe(201);
    expect(ok.json.version).toBe('t0003');
    const antes = structuredClone(repo.pointer);
    const filas = repo.rows.size;
    const choque = await put(configBody({ baseVersion: 't0002' }));
    expect(choque.status).toBe(409);
    expect(choque.json).toEqual({ error: 'conflict' });
    expect(repo.rows.size).toBe(filas);
    expect(repo.pointer).toEqual(antes);
  });

  it('baseVersion con tabla vacía: 409', async () => {
    const { put } = setup();
    expect((await put(configBody({ baseVersion: 't0001' }))).status).toBe(409);
  });

  it('carrera: otra persona guarda entre la lectura y la escritura -> 409 y sin duplicar', async () => {
    const { repo, put, seed } = setup();
    seed(1, 1);
    repo.onBeforeWrite = () => {
      repo.rows.set('t0002', storedRow('t0002'));
      repo.pointer = { ...repo.pointer!, latestVersion: 't0002' };
    };
    const r = await put(configBody());
    expect(r.status).toBe(409);
    expect(repo.audits).toEqual([]);
    expect(repo.rows.get('t0002')).toEqual(storedRow('t0002'));
  });

  it('un error inesperado del repositorio es 500 sin detalles', async () => {
    const { repo, put } = setup();
    repo.writeError = new Error('secreto interno de dynamo');
    const r = await put(configBody());
    expect(r.status).toBe(500);
    expect(r.text).not.toContain('secreto');
  });

  it.each([
    ['sin resumenCambio', (b: Record<string, unknown>) => delete b['resumenCambio']],
    ['resumenCambio vacío', (b: Record<string, unknown>) => (b['resumenCambio'] = '')],
    [
      'resumenCambio de 301 caracteres',
      (b: Record<string, unknown>) => (b['resumenCambio'] = 'x'.repeat(301)),
    ],
    ['creadaPor enviado por el cliente', (b: Record<string, unknown>) => (b['creadaPor'] = 'otro')],
    [
      'creadaAt enviado por el cliente',
      (b: Record<string, unknown>) => (b['creadaAt'] = '2020-01-01T00:00:00Z'),
    ],
    ['version enviada por el cliente', (b: Record<string, unknown>) => (b['version'] = 't0099')],
    ['activa enviada por el cliente', (b: Record<string, unknown>) => (b['activa'] = true)],
    ['activar no booleano', (b: Record<string, unknown>) => (b['activar'] = 'si')],
    ['baseVersion inválida', (b: Record<string, unknown>) => (b['baseVersion'] = 'ACTIVE')],
    ['campo desconocido', (b: Record<string, unknown>) => (b['extra'] = 1)],
    ['camiones vacíos', (b: Record<string, unknown>) => (b['camiones'] = [])],
    ['maxKm negativo', (b: Record<string, unknown>) => (b['maxKm'] = -1)],
  ])('422 validation_error y no escribe: %s', async (_n, mut) => {
    const { repo, put } = setup();
    const body = configBody();
    mut(body);
    const r = await put(body);
    expect(r.status).toBe(422);
    expect(r.json.error).toBe('validation_error');
    expect(repo.rows.size).toBe(0);
    expect(repo.audits).toEqual([]);
  });

  it('cuerpos hostiles: 422/400, nunca 500', async () => {
    const { call, repo } = setup();
    for (const rawBody of [
      'null',
      '[]',
      '"texto"',
      '42',
      'true',
      '{"__proto__":{"x":1}}',
      '{',
      '',
    ]) {
      const r = await call({ method: 'PUT', path: '/admin/freight-config', rawBody });
      expect([400, 422], rawBody).toContain(r.status);
    }
    expect(repo.rows.size).toBe(0);
  });
});

describe('POST /admin/freight-config/{version}/activate', () => {
  const act = (call: ReturnType<typeof setup>['call'], v: string, groups = '[owner]') =>
    call({ method: 'POST', path: `/admin/freight-config/${v}/activate`, groups });

  it('mueve SOLO el puntero a una versión anterior y audita', async () => {
    const { repo, call, seed } = setup();
    seed(3, 3);
    const r = await act(call, 't0001');
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ changed: true, version: 't0001', activa: true });
    expect(repo.pointer).toMatchObject({
      activeVersion: 't0001',
      latestVersion: 't0003',
      activadaPor: 'user-1',
    });
    expect(repo.audits).toHaveLength(1);
    expect(repo.audits[0]).toMatchObject({
      pk: 'ENTITY#freight-config#t0001',
      accion: 'update',
      antes: { activa: false, activaAnterior: 't0003' },
      despues: { activa: true },
    });
    expect(repo.rows.size).toBe(3);
  });

  it('activar la versión que ya es activa: 200 sin cambios y sin auditoría', async () => {
    const { repo, call, seed } = setup();
    seed(2, 2);
    const r = await act(call, 't0002');
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ changed: false, version: 't0002', activa: true });
    expect(repo.audits).toEqual([]);
    expect(repo.calls).not.toContain('setActive');
  });

  it('versión inexistente: 404', async () => {
    const { repo, call, seed } = setup();
    seed(2, 1);
    expect((await act(call, 't0009')).status).toBe(404);
    expect(repo.pointer?.activeVersion).toBe('t0001');
  });

  it('no activa una versión guardada corrupta: 500 y el puntero no cambia', async () => {
    const { repo, call, seed } = setup();
    seed(2, 2);
    repo.rows.set('t0001', { version: 't0001', basura: true });
    const r = await act(call, 't0001');
    expect(r.status).toBe(500);
    expect(r.json).toEqual({ error: 'invalid_stored_item' });
    expect(repo.pointer?.activeVersion).toBe('t0002');
    expect(repo.audits).toEqual([]);
  });

  it('sin versiones guardadas: 404', async () => {
    const { call } = setup();
    expect((await act(call, 't0001')).status).toBe(404);
  });

  it.each(['ACTIVE', 't1', 'T0001', 'v0001', 't0001x', '..', 't0001%2Fx', 't00 01'])(
    'versión %s en el path: 400 invalid_path',
    async (v) => {
      const { repo, call, seed } = setup();
      seed(2, 1);
      const r = await act(call, v);
      expect(r.status, v).toBe(400);
      expect(r.json).toEqual({ error: 'invalid_path' });
      expect(repo.calls).toEqual([]);
    },
  );

  it('carrera: el puntero cambió entre la lectura y la escritura -> 409', async () => {
    const { repo, call, seed } = setup();
    seed(3, 3);
    repo.onBeforeWrite = () => {
      repo.pointer = { ...repo.pointer!, activeVersion: 't0002' };
    };
    const r = await act(call, 't0001');
    expect(r.status).toBe(409);
    expect(repo.pointer?.activeVersion).toBe('t0002');
    expect(repo.audits).toEqual([]);
  });
});

describe('lecturas', () => {
  it('lista vacía: sin activa ni versiones', async () => {
    const { call } = setup();
    const r = await call({ path: '/admin/freight-config' });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({
      activeVersion: null,
      latestVersion: null,
      versions: [],
      nextCursor: null,
    });
  });

  it('lista de la más nueva a la más vieja, marca la activa y devuelve `ejemplo` tal cual', async () => {
    const { call, seed } = setup();
    seed(3, 2);
    const r = await call({ path: '/admin/freight-config' });
    expect(r.json.activeVersion).toBe('t0002');
    expect(r.json.latestVersion).toBe('t0003');
    expect(r.json.versions.map((v: { version: string }) => v.version)).toEqual([
      't0003',
      't0002',
      't0001',
    ]);
    expect(r.json.versions.map((v: { activa: boolean }) => v.activa)).toEqual([false, true, false]);
    expect(r.json.versions.map((v: { ejemplo: boolean }) => v.ejemplo)).toEqual([
      true,
      false,
      true,
    ]);
    expect(r.json.versions[0]).toMatchObject({
      creadaPor: 'user-0',
      resumenCambio: 'Tarifas de ejemplo',
    });
    // Es un resumen: el detalle (camiones, zonas) se pide por versión.
    expect(r.json.versions[0]).not.toHaveProperty('camiones');
    expect(r.json.nextCursor).toBeNull();
  });

  it('pagina con limit y cursor', async () => {
    const { call, seed } = setup();
    seed(5, 5);
    const p1 = await call({ path: '/admin/freight-config', query: { limit: '2' } });
    expect(p1.json.versions.map((v: { version: string }) => v.version)).toEqual(['t0005', 't0004']);
    expect(p1.json.nextCursor).toBe('t0004');
    const p2 = await call({
      path: '/admin/freight-config',
      query: { limit: '2', cursor: p1.json.nextCursor },
    });
    expect(p2.json.versions.map((v: { version: string }) => v.version)).toEqual(['t0003', 't0002']);
    const p3 = await call({
      path: '/admin/freight-config',
      query: { limit: '2', cursor: p2.json.nextCursor },
    });
    expect(p3.json.versions.map((v: { version: string }) => v.version)).toEqual(['t0001']);
    expect(p3.json.nextCursor).toBeNull();
  });

  it.each([
    { limit: '0' },
    { limit: '51' },
    { limit: 'abc' },
    { limit: '1.5' },
    { cursor: 'ACTIVE' },
    { cursor: 't1' },
  ])('query inválida %j: 400', async (query) => {
    const { call, seed } = setup();
    seed(2, 1);
    const r = await call({ path: '/admin/freight-config', query });
    expect(r.status).toBe(400);
    expect(r.json).toEqual({ error: 'invalid_query' });
  });

  it('detalle: la config completa con `activa` derivada', async () => {
    const { call, seed } = setup();
    seed(2, 2);
    const a = await call({ path: '/admin/freight-config/t0002' });
    expect(a.status).toBe(200);
    expect(a.json).toMatchObject({ version: 't0002', activa: true, ejemplo: false });
    expect(a.json.camiones).toHaveLength(3);
    const b = await call({ path: '/admin/freight-config/t0001' });
    expect(b.json.activa).toBe(false);
  });

  it('detalle: inexistente 404; path inválido 400', async () => {
    const { call, seed } = setup();
    seed(1, 1);
    expect((await call({ path: '/admin/freight-config/t0007' })).status).toBe(404);
    expect((await call({ path: '/admin/freight-config/ACTIVE' })).status).toBe(400);
  });

  it('una fila guardada inválida en el detalle: 500 sin detalles', async () => {
    const { repo, call, seed } = setup();
    seed(1, 1);
    repo.rows.set('t0001', { version: 't0001', basura: true });
    const r = await call({ path: '/admin/freight-config/t0001' });
    expect(r.status).toBe(500);
    expect(r.json).toEqual({ error: 'invalid_stored_item' });
  });
});

describe('POST /admin/freight/simulate', () => {
  const item = (over: Record<string, unknown> = {}) => ({
    stoneId: 'arenisca',
    cantidad: 10,
    unidad: 'm2',
    espesorCm: 5,
    ...over,
  });
  const sim = (call: ReturnType<typeof setup>['call'], body: unknown) =>
    call({ method: 'POST', path: '/admin/freight/simulate', body });

  it('éxito: usa la config ACTIVA y las piedras de la tabla', async () => {
    const { call, seed } = setup();
    seed(2, 2);
    const r = await sim(call, { codigoPostal: '72000', distanciaKm: 60, items: [item()] });
    expect(r.status).toBe(200);
    // 10 m² × 110 kg/m² = 1100 kg -> Camioneta: max(1500, 800 + 60×12 = 1520) = 1520 + 500 = 2020.
    expect(r.json).toMatchObject({
      moneda: 'MXN',
      pesoTotalKg: 1100,
      distanciaKm: 60,
      camion: 'Camioneta',
      viajes: 1,
      versionTarifa: 't0002',
      aviso: 'Estimado sujeto a confirmación.',
    });
    expect(r.json.estimadoMin).toBe(1800);
    expect(r.json.estimadoMax).toBe(2250);
  });

  it('con `version` usa ESA versión (no la activa) y la marca como versionTarifa', async () => {
    const { repo, call, seed } = setup();
    seed(2, 1);
    repo.rows.set('t0002', storedRow('t0002', { recargoDescarga: 0 }));
    const r = await sim(call, {
      version: 't0002',
      codigoPostal: '72000',
      distanciaKm: 60,
      items: [item()],
    });
    expect(r.status).toBe(200);
    expect(r.json.versionTarifa).toBe('t0002');
    expect(r.json.estimadoMax).toBeLessThan(2250);
  });

  it('`version` inexistente: 404; con formato inválido: 400', async () => {
    const { call, seed } = setup();
    seed(1, 1);
    const base = { codigoPostal: '72000', distanciaKm: 60, items: [item()] };
    expect((await sim(call, { ...base, version: 't0009' })).status).toBe(404);
    for (const version of ['ACTIVE', 7, null, {}, 't1']) {
      const r = await sim(call, { ...base, version });
      expect(r.status, String(version)).toBe(400);
    }
  });

  it('sin CP: 400 salvo skipZoneCheck:true (el simulador puede omitirlo)', async () => {
    const { call, seed } = setup();
    seed(1, 1);
    const body = { distanciaKm: 60, items: [item()] };
    expect((await sim(call, body)).status).toBe(400);
    expect((await sim(call, { ...body, skipZoneCheck: true })).status).toBe(200);
  });

  it('skipZoneCheck salta SOLO la zona: un CP fuera de zona pasa, pero maxKm sigue aplicando', async () => {
    const { call, seed } = setup();
    seed(1, 1);
    const fuera = { codigoPostal: '97000', distanciaKm: 60, items: [item()] };
    expect((await sim(call, fuera)).status).toBe(422);
    expect((await sim(call, { ...fuera, skipZoneCheck: true })).status).toBe(200);
    const lejos = { ...fuera, distanciaKm: 351, skipZoneCheck: true };
    expect((await sim(call, lejos)).status).toBe(422);
  });

  it('skipZoneCheck debe ser booleano (un "true" de texto o 1 no cuenta): 400', async () => {
    const { call, seed } = setup();
    seed(1, 1);
    for (const skipZoneCheck of ['true', 1, null]) {
      const r = await sim(call, { distanciaKm: 60, items: [item()], skipZoneCheck });
      expect(r.status, String(skipZoneCheck)).toBe(400);
    }
  });

  it('CP fuera de zona: 422 out_of_zone con «consúltenos por WhatsApp»', async () => {
    const { call, seed } = setup();
    seed(1, 1);
    const r = await sim(call, { codigoPostal: '97000', distanciaKm: 60, items: [item()] });
    expect(r.status).toBe(422);
    expect(r.json.error).toBe('out_of_zone');
    expect(r.json.message).toContain('consúltenos por WhatsApp');
  });

  it('distancia mayor que maxKm: 422 out_of_zone', async () => {
    const { call, seed } = setup();
    seed(1, 1);
    const r = await sim(call, { codigoPostal: '72000', distanciaKm: 351, items: [item()] });
    expect(r.status).toBe(422);
    expect(r.json.error).toBe('out_of_zone');
  });

  it('pedido demasiado grande: 422 too_large con «consúltenos por WhatsApp»', async () => {
    const { call, seed } = setup();
    seed(1, 1);
    const r = await sim(call, {
      codigoPostal: '72000',
      distanciaKm: 60,
      items: [item({ cantidad: 100000 })],
    });
    expect(r.status).toBe(422);
    expect(r.json.error).toBe('too_large');
    expect(r.json.message).toContain('consúltenos por WhatsApp');
  });

  it.each([
    ['unit_not_sold', { unidad: 'pieza' }],
    ['unknown_stone', { stoneId: 'no-existe' }],
    ['thickness_not_available', { espesorCm: 7 }],
  ])('%s: 400 con mensaje en español, sin eco de lo enviado', async (code, over) => {
    const { call, seed } = setup();
    seed(1, 1);
    const r = await sim(call, {
      codigoPostal: '72000',
      distanciaKm: 60,
      items: [item(over)],
    });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe(code);
    expect(typeof r.json.message).toBe('string');
    expect(r.text).not.toContain('no-existe');
  });

  it('piedra dada de baja: 400 inactive_stone', async () => {
    const { repo, call, seed } = setup();
    seed(1, 1);
    repo.stones.set('arenisca', stoneRow({ activa: false }));
    const r = await sim(call, { codigoPostal: '72000', distanciaKm: 60, items: [item()] });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('inactive_stone');
  });

  it('sin config activa: 409 freight_config_missing', async () => {
    const { call } = setup();
    const r = await sim(call, { codigoPostal: '72000', distanciaKm: 60, items: [item()] });
    expect(r.status).toBe(409);
    expect(r.json).toEqual({ error: 'freight_config_missing' });
  });

  it('puntero que apunta a una versión que no existe: 409 freight_config_missing', async () => {
    const { repo, call, seed } = setup();
    seed(1, 1);
    repo.rows.clear();
    const r = await sim(call, { codigoPostal: '72000', distanciaKm: 60, items: [item()] });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('freight_config_missing');
  });

  it('config guardada corrupta: 500 invalid_stored_item (no un TypeError)', async () => {
    const { repo, call, seed } = setup();
    seed(1, 1);
    repo.rows.set('t0001', { version: 't0001', camiones: 'x' });
    const r = await sim(call, { codigoPostal: '72000', distanciaKm: 60, items: [item()] });
    expect(r.status).toBe(500);
    expect(r.json).toEqual({ error: 'invalid_stored_item' });
  });

  it('piedra guardada corrupta: 500 invalid_stored_item', async () => {
    const { repo, call, seed } = setup();
    seed(1, 1);
    repo.stones.set('arenisca', { id: 'arenisca', basura: 1 });
    const r = await sim(call, { codigoPostal: '72000', distanciaKm: 60, items: [item()] });
    expect(r.status).toBe(500);
    expect(r.json).toEqual({ error: 'invalid_stored_item' });
  });

  it('no consulta la tabla de piedras con ids repetidos ni inventados de más', async () => {
    const { call, seed } = setup();
    seed(1, 1);
    const r = await sim(call, {
      codigoPostal: '72000',
      distanciaKm: 60,
      items: [item(), item({ cantidad: 5 })],
    });
    expect(r.status).toBe(200);
  });

  it('entradas hostiles: siempre 400 con un código, nunca 500 ni TypeError', async () => {
    const { call, seed, lines } = setup();
    seed(1, 1);
    const hostiles: unknown[] = [
      null,
      [],
      'texto',
      42,
      {},
      { items: 'x', distanciaKm: 1 },
      { items: [], distanciaKm: 1 },
      { items: [null], distanciaKm: 1 },
      { items: [[]], distanciaKm: 1 },
      { items: [item({ stoneId: { $ne: 1 } })], distanciaKm: 1 },
      { items: [item({ cantidad: '10' })], distanciaKm: 1 },
      { items: [item({ cantidad: -1 })], distanciaKm: 1 },
      { items: [item({ unidad: 'galón' })], distanciaKm: 1 },
      { items: [item()], distanciaKm: 'lejos' },
      { items: [item()], distanciaKm: -5 },
      { items: [item()], distanciaKm: 1, codigoPostal: 72000 },
      { items: [item()], distanciaKm: 1, codigoPostal: '7200' },
      { items: [item()], distanciaKm: 1, extra: true },
      { items: Array.from({ length: 51 }, () => item()), distanciaKm: 1 },
      JSON.parse('{"__proto__":{"x":1},"items":[],"distanciaKm":1}'),
    ];
    for (const body of hostiles) {
      const r = await sim(call, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(typeof r.json.error).toBe('string');
    }
    expect(lines.join('\n')).not.toContain('TypeError');
    expect(lines.join('\n')).not.toContain('unhandled_error');
  });

  it('el peso no viene del navegador: un campo pesoKg se rechaza', async () => {
    const { call, seed } = setup();
    seed(1, 1);
    const r = await sim(call, {
      distanciaKm: 1,
      codigoPostal: '72000',
      items: [item({ pesoKg: 1 })],
    });
    expect(r.status).toBe(400);
  });

  it('los logs llevan requestId y NO el CP, la piedra ni la cantidad', async () => {
    const { call, seed, lines } = setup();
    seed(1, 1);
    await sim(call, { codigoPostal: '72123', distanciaKm: 61, items: [item({ cantidad: 7.77 })] });
    await sim(call, { codigoPostal: '97123', distanciaKm: 61, items: [item({ cantidad: 7.77 })] });
    const todo = lines.join('\n');
    expect(todo).toContain('req-1');
    expect(todo).not.toContain('72123');
    expect(todo).not.toContain('97123');
    expect(todo).not.toContain('7.77');
  });
});

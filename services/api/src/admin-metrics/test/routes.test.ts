/* eslint-disable @typescript-eslint/no-explicit-any -- respuestas JSON de prueba sin tipar */
import { metricsResponseSchema, type Quote } from '@canteras/shared';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { describe, expect, it } from 'vitest';
import { quote } from '../../admin-quotes/test/fixtures';
import { createMetricsRouter } from '../routes';
import { MemoryMetricsRepository } from './memory-repository';

type Ev = APIGatewayProxyEventV2WithJWTAuthorizer;
interface Call {
  method?: string;
  path?: string;
  groups?: string;
  query?: Record<string, string>;
}

function ev(c: Call): Ev {
  const claims: Record<string, string> = { sub: 'user-1', token_use: 'access' };
  if (c.groups !== undefined) claims['cognito:groups'] = c.groups;
  const path = c.path ?? '/admin/metrics';
  return {
    version: '2.0',
    rawPath: path,
    rawQueryString: '',
    headers: {},
    ...(c.query ? { queryStringParameters: c.query } : {}),
    isBase64Encoded: false,
    requestContext: {
      requestId: 'req-1',
      http: { method: c.method ?? 'GET', path },
      authorizer: { jwt: { claims, scopes: [] } },
    },
  } as unknown as Ev;
}

// Martes 24 nov 2026, 12:00 hora local.
const NOW = Date.parse('2026-11-24T18:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const iso = (ms: number): string => new Date(ms).toISOString();
const id = (n: number): string => `01ARZ3NDEKTSV4RRFFQ69G${String(n).padStart(4, '0')}`;
const fol = (n: number): string => `CN-2026-${String(n).padStart(5, '0')}`;

function setup(limits?: { pageSize?: number; maxPages?: number }) {
  const repo = new MemoryMetricsRepository();
  const lines: string[] = [];
  const router = createMetricsRouter(
    {
      repo,
      now: () => new Date(NOW),
      retry: { sleep: async () => {}, random: () => 0 },
      ...(limits ? { limits } : {}),
    },
    { logSink: (l) => lines.push(l) },
  );
  const call = async (c: Call = {}, groups = '[owner]') => {
    const res = await router.handle(ev({ groups, ...c }));
    const text = res.body as string;
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: res.statusCode, text, json, headers: res.headers ?? {} };
  };
  return { repo, lines, call, router };
}

const q = (n: number, over: Partial<Quote> = {}): Quote =>
  quote({ quoteId: id(n), folio: fol(n), createdAt: iso(NOW - HOUR), ...over });

describe('permisos por ruta y método', () => {
  for (const [group, role] of [
    ['[owner]', 'owner'],
    ['[staff]', 'staff'],
  ] as const) {
    it(`GET /admin/metrics como ${role}: 200`, async () => {
      const { call } = setup();
      expect((await call({}, group)).status).toBe(200);
    });
  }
  it.each([['[]'], ['[admin]'], ['[x,owner]'], ['[ownerx]'], ['[OWNER]']])(
    'GET con grupos %s: 403 sin tocar la base',
    async (groups) => {
      const { repo, call } = setup();
      expect((await call({}, groups)).status).toBe(403);
      expect(repo.calls).toEqual([]);
    },
  );
  it('sin claim de grupos: 403', async () => {
    const { repo, router } = setup();
    const res = await router.handle(ev({}));
    expect(res.statusCode).toBe(403);
    expect(repo.calls).toEqual([]);
  });
  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('%s /admin/metrics: 404, solo lectura', async (m) => {
    const { repo, call } = setup();
    expect((await call({ method: m })).status).toBe(404);
    expect(repo.calls).toEqual([]);
  });
  it('no existen subrutas', async () => {
    const { call } = setup();
    expect((await call({ path: '/admin/metrics/x' })).status).toBe(404);
  });
});

describe('validación de la query string', () => {
  // `from`/`to` se quitaron a propósito: la pantalla no los manda y, al cambiar el instante de
  // referencia o el rango de carga, daban cifras engañosas (mes y semana «a medias»). Cualquier
  // parámetro es un error 400; la referencia es siempre «ahora» del servidor.
  it.each([[{ foo: '1' }], [{ from: '2026-10-01' }], [{ to: '2026-11-10' }], [{ limit: '5' }]])(
    '%j: 400 invalid_query y no toca la base',
    async (query) => {
      const { repo, call } = setup();
      const r = await call({ query });
      expect(r.status).toBe(400);
      expect(r.json).toEqual({ error: 'invalid_query' });
      expect(repo.calls).toEqual([]);
    },
  );
});

describe('qué consulta (solo byStatus, nunca Scan ni byDate)', () => {
  const OPEN = ['nueva', 'en_revision', 'cotizada'];
  const CLOSED = ['enviada', 'ganada', 'perdida', 'cancelada'];
  it('abiertas sin límite de antigüedad; cerradas con rango de 120 días; sin releer las abiertas', async () => {
    const { repo, call } = setup();
    await call();
    expect(repo.queries.every((x) => x.index === 'status')).toBe(true);
    expect(repo.queries.map((x) => x.status).sort()).toEqual([...OPEN, ...CLOSED].sort());
    for (const s of OPEN) {
      const qy = repo.queries.find((x) => x.status === s)!;
      expect(qy.from).toBeUndefined();
      expect(qy).toMatchObject({ to: `${iso(NOW)}#~`, limit: 200 });
    }
    for (const s of CLOSED) {
      expect(repo.queries.find((x) => x.status === s)).toMatchObject({
        from: iso(NOW - 120 * DAY),
        to: `${iso(NOW)}#~`,
        limit: 200,
      });
    }
    expect(repo.calls.every((c) => c === 'query' || c === 'batchGet')).toBe(true);
  });
  it('una cotizada sin enviar de hace 200 días sigue esperando respuesta (se consulta sin límite de antigüedad)', async () => {
    const { repo, call } = setup();
    repo.seed(q(1, { status: 'cotizada', createdAt: iso(NOW - 200 * DAY) }));
    const r = await call();
    expect(r.json.waiting.items.map((i: any) => [i.folio, i.status, i.overdue])).toEqual([
      [fol(1), 'cotizada', true],
    ]);
    expect(r.json.waiting.overdueCount).toBe(1);
    expect(r.json.cards.pending.total).toBe(0);
  });
  it('el rango informado es de 120 días hasta ahora', async () => {
    const { call } = setup();
    const r = await call();
    expect(r.json.range).toEqual({ from: iso(NOW - 120 * DAY), to: iso(NOW) });
  });
  it('el tope de filas es por consulta: las abiertas no gastan el de las cerradas', async () => {
    const { repo, call } = setup({ pageSize: 2, maxPages: 2 });
    for (let i = 1; i <= 6; i++) repo.seed(q(i, { status: 'nueva' })); // 6 abiertas > tope 4
    for (let i = 7; i <= 10; i++) repo.seed(q(i, { status: 'cancelada' })); // 4 cerradas = tope
    const r = await call();
    expect(r.json.truncated).toBe(true); // por las abiertas
    expect(r.json.weekly.at(-1).count).toBe(4 + 4); // 4 abiertas leídas + las 4 cerradas completas
  });
});

describe('respuesta', () => {
  it('cumple el esquema compartido y calcula las tarjetas con los datos sembrados', async () => {
    const { repo, call } = setup();
    repo.seed(q(1, { status: 'nueva' }));
    repo.seed(q(2, { status: 'en_revision', createdAt: iso(NOW - 60 * HOUR) }));
    repo.seed(
      q(3, {
        status: 'ganada',
        createdAt: iso(NOW - 10 * DAY),
        history: [{ at: iso(NOW - 2 * DAY), by: 'u', tipo: 'estado', de: 'enviada', a: 'ganada' }],
        finalQuote: {
          items: [{ stoneId: 'arenisca', precioUnitario: 100, subtotal: 100 }],
          fleteFinal: 0,
          subtotal: 100,
          iva: null,
          ivaPct: null,
          total: 100,
          vigenciaDias: 15,
        },
      }),
    );
    repo.postalCodes.set('72810', 'Puebla');
    const r = await call();
    expect(r.status).toBe(200);
    expect(metricsResponseSchema.safeParse(r.json).success).toBe(true);
    expect(r.json.cards.pending).toEqual({ total: 2, nuevas: 1, enRevision: 1 });
    expect(r.json.cards.won).toEqual({ count: 1, value: 100, withoutAmount: 0 });
    expect(r.json.zones).toEqual([{ estado: 'Puebla', count: 3 }]);
    expect(r.json.waiting.items.map((i: any) => i.folio)).toEqual([fol(2), fol(1)]);
    expect(r.json.truncated).toBe(false);
    expect(r.json.zonesPartial).toBe(false);
    expect(r.json.skipped).toBe(0);
    expect(r.json.generatedAt).toBe(iso(NOW));
  });
  it('una solicitud que aparece en dos consultas se cuenta una sola vez', async () => {
    const { repo, call } = setup();
    repo.seed(q(1, { status: 'nueva' })); // sale por byStatus y por byDate
    const r = await call();
    expect(r.json.cards.pending.total).toBe(1);
    expect(r.json.weekly.at(-1).count).toBe(1);
  });
  it('sin datos personales salvo folio, cliente y obra del bloque «esperando respuesta»', async () => {
    const { repo, call } = setup();
    repo.seed(q(1, { status: 'nueva' }));
    const r = await call();
    expect(r.text).not.toContain('maria@example.com');
    expect(r.text).not.toContain('555-0101');
    expect(r.text).not.toContain('Fachada');
    expect(r.json.waiting.items[0]).toEqual({
      quoteId: id(1),
      folio: fol(1),
      status: 'nueva',
      cliente: 'María Pérez',
      lugar: 'San Andrés Cholula',
      createdAt: iso(NOW - HOUR),
      ageHours: 1,
      overdue: false,
    });
  });
  it('omite las filas que ya no validan, las cuenta y no tira el endpoint', async () => {
    const { repo, call, lines } = setup();
    repo.seed(q(1));
    repo.seedRaw({
      quoteId: id(9),
      gsi1pk: 'STATUS#nueva',
      gsi1sk: `${iso(NOW - HOUR)}#${id(9)}`,
      gsi2pk: 'QUOTE',
      gsi2sk: `${iso(NOW - HOUR)}#${id(9)}`,
      customer: { nombre: 'Persona Secreta', telefono: '000', correo: 'x@y.z' },
      campoViejo: true,
    });
    const r = await call();
    expect(r.status).toBe(200);
    expect(r.json.skipped).toBe(1);
    expect(r.json.cards.pending.total).toBe(1);
    const log = lines.join('\n');
    expect(log).toContain(id(9));
    expect(log).not.toContain('Persona Secreta');
  });
  it('marca truncado si se llega al tope de páginas', async () => {
    const { repo, call } = setup({ pageSize: 1, maxPages: 1 });
    repo.seed(q(1));
    repo.seed(q(2));
    const r = await call();
    expect(r.status).toBe(200);
    expect(r.json.truncated).toBe(true);
  });
  it('marca zonas parciales si quedan CP sin procesar', async () => {
    const { repo, call } = setup();
    repo.seed(q(1));
    repo.alwaysUnprocessed.add('72810');
    const r = await call();
    expect(r.json.zonesPartial).toBe(true);
    expect(r.json.zones).toEqual([{ estado: 'Sin dato', count: 1 }]);
  });
  it('con más de 300 CP distintos marca las zonas como parciales', async () => {
    const { repo, call } = setup();
    for (let i = 1; i <= 301; i++) {
      repo.seed(
        q(i, {
          works: { lugar: 'x', codigoPostal: String(i).padStart(5, '0'), uso: '', notas: '' },
        }),
      );
    }
    const r = await call();
    expect(r.status).toBe(200);
    expect(r.json.zonesPartial).toBe(true);
    expect(r.json.truncated).toBe(false);
  });
  it('lista vacía: 200 con ceros', async () => {
    const { call } = setup();
    const r = await call();
    expect(r.status).toBe(200);
    expect(r.json.cards.pending.total).toBe(0);
    expect(r.json.cards.response.averageHours).toBeNull();
  });
});

describe('errores y logs', () => {
  it('si la base falla responde 500 genérico sin detalles internos', async () => {
    const { repo, call, lines } = setup();
    repo.queryError = new Error('boom con detalle secreto');
    const r = await call();
    expect(r.status).toBe(500);
    expect(r.json.error).toBe('internal_error');
    expect(r.text).not.toContain('boom');
    expect(lines.join('\n')).not.toContain('María');
  });
  it('registra solo conteos y el usuario, sin PII', async () => {
    const { repo, call, lines } = setup();
    repo.seed(q(1));
    await call();
    const line = lines.find((l) => l.includes('metrics_computed'));
    expect(line).toBeDefined();
    const log = JSON.parse(line!);
    expect(log).toMatchObject({ rows: 1, skipped: 0, truncated: false, userId: 'user-1' });
    expect(lines.join('\n')).not.toContain('María');
    expect(lines.join('\n')).not.toContain('maria@example.com');
  });
});

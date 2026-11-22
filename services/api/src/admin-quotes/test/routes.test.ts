/* eslint-disable @typescript-eslint/no-explicit-any -- respuestas JSON de prueba sin tipar */
import type { Quote } from '@canteras/shared';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { describe, expect, it } from 'vitest';
import { encodeCursor } from '../cursor';
import { ID_A, ID_B, ID_C, PRICES, quote } from './fixtures';
import { MemoryQuoteRepository } from './memory-repository';
import { createQuotesRouter } from '../routes';

type Ev = APIGatewayProxyEventV2WithJWTAuthorizer;
interface Call {
  method?: string;
  path: string;
  groups?: string;
  body?: unknown;
  query?: Record<string, string>;
}

function ev(c: Call): Ev {
  const claims: Record<string, string> = { sub: 'user-1', token_use: 'access' };
  if (c.groups !== undefined) claims['cognito:groups'] = c.groups;
  return {
    version: '2.0',
    rawPath: c.path,
    rawQueryString: '',
    headers: {},
    ...(c.query ? { queryStringParameters: c.query } : {}),
    isBase64Encoded: false,
    ...(c.body === undefined ? {} : { body: JSON.stringify(c.body) }),
    requestContext: {
      requestId: 'req-1',
      http: { method: c.method ?? 'GET', path: c.path },
      authorizer: { jwt: { claims, scopes: [] } },
    },
  } as unknown as Ev;
}

const T = Date.parse('2026-11-19T12:00:00.000Z');

function setup() {
  const repo = new MemoryQuoteRepository();
  const lines: string[] = [];
  let tick = 0;
  const router = createQuotesRouter(
    { repo, now: () => new Date(T + 1000 * tick++) },
    { logSink: (l) => lines.push(l) },
  );
  const call = async (c: Call, groups = '[owner]') => {
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
  const patch = (id: string, body: unknown, groups = '[owner]') =>
    call({ method: 'PATCH', path: `/admin/quotes/${id}`, body }, groups);
  const note = (id: string, body: unknown, groups = '[owner]') =>
    call({ method: 'POST', path: `/admin/quotes/${id}/notes`, body }, groups);
  return { repo, lines, call, patch, note };
}

// Rutas y quién puede entrar (permiso por ruta Y método).
const MATRIZ: ReadonlyArray<readonly [string, string, ReadonlyArray<'owner' | 'staff'>]> = [
  ['GET', '/admin/quotes', ['owner', 'staff']],
  ['GET', `/admin/quotes/${ID_A}`, ['owner', 'staff']],
  ['PATCH', `/admin/quotes/${ID_A}`, ['owner', 'staff']],
  ['POST', `/admin/quotes/${ID_A}/notes`, ['owner', 'staff']],
  ['GET', '/admin/quotes/export.csv', ['owner']],
];

describe('permisos por ruta y método', () => {
  for (const [method, path, allowed] of MATRIZ) {
    for (const [group, role] of [
      ['[owner]', 'owner'],
      ['[staff]', 'staff'],
    ] as const) {
      it(`${method} ${path} como ${role}: ${allowed.includes(role) ? 'pasa' : '403'}`, async () => {
        const { repo, call } = setup();
        repo.seed(quote({ status: 'en_revision' }));
        const r = await call({ method, path, body: method === 'GET' ? undefined : {} }, group);
        if (allowed.includes(role)) expect(r.status).not.toBe(403);
        else {
          expect(r.status).toBe(403);
          expect(repo.calls).toEqual([]); // el repositorio no se toca
        }
      });
    }
  }

  it('sin grupos o con rol desconocido: 403', async () => {
    const { call } = setup();
    expect((await call({ path: '/admin/quotes' }, '[]')).status).toBe(403);
    expect((await call({ path: '/admin/quotes' }, '[admin]')).status).toBe(403);
  });

  it('métodos no declarados: 404', async () => {
    const { call } = setup();
    expect((await call({ method: 'DELETE', path: `/admin/quotes/${ID_A}` })).status).toBe(404);
    expect((await call({ method: 'PUT', path: `/admin/quotes/${ID_A}` })).status).toBe(404);
    expect((await call({ method: 'POST', path: '/admin/quotes' })).status).toBe(404);
  });
});

describe('GET /admin/quotes (lista)', () => {
  function seed3(repo: MemoryQuoteRepository) {
    repo.seed(
      quote({
        quoteId: ID_A,
        folio: 'CN-2026-00001',
        createdAt: '2026-11-10T10:00:00.000Z',
        status: 'nueva',
      }),
    );
    repo.seed(
      quote({
        quoteId: ID_B,
        folio: 'CN-2026-00002',
        createdAt: '2026-11-12T10:00:00.000Z',
        status: 'cotizada',
        customer: { nombre: 'José Ñandú', telefono: '(222) 555-0199', correo: 'jose@example.com' },
        works: { lugar: 'Puebla', codigoPostal: '72000', uso: '', notas: '' },
      }),
    );
    repo.seed(
      quote({
        quoteId: ID_C,
        folio: 'CN-2026-00003',
        createdAt: '2026-11-15T10:00:00.000Z',
        status: 'nueva',
      }),
    );
  }

  it('sin filtros usa el GSI por fecha, descendente, con limit por defecto 25', async () => {
    const { repo, call } = setup();
    seed3(repo);
    const r = await call({ path: '/admin/quotes' });
    expect(r.status).toBe(200);
    expect(r.json.items.map((i: any) => i.folio)).toEqual([
      'CN-2026-00003',
      'CN-2026-00002',
      'CN-2026-00001',
    ]);
    expect(r.json.nextCursor).toBeNull();
    expect(repo.lastList).toMatchObject({ index: 'date', limit: 25 });
  });

  it('con status usa el GSI por estado', async () => {
    const { repo, call } = setup();
    seed3(repo);
    const r = await call({ path: '/admin/quotes', query: { status: 'nueva' } });
    expect(r.json.items.map((i: any) => i.folio)).toEqual(['CN-2026-00003', 'CN-2026-00001']);
    expect(repo.lastList).toMatchObject({ index: 'status', status: 'nueva' });
  });

  it('pagina con cursor y limit', async () => {
    const { repo, call } = setup();
    seed3(repo);
    const p1 = await call({ path: '/admin/quotes', query: { limit: '2' } });
    expect(p1.json.items).toHaveLength(2);
    expect(typeof p1.json.nextCursor).toBe('string');
    const p2 = await call({
      path: '/admin/quotes',
      query: { limit: '2', cursor: p1.json.nextCursor },
    });
    expect(p2.json.items.map((i: any) => i.folio)).toEqual(['CN-2026-00001']);
    expect(p2.json.nextCursor).toBeNull();
  });

  it('from y to filtran por fecha (inclusivo, día completo)', async () => {
    const { repo, call } = setup();
    seed3(repo);
    const r = await call({
      path: '/admin/quotes',
      query: { from: '2026-11-12', to: '2026-11-15' },
    });
    expect(r.json.items.map((i: any) => i.folio)).toEqual(['CN-2026-00003', 'CN-2026-00002']);
    expect(repo.lastList).toMatchObject({
      from: '2026-11-12T00:00:00.000Z',
      to: '2026-11-15T23:59:59.999Z#~',
    });
  });

  it('q busca sin acentos ni mayúsculas en folio, nombre, teléfono y CP', async () => {
    const { repo, call } = setup();
    seed3(repo);
    const por = async (q: string) =>
      (await call({ path: '/admin/quotes', query: { q } })).json.items.map((i: any) => i.folio);
    expect(await por('JOSE ñandu')).toEqual(['CN-2026-00002']);
    expect(await por('2225550199')).toEqual(['CN-2026-00002']);
    expect(await por('cn-2026-00003')).toEqual(['CN-2026-00003']);
    expect(await por('72000')).toEqual(['CN-2026-00002']);
    expect(await por('nadie-existe')).toEqual([]);
  });

  it('q puede devolver una página vacía CON nextCursor (el filtro se aplica después del Limit)', async () => {
    const { repo, call } = setup();
    seed3(repo);
    const r = await call({ path: '/admin/quotes', query: { q: 'cn-2026-00001', limit: '1' } });
    expect(r.json.items).toEqual([]);
    expect(typeof r.json.nextCursor).toBe('string');
    const r2 = await call({
      path: '/admin/quotes',
      query: { q: 'cn-2026-00001', limit: '1', cursor: r.json.nextCursor },
    });
    expect(r2.json.items).toEqual([]);
    const r3 = await call({
      path: '/admin/quotes',
      query: { q: 'cn-2026-00001', limit: '1', cursor: r2.json.nextCursor },
    });
    expect(r3.json.items.map((i: any) => i.folio)).toEqual(['CN-2026-00001']);
  });

  it.each([
    ['limit 0', { limit: '0' }],
    ['limit 51', { limit: '51' }],
    ['limit no numérico', { limit: 'x' }],
    ['status inválido', { status: 'hola' }],
    ['q de 1 carácter', { q: 'a' }],
    ['q demasiado larga', { q: 'a'.repeat(61) }],
    ['fecha inválida', { from: '2026-13-40' }],
    ['from > to', { from: '2026-11-20', to: '2026-11-10' }],
    ['parámetro desconocido', { foo: '1' }],
  ])('400 invalid_query con %s', async (_n, query) => {
    const { call } = setup();
    const r = await call({ path: '/admin/quotes', query });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('invalid_query');
  });

  it.each(['basura', '', 'e30', Buffer.from('{"quoteId":"x"}').toString('base64url')])(
    '400 invalid_cursor con cursor %j',
    async (cursor) => {
      const { call, repo } = setup();
      const r = await call({ path: '/admin/quotes', query: { cursor } });
      expect(r.status).toBe(400);
      expect(r.json.error).toBe('invalid_cursor');
      expect(repo.calls).toEqual([]);
    },
  );

  it('un cursor de otro rango de fechas se rechaza (400, nunca 500)', async () => {
    const { repo, call } = setup();
    repo.seed(quote({ quoteId: ID_A, createdAt: '2026-11-10T10:00:00.000Z' }));
    const c = encodeCursor({
      quoteId: ID_A,
      gsi2pk: 'QUOTE',
      gsi2sk: `2026-11-10T10:00:00.000Z#${ID_A}`,
    });
    const r = await call({ path: '/admin/quotes', query: { cursor: c, from: '2026-11-15' } });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('invalid_cursor');
    expect(repo.calls).toEqual([]);
  });

  it('q con lada: «+52 222 555» encuentra el teléfono guardado con +52', async () => {
    const { repo, call } = setup();
    repo.seed(
      quote({ customer: { nombre: 'Ana', telefono: '+52 222 555 0100', correo: 'a@example.com' } }),
    );
    const r = await call({ path: '/admin/quotes', query: { q: '+52 222 555' } });
    expect(r.json.items).toHaveLength(1);
  });

  it('un cursor de otro índice se rechaza', async () => {
    const { call } = setup();
    const c = encodeCursor({
      quoteId: ID_A,
      gsi1pk: 'STATUS#nueva',
      gsi1sk: `2026-11-10T10:00:00.000Z#${ID_A}`,
    });
    expect((await call({ path: '/admin/quotes', query: { cursor: c } })).json.error).toBe(
      'invalid_cursor',
    );
    expect(
      (await call({ path: '/admin/quotes', query: { cursor: c, status: 'cotizada' } })).json.error,
    ).toBe('invalid_cursor');
  });

  it('el resumen no trae notas, historial ni claves internas', async () => {
    const { repo, call } = setup();
    repo.seed(quote({ notes: [{ at: '2026-11-10T10:00:00.000Z', by: 'u', texto: 'interna' }] }));
    const r = await call({ path: '/admin/quotes' });
    const item = r.json.items[0];
    expect(item).toMatchObject({ quoteId: ID_A, folio: 'CN-2026-00001', status: 'nueva', rev: 1 });
    expect(r.text).not.toContain('interna');
    for (const k of ['gsi1pk', 'gsi2pk', 'searchKey', 'notes', 'history'])
      expect(r.text).not.toContain(k);
  });

  it('omite ítems corruptos sin tirar el listado ni registrar PII', async () => {
    const { repo, call, lines } = setup();
    repo.seed(quote());
    repo.rows.set(ID_B, {
      quoteId: ID_B,
      gsi2pk: 'QUOTE',
      gsi2sk: `2026-11-11T10:00:00.000Z#${ID_B}`,
      customer: { nombre: 'Secreto' },
    });
    const r = await call({ path: '/admin/quotes' });
    expect(r.status).toBe(200);
    expect(r.json.items).toHaveLength(1);
    expect(lines.join('\n')).toContain('invalid_stored_item');
    expect(lines.join('\n')).not.toContain('Secreto');
  });
});

describe('GET /admin/quotes/{quoteId}', () => {
  it('devuelve la solicitud completa sin claves internas', async () => {
    const { repo, call } = setup();
    repo.seed(quote());
    const r = await call({ path: `/admin/quotes/${ID_A}` });
    expect(r.status).toBe(200);
    expect(r.json.customer.correo).toBe('maria@example.com');
    expect(r.json.searchKey).toBeUndefined();
    expect(r.json.gsi1pk).toBeUndefined();
  });
  it('404 si no existe y 400 si el id no es ULID', async () => {
    const { call } = setup();
    expect((await call({ path: `/admin/quotes/${ID_B}` })).status).toBe(404);
    expect((await call({ path: '/admin/quotes/no-es-ulid' })).status).toBe(400);
    expect((await call({ path: '/admin/quotes/01arz3ndektsv4rrffq69g5fav' })).status).toBe(400);
  });
  it('500 genérico si la fila guardada no valida', async () => {
    const { repo, call } = setup();
    repo.rows.set(ID_A, { quoteId: ID_A, customer: { nombre: 'Secreto' } });
    const r = await call({ path: `/admin/quotes/${ID_A}` });
    expect(r.status).toBe(500);
    expect(r.text).not.toContain('Secreto');
  });
});

describe('PATCH /admin/quotes/{quoteId}', () => {
  it('nueva -> en_revision: sube rev, agrega historial, no toca respondedAt', async () => {
    const { repo, patch } = setup();
    repo.seed(quote());
    const r = await patch(ID_A, { status: 'en_revision', rev: 1 });
    expect(r.status).toBe(200);
    expect(r.json.status).toBe('en_revision');
    expect(r.json.rev).toBe(2);
    expect(r.json.respondedAt).toBeUndefined();
    expect(r.json.history).toEqual([
      {
        at: '2026-11-19T12:00:00.000Z',
        by: 'user-1',
        tipo: 'estado',
        de: 'nueva',
        a: 'en_revision',
      },
    ]);
  });

  it('actualiza las claves del índice por estado', async () => {
    const { repo, patch } = setup();
    repo.seed(quote());
    await patch(ID_A, { status: 'en_revision', rev: 1 });
    expect(repo.rows.get(ID_A)!['gsi1pk']).toBe('STATUS#en_revision');
  });

  it('rev viejo: 409 conflict y no escribe', async () => {
    const { repo, patch } = setup();
    repo.seed(quote({ rev: 3 }));
    const r = await patch(ID_A, { status: 'en_revision', rev: 2 });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('conflict');
    expect(repo.audits).toHaveLength(0);
    expect(repo.rows.get(ID_A)!['rev']).toBe(3);
  });

  it('carrera: otro escribe entre la lectura y la escritura -> 409', async () => {
    const { repo, patch } = setup();
    repo.seed(quote());
    repo.onBeforeWrite = () => {
      repo.rows.get(ID_A)!['rev'] = 2;
    };
    const r = await patch(ID_A, { status: 'en_revision', rev: 1 });
    expect(r.status).toBe(409);
    expect(repo.audits).toHaveLength(0);
  });

  it('falta rev: 422', async () => {
    const { repo, patch } = setup();
    repo.seed(quote());
    expect((await patch(ID_A, { status: 'en_revision' })).status).toBe(422);
  });

  it('PATCH a enviada: 422 (solo la acción de envío llega a enviada)', async () => {
    const { repo, patch } = setup();
    repo.seed(quote({ status: 'cotizada' }));
    const r = await patch(ID_A, { status: 'enviada', rev: 1 });
    expect(r.status).toBe(422);
    expect(r.json.error).toBe('validation_error');
  });

  it('perdida sin lostReason: 422; con lostReason: guarda el motivo', async () => {
    const { repo, patch } = setup();
    repo.seed(quote({ status: 'enviada' }));
    expect((await patch(ID_A, { status: 'perdida', rev: 1 })).status).toBe(422);
    const r = await patch(ID_A, { status: 'perdida', lostReason: 'precio_flete', rev: 1 });
    expect(r.status).toBe(200);
    expect(r.json.lostReason).toBe('precio_flete');
    expect(r.json.status).toBe('perdida');
  });

  it('cotizada sin finalQuote: 422', async () => {
    const { repo, patch } = setup();
    repo.seed(quote({ status: 'en_revision' }));
    expect((await patch(ID_A, { status: 'cotizada', rev: 1 })).status).toBe(422);
  });

  it('en_revision -> cotizada calcula subtotales y total en el servidor', async () => {
    const { repo, patch } = setup();
    repo.seed(quote({ status: 'en_revision' }));
    const r = await patch(ID_A, { status: 'cotizada', finalQuote: PRICES, rev: 1 });
    expect(r.status).toBe(200);
    expect(r.json.finalQuote).toEqual({
      items: [
        { stoneId: 'arenisca', precioUnitario: 120.5, subtotal: 1205 },
        { stoneId: 'caliza', precioUnitario: 300, subtotal: 900 },
      ],
      fleteFinal: 1500,
      subtotal: 2105,
      iva: null,
      ivaPct: null,
      total: 3605,
      vigenciaDias: 15,
    });
    expect(r.json.history.map((h: any) => h.tipo)).toEqual(['edicion', 'estado']);
  });

  it('el cliente no puede mandar subtotal ni total: 422', async () => {
    const { repo, patch } = setup();
    repo.seed(quote({ status: 'en_revision' }));
    const r = await patch(ID_A, { finalQuote: { ...PRICES, total: 1 }, rev: 1 });
    expect(r.status).toBe(422);
  });

  it('faltan precios, sobra una piedra o hay flete negativo: 422', async () => {
    const { repo, patch } = setup();
    repo.seed(quote({ status: 'en_revision' }));
    const uno = { items: [PRICES.items[0]], fleteFinal: 0 };
    const extra = {
      items: [...PRICES.items, { stoneId: 'otra', precioUnitario: 1 }],
      fleteFinal: 0,
    };
    expect((await patch(ID_A, { finalQuote: uno, rev: 1 })).status).toBe(422);
    expect((await patch(ID_A, { finalQuote: extra, rev: 1 })).status).toBe(422);
    expect((await patch(ID_A, { finalQuote: { ...PRICES, fleteFinal: -1 }, rev: 1 })).status).toBe(
      422,
    );
    expect(repo.audits).toHaveLength(0);
  });

  it('precios editables solo en en_revision y cotizada', async () => {
    for (const status of ['nueva', 'enviada', 'ganada', 'perdida', 'cancelada'] as const) {
      const { repo, patch } = setup();
      repo.seed(quote({ status }));
      const r = await patch(ID_A, { finalQuote: PRICES, rev: 1 });
      expect(r.status, status).toBe(409);
      expect(r.json.error).toBe('quote_locked');
    }
    for (const status of ['en_revision', 'cotizada'] as const) {
      const { repo, patch } = setup();
      repo.seed(quote({ status }));
      expect((await patch(ID_A, { finalQuote: PRICES, rev: 1 })).status, status).toBe(200);
    }
  });

  it('editar precios sin cambiar el estado conserva el estado', async () => {
    const { repo, patch } = setup();
    repo.seed(quote({ status: 'cotizada' }));
    const r = await patch(ID_A, { finalQuote: { ...PRICES, vigenciaDias: 30 }, rev: 1 });
    expect(r.json.status).toBe('cotizada');
    expect(r.json.finalQuote.vigenciaDias).toBe(30);
  });

  it('transiciones inválidas: 409 invalid_transition', async () => {
    const { repo, patch } = setup();
    repo.seed(quote({ status: 'nueva' }));
    expect((await patch(ID_A, { status: 'ganada', rev: 1 })).json.error).toBe('invalid_transition');
    const f = setup();
    f.repo.seed(quote({ status: 'ganada' }));
    expect((await f.patch(ID_A, { status: 'cancelada', rev: 1 })).json.error).toBe(
      'invalid_transition',
    );
  });

  it('cancelada desde cualquier estado no final (owner)', async () => {
    for (const status of ['nueva', 'en_revision', 'cotizada', 'enviada'] as const) {
      const { repo, patch } = setup();
      repo.seed(quote({ status }));
      expect((await patch(ID_A, { status: 'cancelada', rev: 1 })).status, status).toBe(200);
    }
  });

  it('cotizada -> en_revision (corregir precios)', async () => {
    const { repo, patch } = setup();
    repo.seed(quote({ status: 'cotizada' }));
    expect((await patch(ID_A, { status: 'en_revision', rev: 1 })).status).toBe(200);
  });

  it('staff: solo transiciones de preparación; ganada, perdida y cancelada dan 403', async () => {
    const casos: Array<[string, Record<string, unknown>, number]> = [
      ['nueva', { status: 'en_revision' }, 200],
      ['en_revision', { status: 'cotizada', finalQuote: PRICES }, 200],
      ['cotizada', { status: 'en_revision' }, 200],
      ['nueva', { status: 'cancelada' }, 403],
      ['cotizada', { status: 'cancelada' }, 403],
      ['enviada', { status: 'ganada' }, 403],
      ['enviada', { status: 'perdida', lostReason: 'otro' }, 403],
      ['enviada', { status: 'cancelada' }, 403],
    ];
    for (const [from, body, esperado] of casos) {
      const { repo, patch } = setup();
      repo.seed(quote({ status: from as Quote['status'] }));
      const r = await patch(ID_A, { ...body, rev: 1 }, '[staff]');
      expect(r.status, `${from} ${JSON.stringify(body.status)}`).toBe(esperado);
      if (esperado === 403) expect(repo.audits).toHaveLength(0);
    }
  });

  it('staff puede editar precios y flete en en_revision', async () => {
    const { repo, patch } = setup();
    repo.seed(quote({ status: 'en_revision' }));
    expect((await patch(ID_A, { finalQuote: PRICES, rev: 1 }, '[staff]')).status).toBe(200);
  });

  it('404 si no existe', async () => {
    const { patch } = setup();
    expect((await patch(ID_A, { status: 'en_revision', rev: 1 })).status).toBe(404);
  });

  it('historial lleno: 409 history_full', async () => {
    const { repo, patch } = setup();
    const h = { at: '2026-11-10T10:00:00.000Z', by: 'u', tipo: 'nota' as const };
    repo.seed(quote({ history: Array(200).fill(h) }));
    const r = await patch(ID_A, { status: 'en_revision', rev: 1 });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('history_full');
  });

  it('error inesperado del repositorio: 500 sin detalles', async () => {
    const { repo, patch } = setup();
    repo.seed(quote());
    repo.writeError = new Error('boom con maria@example.com');
    const r = await patch(ID_A, { status: 'en_revision', rev: 1 });
    expect(r.status).toBe(500);
    expect(r.text).not.toContain('maria@example.com');
  });
});

describe('POST /admin/quotes/{quoteId}/notes', () => {
  it('agrega la nota y una entrada de historial, sube rev', async () => {
    const { repo, note } = setup();
    repo.seed(quote());
    const r = await note(ID_A, { texto: 'Llamar el lunes', rev: 1 }, '[staff]');
    expect(r.status).toBe(201);
    expect(r.json.rev).toBe(2);
    expect(r.json.notes).toEqual([
      { at: '2026-11-19T12:00:00.000Z', by: 'user-1', texto: 'Llamar el lunes' },
    ]);
    expect(r.json.history).toEqual([
      {
        at: '2026-11-19T12:00:00.000Z',
        by: 'user-1',
        tipo: 'nota',
        texto: 'Nota interna agregada',
      },
    ]);
    expect(repo.rows.get(ID_A)!['gsi1pk']).toBe('STATUS#nueva'); // estado intacto
  });

  it('nota de 2000 caracteres pasa y de 2001 da 422', async () => {
    const { repo, note } = setup();
    repo.seed(quote());
    expect((await note(ID_A, { texto: 'x'.repeat(2001), rev: 1 })).status).toBe(422);
    expect((await note(ID_A, { texto: 'x'.repeat(2000), rev: 1 })).status).toBe(201);
  });

  it('rev viejo 409, sin rev 422, inexistente 404', async () => {
    const { repo, note } = setup();
    repo.seed(quote({ rev: 2 }));
    expect((await note(ID_A, { texto: 'hola', rev: 1 })).status).toBe(409);
    expect((await note(ID_A, { texto: 'hola' })).status).toBe(422);
    expect((await note(ID_B, { texto: 'hola', rev: 1 })).status).toBe(404);
  });

  it('tope de notas: 409 notes_limit', async () => {
    const { repo, note } = setup();
    const n = { at: '2026-11-10T10:00:00.000Z', by: 'u', texto: 'x' };
    repo.seed(quote({ notes: Array(100).fill(n) }));
    const r = await note(ID_A, { texto: 'otra', rev: 1 });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('notes_limit');
  });
});

describe('GET /admin/quotes/export.csv', () => {
  it('la ruta literal NO choca con {quoteId}: devuelve CSV, no 400 ni 404', async () => {
    const { repo, call } = setup();
    repo.seed(quote());
    const r = await call({ path: '/admin/quotes/export.csv' });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(r.headers['content-disposition']).toBe(
      'attachment; filename="solicitudes-2026-11-19.csv"',
    );
    expect(r.text.startsWith('﻿"Folio"')).toBe(true);
    expect(r.text).toContain('"CN-2026-00001"');
  });

  it('un id ULID sigue llegando al detalle', async () => {
    const { repo, call } = setup();
    repo.seed(quote());
    expect((await call({ path: `/admin/quotes/${ID_A}` })).json.folio).toBe('CN-2026-00001');
  });

  it('staff recibe 403 en export.csv (no cae en {quoteId})', async () => {
    const { call } = setup();
    expect((await call({ path: '/admin/quotes/export.csv' }, '[staff]')).status).toBe(403);
  });

  it('respeta los filtros y neutraliza fórmulas', async () => {
    const { repo, call } = setup();
    repo.seed(
      quote({
        quoteId: ID_A,
        status: 'nueva',
        customer: { nombre: '=cmd|x', telefono: '555-0101', correo: 'a@example.com' },
      }),
    );
    repo.seed(
      quote({
        quoteId: ID_B,
        folio: 'CN-2026-00002',
        status: 'cotizada',
        createdAt: '2026-11-12T10:00:00.000Z',
      }),
    );
    const r = await call({ path: '/admin/quotes/export.csv', query: { status: 'nueva' } });
    expect(r.text).toContain(`"'=cmd|x"`);
    expect(r.text).not.toContain('CN-2026-00002');
  });

  it('con tope: recorta a 5000 filas y avisa con cabecera', async () => {
    const { repo, call } = setup();
    for (let i = 0; i < 5003; i++) {
      const id = `01ARZ3NDEKTSV4RRFFQ69G${String(i)
        .padStart(4, '0')
        .replace(/\d/g, (d) => 'ABCDEFGHJK'[Number(d)]!)}`;
      repo.seed(
        quote({ quoteId: id, createdAt: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString() }),
      );
    }
    const r = await call({ path: '/admin/quotes/export.csv' });
    expect(r.status).toBe(200);
    expect(r.text.split('\r\n')).toHaveLength(5002); // encabezado + 5000 + vacío final
    expect(r.headers['x-export-truncated']).toBe('true');
  });

  it('filas corruptas: se cuentan en x-export-skipped y no tumban el CSV', async () => {
    const { repo, call } = setup();
    repo.seed(quote());
    repo.rows.set(ID_B, {
      quoteId: ID_B,
      gsi2pk: 'QUOTE',
      gsi2sk: `2026-11-11T10:00:00.000Z#${ID_B}`,
    });
    const r = await call({ path: '/admin/quotes/export.csv' });
    expect(r.status).toBe(200);
    expect(r.headers['x-export-skipped']).toBe('1');
    const ok = setup();
    ok.repo.seed(quote());
    expect(
      (await ok.call({ path: '/admin/quotes/export.csv' })).headers['x-export-skipped'],
    ).toBeUndefined();
  });

  it('si el CSV pasa de ~5 MB se recorta por bytes y se marca truncado (no 413)', async () => {
    const { repo, call } = setup();
    const items = Array.from({ length: 50 }, (_, i) => ({
      stoneId: `piedra-${i}`,
      nombre: 'N'.repeat(120),
      acabado: '',
      cantidad: 1,
      unidad: 'pieza' as const,
      pesoKg: 1,
    }));
    for (let i = 0; i < 1100; i++) {
      const id = `01ARZ3NDEKTSV4RRFFQ69G${String(i)
        .padStart(4, '0')
        .replace(/\d/g, (d) => 'ABCDEFGHJK'[Number(d)]!)}`;
      repo.seed(
        quote({
          quoteId: id,
          items,
          createdAt: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
        }),
      );
    }
    const r = await call({ path: '/admin/quotes/export.csv' });
    expect(r.status).toBe(200);
    expect(r.headers['x-export-truncated']).toBe('true');
    expect(Buffer.byteLength(r.text, 'utf8')).toBeLessThanOrEqual(5 * 1024 * 1024);
    expect(r.text.split('\r\n').length).toBeGreaterThan(100);
  });

  it('rechaza parámetros que no son filtros', async () => {
    const { call } = setup();
    expect((await call({ path: '/admin/quotes/export.csv', query: { cursor: 'x' } })).status).toBe(
      400,
    );
  });
});

// Texto CJK: 3 bytes por carácter en UTF-8, 1 en UTF-16 (el límite por caracteres no protege los 400 KB).
const CJK = (n: number) => '漢'.repeat(n);
const size = (q: Quote) => Buffer.byteLength(JSON.stringify(q), 'utf8');

/** Solicitud en en_revision con notas CJK hasta quedar justo por debajo de `target` bytes. */
function bigQuote(target: number): Quote {
  const base = quote({ status: 'en_revision' });
  const notes: Quote['notes'] = [];
  const mk = (n: number) => ({ at: '2026-11-10T10:00:00.000Z', by: 'u', texto: CJK(n) });
  let q = { ...base, notes };
  while (size({ ...q, notes: [...notes, mk(2000)] }) < target) notes.push(mk(2000));
  // Ajuste fino con una última nota más corta.
  let n = 2000;
  while (n > 1 && size({ ...q, notes: [...notes, mk(n)] }) > target) n -= 50;
  notes.push(mk(n));
  q = { ...base, notes };
  return q;
}

describe('tope de 400 KB por bytes (409 quote_too_large)', () => {
  it('una nota CJK que haría pasar los ~350 KB da 409 con mensaje claro, no 500', async () => {
    const { repo, note } = setup();
    const q = bigQuote(346_000);
    expect(q.notes.length).toBeLessThan(100); // el tope por cantidad NO protege
    repo.seed(q);
    const r = await note(ID_A, { texto: CJK(2000), rev: 1 });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('quote_too_large');
    expect(r.json.message).toMatch(/demasiado grande/i);
    expect(repo.audits).toHaveLength(0);
  });

  it('una nota pequeña en una solicitud lejos del límite pasa', async () => {
    const { repo, note } = setup();
    repo.seed(bigQuote(100_000));
    expect((await note(ID_A, { texto: CJK(100), rev: 1 })).status).toBe(201);
  });

  it('el PATCH también valida el tamaño antes de guardar', async () => {
    const { repo, patch } = setup();
    repo.seed(bigQuote(349_900));
    const r = await patch(ID_A, { status: 'cotizada', finalQuote: PRICES, rev: 1 });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('quote_too_large');
    expect(repo.audits).toHaveLength(0);
  });

  it('un ítem cerca pero debajo del umbral se guarda', async () => {
    const { repo, note } = setup();
    repo.seed(bigQuote(330_000));
    expect((await note(ID_A, { texto: 'hola', rev: 1 })).status).toBe(201);
  });
});

describe('PII fuera de auditoría y logs', () => {
  const PII = ['María', 'maria@example.com', '555-0101', 'San Andrés', 'Llamar'];

  it('la auditoría no contiene datos del cliente y usa entityType quote', async () => {
    const { repo, patch, note } = setup();
    repo.seed(quote({ status: 'en_revision' }));
    await patch(ID_A, { status: 'cotizada', finalQuote: PRICES, rev: 1 });
    await note(ID_A, { texto: 'Llamar a María al 555-0101', rev: 2 });
    expect(repo.audits).toHaveLength(2);
    const dump = JSON.stringify(repo.audits);
    for (const p of PII) expect(dump).not.toContain(p);
    expect(repo.audits[0]).toMatchObject({
      pk: `ENTITY#quote#${ID_A}`,
      accion: 'status',
      antes: { status: 'en_revision', rev: 1 },
      despues: {
        status: 'cotizada',
        rev: 2,
        finalQuote: { subtotal: 2105, fleteFinal: 1500, total: 3605, vigenciaDias: 15 },
      },
    });
    expect(repo.audits[1]).toMatchObject({
      accion: 'update',
      antes: { rev: 2, notas: 0 },
      despues: { rev: 3, notas: 1, longitudNota: 26 },
    });
    expect(repo.audits[0]!.scope).toBeUndefined();
  });

  it('perdida audita el motivo (sin PII)', async () => {
    const { repo, patch } = setup();
    repo.seed(quote({ status: 'enviada' }));
    await patch(ID_A, { status: 'perdida', lostReason: 'otro_proveedor', rev: 1 });
    expect(repo.audits[0]!.despues).toMatchObject({
      status: 'perdida',
      lostReason: 'otro_proveedor',
    });
  });

  it('los logs solo llevan quoteId/folio/acción: sin teléfono, correo, nombre, notas ni query q', async () => {
    const { repo, patch, note, call, lines } = setup();
    repo.seed(quote({ status: 'en_revision' }));
    await patch(ID_A, { status: 'cotizada', finalQuote: PRICES, rev: 1 });
    await note(ID_A, { texto: 'Llamar a María', rev: 2 });
    await call({ path: '/admin/quotes', query: { q: 'maria perez' } });
    await call({ path: '/admin/quotes/export.csv', query: { q: 'maria perez' } });
    await call({ path: `/admin/quotes/${ID_A}` });
    const dump = lines.join('\n');
    expect(dump).toContain('quote_updated');
    expect(dump).toContain('CN-2026-00001');
    for (const p of [...PII, 'maria perez', 'María Pérez']) expect(dump).not.toContain(p);
  });
});

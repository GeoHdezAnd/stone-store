import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { describe, expect, it, vi } from 'vitest';
import { HttpError, jsonResponse } from '../http';
import { createRouter, route, type Handler } from '../router';

type Ev = APIGatewayProxyEventV2WithJWTAuthorizer;

interface Opts {
  method?: string;
  path?: string;
  claims?: Record<string, string> | null;
  groups?: string | undefined;
  sub?: string | undefined;
  /** Por defecto `access`; `null` quita el claim. */
  tokenUse?: string | null;
  body?: string | undefined;
  b64?: boolean;
  query?: Record<string, string>;
}

/** Arma un evento payload v2; `claims: null` simula una ruta sin authorizer. */
function ev(o: Opts = {}): Ev {
  const claims: Record<string, string> = { ...(o.claims ?? {}) };
  if (!('sub' in o) || o.sub !== undefined) claims.sub = o.sub ?? 'user-1';
  if (o.tokenUse !== null) claims.token_use = o.tokenUse ?? 'access';
  if (o.groups !== undefined) claims['cognito:groups'] = o.groups;
  const requestContext: Record<string, unknown> = {
    requestId: 'req-1',
    http: { method: o.method ?? 'GET', path: o.path ?? '/admin/x' },
  };
  if (o.claims !== null) requestContext.authorizer = { jwt: { claims, scopes: [] } };
  return {
    version: '2.0',
    rawPath: o.path ?? '/admin/x',
    rawQueryString: '',
    queryStringParameters: o.query,
    headers: {},
    isBase64Encoded: o.b64 ?? false,
    body: o.body,
    requestContext,
  } as unknown as Ev;
}

function setup(extra: Parameters<typeof createRouter>[1] = {}) {
  const lines: string[] = [];
  const ownerH = vi.fn<Handler>(async () => jsonResponse(200, { who: 'owner' }));
  const staffH = vi.fn<Handler>(async () => jsonResponse(200, { who: 'staff' }));
  const bothH = vi.fn<Handler>(async (c) =>
    jsonResponse(200, { who: 'both', params: c.params, body: c.body }),
  );
  const router = createRouter(
    [
      route('GET', '/admin/owner-only', ['owner'], ownerH),
      route('GET', '/admin/staff-only', ['staff'], staffH),
      route('GET', '/admin/both', ['owner', 'staff'], bothH),
      route('POST', '/admin/both', ['owner', 'staff'], bothH),
      route('PUT', '/admin/things/{id}', ['owner'], bothH),
      route('DELETE', '/admin/things/{id}/sub/{sid}', ['owner'], bothH),
      route('GET', '/admin/boom', ['owner'], async () => {
        throw new Error('secreto interno juan@example.com');
      }),
      route('GET', '/admin/http-error', ['owner'], async () => {
        throw new HttpError(409, 'conflict', 'detalle');
      }),
    ],
    { logSink: (l) => lines.push(l), ...extra },
  );
  return { router, ownerH, staffH, bothH, lines };
}

const json = (r: { body?: string | undefined }) => JSON.parse(r.body ?? 'null');

describe('autorización: matriz rol x ruta x formato del claim', () => {
  const formats = (g: string[]) => [`[${g.join(' ')}]`, g.join(' ')];
  const cases: [string, string[], string, number][] = [];
  const paths = {
    '/admin/owner-only': ['owner'],
    '/admin/staff-only': ['staff'],
    '/admin/both': ['owner', 'staff'],
  };
  const users: Record<string, string[]> = {
    owner: ['owner'],
    staff: ['staff'],
    'owner+staff': ['owner', 'staff'],
  };
  for (const [uname, groups] of Object.entries(users)) {
    for (const [p, allowed] of Object.entries(paths)) {
      const ok = groups.some((g) => allowed.includes(g));
      for (const f of formats(groups)) cases.push([uname, groups, `${p}|${f}`, ok ? 200 : 403]);
    }
  }
  it.each(cases)('%s -> %s %s => %i', async (_u, _g, combo, status) => {
    const [path, groups] = combo.split('|') as [string, string];
    const { router } = setup();
    const res = await router.handle(ev({ path, groups }));
    expect(res.statusCode).toBe(status);
  });

  it.each(['[x,owner]', '[a,owner b]', '["owner"]', '[owner,staff]', '[owner, staff]'])(
    'el claim ambiguo %s no escala a owner -> 403',
    async (groups) => {
      const { router, ownerH } = setup();
      const res = await router.handle(ev({ path: '/admin/owner-only', groups }));
      expect(res.statusCode).toBe(403);
      expect(ownerH).not.toHaveBeenCalled();
    },
  );

  it('owner NO accede a una ruta solo para staff (sin jerarquía)', async () => {
    const { router, staffH } = setup();
    const res = await router.handle(ev({ path: '/admin/staff-only', groups: '[owner]' }));
    expect(res.statusCode).toBe(403);
    expect(json(res)).toEqual({ error: 'forbidden' });
    expect(staffH).not.toHaveBeenCalled();
  });

  it.each([
    '[owner-solo-lectura]',
    '[xowner]',
    '[OWNER]',
    '[owner2]',
    '[superowner staff2]',
    '[__proto__]',
    '[constructor]',
  ])('el grupo parecido %s no da acceso a una ruta owner', async (groups) => {
    const { router, ownerH } = setup();
    const res = await router.handle(ev({ path: '/admin/owner-only', groups }));
    expect(res.statusCode).toBe(403);
    expect(ownerH).not.toHaveBeenCalled();
  });

  it.each([undefined, '', '[]', '   ', '[ ]'])(
    'claim de grupos %j (con claims presentes) -> 403',
    async (groups) => {
      const { router, bothH } = setup();
      const res = await router.handle(ev({ path: '/admin/both', groups }));
      expect(res.statusCode).toBe(403);
      expect(bothH).not.toHaveBeenCalled();
    },
  );

  it('sin authorizer/claims -> 401 (falla cerrado) aunque la ruta no exista', async () => {
    const { router, bothH } = setup();
    expect((await router.handle(ev({ path: '/admin/both', claims: null }))).statusCode).toBe(401);
    expect((await router.handle(ev({ path: '/nada', claims: null }))).statusCode).toBe(401);
    expect(bothH).not.toHaveBeenCalled();
  });

  it('sin claims en absoluto (requestContext vacío) -> 401 sin lanzar', async () => {
    const { router } = setup();
    const res = await router.handle({
      rawPath: '/admin/both',
      requestContext: {},
    } as unknown as Ev);
    expect(res.statusCode).toBe(401);
    const res2 = await router.handle({} as unknown as Ev);
    expect(res2.statusCode).toBe(401);
  });

  it.each([['id'], ['refresh'], [''], [null]])(
    'token_use %j (no es access) -> 401 antes de buscar la ruta',
    async (tokenUse) => {
      const { router, bothH } = setup();
      for (const path of ['/admin/both', '/nada']) {
        const res = await router.handle(ev({ path, groups: '[owner]', tokenUse }));
        expect(res.statusCode).toBe(401);
        expect(JSON.parse(res.body as string)).toEqual({ error: 'unauthorized' });
      }
      expect(bothH).not.toHaveBeenCalled();
    },
  );

  it('un access token válido sí llega al handler', async () => {
    const { router, bothH } = setup();
    const res = await router.handle(
      ev({ path: '/admin/both', groups: '[owner]', tokenUse: 'access' }),
    );
    expect(res.statusCode).toBe(200);
    expect(bothH).toHaveBeenCalledOnce();
  });

  it.each([undefined, ''])('claim sub %j -> 401', async (sub) => {
    const { router, bothH } = setup();
    const res = await router.handle(ev({ path: '/admin/both', groups: '[owner]', sub }));
    expect(res.statusCode).toBe(401);
    expect(bothH).not.toHaveBeenCalled();
  });

  it('el 403 registra warn con requestId, userId y ruta, sin PII', async () => {
    const { router, lines } = setup();
    await router.handle(
      ev({ path: '/admin/staff-only', groups: '[owner]', claims: { email: 'a@b.com' } }),
    );
    const warn = lines.map((l) => JSON.parse(l)).find((l) => l.level === 'warn');
    expect(warn).toMatchObject({ requestId: 'req-1', userId: 'user-1' });
    expect(JSON.stringify(warn)).toContain('/admin/staff-only');
    expect(JSON.stringify(warn)).not.toContain('a@b.com');
  });
});

describe('resolución de rutas', () => {
  it('ruta inexistente -> 404 aunque sea owner', async () => {
    const { router } = setup();
    const res = await router.handle(ev({ path: '/admin/nope', groups: '[owner staff]' }));
    expect(res.statusCode).toBe(404);
    expect(json(res)).toEqual({ error: 'not_found' });
  });

  it.each(['DELETE', 'PATCH', 'HEAD', 'OPTIONS', 'get'])(
    'método %s no declarado -> 404',
    async (method) => {
      const { router, bothH } = setup();
      const res = await router.handle(ev({ method, path: '/admin/both', groups: '[owner]' }));
      expect(res.statusCode).toBe(404);
      expect(bothH).not.toHaveBeenCalled();
    },
  );

  it('extrae parámetros de ruta', async () => {
    const { router, bothH } = setup();
    const res = await router.handle(
      ev({ method: 'DELETE', path: '/admin/things/abc/sub/xyz', groups: '[owner]' }),
    );
    expect(res.statusCode).toBe(200);
    expect(bothH.mock.calls[0]?.[0].params).toEqual({ id: 'abc', sid: 'xyz' });
  });

  it('decodifica parámetros percent-encoded válidos', async () => {
    const { router, bothH } = setup();
    await router.handle(ev({ method: 'PUT', path: '/admin/things/a%2Db', groups: '[owner]' }));
    expect(bothH.mock.calls[0]?.[0].params).toEqual({ id: 'a-b' });
  });

  it('percent-encoding inválido -> 400 (tras autorizar)', async () => {
    const { router, bothH } = setup();
    expect(
      (
        await router.handle(
          ev({ method: 'PUT', path: '/admin/things/%E0%A4%A', groups: '[owner]' }),
        )
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await router.handle(
          ev({ method: 'PUT', path: '/admin/things/%E0%A4%A', groups: '[staff]' }),
        )
      ).statusCode,
    ).toBe(403);
    expect(bothH).not.toHaveBeenCalled();
  });

  it.each([
    '..%2F..%2Fsettings',
    '%2e%2e',
    'a%23b',
    '.',
    '%2F',
    '..',
    'a%25b',
    '-x',
    'a b'.replace(' ', '%20'),
  ])('parámetro peligroso %s -> 400 invalid_path', async (id) => {
    const { router, bothH } = setup();
    const res = await router.handle(
      ev({ method: 'PUT', path: `/admin/things/${id}`, groups: '[owner]' }),
    );
    expect(res.statusCode).toBe(400);
    expect(json(res)).toEqual({ error: 'invalid_path' });
    expect(bothH).not.toHaveBeenCalled();
  });

  it.each(['01J9Z3K8M2Q7R5T1V4W6X8Y0ZA', 'v12.1', 'arenisca', 'a_b-c'])(
    'parámetro válido %s pasa',
    async (id) => {
      const { router, bothH } = setup();
      const res = await router.handle(
        ev({ method: 'PUT', path: `/admin/things/${id}`, groups: '[owner]' }),
      );
      expect(res.statusCode).toBe(200);
      expect(bothH.mock.calls[0]?.[0].params.id).toBe(id);
    },
  );

  it('la autorización ocurre antes de validar parámetros (403, no 400)', async () => {
    const { router } = setup();
    const res = await router.handle(
      ev({ method: 'PUT', path: '/admin/things/..%2Fx', groups: '[staff]' }),
    );
    expect(res.statusCode).toBe(403);
  });

  it('permite sobrescribir el patrón de parámetros por ruta', async () => {
    const h = vi.fn<Handler>(async () => jsonResponse(200, {}));
    const router = createRouter([
      route('GET', '/admin/p/{cp}', ['owner'], h, { paramPattern: /^\d{5}$/ }),
    ]);
    expect(
      (await router.handle(ev({ path: '/admin/p/74000', groups: '[owner]' }))).statusCode,
    ).toBe(200);
    expect(
      (await router.handle(ev({ path: '/admin/p/abcde', groups: '[owner]' }))).statusCode,
    ).toBe(400);
  });

  it('un parámetro es un solo segmento: no cruza "/" ni acepta vacío', async () => {
    const { router } = setup();
    expect(
      (await router.handle(ev({ method: 'PUT', path: '/admin/things/a/b', groups: '[owner]' })))
        .statusCode,
    ).toBe(404);
    expect(
      (await router.handle(ev({ method: 'PUT', path: '/admin/things/', groups: '[owner]' })))
        .statusCode,
    ).toBe(404);
    expect(
      (await router.handle(ev({ method: 'PUT', path: '/admin/things//', groups: '[owner]' })))
        .statusCode,
    ).toBe(404);
  });

  it('un parámetro llamado __proto__ es rechazado por defecto y, si se permite, no contamina nada', async () => {
    const { router } = setup();
    expect(
      (
        await router.handle(
          ev({ method: 'PUT', path: '/admin/things/__proto__', groups: '[owner]' }),
        )
      ).statusCode,
    ).toBe(400);
    const h = vi.fn<Handler>(async () => jsonResponse(200, {}));
    const r2 = createRouter([
      route('GET', '/admin/q/{id}', ['owner'], h, { paramPattern: /^.+$/ }),
    ]);
    await r2.handle(ev({ path: '/admin/q/__proto__', groups: '[owner]' }));
    expect(h.mock.calls[0]?.[0].params.id).toBe('__proto__');
    expect(({} as Record<string, unknown>).id).toBeUndefined();
  });

  it('normaliza la barra final', async () => {
    const { router } = setup();
    expect((await router.handle(ev({ path: '/admin/both/', groups: '[owner]' }))).statusCode).toBe(
      200,
    );
  });

  it('es sensible a mayúsculas', async () => {
    const { router } = setup();
    expect((await router.handle(ev({ path: '/Admin/Both', groups: '[owner]' }))).statusCode).toBe(
      404,
    );
  });

  it('usa requestContext.http.method', async () => {
    const { router } = setup();
    const e = ev({ path: '/admin/both', groups: '[owner]' });
    (e.requestContext.http as { method: string }).method = 'POST';
    const res = await router.handle(e);
    expect(res.statusCode).toBe(200);
  });

  describe('basePath', () => {
    it('recorta el prefijo', async () => {
      const { router } = setup({ basePath: '/dev' });
      expect(
        (await router.handle(ev({ path: '/dev/admin/both', groups: '[owner]' }))).statusCode,
      ).toBe(200);
    });
    it('sin el prefijo -> 404; prefijo parcial no cuenta', async () => {
      const { router } = setup({ basePath: '/dev' });
      expect((await router.handle(ev({ path: '/admin/both', groups: '[owner]' }))).statusCode).toBe(
        404,
      );
      expect(
        (await router.handle(ev({ path: '/devx/admin/both', groups: '[owner]' }))).statusCode,
      ).toBe(404);
    });
    it('se valida al crear el router', () => {
      expect(() => createRouter([], { basePath: 'dev' })).toThrow();
      expect(() => createRouter([], { basePath: '/dev/' })).toThrow();
    });
  });
});

describe('orden: autorizar antes de leer el cuerpo', () => {
  it('JSON inválido en ruta prohibida -> 403, no 400', async () => {
    const { router, bothH } = setup();
    const res = await router.handle(
      ev({ method: 'PUT', path: '/admin/things/1', groups: '[staff]', body: '{no-json' }),
    );
    expect(res.statusCode).toBe(403);
    expect(bothH).not.toHaveBeenCalled();
  });

  it('cuerpo enorme en ruta prohibida -> 403, no 413', async () => {
    const { router } = setup({ maxBodyBytes: 10 });
    const res = await router.handle(
      ev({ method: 'PUT', path: '/admin/things/1', groups: '[staff]', body: 'x'.repeat(100) }),
    );
    expect(res.statusCode).toBe(403);
  });

  it('no se parsea el cuerpo cuando se deniega (JSON.parse no se invoca)', async () => {
    const spy = vi.spyOn(JSON, 'parse');
    try {
      const { router } = setup();
      await router.handle(
        ev({ method: 'PUT', path: '/admin/things/1', groups: '[staff]', body: '{"a":1}' }),
      );
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('cuerpo', () => {
  it('413 si excede maxBodyBytes (texto, cuenta bytes UTF-8)', async () => {
    const { router, bothH } = setup({ maxBodyBytes: 10 });
    const res = await router.handle(
      ev({ method: 'POST', groups: '[owner]', path: '/admin/both', body: '"ñññññññ"' }),
    );
    expect(res.statusCode).toBe(413);
    expect(json(res)).toEqual({ error: 'payload_too_large' });
    expect(bothH).not.toHaveBeenCalled();
  });

  it('413 si excede maxBodyBytes decodificado (base64)', async () => {
    const { router } = setup({ maxBodyBytes: 10 });
    const body = Buffer.from(JSON.stringify({ a: 'x'.repeat(50) })).toString('base64');
    const res = await router.handle(
      ev({ method: 'POST', groups: '[owner]', path: '/admin/both', body, b64: true }),
    );
    expect(res.statusCode).toBe(413);
  });

  it('en base64 mide los bytes decodificados, no la cadena', async () => {
    const raw = JSON.stringify({ a: 1 });
    const body = Buffer.from(raw).toString('base64');
    const { router } = setup({ maxBodyBytes: raw.length });
    const res = await router.handle(
      ev({ method: 'POST', groups: '[owner]', path: '/admin/both', body, b64: true }),
    );
    expect(res.statusCode).toBe(200);
    expect(json(res).body).toEqual({ a: 1 });
  });

  it('límite por defecto de 262144 bytes', async () => {
    const { router } = setup();
    const big = JSON.stringify({ a: 'x'.repeat(262_144) });
    expect(
      (
        await router.handle(
          ev({ method: 'POST', groups: '[owner]', path: '/admin/both', body: big }),
        )
      ).statusCode,
    ).toBe(413);
  });

  it('JSON inválido -> 400 invalid_json', async () => {
    const { router, bothH } = setup();
    const res = await router.handle(
      ev({ method: 'POST', groups: '[owner]', path: '/admin/both', body: '{x' }),
    );
    expect(res.statusCode).toBe(400);
    expect(json(res)).toEqual({ error: 'invalid_json' });
    expect(bothH).not.toHaveBeenCalled();
  });

  it.each([undefined, ''])('cuerpo %j -> body undefined y no se parsea', async (body) => {
    const { router, bothH } = setup();
    await router.handle(ev({ method: 'POST', groups: '[owner]', path: '/admin/both', body }));
    expect(bothH.mock.calls[0]?.[0].body).toBeUndefined();
  });

  it('JSON válido llega al handler', async () => {
    const { router } = setup();
    const res = await router.handle(
      ev({ method: 'POST', groups: '[owner]', path: '/admin/both', body: '{"a":[1]}' }),
    );
    expect(json(res).body).toEqual({ a: [1] });
  });
});

describe('contexto del handler', () => {
  it('recibe userId, roles, requestId, query y log', async () => {
    const { router, bothH } = setup();
    await router.handle(
      ev({
        path: '/admin/both',
        groups: '[owner staff owner-x]',
        sub: 'u-9',
        query: { q: 'a', n: '2' },
      }),
    );
    const c = bothH.mock.calls[0]?.[0];
    expect(c).toMatchObject({
      userId: 'u-9',
      roles: ['owner', 'staff'],
      requestId: 'req-1',
      query: { q: 'a', n: '2' },
    });
    expect(typeof c?.log.info).toBe('function');
  });

  it('query ausente -> objeto vacío', async () => {
    const { router, bothH } = setup();
    await router.handle(ev({ path: '/admin/both', groups: '[owner]' }));
    expect(bothH.mock.calls[0]?.[0].query).toEqual({});
  });
});

describe('errores del handler', () => {
  it('HttpError -> su status y {error: code} (sin mensaje)', async () => {
    const { router } = setup();
    const res = await router.handle(ev({ path: '/admin/http-error', groups: '[owner]' }));
    expect(res.statusCode).toBe(409);
    expect(json(res)).toEqual({ error: 'conflict' });
  });

  it('error genérico -> 500 sin mensaje ni stack, con requestId; detalle solo en el log', async () => {
    const { router, lines } = setup();
    const res = await router.handle(ev({ path: '/admin/boom', groups: '[owner]' }));
    expect(res.statusCode).toBe(500);
    expect(json(res)).toEqual({ error: 'internal_error', requestId: 'req-1' });
    expect(res.body).not.toMatch(/secreto|stack|at /);
    const errLine = lines.map((l) => JSON.parse(l)).find((l) => l.level === 'error');
    expect(errLine).toBeDefined();
    expect(JSON.stringify(errLine)).toContain('secreto interno');
    expect(JSON.stringify(errLine)).not.toContain('juan@example.com');
  });

  it('el 500 no contiene el mensaje ni el stack del error original', async () => {
    const { router } = setup();
    const res = await router.handle(ev({ path: '/admin/boom', groups: '[owner]' }));
    expect(res.body).not.toContain('secreto interno');
    expect(res.body).not.toContain('router.test');
    expect(res.body).not.toContain('Error:');
  });

  it.each([200, 99, 600, 404.5, Number.NaN, 302])(
    'HttpError con status %s inválido -> 500',
    async (status) => {
      const router = createRouter([
        route('GET', '/admin/x', ['owner'], async () => {
          throw new HttpError(status, 'weird');
        }),
      ]);
      expect((await router.handle(ev({ groups: '[owner]' }))).statusCode).toBe(500);
    },
  );

  it('un throw que no es Error también da 500', async () => {
    const router = createRouter([
      route('GET', '/admin/x', ['owner'], async () => {
        throw 'cadena';
      }),
    ]);
    const res = await router.handle(ev({ groups: '[owner]' }));
    expect(res.statusCode).toBe(500);
  });
});

describe('construcción: route() y createRouter()', () => {
  const h: Handler = async () => jsonResponse(200, {});

  it('route() exige roles no vacíos y válidos en ejecución', () => {
    expect(() => route('GET', '/a', [] as never, h)).toThrow();
    expect(() => route('GET', '/a', 'owner' as never, h)).toThrow();
    expect(() => route('GET', '/a', undefined as never, h)).toThrow();
    expect(() => route('GET', '/a', ['admin'] as never, h)).toThrow();
    expect(() => route('GET', '/a', ['owner', 'OWNER'] as never, h)).toThrow();
    expect(() => route('GET', '/a', ['owner'], h)).not.toThrow();
  });

  it('el arreglo de roles queda congelado (no se puede ampliar después)', () => {
    const roles: ['owner'] = ['owner'];
    const r = route('GET', '/a', roles, h);
    roles.push('staff' as never);
    expect(r.roles).toEqual(['owner']);
  });

  it('rechaza rutas duplicadas (método + patrón)', () => {
    expect(() =>
      createRouter([route('GET', '/a', ['owner'], h), route('GET', '/a', ['staff'], h)]),
    ).toThrow(/duplicad/i);
  });

  it('rechaza duplicados equivalentes con distinto nombre de parámetro', () => {
    expect(() =>
      createRouter([
        route('GET', '/a/{id}', ['owner'], h),
        route('GET', '/a/{otro}', ['owner'], h),
      ]),
    ).toThrow(/duplicad/i);
  });

  it('el mismo patrón con otro método es válido', () => {
    expect(() =>
      createRouter([route('GET', '/a', ['owner'], h), route('POST', '/a', ['owner'], h)]),
    ).not.toThrow();
  });

  it.each([
    'a',
    '',
    '/a/*',
    '/a/{id',
    '/a/id}',
    '/a/{}',
    '/a/{i d}',
    '/a/x{id}',
    '/a/{id}/{id}',
    '/a//b',
    '/a/{proxy+}',
    '/a/**',
    '/a?x=1',
    '/a/{__proto__}',
  ])('rechaza el patrón inválido %j', (p) => {
    expect(() => createRouter([route('GET', p, ['owner'], h)])).toThrow();
  });

  it.each(['HEAD', 'OPTIONS', 'get', 'TRACE', ''])('rechaza el método %j', (m) => {
    expect(() => createRouter([route(m as never, '/a', ['owner'], h)])).toThrow();
  });

  it('rechaza maxBodyBytes inválido', () => {
    expect(() => createRouter([], { maxBodyBytes: 0 })).toThrow();
    expect(() => createRouter([], { maxBodyBytes: -1 })).toThrow();
    expect(() => createRouter([], { maxBodyBytes: Number.NaN })).toThrow();
  });
});

import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { describe, expect, it } from 'vitest';
import { mailSettings, publicSettings, quotingSettings } from './fixtures';
import { MemorySettingsRepository } from './memory-repository';
import { ConflictError } from '../repository';
import { createSettingsRouter } from '../routes';

type Ev = APIGatewayProxyEventV2WithJWTAuthorizer;

const NOW = new Date('2026-11-18T10:00:00.000Z');

interface Call {
  method?: string;
  path: string;
  groups?: string | undefined;
  body?: unknown;
  rawBody?: string;
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
    isBase64Encoded: false,
    body,
    requestContext: {
      requestId: 'req-1',
      http: { method: c.method ?? 'GET', path: c.path },
      authorizer: { jwt: { claims, scopes: [] } },
    },
  } as unknown as Ev;
}

function setup() {
  const repo = new MemorySettingsRepository();
  const lines: string[] = [];
  const router = createSettingsRouter(repo, { logSink: (l) => lines.push(l), now: () => NOW });
  const call = async (c: Call) => {
    const res = await router.handle(ev({ groups: '[owner]', ...c }));
    return {
      status: res.statusCode,
      text: res.body as string,
      json: JSON.parse(res.body as string),
    };
  };
  return { repo, lines, call };
}

const PUT_ROUTES = [
  ['/admin/settings/public', publicSettings],
  ['/admin/settings/mail', mailSettings],
  ['/admin/settings/quoting', quotingSettings],
] as const;

describe('matriz de roles por ruta', () => {
  it('sin rol o con un grupo desconocido: 403 en todas las rutas y el repositorio no se toca', async () => {
    const { repo, call } = setup();
    for (const groups of [undefined, '[]', '[owner-solo-lectura]', '[visitante]']) {
      expect((await call({ path: '/admin/settings', groups })).status, `GET ${groups}`).toBe(403);
      for (const [path, make] of PUT_ROUTES) {
        const r = await call({ method: 'PUT', path, groups, body: make() });
        expect(r.status, `PUT ${path} ${groups}`).toBe(403);
      }
    }
    expect(repo.calls).toEqual([]);
  });

  it('staff puede LEER', async () => {
    const { call } = setup();
    expect((await call({ path: '/admin/settings', groups: '[staff]' })).status).toBe(200);
  });

  it.each(PUT_ROUTES)(
    'staff NO puede escribir %s: 403 y el repositorio NO escribe',
    async (path, make) => {
      const { repo, call } = setup();
      const r = await call({ method: 'PUT', path, groups: '[staff]', body: make() });
      expect(r.status).toBe(403);
      expect(repo.calls).toEqual([]);
      expect(repo.audits).toEqual([]);
    },
  );

  it.each(PUT_ROUTES)('owner puede escribir %s', async (path, make) => {
    const { call } = setup();
    expect((await call({ method: 'PUT', path, body: make() })).status).toBe(200);
  });

  it('un grupo con ambos roles puede escribir (basta owner)', async () => {
    const { call } = setup();
    const r = await call({
      method: 'PUT',
      path: '/admin/settings/public',
      groups: '[staff owner]',
      body: publicSettings(),
    });
    expect(r.status).toBe(200);
  });
});

describe('rutas y métodos no declarados', () => {
  it.each([
    ['PUT', '/admin/settings'],
    ['POST', '/admin/settings'],
    ['DELETE', '/admin/settings'],
    ['PATCH', '/admin/settings'],
    ['GET', '/admin/settings/public'],
    ['GET', '/admin/settings/mail'],
    ['GET', '/admin/settings/quoting'],
    ['DELETE', '/admin/settings/quoting'],
    ['POST', '/admin/settings/quoting'],
    ['PUT', '/admin/settings/QUOTING'],
    ['POST', '/admin/settings/public'],
    ['DELETE', '/admin/settings/public'],
    ['DELETE', '/admin/settings/mail'],
    ['PUT', '/admin/settings/otra'],
    ['PUT', '/admin/settings/public/extra'],
    ['PUT', '/admin/settings/PUBLIC'],
    ['GET', '/admin/settings/otra'],
  ])('%s %s da 404 y no toca el repositorio', async (method, path) => {
    const { repo, call } = setup();
    const r = await call({ method, path, body: publicSettings() });
    expect(r.status).toBe(404);
    expect(repo.calls).toEqual([]);
  });
});

describe('GET /admin/settings', () => {
  it('sin filas: public y mail null; quoting con su valor por defecto (sin IVA)', async () => {
    const { call } = setup();
    const r = await call({ path: '/admin/settings' });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ public: null, mail: null, quoting: { ivaPctDefault: null } });
  });

  it('con fila QUOTING: la incluye (owner y staff la leen) sin `key`', async () => {
    const { repo, call } = setup();
    repo.seedRaw('QUOTING', { key: 'QUOTING', ...quotingSettings({ ivaPctDefault: 8 }) });
    for (const groups of ['[owner]', '[staff]']) {
      const r = await call({ path: '/admin/settings', groups });
      expect(r.json.quoting).toEqual({ ivaPctDefault: 8 });
      expect(r.text).not.toContain('"key"');
    }
  });

  it('fila QUOTING inválida: se trata como el valor por defecto (null), con warn sin valores y sin tumbar PUBLIC/MAIL', async () => {
    const { repo, lines, call } = setup();
    repo.seedRaw('PUBLIC', { key: 'PUBLIC', ...publicSettings() });
    repo.seedRaw('MAIL', { key: 'MAIL', ...mailSettings() });
    repo.seedRaw('QUOTING', { key: 'QUOTING', ivaPctDefault: 7, secreto: 'VALOR-RARO' });
    const r = await call({ path: '/admin/settings' });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({
      public: publicSettings(),
      mail: mailSettings(),
      quoting: { ivaPctDefault: null },
    });
    const warns = lines.map((l) => JSON.parse(l)).filter((l) => l.msg === 'invalid_stored_item');
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatchObject({ key: 'QUOTING' });
    expect(lines.join('\n')).not.toContain('VALOR-RARO');
  });

  it('con filas: devuelve los datos SIN el atributo `key`', async () => {
    const { repo, call } = setup();
    repo.seedRaw('PUBLIC', { key: 'PUBLIC', ...publicSettings() });
    repo.seedRaw('MAIL', { key: 'MAIL', ...mailSettings() });
    const r = await call({ path: '/admin/settings', groups: '[staff]' });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({
      public: publicSettings(),
      mail: mailSettings(),
      quoting: { ivaPctDefault: null },
    });
    expect(r.text).not.toContain('"key"');
    expect([...repo.calls].sort()).toEqual(['get:MAIL', 'get:PUBLIC', 'get:QUOTING']);
  });

  it('una fila ausente y otra presente: solo la ausente es null', async () => {
    const { repo, call } = setup();
    repo.seedRaw('MAIL', { key: 'MAIL', ...mailSettings() });
    const r = await call({ path: '/admin/settings' });
    expect(r.json).toEqual({
      public: null,
      mail: mailSettings(),
      quoting: { ivaPctDefault: null },
    });
  });

  it('una fila inválida da null y un warn SIN valores guardados', async () => {
    const { repo, lines, call } = setup();
    repo.seedRaw('PUBLIC', {
      key: 'PUBLIC',
      ...publicSettings({
        nombrePatio: 'PatioSecretoXYZ',
        whatsapp: 'VALOR-SECRETO-INVALIDO',
        extra: 'otro-secreto',
      }),
    });
    repo.seedRaw('MAIL', { key: 'MAIL', ...mailSettings() });
    const r = await call({ path: '/admin/settings' });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({
      public: null,
      mail: mailSettings(),
      quoting: { ivaPctDefault: null },
    });
    const warns = lines.map((l) => JSON.parse(l)).filter((l) => l.msg === 'invalid_stored_item');
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatchObject({ level: 'warn', requestId: 'req-1', key: 'PUBLIC' });
    const todo = lines.join('\n');
    expect(todo).not.toContain('PatioSecretoXYZ');
    expect(todo).not.toContain('VALOR-SECRETO-INVALIDO');
    expect(todo).not.toContain('otro-secreto');
    expect(r.text).not.toContain('VALOR-SECRETO-INVALIDO');
  });

  it('una fila con un atributo extra (fuera del esquema) se trata como inválida', async () => {
    const { repo, call } = setup();
    repo.seedRaw('MAIL', { key: 'MAIL', ...mailSettings(), interno: 'x' });
    expect((await call({ path: '/admin/settings' })).json).toEqual({
      public: null,
      mail: null,
      quoting: { ivaPctDefault: null },
    });
  });
});

describe('PUT: validación (422 sin eco de lo enviado)', () => {
  // [nombre, fila, cuerpo, texto enviado que NO debe volver en la respuesta]
  const malos: [string, string, Record<string, unknown>, string][] = [
    ['whatsapp con letras', 'public', publicSettings({ whatsapp: 'ABC-eco-1234567' }), 'ABC-eco'],
    ['whatsapp con +', 'public', publicSettings({ whatsapp: '+525512399999' }), '525512399999'],
    ['lat fuera de rango', 'public', publicSettings({ lat: 91.5 }), '91.5'],
    ['lng fuera de rango', 'public', publicSettings({ lng: -181.5 }), '181.5'],
    [
      'correo inválido',
      'public',
      publicSettings({ correoRemitente: 'no-es-correo-eco' }),
      'no-es-correo-eco',
    ],
    ['clave extra en public', 'public', { ...publicSettings(), claveExtra: 1 }, 'claveExtra'],
    ['clave extra en mail', 'mail', { ...mailSettings(), claveExtra: 1 }, 'claveExtra'],
    [
      'plantilla con {{desconocida}}',
      'mail',
      mailSettings({ plantillaCotizacion: 'Texto-privado {{desconocida}}' }),
      'Texto-privado',
    ],
    [
      'asunto con {{desconocida}}',
      'mail',
      mailSettings({ asuntoCotizacion: 'Texto-privado {{desconocida}}' }),
      'Texto-privado',
    ],
    ['IVA 7 %', 'quoting', { ivaPctDefault: 7 }, '7'],
    ['IVA 0', 'quoting', { ivaPctDefault: 0 }, '0'],
    ['IVA 16.0001', 'quoting', { ivaPctDefault: 16.0001 }, '16.0001'],
    ['IVA como texto', 'quoting', { ivaPctDefault: '16' }, 'ivaPctDefault":"16'],
    ['IVA ausente', 'quoting', {}, 'zzz'],
    ['clave extra en quoting', 'quoting', { ivaPctDefault: 16, claveExtra: 1 }, 'claveExtra'],
    [
      'llaves mal formadas',
      'mail',
      mailSettings({ plantillaCotizacion: 'Texto-privado {nombre} }' }),
      'Texto-privado',
    ],
  ];

  it.each(malos)('%s -> 422 sin escribir ni repetir lo enviado', async (_n, which, body, eco) => {
    const { repo, call } = setup();
    const r = await call({ method: 'PUT', path: `/admin/settings/${which}`, body });
    expect(r.status).toBe(422);
    expect(r.json.error).toBe('validation_error');
    expect(r.json.issues.length).toBeGreaterThan(0);
    for (const i of r.json.issues) {
      expect(Object.keys(i).sort()).toEqual(['message', 'path']);
    }
    expect(r.text).not.toContain(eco);
    expect(repo.audits).toEqual([]);
    expect(repo.calls.filter((c) => c.startsWith('put'))).toEqual([]);
  });

  it('una plantilla con variable desconocida se rechaza con la ruta del campo', async () => {
    const { call } = setup();
    const r = await call({
      method: 'PUT',
      path: '/admin/settings/mail',
      body: mailSettings({ plantillaCotizacion: 'Hola {{desconocida}}' }),
    });
    expect(r.status).toBe(422);
    expect(r.json.issues[0].path).toBe('plantillaCotizacion');
  });

  it('`__proto__` como propiedad propia se rechaza (422) sin escribir', async () => {
    const { repo, call } = setup();
    const r = await call({
      method: 'PUT',
      path: '/admin/settings/public',
      rawBody: `{"__proto__":{"admin":true},${JSON.stringify(publicSettings()).slice(1)}`,
    });
    expect(r.status).toBe(422);
    expect(repo.audits).toEqual([]);
  });

  it('cuerpo ausente o que no es un objeto -> 422; JSON roto -> 400', async () => {
    const { repo, call } = setup();
    expect((await call({ method: 'PUT', path: '/admin/settings/mail' })).status).toBe(422);
    expect((await call({ method: 'PUT', path: '/admin/settings/mail', body: [1] })).status).toBe(
      422,
    );
    expect(
      (await call({ method: 'PUT', path: '/admin/settings/mail', rawBody: '{x' })).status,
    ).toBe(400);
    expect(repo.audits).toEqual([]);
  });
});

describe('PUT: escritura', () => {
  it('PUT /public escribe SOLO la fila PUBLIC y devuelve los datos sin `key`', async () => {
    const { repo, call } = setup();
    const r = await call({ method: 'PUT', path: '/admin/settings/public', body: publicSettings() });
    expect(r.status).toBe(200);
    expect(r.json).toEqual(publicSettings());
    expect(r.text).not.toContain('"key"');
    expect(repo.calls.filter((c) => c.startsWith('put'))).toEqual(['put:PUBLIC']);
    expect(await repo.get('MAIL')).toBeNull();
    expect(await repo.get('PUBLIC')).toEqual({ key: 'PUBLIC', ...publicSettings() });
  });

  it('PUT /mail escribe SOLO la fila MAIL', async () => {
    const { repo, call } = setup();
    const r = await call({ method: 'PUT', path: '/admin/settings/mail', body: mailSettings() });
    expect(r.status).toBe(200);
    expect(r.json).toEqual(mailSettings());
    expect(repo.calls.filter((c) => c.startsWith('put'))).toEqual(['put:MAIL']);
    expect(await repo.get('PUBLIC')).toBeNull();
    expect(await repo.get('MAIL')).toEqual({ key: 'MAIL', ...mailSettings() });
  });

  it('la primera vez audita `create` con antes=null; la segunda `update` con el antes correcto', async () => {
    const { repo, call } = setup();
    const v1 = publicSettings();
    const v2 = publicSettings({ nombrePatio: 'Otro patio' });
    await call({ method: 'PUT', path: '/admin/settings/public', body: v1 });
    await call({ method: 'PUT', path: '/admin/settings/public', body: v2 });
    expect(repo.audits).toHaveLength(2);
    expect(repo.audits[0]).toMatchObject({ accion: 'create', antes: null, despues: v1 });
    expect(repo.audits[1]).toMatchObject({ accion: 'update', antes: v1, despues: v2 });
    expect(JSON.stringify(repo.audits[1]?.antes)).not.toContain('"key"');
  });

  it('upsert sobre una fila sembrada: update, `antes` sin `key`', async () => {
    const { repo, call } = setup();
    repo.seedRaw('MAIL', { key: 'MAIL', ...mailSettings() });
    const nuevo = mailSettings({ asuntoCotizacion: 'Nuevo {{folio}}' });
    await call({ method: 'PUT', path: '/admin/settings/mail', body: nuevo });
    expect(repo.audits[0]).toMatchObject({
      accion: 'update',
      antes: mailSettings(),
      despues: nuevo,
    });
  });

  it('forma exacta de la auditoría: pk, sk, userId, acción', async () => {
    const { repo, call } = setup();
    await call({ method: 'PUT', path: '/admin/settings/public', body: publicSettings() });
    await call({ method: 'PUT', path: '/admin/settings/mail', body: mailSettings() });
    expect(repo.audits[0]).toEqual({
      pk: 'ENTITY#settings#public',
      sk: '2026-11-18T10:00:00.000Z#req-1',
      userId: 'user-1',
      accion: 'create',
      antes: null,
      despues: publicSettings(),
      scope: 'CATALOG',
    });
    expect(repo.audits[1]).toMatchObject({ pk: 'ENTITY#settings#mail', accion: 'create' });
    // La fila MAIL no se publica: su auditoría no entra al índice de cambios pendientes.
    expect(repo.audits[1]).not.toHaveProperty('scope');
  });

  it('lee la fila previa ANTES de escribir (para decidir create/update)', async () => {
    const { repo, call } = setup();
    await call({ method: 'PUT', path: '/admin/settings/public', body: publicSettings() });
    expect(repo.calls).toEqual(['get:PUBLIC', 'put:PUBLIC']);
  });

  it('si la fila previa existe pero es inválida, se corrige con PUT y `antes` la conserva sin `key`', async () => {
    const { repo, call } = setup();
    repo.seedRaw('PUBLIC', { key: 'PUBLIC', whatsapp: 'basura' });
    const r = await call({ method: 'PUT', path: '/admin/settings/public', body: publicSettings() });
    expect(r.status).toBe(200);
    expect(repo.audits[0]).toMatchObject({ accion: 'update', antes: { whatsapp: 'basura' } });
  });
});

describe('PUT /admin/settings/quoting', () => {
  it.each([null, 8, 16])('owner guarda ivaPctDefault %s en la fila QUOTING', async (v) => {
    const { repo, call } = setup();
    const r = await call({
      method: 'PUT',
      path: '/admin/settings/quoting',
      body: { ivaPctDefault: v },
    });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ivaPctDefault: v });
    expect(repo.calls.filter((c) => c.startsWith('put'))).toEqual(['put:QUOTING']);
    expect(await repo.get('QUOTING')).toEqual({ key: 'QUOTING', ivaPctDefault: v });
    expect(await repo.get('PUBLIC')).toBeNull();
  });

  it('staff recibe 403 y no se escribe nada ni se audita', async () => {
    const { repo, call } = setup();
    const r = await call({
      method: 'PUT',
      path: '/admin/settings/quoting',
      groups: '[staff]',
      body: { ivaPctDefault: 16 },
    });
    expect(r.status).toBe(403);
    expect(repo.calls).toEqual([]);
    expect(repo.audits).toEqual([]);
  });

  it('audita con forma exacta y SIN scope CATALOG (no se publica)', async () => {
    const { repo, call } = setup();
    await call({ method: 'PUT', path: '/admin/settings/quoting', body: { ivaPctDefault: 16 } });
    await call({ method: 'PUT', path: '/admin/settings/quoting', body: { ivaPctDefault: 8 } });
    expect(repo.audits[0]).toEqual({
      pk: 'ENTITY#settings#quoting',
      sk: '2026-11-18T10:00:00.000Z#req-1',
      userId: 'user-1',
      accion: 'create',
      antes: null,
      despues: { ivaPctDefault: 16 },
    });
    expect(repo.audits[1]).toMatchObject({
      accion: 'update',
      antes: { ivaPctDefault: 16 },
      despues: { ivaPctDefault: 8 },
    });
    expect(repo.audits[0]).not.toHaveProperty('scope');
  });

  it('`__proto__` como propiedad propia se rechaza (422)', async () => {
    const { repo, call } = setup();
    const r = await call({
      method: 'PUT',
      path: '/admin/settings/quoting',
      rawBody: '{"__proto__":{"admin":true},"ivaPctDefault":16}',
    });
    expect(r.status).toBe(422);
    expect(repo.audits).toEqual([]);
  });
});

describe('PUT: errores de la transacción', () => {
  it('ConflictError -> 409 conflict', async () => {
    const { repo, call } = setup();
    repo.putError = new ConflictError();
    const r = await call({ method: 'PUT', path: '/admin/settings/public', body: publicSettings() });
    expect(r.status).toBe(409);
    expect(r.json).toEqual({ error: 'conflict' });
  });

  it('cualquier otro error -> 500 genérico sin detalles internos', async () => {
    const { repo, call } = setup();
    repo.putError = new Error('detalle-interno-secreto');
    const r = await call({ method: 'PUT', path: '/admin/settings/mail', body: mailSettings() });
    expect(r.status).toBe(500);
    expect(r.json.error).toBe('internal_error');
    expect(r.text).not.toContain('detalle-interno-secreto');
  });
});

describe('logs sin datos del negocio ni PII', () => {
  it('los valores de WhatsApp, correo y demás campos no aparecen en el sink de logs (GET, PUT, errores)', async () => {
    const { repo, lines, call } = setup();
    // `nombrePatio` va primero: ningún enmascarado del logger lo oculta por casualidad.
    const pub = publicSettings({
      nombrePatio: 'PatioSecretoXYZ',
      whatsapp: '529998887766',
      correoRemitente: 'unico-xyz@ejemplo.test',
    });
    await call({ method: 'PUT', path: '/admin/settings/public', body: pub });
    await call({ method: 'PUT', path: '/admin/settings/public', body: { ...pub, whatsapp: 'x' } });
    await call({ path: '/admin/settings' });
    repo.putError = new ConflictError();
    await call({ method: 'PUT', path: '/admin/settings/public', body: pub });
    repo.putError = new Error('fallo con 529998887766');
    await call({ method: 'PUT', path: '/admin/settings/public', body: pub });
    const mail = mailSettings({ asuntoCotizacion: 'AsuntoSecretoXYZ {{folio}}' });
    await call({ method: 'PUT', path: '/admin/settings/mail', body: mail });
    const todo = lines.join('\n');
    expect(lines.length).toBeGreaterThan(0);
    for (const secreto of ['PatioSecretoXYZ', '529998887766', 'unico-xyz', 'AsuntoSecretoXYZ']) {
      expect(todo, secreto).not.toContain(secreto);
    }
  });

  it('el log de escritura trae entidad, acción y usuario', async () => {
    const { lines, call } = setup();
    await call({ method: 'PUT', path: '/admin/settings/mail', body: mailSettings() });
    const w = lines.map((l) => JSON.parse(l)).find((l) => l.msg === 'settings_write');
    expect(w).toMatchObject({ level: 'info', entity: 'settings', id: 'mail', action: 'create' });
  });
});

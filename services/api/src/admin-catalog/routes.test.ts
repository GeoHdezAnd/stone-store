import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { describe, expect, it } from 'vitest';
import { ENTITIES, ENTITY_NAMES, type EntityName } from './entities';
import { finish, project, service, stone } from './fixtures';
import { MemoryCatalogRepository } from './memory-repository';
import { createCatalogRouter } from './routes';
import { encodeCursor } from './cursor';
import { ConflictError } from './repository';

type Ev = APIGatewayProxyEventV2WithJWTAuthorizer;

const NOW = new Date('2026-11-18T10:00:00.000Z');
const valid = { stone, project, finish, service } as const;

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
    queryStringParameters: c.query,
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
  const repo = new MemoryCatalogRepository();
  const lines: string[] = [];
  const router = createCatalogRouter(repo, { logSink: (l) => lines.push(l), now: () => NOW });
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

const seg = (n: EntityName) => ENTITIES[n].segment;

describe('matriz de roles por ruta', () => {
  it.each(ENTITY_NAMES)(
    '%s: sin rol o con un grupo desconocido da 403 y no toca el repositorio',
    async (n) => {
      const { repo, call } = setup();
      const id = valid[n]().id as string;
      for (const groups of [undefined, '[]', '[owner-solo-lectura]', '[visitante]']) {
        for (const [method, path] of [
          ['GET', `/admin/${seg(n)}`],
          ['GET', `/admin/${seg(n)}/${id}`],
          ['POST', `/admin/${seg(n)}`],
          ['PUT', `/admin/${seg(n)}/${id}`],
          ['DELETE', `/admin/${seg(n)}/${id}`],
        ] as const) {
          const r = await call({ method, path, groups, body: valid[n]() });
          expect(r.status, `${method} ${path} ${groups}`).toBe(403);
        }
      }
      expect(repo.calls).toEqual([]);
    },
  );

  it.each(ENTITY_NAMES)('%s: staff puede listar, leer, crear y reemplazar', async (n) => {
    const { call } = setup();
    const id = valid[n]().id as string;
    const g = '[staff]';
    expect((await call({ path: `/admin/${seg(n)}`, groups: g })).status).toBe(200);
    expect(
      (await call({ method: 'POST', path: `/admin/${seg(n)}`, groups: g, body: valid[n]() }))
        .status,
    ).toBe(201);
    expect((await call({ path: `/admin/${seg(n)}/${id}`, groups: g })).status).toBe(200);
    expect(
      (await call({ method: 'PUT', path: `/admin/${seg(n)}/${id}`, groups: g, body: valid[n]() }))
        .status,
    ).toBe(200);
  });

  it.each(ENTITY_NAMES)(
    '%s: staff NO puede hacer DELETE (403) y el repositorio no se invoca',
    async (n) => {
      const { repo, call } = setup();
      const id = valid[n]().id as string;
      await call({ method: 'POST', path: `/admin/${seg(n)}`, body: valid[n]() });
      repo.calls.length = 0;
      const r = await call({ method: 'DELETE', path: `/admin/${seg(n)}/${id}`, groups: '[staff]' });
      expect(r.status).toBe(403);
      expect(repo.calls).toEqual([]);
      expect(repo.audits).toHaveLength(1); // solo la de creación
    },
  );

  it.each(ENTITY_NAMES)('%s: owner sí puede hacer DELETE (baja lógica)', async (n) => {
    const { call } = setup();
    const id = valid[n]().id as string;
    await call({ method: 'POST', path: `/admin/${seg(n)}`, body: valid[n]() });
    const r = await call({ method: 'DELETE', path: `/admin/${seg(n)}/${id}`, groups: '[owner]' });
    expect(r.status).toBe(200);
    expect(r.json.activa).toBe(false);
  });
});

describe('crear (POST)', () => {
  it.each(ENTITY_NAMES)('%s: responde 201 con la entidad', async (n) => {
    const { call } = setup();
    const r = await call({ method: 'POST', path: `/admin/${seg(n)}`, body: valid[n]() });
    expect(r.status).toBe(201);
    expect(r.json).toEqual(valid[n]());
  });

  it('duplicado da 409 already_exists', async () => {
    const { call } = setup();
    await call({ method: 'POST', path: '/admin/finishes', body: finish() });
    const r = await call({ method: 'POST', path: '/admin/finishes', body: finish() });
    expect(r.status).toBe(409);
    expect(r.json).toEqual({ error: 'already_exists' });
  });

  it('campos extra dan 422 validation_error y no se reproduce el valor enviado', async () => {
    const { repo, call } = setup();
    const r = await call({
      method: 'POST',
      path: '/admin/finishes',
      body: { ...finish(), secreto: 'VALOR-SECRETO-123' },
    });
    expect(r.status).toBe(422);
    expect(r.json.error).toBe('validation_error');
    expect(r.json.issues.length).toBeGreaterThan(0);
    expect(r.text).not.toContain('VALOR-SECRETO-123');
    expect(r.text).not.toContain('secreto');
    expect(repo.calls).toEqual([]);
  });

  it('tipos incorrectos: issues con path y mensaje en español, sin eco del valor', async () => {
    const { call } = setup();
    const r = await call({
      method: 'POST',
      path: '/admin/projects',
      body: project({
        categoria: 'ZZZ-INVALIDA',
        anio: 'ZZZ-TEXTO',
        piedras: ['A B'],
        testimonio: { texto: '', autor: 'x' },
      }),
    });
    expect(r.status).toBe(422);
    const paths = r.json.issues.map((i: { path: string }) => i.path);
    expect(paths).toEqual(
      expect.arrayContaining(['categoria', 'anio', 'piedras[0]', 'testimonio.texto']),
    );
    for (const i of r.json.issues) {
      expect(Object.keys(i).sort()).toEqual(['message', 'path']);
      expect(typeof i.message).toBe('string');
    }
    expect(r.text).not.toContain('ZZZ-INVALIDA');
    expect(r.text).not.toContain('ZZZ-TEXTO');
  });

  it('cuerpo ausente o que no es objeto da 422', async () => {
    const { call } = setup();
    for (const body of [undefined, [], 'texto', 5, null]) {
      const r = await call({ method: 'POST', path: '/admin/services', body });
      expect(r.status, JSON.stringify(body)).toBe(422);
      expect(r.json.error).toBe('validation_error');
    }
  });

  it('un cuerpo con __proto__ se rechaza y no contamina el prototipo', async () => {
    const { repo, call } = setup();
    const raw = JSON.stringify(service()).replace('{', '{"__proto__":{"polluted":true},');
    const r = await call({ method: 'POST', path: '/admin/services', rawBody: raw });
    expect(r.status).toBe(422);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(r.text).not.toContain('__proto__');
    expect(repo.calls).toEqual([]);
  });

  it('JSON inválido lo rechaza el router con 400', async () => {
    const { call } = setup();
    const r = await call({ method: 'POST', path: '/admin/services', rawBody: '{no' });
    expect(r.status).toBe(400);
  });
});

describe('referencias', () => {
  it('project con piedra inexistente da 422 invalid_reference', async () => {
    const { call } = setup();
    const r = await call({
      method: 'POST',
      path: '/admin/projects',
      body: project({ piedras: ['no-hay'] }),
    });
    expect(r.status).toBe(422);
    expect(r.json).toEqual({ error: 'invalid_reference', field: 'piedras', ids: ['no-hay'] });
  });

  it('project con acabado inexistente da 422 invalid_reference', async () => {
    const { call } = setup();
    await call({ method: 'POST', path: '/admin/stones', body: stone() });
    const r = await call({
      method: 'POST',
      path: '/admin/projects',
      body: project({ piedras: ['arenisca'], acabados: ['labrado', 'cincelado'] }),
    });
    expect(r.status).toBe(422);
    expect(r.json).toEqual({
      error: 'invalid_reference',
      field: 'acabados',
      ids: ['labrado', 'cincelado'],
    });
  });

  it('stone con proyecto relacionado inexistente da 422 (también en PUT)', async () => {
    const { call } = setup();
    const post = await call({
      method: 'POST',
      path: '/admin/stones',
      body: stone({ proyectosRelacionados: ['x'] }),
    });
    expect(post.status).toBe(422);
    expect(post.json).toEqual({
      error: 'invalid_reference',
      field: 'proyectosRelacionados',
      ids: ['x'],
    });
    await call({ method: 'POST', path: '/admin/stones', body: stone() });
    const put = await call({
      method: 'PUT',
      path: '/admin/stones/arenisca',
      body: stone({ proyectosRelacionados: ['x'] }),
    });
    expect(put.status).toBe(422);
    expect(put.json.error).toBe('invalid_reference');
  });

  it('las referencias existentes pasan; stone.acabados (nombres libres) no se comprueban', async () => {
    const { call } = setup();
    expect(
      (
        await call({
          method: 'POST',
          path: '/admin/stones',
          body: stone({ acabados: ['Nombre que no existe'] }),
        })
      ).status,
    ).toBe(201);
    await call({ method: 'POST', path: '/admin/finishes', body: finish({ id: 'labrado' }) });
    const r = await call({
      method: 'POST',
      path: '/admin/projects',
      body: project({ piedras: ['arenisca'], acabados: ['labrado'] }),
    });
    expect(r.status).toBe(201);
    const back = await call({
      method: 'PUT',
      path: '/admin/stones/arenisca',
      body: stone({ proyectosRelacionados: ['casa-tepeyahualco'] }),
    });
    expect(back.status).toBe(200);
  });
});

describe('reemplazar (PUT)', () => {
  it('id de la ruta distinto del cuerpo da 400 id_mismatch', async () => {
    const { repo, call } = setup();
    const r = await call({ method: 'PUT', path: '/admin/stones/otra', body: stone() });
    expect(r.status).toBe(400);
    expect(r.json).toEqual({ error: 'id_mismatch' });
    expect(repo.calls).toEqual([]);
  });

  it('inexistente da 404 not_found', async () => {
    const { call } = setup();
    const r = await call({ method: 'PUT', path: '/admin/stones/arenisca', body: stone() });
    expect(r.status).toBe(404);
    expect(r.json).toEqual({ error: 'not_found' });
  });

  it('reemplaza y audita con antes = actual y después = nuevo', async () => {
    const { repo, call } = setup();
    await call({ method: 'POST', path: '/admin/services', body: service() });
    const nuevo = service({ titulo: 'Otro título' });
    const r = await call({ method: 'PUT', path: '/admin/services/piedra-en-bruto', body: nuevo });
    expect(r.status).toBe(200);
    expect(r.json).toEqual(nuevo);
    expect(repo.audits[1]).toEqual({
      pk: 'ENTITY#service#piedra-en-bruto',
      sk: '2026-11-18T10:00:00.000Z#req-1',
      userId: 'user-1',
      accion: 'update',
      antes: service(),
      despues: nuevo,
    });
  });

  it('valida el cuerpo igual que POST (422)', async () => {
    const { call } = setup();
    await call({ method: 'POST', path: '/admin/services', body: service() });
    const r = await call({
      method: 'PUT',
      path: '/admin/services/piedra-en-bruto',
      body: { ...service(), extra: 1 },
    });
    expect(r.status).toBe(422);
  });

  it('un item guardado inválido se puede corregir con PUT', async () => {
    const { repo, call } = setup();
    repo.seedRaw('service', { id: 'piedra-en-bruto', roto: true });
    const r = await call({
      method: 'PUT',
      path: '/admin/services/piedra-en-bruto',
      body: service(),
    });
    expect(r.status).toBe(200);
  });
});

describe('baja lógica (DELETE)', () => {
  it('pone activa=false, audita y el repositorio no tiene ni usa un borrado físico', async () => {
    const { repo, call } = setup();
    await call({ method: 'POST', path: '/admin/finishes', body: finish() });
    const r = await call({ method: 'DELETE', path: '/admin/finishes/apomazado' });
    expect(r.status).toBe(200);
    expect(r.json).toEqual(finish({ activa: false }));
    expect((await call({ path: '/admin/finishes/apomazado' })).json.activa).toBe(false);
    expect(repo.calls).not.toContain('delete');
    expect(repo.audits[1]).toEqual({
      pk: 'ENTITY#finish#apomazado',
      sk: '2026-11-18T10:00:00.000Z#req-1',
      userId: 'user-1',
      accion: 'delete',
      antes: finish(),
      despues: finish({ activa: false }),
    });
  });

  it('es idempotente: si ya estaba inactiva devuelve 200 sin escribir de nuevo', async () => {
    const { repo, call } = setup();
    await call({ method: 'POST', path: '/admin/finishes', body: finish({ activa: false }) });
    const antes = repo.calls.length;
    const r = await call({ method: 'DELETE', path: '/admin/finishes/apomazado' });
    expect(r.status).toBe(200);
    expect(r.json.activa).toBe(false);
    expect(repo.calls.slice(antes)).not.toContain('softDelete');
    expect(repo.audits).toHaveLength(1);
  });

  it('inexistente da 404', async () => {
    const { call } = setup();
    expect((await call({ method: 'DELETE', path: '/admin/finishes/nada' })).status).toBe(404);
  });
});

describe('leer (GET /{id})', () => {
  it('inexistente da 404', async () => {
    const { call } = setup();
    expect((await call({ path: '/admin/stones/nada' })).status).toBe(404);
  });

  it('un item guardado que no valida da 500 sin filtrar detalles', async () => {
    const { repo, call } = setup();
    repo.seedRaw('stone', { id: 'roto', nombre: 'DATO-INTERNO' });
    const r = await call({ path: '/admin/stones/roto' });
    expect(r.status).toBe(500);
    expect(r.text).not.toContain('DATO-INTERNO');
  });

  it('ids que pasan el router pero no son slugs dan 400 invalid_path', async () => {
    const { repo, call } = setup();
    for (const id of ['ABC', 'a.b', 'a_b', 'a--b']) {
      for (const method of ['GET', 'DELETE'] as const) {
        const r = await call({ method, path: `/admin/stones/${id}` });
        expect(r.status, `${method} ${id}`).toBe(400);
        expect(r.json).toEqual({ error: 'invalid_path' });
      }
      const put = await call({ method: 'PUT', path: `/admin/stones/${id}`, body: stone() });
      expect(put.status).toBe(400);
      expect(put.json).toEqual({ error: 'invalid_path' });
    }
    expect(repo.calls).toEqual([]);
  });
});

describe('listar (GET)', () => {
  async function seeded(n = 5) {
    const s = setup();
    for (let i = 0; i < n; i++) {
      s.repo.seedRaw('service', service({ id: `s${i}` }));
    }
    s.repo.calls.length = 0;
    return s;
  }

  it('pagina con limit y la última página trae nextCursor null', async () => {
    const { call } = await seeded(5);
    const p1 = await call({ path: '/admin/services', query: { limit: '2' } });
    expect(p1.status).toBe(200);
    expect(p1.json.items.map((i: { id: string }) => i.id)).toEqual(['s0', 's1']);
    expect(typeof p1.json.nextCursor).toBe('string');
    const p2 = await call({
      path: '/admin/services',
      query: { limit: '2', cursor: p1.json.nextCursor },
    });
    expect(p2.json.items.map((i: { id: string }) => i.id)).toEqual(['s2', 's3']);
    const p3 = await call({
      path: '/admin/services',
      query: { limit: '2', cursor: p2.json.nextCursor },
    });
    expect(p3.json.items.map((i: { id: string }) => i.id)).toEqual(['s4']);
    expect(p3.json.nextCursor).toBeNull();
  });

  it('limit por defecto 25', async () => {
    const { call } = await seeded(30);
    const r = await call({ path: '/admin/services' });
    expect(r.json.items).toHaveLength(25);
    expect(r.json.nextCursor).not.toBeNull();
  });

  it.each(['0', '51', 'abc', '1.5', '-1', '', ' 5', '5e1', '0x5'])(
    'limit %j da 400 invalid_query',
    async (limit) => {
      const { repo, call } = await seeded(1);
      const r = await call({ path: '/admin/services', query: { limit } });
      expect(r.status).toBe(400);
      expect(r.json).toEqual({ error: 'invalid_query' });
      expect(repo.calls).toEqual([]);
    },
  );

  it('limit en los extremos válidos (1 y 50)', async () => {
    const { call } = await seeded(3);
    expect((await call({ path: '/admin/services', query: { limit: '1' } })).status).toBe(200);
    expect((await call({ path: '/admin/services', query: { limit: '50' } })).status).toBe(200);
  });

  const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
  it.each([
    ['base64 inválido', '!!!'],
    ['JSON inválido', b64('no json')],
    ['clave extra', b64('{"id":"a","extra":1}')],
    ['id con ../', b64('{"id":"../x"}')],
    ['id con mayúsculas', b64('{"id":"ABC"}')],
    ['no es objeto', b64('[1]')],
    ['cursor vacío', ''],
  ])('cursor inválido (%s) da 400 invalid_cursor y no llega a DynamoDB', async (_n, cursor) => {
    const { repo, call } = await seeded(2);
    const r = await call({ path: '/admin/services', query: { cursor } });
    expect(r.status).toBe(400);
    expect(r.json).toEqual({ error: 'invalid_cursor' });
    expect(repo.calls).toEqual([]);
  });

  it('un cursor válido sí se usa', async () => {
    const { call } = await seeded(3);
    const r = await call({ path: '/admin/services', query: { cursor: encodeCursor('s0') } });
    expect(r.json.items.map((i: { id: string }) => i.id)).toEqual(['s1', 's2']);
  });

  it('omite y registra (sin PII) los items guardados que no validan', async () => {
    const { repo, lines, call } = await seeded(1);
    repo.seedRaw('service', { id: 'roto', titulo: 'TITULO-INTERNO', correo: 'a@b.com' });
    const r = await call({ path: '/admin/services' });
    expect(r.json.items.map((i: { id: string }) => i.id)).toEqual(['s0']);
    const warn = lines.map((l) => JSON.parse(l)).find((l) => l.msg === 'invalid_stored_item');
    expect(warn).toMatchObject({ level: 'warn', entity: 'service', id: 'roto' });
    expect(lines.join('\n')).not.toContain('TITULO-INTERNO');
  });
});

describe('auditoría y logs', () => {
  it('create audita antes null y después la entidad completa', async () => {
    const { repo, call } = setup();
    await call({ method: 'POST', path: '/admin/stones', body: stone() });
    expect(repo.audits).toEqual([
      {
        pk: 'ENTITY#stone#arenisca',
        sk: '2026-11-18T10:00:00.000Z#req-1',
        userId: 'user-1',
        accion: 'create',
        antes: null,
        despues: stone(),
      },
    ]);
  });

  it('registra la escritura con ids y sub, sin el cuerpo', async () => {
    const { lines, call } = setup();
    await call({
      method: 'POST',
      path: '/admin/services',
      body: service({ descripcion: 'TEXTO-LARGO-PRIVADO' }),
    });
    const log = lines.map((l) => JSON.parse(l)).find((l) => l.msg === 'catalog_write');
    expect(log).toMatchObject({
      entity: 'service',
      id: 'piedra-en-bruto',
      action: 'create',
      userId: 'user-1',
    });
    expect(lines.join('\n')).not.toContain('TEXTO-LARGO-PRIVADO');
  });

  it('un error inesperado del repositorio da 500 genérico', async () => {
    const { repo, call } = setup();
    repo.create = async () => {
      throw new Error('detalle interno secreto');
    };
    const r = await call({ method: 'POST', path: '/admin/services', body: service() });
    expect(r.status).toBe(500);
    expect(r.text).not.toContain('secreto');
  });
});

describe('activa: solo owner da de baja, reactiva o crea inactivo', () => {
  const STAFF = '[staff]';

  it.each(ENTITY_NAMES)(
    '%s: staff PUT con activa distinta da 403 y no se escribe nada',
    async (n) => {
      const { repo, call } = setup();
      const id = valid[n]().id as string;
      await call({ method: 'POST', path: `/admin/${seg(n)}`, body: valid[n]() });
      const writes = repo.audits.length;
      repo.calls.length = 0;
      const r = await call({
        method: 'PUT',
        path: `/admin/${seg(n)}/${id}`,
        groups: STAFF,
        body: valid[n]({ activa: false }),
      });
      expect(r.status).toBe(403);
      expect(r.json).toEqual({ error: 'forbidden' });
      expect(repo.calls).not.toContain('replace');
      expect(repo.audits).toHaveLength(writes);
      expect((await call({ path: `/admin/${seg(n)}/${id}` })).json.activa).toBe(true);
    },
  );

  it.each(ENTITY_NAMES)('%s: staff PUT con la misma activa da 200', async (n) => {
    const { call } = setup();
    const id = valid[n]().id as string;
    await call({ method: 'POST', path: `/admin/${seg(n)}`, body: valid[n]() });
    const r = await call({
      method: 'PUT',
      path: `/admin/${seg(n)}/${id}`,
      groups: STAFF,
      body: valid[n](),
    });
    expect(r.status).toBe(200);
  });

  it.each(ENTITY_NAMES)(
    '%s: staff POST con activa:false da 403; con activa:true, 201',
    async (n) => {
      const { repo, call } = setup();
      const r = await call({
        method: 'POST',
        path: `/admin/${seg(n)}`,
        groups: STAFF,
        body: valid[n]({ activa: false }),
      });
      expect(r.status).toBe(403);
      expect(r.json).toEqual({ error: 'forbidden' });
      expect(repo.calls).not.toContain('create');
      const ok = await call({
        method: 'POST',
        path: `/admin/${seg(n)}`,
        groups: STAFF,
        body: valid[n](),
      });
      expect(ok.status).toBe(201);
    },
  );

  it.each(ENTITY_NAMES)(
    '%s: owner puede crear inactivo y cambiar activa por PUT (auditoría update)',
    async (n) => {
      const { repo, call } = setup();
      const id = valid[n]().id as string;
      const p = await call({
        method: 'POST',
        path: `/admin/${seg(n)}`,
        body: valid[n]({ activa: false }),
      });
      expect(p.status).toBe(201);
      const up = await call({ method: 'PUT', path: `/admin/${seg(n)}/${id}`, body: valid[n]() });
      expect(up.status).toBe(200);
      expect(up.json.activa).toBe(true);
      const down = await call({
        method: 'PUT',
        path: `/admin/${seg(n)}/${id}`,
        body: valid[n]({ activa: false }),
      });
      expect(down.status).toBe(200);
      expect(repo.audits.map((a) => a.accion)).toEqual(['create', 'update', 'update']);
    },
  );

  it.each(ENTITY_NAMES)(
    '%s: owner DELETE y luego staff PUT {activa:true} da 403 y sigue inactivo',
    async (n) => {
      const { call } = setup();
      const id = valid[n]().id as string;
      await call({ method: 'POST', path: `/admin/${seg(n)}`, body: valid[n]() });
      await call({ method: 'DELETE', path: `/admin/${seg(n)}/${id}` });
      const r = await call({
        method: 'PUT',
        path: `/admin/${seg(n)}/${id}`,
        groups: STAFF,
        body: valid[n](),
      });
      expect(r.status).toBe(403);
      expect((await call({ path: `/admin/${seg(n)}/${id}` })).json.activa).toBe(false);
    },
  );
});

describe('DELETE no filtra atributos fuera del esquema', () => {
  it('con un atributo extra guardado responde 500 genérico, sin el valor y sin escribir', async () => {
    const { repo, call } = setup();
    repo.seedRaw('finish', { ...finish(), secretoInterno: 'VALOR-INTERNO' });
    const r = await call({ method: 'DELETE', path: '/admin/finishes/apomazado' });
    expect(r.status).toBe(500);
    expect(r.text).not.toContain('VALOR-INTERNO');
    expect(repo.calls).not.toContain('softDelete');
  });

  it('también en la rama idempotente (ya inactivo)', async () => {
    const { repo, call } = setup();
    repo.seedRaw('finish', { ...finish({ activa: false }), secretoInterno: 'VALOR-INTERNO' });
    const r = await call({ method: 'DELETE', path: '/admin/finishes/apomazado' });
    expect(r.status).toBe(500);
    expect(r.text).not.toContain('VALOR-INTERNO');
  });
});

describe('conflicto de transacción', () => {
  it('ConflictError del repositorio da 409 conflict en POST, PUT y DELETE', async () => {
    const { repo, call } = setup();
    await call({ method: 'POST', path: '/admin/services', body: service() });
    const boom = async () => {
      throw new ConflictError();
    };
    repo.create = boom;
    repo.replace = boom;
    repo.softDelete = boom;
    for (const [method, path] of [
      ['POST', '/admin/services'],
      ['PUT', '/admin/services/piedra-en-bruto'],
      ['DELETE', '/admin/services/piedra-en-bruto'],
    ] as const) {
      const r = await call({
        method,
        path,
        body: service({ id: path.endsWith('bruto') ? 'piedra-en-bruto' : 'otro-id' }),
      });
      expect(r.status, method).toBe(409);
      expect(r.json).toEqual({ error: 'conflict' });
    }
  });
});

describe('las fotos deben pertenecer a la entidad (422)', () => {
  const UUID = '3f2b8c1e-9a4d-4e6b-8c7a-1d2e3f4a5b6c';
  const casos = [
    [
      'stones',
      'stone',
      { fotos: [`stones/otra/${UUID}.jpg`] },
      { fotos: [`stones/arenisca/${UUID}.jpg`] },
    ],
    [
      'projects',
      'project',
      { fotos: [`projects/otro/${UUID}.jpg`] },
      { fotos: [`projects/casa-tepeyahualco/${UUID}.jpg`] },
    ],
    [
      'finishes',
      'finish',
      { foto: `finishes/otro/${UUID}.jpg` },
      { foto: `finishes/apomazado/${UUID}.jpg` },
    ],
  ] as const;

  it.each(casos)(
    '%s: POST y PUT con foto ajena dan 422; con foto propia pasan',
    async (seg_, nombre, mala, buena) => {
      const { call } = setup();
      const item = valid[nombre];
      const post = await call({ method: 'POST', path: `/admin/${seg_}`, body: item(mala) });
      expect(post.status).toBe(422);
      expect(post.json.error).toBe('validation_error');
      expect(post.text).not.toContain('otr');
      const ok = await call({ method: 'POST', path: `/admin/${seg_}`, body: item(buena) });
      expect(ok.status).toBe(201);
      const id = item().id as string;
      const put = await call({ method: 'PUT', path: `/admin/${seg_}/${id}`, body: item(mala) });
      expect(put.status).toBe(422);
      expect(put.text).not.toContain('otr');
    },
  );
});

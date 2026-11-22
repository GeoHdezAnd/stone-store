import { catalogDocumentSchema } from '@canteras/shared';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { describe, expect, it } from 'vitest';
import { finish, project, service, stone } from '../../admin-catalog/test/fixtures';
import { mailSettings, publicSettings } from '../../admin-settings/test/fixtures';
import type { Invalidator } from '../invalidator';
import { MemoryPublishRepository } from './memory-repository';
import { MemoryPublishStorage } from '../memory-storage';
import { createPublishRouter } from '../routes';
import { sha256Hex } from '../sha256';

type Ev = APIGatewayProxyEventV2WithJWTAuthorizer;

let tick = 0;
const T0 = Date.parse('2026-11-19T10:00:00.000Z');
// Reloj que avanza 1 s por lectura: cada publicación tiene su propia marca de tiempo.
const clock = () => new Date(T0 + 1000 * tick++);

interface Call {
  method?: string;
  path: string;
  groups?: string | undefined;
}

function ev(c: Call): Ev {
  const claims: Record<string, string> = { sub: 'user-1', token_use: 'access' };
  if (c.groups !== undefined) claims['cognito:groups'] = c.groups;
  return {
    version: '2.0',
    rawPath: c.path,
    rawQueryString: '',
    headers: {},
    isBase64Encoded: false,
    requestContext: {
      requestId: 'req-1',
      http: { method: c.method ?? 'GET', path: c.path },
      authorizer: { jwt: { claims, scopes: [] } },
    },
  } as unknown as Ev;
}

class FakeInvalidator implements Invalidator {
  readonly calls: (readonly string[])[] = [];
  error: Error | null = null;
  result: 'ok' | 'skipped' = 'ok';
  async invalidate(paths: readonly string[]) {
    this.calls.push(paths);
    if (this.error) throw this.error;
    return this.result;
  }
}

function setup() {
  tick = 0;
  const repo = new MemoryPublishRepository();
  repo.catalog = {
    stones: [stone()],
    projects: [project()],
    finishes: [finish()],
    services: [service()],
    publicSettings: { ...publicSettings(), key: 'PUBLIC' },
  };
  const storage = new MemoryPublishStorage();
  const invalidator = new FakeInvalidator();
  const lines: string[] = [];
  const router = createPublishRouter(
    { repo, storage, invalidator, sha256: sha256Hex, now: clock },
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
  const publish = (groups?: string) =>
    call({ method: 'POST', path: '/admin/publish', groups: groups ?? '[owner]' });
  return { repo, storage, invalidator, lines, call, publish };
}

const OBJ = (v: string) => `published/${v}/catalog.json`;
const CURRENT_COPY = 'published/catalog.json';

describe('matriz de roles por ruta', () => {
  const rutas = [
    ['POST', '/admin/publish'],
    ['GET', '/admin/publications'],
    ['POST', '/admin/publications/v0001/revert'],
  ] as const;

  it('sin rol o con un grupo desconocido: 403 en todas las rutas y nada se toca', async () => {
    const { repo, storage, invalidator, call } = setup();
    for (const groups of [undefined, '[]', '[visitante]']) {
      for (const [method, path] of rutas) {
        const r = await call({ method, path, groups });
        expect(r.status, `${method} ${path} ${groups}`).toBe(403);
      }
    }
    expect(repo.calls).toEqual([]);
    expect(storage.calls).toEqual([]);
    expect(invalidator.calls).toEqual([]);
  });

  it('staff puede LEER las publicaciones', async () => {
    const { call } = setup();
    expect((await call({ path: '/admin/publications', groups: '[staff]' })).status).toBe(200);
  });

  it.each([
    ['POST', '/admin/publish'],
    ['POST', '/admin/publications/v0001/revert'],
  ])('staff NO puede %s %s: 403 y no se toca nada', async (method, path) => {
    const { repo, storage, invalidator, call } = setup();
    const r = await call({ method, path, groups: '[staff]' });
    expect(r.status).toBe(403);
    expect(r.json).toEqual({ error: 'forbidden' });
    expect(repo.calls).toEqual([]);
    expect(storage.calls).toEqual([]);
    expect(invalidator.calls).toEqual([]);
  });

  it('métodos o rutas no declaradas: 404', async () => {
    const { call } = setup();
    expect((await call({ method: 'GET', path: '/admin/publish' })).status).toBe(404);
    expect((await call({ method: 'DELETE', path: '/admin/publications' })).status).toBe(404);
    expect((await call({ method: 'POST', path: '/admin/publications' })).status).toBe(404);
  });
});

describe('POST /admin/publish: flujo feliz', () => {
  it('publica v0001: objeto inmutable, fila, CURRENT, auditoría, copia e invalidación', async () => {
    const { repo, storage, invalidator, publish } = setup();
    invalidator.result = 'ok';
    const r = await publish();
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ changed: true, version: 'v0001', invalidation: 'ok' });

    // Mismos bytes en la versión inmutable y en la copia vigente.
    const inmutable = storage.objects.get(OBJ('v0001'));
    expect(inmutable).toBeDefined();
    expect(storage.objects.get(CURRENT_COPY)).toBe(inmutable);
    const doc = catalogDocumentSchema.parse(JSON.parse(inmutable as string));
    expect(doc.version).toBe('v0001');
    expect(doc.stones.map((s) => s.id)).toEqual(['arenisca']);

    expect(repo.current).toMatchObject({
      currentVersion: 'v0001',
      hash: doc.hash,
      publishedBy: 'user-1',
    });
    expect(repo.rows.get('v0001')).toMatchObject({
      action: 'publish',
      hash: doc.hash,
      s3Key: OBJ('v0001'),
      counts: { stones: 1, finishes: 1, projects: 1, services: 1 },
    });
    expect(repo.audits).toHaveLength(1);
    expect(repo.audits[0]).toMatchObject({
      pk: 'ENTITY#publication#v0001',
      accion: 'publish',
      userId: 'user-1',
    });
    expect(repo.audits[0]).not.toHaveProperty('scope');
    expect(invalidator.calls).toEqual([['/published/catalog.json']]);
  });

  it('respeta el orden: objeto inmutable, transacción, copia vigente, invalidación', async () => {
    const { repo, storage, invalidator, publish } = setup();
    const orden: string[] = [];
    const putImm = storage.putImmutable.bind(storage);
    storage.putImmutable = async (...a) => {
      orden.push('inmutable');
      return putImm(...a);
    };
    const commit = repo.commit.bind(repo);
    repo.commit = async (i) => {
      orden.push('commit');
      return commit(i);
    };
    const copy = storage.putCurrentCopy.bind(storage);
    storage.putCurrentCopy = async (b) => {
      orden.push('copia');
      return copy(b);
    };
    const inv = invalidator.invalidate.bind(invalidator);
    invalidator.invalidate = async (p) => {
      orden.push('invalidacion');
      return inv(p);
    };
    await publish();
    expect(orden).toEqual(['inmutable', 'commit', 'copia', 'invalidacion']);
  });

  it('sin distribución configurada informa invalidation: skipped', async () => {
    const { invalidator, publish } = setup();
    invalidator.result = 'skipped';
    expect((await publish()).json.invalidation).toBe('skipped');
  });

  it('solo publica activos y publicados, y filtra referencias', async () => {
    const { repo, storage, publish } = setup();
    repo.catalog.stones = [
      stone({ id: 'a', proyectosRelacionados: ['casa-tepeyahualco', 'borrador'] }),
      stone({ id: 'oculta', activa: false }),
    ];
    repo.catalog.projects = [project(), project({ id: 'borrador', estado: 'borrador' })];
    await publish();
    const doc = catalogDocumentSchema.parse(
      JSON.parse(storage.objects.get(OBJ('v0001')) as string),
    );
    expect(doc.stones.map((s) => s.id)).toEqual(['a']);
    expect(doc.stones[0]?.proyectosRelacionados).toEqual(['casa-tepeyahualco']);
    expect(doc.projects.map((p) => p.id)).toEqual(['casa-tepeyahualco']);
  });

  it('nunca publica la fila MAIL ni sus textos', async () => {
    const { repo, storage, publish } = setup();
    // Aunque la fuente trajera plantillas mezcladas en la fila PUBLIC, el documento las rechaza.
    const mail = mailSettings();
    repo.catalog.publicSettings = { ...publicSettings(), key: 'PUBLIC', ...mail };
    expect((await publish()).status).toBe(422);
    expect([...storage.objects.values()].join('')).not.toContain(mail.plantillaCotizacion);
    // Con la fila PUBLIC limpia, nada de MAIL aparece en el objeto.
    repo.catalog.publicSettings = { ...publicSettings(), key: 'PUBLIC' };
    await publish();
    const texto = storage.objects.get(OBJ('v0001')) as string;
    expect(texto).not.toContain(mail.plantillaCotizacion);
    expect(texto).not.toContain('plantillaCotizacion');
    expect(texto).not.toContain('"key"');
  });

  it('la segunda publicación con cambios es v0002 y apunta a la nueva versión', async () => {
    const { repo, storage, publish } = setup();
    await publish();
    repo.catalog.stones = [stone({ nombre: 'Arenisca fina' })];
    const r = await publish();
    expect(r.json).toMatchObject({ changed: true, version: 'v0002' });
    expect(repo.current?.currentVersion).toBe('v0002');
    expect([...repo.rows.keys()].sort()).toEqual(['v0001', 'v0002']);
    expect(storage.objects.has(OBJ('v0001'))).toBe(true);
    expect(JSON.parse(storage.objects.get(CURRENT_COPY) as string).version).toBe('v0002');
  });
});

describe('POST /admin/publish: sin cambios', () => {
  it('responde 200 changed:false y no crea versión ni auditoría', async () => {
    const { repo, publish } = setup();
    await publish();
    const r = await publish();
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ changed: false, version: 'v0001' });
    expect(repo.rows.size).toBe(1);
    expect(repo.audits).toHaveLength(1);
  });

  it('no crea un objeto inmutable nuevo y reafirma la copia vigente (autocuración)', async () => {
    const { storage, publish } = setup();
    await publish();
    storage.calls.length = 0;
    await publish();
    expect(storage.calls).toEqual(['getImmutable:v0001', 'putCurrentCopy']);
  });
});

describe('POST /admin/publish: conflictos y fallos', () => {
  it('409 si otro publicó entre la lectura y la transacción; no copia ni invalida', async () => {
    const { repo, storage, invalidator, publish } = setup();
    await publish();
    repo.catalog.stones = [stone({ nombre: 'Otro nombre' })];
    repo.onBeforeCommit = () => {
      // Otro publicador movió CURRENT mientras tanto.
      repo.current = {
        ...(repo.current as NonNullable<typeof repo.current>),
        currentVersion: 'v0002',
      };
    };
    storage.calls.length = 0;
    invalidator.calls.length = 0;
    const r = await publish();
    expect(r.status).toBe(409);
    expect(r.json).toEqual({ error: 'conflict' });
    expect(storage.calls).not.toContain('putCurrentCopy');
    expect(invalidator.calls).toEqual([]);
    expect(repo.audits).toHaveLength(1);
  });

  it('409 si el objeto de esa versión ya existe Y la fila también (otro publicó)', async () => {
    const { repo, storage, publish } = setup();
    storage.objects.set(OBJ('v0001'), '{}');
    repo.rows.set('v0001', {} as never);
    expect((await publish()).status).toBe(409);
    expect(repo.audits).toHaveLength(0);
  });

  it('se recupera de un objeto huérfano (existe el objeto, no la fila) sobrescribiéndolo', async () => {
    const { storage, publish } = setup();
    storage.objects.set(OBJ('v0001'), '{"huerfano":true}');
    const r = await publish();
    expect(r.status).toBe(200);
    expect(storage.calls).toContain('putImmutable:v0001:overwrite');
    expect(JSON.parse(storage.objects.get(OBJ('v0001')) as string).version).toBe('v0001');
  });

  it('502 si falla la copia: CURRENT ya quedó consistente y un reintento la completa', async () => {
    const { repo, storage, publish } = setup();
    storage.failCopy = new Error('S3 caído: arn:aws:s3:::bucket-secreto');
    const r = await publish();
    expect(r.status).toBe(502);
    expect(r.json).toEqual({ error: 'copy_failed', version: 'v0001', retry: true });
    expect(r.text).not.toContain('secreto');
    expect(repo.current?.currentVersion).toBe('v0001');
    expect(storage.objects.has(OBJ('v0001'))).toBe(true);
    expect(storage.objects.has(CURRENT_COPY)).toBe(false);

    storage.failCopy = null;
    const retry = await publish();
    expect(retry.status).toBe(200);
    expect(retry.json).toMatchObject({ changed: false, version: 'v0001' });
    expect(storage.objects.get(CURRENT_COPY)).toBe(storage.objects.get(OBJ('v0001')));
  });

  it('si falla la subida del objeto inmutable no toca la base', async () => {
    const { repo, storage, publish } = setup();
    storage.failPutImmutable = new Error('boom');
    expect((await publish()).status).toBe(500);
    expect(repo.rows.size).toBe(0);
    expect(repo.current).toBeNull();
  });

  it('una invalidación fallida NO falla la publicación: se informa y se registra', async () => {
    const { invalidator, lines, publish } = setup();
    invalidator.error = new Error('AccessDenied distribution E123');
    const r = await publish();
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ changed: true, version: 'v0001', invalidation: 'failed' });
    expect(r.text).not.toContain('E123');
    expect(lines.join('\n')).toContain('invalidation_failed');
  });

  it('422 si una entidad guardada no cumple el esquema: no escribe nada y no filtra valores', async () => {
    const { repo, storage, publish } = setup();
    repo.catalog.stones = [{ ...stone(), densidadKgM3: 'secreto-raro' }];
    const r = await publish();
    expect(r.status).toBe(422);
    expect(r.json).toEqual({ error: 'invalid_stored_item' });
    expect(r.text).not.toContain('secreto-raro');
    expect(storage.calls).toEqual([]);
    expect(repo.rows.size).toBe(0);
  });

  it('422 si no existe la configuración pública', async () => {
    const { repo, storage, publish } = setup();
    repo.catalog.publicSettings = null;
    const r = await publish();
    expect(r.status).toBe(422);
    expect(r.json).toEqual({ error: 'settings_missing' });
    expect(storage.calls).toEqual([]);
  });

  it('un error inesperado devuelve 500 genérico con requestId y sin detalles', async () => {
    const { repo, publish } = setup();
    repo.commitError = new Error('tabla Publications-secreta no accesible');
    const r = await publish();
    expect(r.status).toBe(500);
    expect(r.json).toEqual({ error: 'internal_error', requestId: 'req-1' });
    expect(r.text).not.toContain('secreta');
  });
});

describe('POST /admin/publications/{version}/revert', () => {
  async function conDosVersiones() {
    const s = setup();
    await s.publish(); // v0001
    s.repo.catalog.stones = [stone({ nombre: 'Arenisca fina' })];
    await s.publish(); // v0002
    return s;
  }

  it('crea una publicación NUEVA (v0003) con el contenido de v0001 y no toca las anteriores', async () => {
    const { repo, storage, invalidator, call } = await conDosVersiones();
    const v1Antes = storage.objects.get(OBJ('v0001'));
    const v2Antes = storage.objects.get(OBJ('v0002'));
    const hashV1 = repo.rows.get('v0001')?.hash;
    invalidator.calls.length = 0;

    const r = await call({ method: 'POST', path: '/admin/publications/v0001/revert' });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      changed: true,
      version: 'v0003',
      revertedFrom: 'v0001',
      invalidation: 'ok',
    });

    expect(storage.objects.get(OBJ('v0001'))).toBe(v1Antes);
    expect(storage.objects.get(OBJ('v0002'))).toBe(v2Antes);
    const v3 = catalogDocumentSchema.parse(JSON.parse(storage.objects.get(OBJ('v0003')) as string));
    expect(v3.version).toBe('v0003');
    expect(v3.hash).toBe(hashV1);
    expect(v3.stones[0]?.nombre).toBe('Arenisca');
    expect(storage.objects.get(CURRENT_COPY)).toBe(storage.objects.get(OBJ('v0003')));

    expect(repo.rows.get('v0003')).toMatchObject({
      action: 'revert',
      revertedFrom: 'v0001',
      hash: hashV1,
    });
    expect(repo.rows.get('v0001')?.action).toBe('publish');
    expect(repo.current?.currentVersion).toBe('v0003');
    expect(repo.audits.at(-1)).toMatchObject({
      pk: 'ENTITY#publication#v0003',
      accion: 'revert',
    });
    expect(invalidator.calls).toEqual([['/published/catalog.json']]);
  });

  it('el corte de cambios pendientes del revert es el del contenido republicado', async () => {
    const { repo, call } = await conDosVersiones();
    await call({ method: 'POST', path: '/admin/publications/v0001/revert' });
    expect(repo.current?.generatedAt).toBe(repo.rows.get('v0001')?.generatedAt);
  });

  it('revertir a la versión que ya está vigente es «sin cambios»', async () => {
    const { repo, call } = await conDosVersiones();
    const r = await call({ method: 'POST', path: '/admin/publications/v0002/revert' });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ changed: false, version: 'v0002' });
    expect(repo.rows.size).toBe(2);
  });

  it('404 si la versión no existe', async () => {
    const { call } = await conDosVersiones();
    const r = await call({ method: 'POST', path: '/admin/publications/v0099/revert' });
    expect(r.status).toBe(404);
    expect(r.json).toEqual({ error: 'not_found' });
  });

  it.each(['v1', 'CURRENT', 'v0001x', '1', 'V0001', '..'])(
    '400 con una versión inválida en la ruta (%s) sin tocar nada',
    async (version) => {
      const { repo, storage, call } = setup();
      const r = await call({ method: 'POST', path: `/admin/publications/${version}/revert` });
      expect(r.status).toBe(400);
      expect(r.json).toEqual({ error: 'invalid_path' });
      expect(repo.calls).toEqual([]);
      expect(storage.calls).toEqual([]);
    },
  );

  it('409 en conflicto', async () => {
    const { repo, call } = await conDosVersiones();
    repo.onBeforeCommit = () => {
      repo.current = {
        ...(repo.current as NonNullable<typeof repo.current>),
        currentVersion: 'v0003',
      };
    };
    const r = await call({ method: 'POST', path: '/admin/publications/v0001/revert' });
    expect(r.status).toBe(409);
  });

  it('500 invalid_publication si el objeto guardado no es un documento válido o no coincide con su hash', async () => {
    const { storage, call } = await conDosVersiones();
    storage.objects.set(OBJ('v0001'), '{"hola":1}');
    const r = await call({ method: 'POST', path: '/admin/publications/v0001/revert' });
    expect(r.status).toBe(500);
    expect(r.json).toEqual({ error: 'invalid_publication' });
  });

  it('502 si falla la copia, con CURRENT ya consistente', async () => {
    const { repo, storage, call } = await conDosVersiones();
    storage.failCopy = new Error('x');
    const r = await call({ method: 'POST', path: '/admin/publications/v0001/revert' });
    expect(r.status).toBe(502);
    expect(r.json).toEqual({ error: 'copy_failed', version: 'v0003', retry: true });
    expect(repo.current?.currentVersion).toBe('v0003');
  });
});

describe('GET /admin/publications', () => {
  it('sin publicaciones: current null y lista vacía', async () => {
    const { call } = setup();
    const r = await call({ path: '/admin/publications' });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({
      current: null,
      publications: [],
      pending: { items: [], truncated: false },
    });
  });

  it('devuelve current, el historial (reciente primero) y los cambios pendientes desde el corte', async () => {
    const { repo, call, publish } = setup();
    await publish();
    repo.catalog.stones = [stone({ nombre: 'Arenisca fina' })];
    await publish();
    repo.pendingAudits = [
      {
        pk: 'ENTITY#stone#arenisca',
        sk: '2026-11-19T11:00:00.000Z#req-9',
        accion: 'update',
        userId: 'u-2',
      },
    ];
    const r = await call({ path: '/admin/publications', groups: '[staff]' });
    expect(r.status).toBe(200);
    expect(r.json.current).toMatchObject({
      version: 'v0002',
      action: 'publish',
      publishedBy: 'user-1',
    });
    expect(r.json.publications.map((p: { version: string }) => p.version)).toEqual([
      'v0002',
      'v0001',
    ]);
    expect(r.json.pending).toEqual({
      items: [
        {
          entity: 'stone',
          id: 'arenisca',
          at: '2026-11-19T11:00:00.000Z',
          accion: 'update',
          userId: 'u-2',
        },
      ],
      truncated: false,
    });
    expect(repo.lastPendingSince).toBe(repo.current?.generatedAt);
  });

  it('sin publicaciones, los pendientes se piden sin corte', async () => {
    const { repo, call } = setup();
    await call({ path: '/admin/publications' });
    expect(repo.lastPendingSince).toBeNull();
  });

  it('no expone hash, claves de S3 ni valores de antes/después', async () => {
    const { repo, call, publish } = setup();
    await publish();
    repo.pendingAudits = [
      {
        pk: 'ENTITY#settings#public',
        sk: '2026-11-19T11:00:00.000Z#req-9',
        accion: 'update',
        userId: 'u-2',
        antes: { whatsapp: '525512345678' },
      },
    ];
    const r = await call({ path: '/admin/publications' });
    expect(r.text).not.toContain('"hash"');
    expect(r.text).not.toContain('s3Key');
    expect(r.text).not.toContain('published/');
    expect(r.text).not.toContain('525512345678');
  });

  it('el historial se limita a las 20 versiones más recientes', async () => {
    const { repo, call } = setup();
    for (let n = 1; n <= 25; n++) {
      const v = `v${String(n).padStart(4, '0')}`;
      repo.rows.set(v, {
        version: v,
        action: 'publish',
        publishedAt: 'x',
        publishedBy: 'u',
      } as never);
    }
    repo.current = {
      version: 'CURRENT',
      currentVersion: 'v0025',
      action: 'publish',
      hash: 'h',
      generatedAt: 'g',
      publishedAt: 'p',
      publishedBy: 'u',
    };
    const r = await call({ path: '/admin/publications' });
    expect(r.json.publications).toHaveLength(20);
    expect(r.json.publications[0].version).toBe('v0025');
    expect(r.json.publications[19].version).toBe('v0006');
  });
});

describe('logs', () => {
  it('registran publicación y versión pero nunca datos de contacto', async () => {
    const { lines, publish } = setup();
    await publish();
    const todo = lines.join('\n');
    expect(todo).toContain('publish');
    expect(todo).not.toContain('525512345678');
    expect(todo).not.toContain('ventas@ejemplo.test');
  });
});

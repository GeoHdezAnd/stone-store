import { MAX_MEDIA_BYTES, UPLOAD_URL_TTL_SECONDS, photoKeySchema } from '@canteras/shared';
import type { PutObjectCommand } from '@aws-sdk/client-s3';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { describe, expect, it } from 'vitest';
import { createMediaRouter, type Presign } from './routes';

type Ev = APIGatewayProxyEventV2WithJWTAuthorizer;

const URL_FIRMADA = 'https://s3.example/bucket/k?X-Amz-Signature=firma-secreta-123';

function setup(opts: { presign?: Presign } = {}) {
  const calls: { command: PutObjectCommand; options: { expiresIn: number } }[] = [];
  const presign: Presign =
    opts.presign ??
    (async (command, options) => {
      calls.push({ command, options });
      return URL_FIRMADA;
    });
  const lines: string[] = [];
  const router = createMediaRouter(
    { bucket: 'bucket-de-prueba', presign },
    { logSink: (l) => lines.push(l) },
  );
  return { router, calls, lines };
}

const ev = (opts: {
  body?: unknown;
  groups?: string;
  method?: string;
  path?: string;
  tokenUse?: string;
  rawBody?: string;
}): Ev =>
  ({
    rawPath: opts.path ?? '/admin/media/upload-url',
    isBase64Encoded: false,
    body: opts.rawBody ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
    requestContext: {
      requestId: 'r1',
      http: { method: opts.method ?? 'POST' },
      authorizer: {
        jwt: {
          claims: {
            sub: 'usuario-1',
            token_use: opts.tokenUse ?? 'access',
            ...(opts.groups === undefined ? {} : { 'cognito:groups': opts.groups }),
          },
          scopes: [],
        },
      },
    },
  }) as unknown as Ev;

const valido = { entity: 'stones', id: 'cantera-rosa', contentType: 'image/png', sizeBytes: 2048 };
const owner = '[owner]';
const staff = '[staff]';

describe('POST /admin/media/upload-url: roles', () => {
  it.each([
    ['owner', owner],
    ['staff', staff],
    ['owner y staff', '[owner staff]'],
  ])('permite a %s', async (_n, groups) => {
    const { router } = setup();
    const res = await router.handle(ev({ body: valido, groups }));
    expect(res.statusCode).toBe(200);
  });

  it.each([
    ['sin grupos', undefined],
    ['grupo desconocido', '[visitante]'],
    ['grupo vacío', '[]'],
  ])('rechaza con 403 %s y no firma nada', async (_n, groups) => {
    const { router, calls } = setup();
    const res = await router.handle(ev({ body: valido, ...(groups ? { groups } : {}) }));
    expect(res.statusCode).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('un id token da 401', async () => {
    const { router, calls } = setup();
    const res = await router.handle(ev({ body: valido, groups: owner, tokenUse: 'id' }));
    expect(res.statusCode).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('no existe ninguna otra ruta ni método (404)', async () => {
    const { router } = setup();
    for (const [method, path] of [
      ['GET', '/admin/media/upload-url'],
      ['PUT', '/admin/media/upload-url'],
      ['DELETE', '/admin/media/upload-url'],
      ['GET', '/admin/media'],
      ['POST', '/admin/media'],
      ['POST', '/admin/media/otra'],
      ['DELETE', '/admin/media/stones/a/x.png'],
    ] as const) {
      const res = await router.handle(ev({ body: valido, groups: owner, method, path }));
      expect(res.statusCode, `${method} ${path}`).toBe(404);
    }
  });
});

describe('POST /admin/media/upload-url: validación', () => {
  const post = async (body: unknown) => {
    const s = setup();
    const res = await s.router.handle(ev({ body, groups: owner }));
    return { ...s, res, json: JSON.parse(res.body as string) };
  };

  it.each([
    'image/svg+xml',
    'text/html',
    'application/pdf',
    'image/gif',
    'IMAGE/PNG',
    'Image/Jpeg',
    '',
  ])('rechaza el tipo %j con 422 y no firma', async (contentType) => {
    const { res, calls, json } = await post({ ...valido, contentType });
    expect(res.statusCode).toBe(422);
    expect(json.error).toBe('validation_error');
    expect(calls).toHaveLength(0);
  });

  it.each(['image/jpeg', 'image/png', 'image/webp', 'image/avif'])(
    'acepta el tipo %s',
    async (contentType) => {
      const { res } = await post({ ...valido, contentType });
      expect(res.statusCode).toBe(200);
    },
  );

  it.each([0, -1, 1.5, MAX_MEDIA_BYTES + 1, Number.NaN, '2048', null])(
    'rechaza el tamaño %j',
    async (sizeBytes) => {
      const { res, calls } = await post({ ...valido, sizeBytes });
      expect(res.statusCode).toBe(422);
      expect(calls).toHaveLength(0);
    },
  );

  it('acepta exactamente el tope de 5 MiB y lo firma como ContentLength', async () => {
    const { res, calls } = await post({ ...valido, sizeBytes: MAX_MEDIA_BYTES });
    expect(res.statusCode).toBe(200);
    expect(calls[0]!.command.input.ContentLength).toBe(MAX_MEDIA_BYTES);
  });

  it.each(['settings', 'users', '../', '../stones', 'STONES', ''])(
    'rechaza la entidad %j',
    async (entity) => {
      const { res, calls } = await post({ ...valido, entity });
      expect(res.statusCode).toBe(422);
      expect(calls).toHaveLength(0);
    },
  );

  it.each(['Cantera', '../x', '..', '%2e%2e', 'a/b', '/a', 'a\\b', '', 'a b'])(
    'rechaza el id %j',
    async (id) => {
      const { res, calls } = await post({ ...valido, id });
      expect(res.statusCode).toBe(422);
      expect(calls).toHaveLength(0);
    },
  );

  it.each(['key', 'filename', 'path', 'name', 'bucket'])(
    'rechaza la clave extra %s sin reflejarla en la respuesta',
    async (extra) => {
      const { res, calls } = await post({ ...valido, [extra]: 'stones/x/malo.png' });
      expect(res.statusCode).toBe(422);
      expect(res.body).not.toContain('malo.png');
      expect(JSON.parse(res.body as string).issues).toEqual([
        { path: '', message: 'El cuerpo incluye campos no permitidos' },
      ]);
      expect(calls).toHaveLength(0);
    },
  );

  it('sin cuerpo da 422; JSON roto da 400', async () => {
    const { router } = setup();
    expect((await router.handle(ev({ groups: owner }))).statusCode).toBe(422);
    expect((await router.handle(ev({ groups: owner, rawBody: '{x' }))).statusCode).toBe(400);
  });

  it('los 422 llevan issues {path,message} en español y no repiten valores enviados', async () => {
    const { json, res } = await post({ ...valido, contentType: 'text/html-secreto-abc' });
    expect(json.issues).toEqual([{ path: 'contentType', message: expect.any(String) }]);
    expect(res.body).not.toContain('secreto-abc');
  });
});

describe('POST /admin/media/upload-url: firma', () => {
  it('responde 200 con key, url, método, cabeceras y vigencia', async () => {
    const { router } = setup();
    const res = await router.handle(ev({ body: valido, groups: staff }));
    expect(res.statusCode).toBe(200);
    const json = JSON.parse(res.body as string);
    expect(Object.keys(json).sort()).toEqual(
      ['expiresInSeconds', 'headers', 'key', 'method', 'url'].sort(),
    );
    expect(json.url).toBe(URL_FIRMADA);
    expect(json.method).toBe('PUT');
    expect(json.headers).toEqual({ 'content-type': 'image/png' });
    expect(json.expiresInSeconds).toBe(UPLOAD_URL_TTL_SECONDS);
  });

  it('el Command lleva Bucket, Key, ContentType y ContentLength exactos y TTL de 300 s', async () => {
    const { router, calls } = setup();
    const res = await router.handle(ev({ body: valido, groups: owner }));
    const { key } = JSON.parse(res.body as string);
    expect(calls).toHaveLength(1);
    const { command, options } = calls[0]!;
    expect(command.input).toEqual({
      Bucket: 'bucket-de-prueba',
      Key: key,
      ContentType: 'image/png',
      ContentLength: 2048,
    });
    expect(options.expiresIn).toBe(300);
  });

  it.each([
    ['stones', 'image/jpeg', 'jpg'],
    ['projects', 'image/webp', 'webp'],
    ['finishes', 'image/avif', 'avif'],
  ])('la clave del servidor (%s) pasa photoKeySchema', async (entity, contentType, ext) => {
    const { router } = setup();
    const res = await router.handle(
      ev({ body: { ...valido, entity, contentType, id: 'abc-1' }, groups: owner }),
    );
    const { key } = JSON.parse(res.body as string) as { key: string };
    expect(photoKeySchema(entity as 'stones').safeParse(key).success).toBe(true);
    expect(key).toMatch(
      new RegExp(
        `^${entity}/abc-1/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.${ext}$`,
      ),
    );
  });

  it('dos peticiones iguales producen claves distintas', async () => {
    const { router } = setup();
    const a = JSON.parse((await router.handle(ev({ body: valido, groups: owner }))).body as string);
    const b = JSON.parse((await router.handle(ev({ body: valido, groups: owner }))).body as string);
    expect(a.key).not.toBe(b.key);
  });

  it('la clave nunca contiene texto del cliente más allá del id validado', async () => {
    const { router } = setup();
    const res = await router.handle(ev({ body: valido, groups: owner }));
    const { key } = JSON.parse(res.body as string) as { key: string };
    const resto = key.replace('stones/cantera-rosa/', '').replace(/\.png$/, '');
    expect(resto).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('un fallo del presigner da 500 genérico sin detalles', async () => {
    const { router } = setup({
      presign: async () => {
        throw new Error('detalle-interno-aws');
      },
    });
    const res = await router.handle(ev({ body: valido, groups: owner }));
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('detalle-interno-aws');
  });

  it('la respuesta tiene cache-control: no-store', async () => {
    const { router } = setup();
    const res = await router.handle(ev({ body: valido, groups: owner }));
    expect(res.headers?.['cache-control']).toBe('no-store');
  });
});

describe('POST /admin/media/upload-url: logs', () => {
  it('registra userId y key, pero nunca la URL firmada ni su firma', async () => {
    const { router, lines } = setup();
    const res = await router.handle(ev({ body: valido, groups: owner }));
    const { key } = JSON.parse(res.body as string);
    const todo = lines.join('\n');
    expect(todo).toContain('usuario-1');
    expect(todo).toContain(key);
    expect(todo).not.toContain('firma-secreta-123');
    expect(todo).not.toContain('X-Amz-Signature');
    expect(todo).not.toContain(URL_FIRMADA);
  });

  it('un error del presigner que contiene la URL no la filtra a los logs', async () => {
    const { router, lines } = setup({
      presign: async () => {
        throw new Error(`falló ${URL_FIRMADA}`);
      },
    });
    await router.handle(ev({ body: valido, groups: owner }));
    expect(lines.join('\n')).not.toContain('firma-secreta-123');
  });
});

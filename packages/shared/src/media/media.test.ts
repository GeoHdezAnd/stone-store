import { describe, expect, it } from 'vitest';
import { PHOTO_FOLDERS, photoKeySchema } from '../catalog';
import {
  MAX_MEDIA_BYTES,
  MEDIA_CONTENT_TYPES,
  MEDIA_ENTITIES,
  MEDIA_EXTENSIONS,
  UPLOAD_URL_TTL_SECONDS,
  buildMediaKey,
  uploadRequestSchema,
} from './index';

const UUID = '3f2b8c1e-9a4d-4e6b-8c7a-1d2e3f4a5b6c';
const valido = {
  entity: 'stones',
  id: 'cantera-rosa',
  contentType: 'image/jpeg',
  sizeBytes: 1024,
};

describe('constantes de media', () => {
  it('fijan entidades, tipos, extensiones, tope y vigencia', () => {
    expect([...MEDIA_ENTITIES]).toEqual(['stones', 'projects', 'finishes']);
    expect([...MEDIA_ENTITIES]).toEqual([...PHOTO_FOLDERS]);
    expect([...MEDIA_CONTENT_TYPES]).toEqual([
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/avif',
    ]);
    expect(MEDIA_EXTENSIONS).toEqual({
      'image/jpeg': 'jpg',
      'image/png': 'png',
      'image/webp': 'webp',
      'image/avif': 'avif',
    });
    expect(MAX_MEDIA_BYTES).toBe(5 * 1024 * 1024);
    expect(UPLOAD_URL_TTL_SECONDS).toBe(300);
  });
});

describe('uploadRequestSchema', () => {
  it('acepta una petición válida', () => {
    expect(uploadRequestSchema.parse(valido)).toEqual(valido);
  });

  it.each(MEDIA_CONTENT_TYPES)('acepta el tipo %s', (contentType) => {
    expect(uploadRequestSchema.safeParse({ ...valido, contentType }).success).toBe(true);
  });

  it.each([
    'image/svg+xml',
    'text/html',
    'application/pdf',
    'image/gif',
    'IMAGE/JPEG',
    'Image/Png',
    'image/jpeg; charset=utf-8',
    ' image/jpeg',
    '',
    'image/*',
  ])('rechaza el tipo %j', (contentType) => {
    expect(uploadRequestSchema.safeParse({ ...valido, contentType }).success).toBe(false);
  });

  it.each([0, -1, 1.5, MAX_MEDIA_BYTES + 1, Number.NaN, Infinity, -Infinity, '1024', null])(
    'rechaza sizeBytes %j',
    (sizeBytes) => {
      expect(uploadRequestSchema.safeParse({ ...valido, sizeBytes }).success).toBe(false);
    },
  );

  it.each([1, MAX_MEDIA_BYTES])('acepta sizeBytes en el límite (%i)', (sizeBytes) => {
    expect(uploadRequestSchema.safeParse({ ...valido, sizeBytes }).success).toBe(true);
  });

  it.each(['settings', 'users', '../', 'Stones', '', 'stones/'])(
    'rechaza la entidad %j',
    (entity) => {
      expect(uploadRequestSchema.safeParse({ ...valido, entity }).success).toBe(false);
    },
  );

  it.each(['Cantera', '../x', '%2e%2e', 'a/b', 'a b', '', '-a', 'a--b', 'a.b', 'x'.repeat(65)])(
    'rechaza el id %j',
    (id) => {
      expect(uploadRequestSchema.safeParse({ ...valido, id }).success).toBe(false);
    },
  );

  it.each(['key', 'filename', 'path', 'name'])('rechaza la clave extra %s', (extra) => {
    expect(uploadRequestSchema.safeParse({ ...valido, [extra]: 'x' }).success).toBe(false);
  });

  it('rechaza campos faltantes y cuerpos que no son objeto', () => {
    expect(uploadRequestSchema.safeParse({}).success).toBe(false);
    expect(uploadRequestSchema.safeParse(null).success).toBe(false);
    expect(uploadRequestSchema.safeParse('x').success).toBe(false);
  });

  it('los mensajes están en español', () => {
    const r = uploadRequestSchema.safeParse({ ...valido, contentType: 'image/gif', sizeBytes: 0 });
    expect(r.success).toBe(false);
    const msgs = r.error!.issues.map((i) => i.message).join(' | ');
    expect(msgs).toMatch(/tipo|imagen|JPEG/i);
    expect(msgs).not.toMatch(/Invalid|Expected|Too small/);
  });
});

describe('buildMediaKey', () => {
  const combos = MEDIA_ENTITIES.flatMap((e) => MEDIA_CONTENT_TYPES.map((t) => [e, t] as const));

  it.each(combos)('arma una clave que pasa photoKeySchema (%s, %s)', (entity, type) => {
    const key = buildMediaKey(entity, 'cantera-rosa', type, UUID);
    expect(key).toBe(`${entity}/cantera-rosa/${UUID}.${MEDIA_EXTENSIONS[type]}`);
    expect(photoKeySchema(entity).safeParse(key).success).toBe(true);
  });

  it.each([
    ['settings', 'a', 'image/png', UUID],
    ['stones', '../a', 'image/png', UUID],
    ['stones', 'A', 'image/png', UUID],
    ['stones', 'a/b', 'image/png', UUID],
    ['stones', 'a', 'image/svg+xml', UUID],
    ['stones', 'a', 'text/html', UUID],
    ['stones', 'a', 'image/png', 'no-es-uuid'],
    ['stones', 'a', 'image/png', UUID.toUpperCase()],
    ['stones', 'a', 'image/png', '3f2b8c1e-9a4d-1e6b-8c7a-1d2e3f4a5b6c'], // v1
    ['stones', 'a', 'image/png', `${UUID}/../x`],
    ['stones', 'a', 'image/png', ''],
  ])('lanza con entradas inválidas (%s, %s, %s, %s)', (entity, id, type, uuid) => {
    expect(() => buildMediaKey(entity as never, id, type as never, uuid)).toThrow();
  });
});

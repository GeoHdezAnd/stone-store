import { GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { MAX_MEDIA_BYTES } from '@canteras/shared';
import { describe, expect, it } from 'vitest';
import { ImageRejectedError } from '../processor';
import { S3ObjectStore } from '../s3-store';

function fakeClient(respond: (cmd: unknown) => unknown) {
  const sent: unknown[] = [];
  const client = {
    send: (cmd: unknown) => {
      sent.push(cmd);
      return Promise.resolve(respond(cmd));
    },
  } as unknown as S3Client;
  return { client, sent };
}

const body = (bytes: Uint8Array) => ({ transformToByteArray: () => Promise.resolve(bytes) });

describe('S3ObjectStore.get', () => {
  it('descarga con GetObject del bucket y clave indicados', async () => {
    const { client, sent } = fakeClient(() => ({
      ContentLength: 3,
      Body: body(new Uint8Array([1, 2, 3])),
    }));
    const out = await new S3ObjectStore(client).get('bkt', 'stones/a/x.jpg');
    expect([...out]).toEqual([1, 2, 3]);
    const cmd = sent[0] as GetObjectCommand;
    expect(cmd).toBeInstanceOf(GetObjectCommand);
    expect(cmd.input).toEqual({ Bucket: 'bkt', Key: 'stones/a/x.jpg' });
  });

  it('rechaza (too_large) si S3 informa más del tope, sin leer el cuerpo', async () => {
    let read = false;
    const { client } = fakeClient(() => ({
      ContentLength: MAX_MEDIA_BYTES + 1,
      Body: { transformToByteArray: () => ((read = true), Promise.resolve(new Uint8Array())) },
    }));
    await expect(new S3ObjectStore(client).get('b', 'k')).rejects.toBeInstanceOf(
      ImageRejectedError,
    );
    expect(read).toBe(false);
  });

  it('una respuesta sin cuerpo es un fallo (no un rechazo permanente)', async () => {
    const { client } = fakeClient(() => ({ ContentLength: 1 }));
    await expect(new S3ObjectStore(client).get('b', 'k')).rejects.not.toBeInstanceOf(
      ImageRejectedError,
    );
  });
});

describe('S3ObjectStore.get: foto borrada antes de procesarse', () => {
  it('NoSuchKey es un rechazo permanente benigno (not_found), no un fallo transitorio', async () => {
    const client = {
      send: () =>
        Promise.reject(
          Object.assign(new Error('The specified key does not exist.'), { name: 'NoSuchKey' }),
        ),
    } as unknown as S3Client;
    await expect(new S3ObjectStore(client).get('b', 'k')).rejects.toMatchObject({
      name: 'ImageRejectedError',
      reason: 'not_found',
    });
  });

  it('cualquier otro error (AccessDenied, red) se propaga tal cual: SÍ reintenta y alarma', async () => {
    const client = {
      send: () => Promise.reject(Object.assign(new Error('denegado'), { name: 'AccessDenied' })),
    } as unknown as S3Client;
    await expect(new S3ObjectStore(client).get('b', 'k')).rejects.toMatchObject({
      name: 'AccessDenied',
    });
  });
});

describe('S3ObjectStore.put', () => {
  it('sube con ContentType y CacheControl, sin ACL (el bucket aplica su cifrado por defecto)', async () => {
    const { client, sent } = fakeClient(() => ({}));
    await new S3ObjectStore(client).put('bkt', 'stones/a/x-480w.webp', new Uint8Array([9]), {
      contentType: 'image/webp',
      cacheControl: 'public, max-age=31536000, immutable',
    });
    const cmd = sent[0] as PutObjectCommand;
    expect(cmd).toBeInstanceOf(PutObjectCommand);
    expect(cmd.input).toEqual({
      Bucket: 'bkt',
      Key: 'stones/a/x-480w.webp',
      Body: new Uint8Array([9]),
      ContentType: 'image/webp',
      CacheControl: 'public, max-age=31536000, immutable',
    });
    expect(cmd.input).not.toHaveProperty('ACL');
  });
});

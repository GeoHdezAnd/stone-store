import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { ObjectExistsError, ObjectMissingError, S3PublishStorage } from '../storage';

type Input = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Sent = { name: string; input: Input };

function setup(reply: (c: Sent) => unknown = () => ({})) {
  const sent: Sent[] = [];
  const client = {
    async send(command: { constructor: { name: string }; input: Input }) {
      const s = { name: command.constructor.name, input: command.input };
      sent.push(s);
      return reply(s);
    },
  };
  return { sent, storage: new S3PublishStorage(client as never, 'bucket-pub') };
}

describe('S3PublishStorage', () => {
  it('putImmutable escribe published/<versión>/catalog.json solo si no existe (If-None-Match: *)', async () => {
    const { storage, sent } = setup();
    await storage.putImmutable('v0003', '{"a":1}', { overwrite: false });
    expect(sent[0]?.name).toBe(PutObjectCommand.name);
    expect(sent[0]?.input).toMatchObject({
      Bucket: 'bucket-pub',
      Key: 'published/v0003/catalog.json',
      Body: '{"a":1}',
      ContentType: 'application/json; charset=utf-8',
      IfNoneMatch: '*',
    });
    expect(sent[0]?.input['CacheControl']).toContain('immutable');
  });

  it('con overwrite no manda la condición', async () => {
    const { storage, sent } = setup();
    await storage.putImmutable('v0003', 'x', { overwrite: true });
    expect(sent[0]?.input).not.toHaveProperty('IfNoneMatch');
  });

  it.each([
    ['PreconditionFailed', undefined],
    ['ConditionalRequestConflict', undefined],
    ['Otro', 412],
  ])('un %s (%s) se traduce a ObjectExistsError', async (name, status) => {
    const { storage } = setup(() => {
      throw Object.assign(new Error('x'), { name, $metadata: { httpStatusCode: status } });
    });
    await expect(storage.putImmutable('v0001', 'x', { overwrite: false })).rejects.toBeInstanceOf(
      ObjectExistsError,
    );
  });

  it('otros errores de S3 se propagan', async () => {
    const { storage } = setup(() => {
      throw Object.assign(new Error('x'), { name: 'AccessDenied' });
    });
    await expect(storage.putImmutable('v0001', 'x', { overwrite: false })).rejects.toThrow('x');
  });

  it('putCurrentCopy escribe published/catalog.json con caché corta', async () => {
    const { storage, sent } = setup();
    await storage.putCurrentCopy('{"a":1}');
    expect(sent[0]?.input).toMatchObject({
      Key: 'published/catalog.json',
      CacheControl: 'public, max-age=60',
    });
  });

  it('getImmutable lee el objeto como texto; NoSuchKey -> ObjectMissingError', async () => {
    const ok = setup(() => ({ Body: { transformToString: async () => '{"a":1}' } }));
    expect(await ok.storage.getImmutable('v0001')).toBe('{"a":1}');
    expect(ok.sent[0]?.name).toBe(GetObjectCommand.name);
    expect(ok.sent[0]?.input['Key']).toBe('published/v0001/catalog.json');
    const missing = setup(() => {
      throw Object.assign(new Error('x'), { name: 'NoSuchKey' });
    });
    await expect(missing.storage.getImmutable('v0001')).rejects.toBeInstanceOf(ObjectMissingError);
  });
});

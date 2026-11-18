import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('handler de media', () => {
  it('falla al arrancar con un mensaje claro si falta MEDIA_BUCKET', async () => {
    vi.stubEnv('MEDIA_BUCKET', '');
    await expect(import('./handler')).rejects.toThrow(/MEDIA_BUCKET/);
  });

  it('con el entorno completo exporta handler y rechaza una petición sin claims', async () => {
    vi.stubEnv('MEDIA_BUCKET', 'bucket-de-prueba');
    vi.stubEnv('AWS_REGION', 'us-east-1');
    const { handler } = await import('./handler');
    const res = await handler({
      rawPath: '/admin/media/upload-url',
      requestContext: { requestId: 'r1', http: { method: 'POST' } },
    } as never);
    expect(res.statusCode).toBe(401);
  });
});

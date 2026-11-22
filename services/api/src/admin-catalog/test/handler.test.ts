import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('handler del catálogo', () => {
  it('falla al arrancar con un mensaje claro si falta una variable de entorno', async () => {
    vi.stubEnv('STONES_TABLE', 'x');
    vi.stubEnv('PROJECTS_TABLE', 'x');
    vi.stubEnv('FINISHES_TABLE', 'x');
    vi.stubEnv('SERVICES_TABLE', 'x');
    vi.stubEnv('AUDIT_TABLE', '');
    await expect(import('../handler')).rejects.toThrow(/AUDIT_TABLE/);
  });

  it('con el entorno completo exporta handler y rechaza una petición sin claims', async () => {
    for (const k of [
      'STONES_TABLE',
      'PROJECTS_TABLE',
      'FINISHES_TABLE',
      'SERVICES_TABLE',
      'AUDIT_TABLE',
    ]) {
      vi.stubEnv(k, `t-${k}`);
    }
    vi.stubEnv('AWS_REGION', 'us-east-1');
    const { handler } = await import('../handler');
    const res = await handler({
      rawPath: '/admin/stones',
      requestContext: { requestId: 'r1', http: { method: 'GET' } },
    } as never);
    expect(res.statusCode).toBe(401);
  });
});

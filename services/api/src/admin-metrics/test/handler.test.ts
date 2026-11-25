import { afterEach, describe, expect, it, vi } from 'vitest';

const VARS = ['QUOTES_TABLE', 'QUOTES_BY_STATUS_INDEX', 'POSTAL_CODES_TABLE'];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('handler del resumen', () => {
  it.each(VARS)('falla al arrancar con un mensaje claro si falta %s', async (faltante) => {
    for (const v of VARS) vi.stubEnv(v, v === faltante ? '' : 'x');
    await expect(import('../handler')).rejects.toThrow(new RegExp(faltante));
  });

  it('con el entorno completo rechaza sin claims (401) sin tocar la base', async () => {
    for (const v of VARS) vi.stubEnv(v, 'x');
    vi.stubEnv('AWS_REGION', 'us-east-1');
    const mod = await import('../handler');
    const res = await mod.handler({
      rawPath: '/admin/metrics',
      requestContext: { requestId: 'r1', http: { method: 'GET' } },
    } as never);
    expect(res.statusCode).toBe(401);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';

const VARS = [
  'QUOTES_TABLE',
  'AUDIT_TABLE',
  'QUOTES_BY_STATUS_INDEX',
  'QUOTES_BY_DATE_INDEX',
  'SETTINGS_TABLE',
];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('handler de solicitudes', () => {
  it.each(VARS)('falla al arrancar con un mensaje claro si falta %s', async (faltante) => {
    for (const v of VARS) vi.stubEnv(v, v === faltante ? '' : 'x');
    await expect(import('../handler')).rejects.toThrow(new RegExp(faltante));
  });

  it('con el entorno completo rechaza sin claims', async () => {
    for (const v of VARS) vi.stubEnv(v, 'x');
    vi.stubEnv('AWS_REGION', 'us-east-1');
    const mod = await import('../handler');
    expect(typeof mod.createQuotesRouter).toBe('function');
    const res = await mod.handler({
      rawPath: '/admin/quotes',
      requestContext: { requestId: 'r1', http: { method: 'GET' } },
    } as never);
    expect(res.statusCode).toBe(401);
  });
});

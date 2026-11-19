import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('handler de flete', () => {
  it.each(['FREIGHT_CONFIG_TABLE', 'STONES_TABLE', 'AUDIT_TABLE'])(
    'falla al arrancar con un mensaje claro si falta %s',
    async (faltante) => {
      for (const v of ['FREIGHT_CONFIG_TABLE', 'STONES_TABLE', 'AUDIT_TABLE']) {
        vi.stubEnv(v, v === faltante ? '' : 'x');
      }
      await expect(import('./handler')).rejects.toThrow(new RegExp(faltante));
    },
  );

  it('con el entorno completo exporta handler y createFreightRouter y rechaza sin claims', async () => {
    vi.stubEnv('FREIGHT_CONFIG_TABLE', 't-freight');
    vi.stubEnv('STONES_TABLE', 't-stones');
    vi.stubEnv('AUDIT_TABLE', 't-audit');
    vi.stubEnv('AWS_REGION', 'us-east-1');
    const mod = await import('./handler');
    expect(typeof mod.createFreightRouter).toBe('function');
    const res = await mod.handler({
      rawPath: '/admin/freight-config',
      requestContext: { requestId: 'r1', http: { method: 'GET' } },
    } as never);
    expect(res.statusCode).toBe(401);
  });
});

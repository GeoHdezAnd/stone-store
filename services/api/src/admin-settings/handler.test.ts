import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('handler de settings', () => {
  it('falla al arrancar con un mensaje claro si falta SETTINGS_TABLE', async () => {
    vi.stubEnv('SETTINGS_TABLE', '');
    vi.stubEnv('AUDIT_TABLE', 'x');
    await expect(import('./handler')).rejects.toThrow(/SETTINGS_TABLE/);
  });

  it('falla al arrancar con un mensaje claro si falta AUDIT_TABLE', async () => {
    vi.stubEnv('SETTINGS_TABLE', 'x');
    vi.stubEnv('AUDIT_TABLE', '');
    await expect(import('./handler')).rejects.toThrow(/AUDIT_TABLE/);
  });

  it('con el entorno completo exporta handler y createSettingsRouter y rechaza sin claims', async () => {
    vi.stubEnv('SETTINGS_TABLE', 't-settings');
    vi.stubEnv('AUDIT_TABLE', 't-audit');
    vi.stubEnv('AWS_REGION', 'us-east-1');
    const mod = await import('./handler');
    expect(typeof mod.createSettingsRouter).toBe('function');
    const res = await mod.handler({
      rawPath: '/admin/settings',
      requestContext: { requestId: 'r1', http: { method: 'GET' } },
    } as never);
    expect(res.statusCode).toBe(401);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { event, validBody } from './fixtures';

const VARS = [
  'QUOTES_TABLE',
  'COUNTERS_TABLE',
  'STONES_TABLE',
  'FREIGHT_CONFIG_TABLE',
  'SETTINGS_TABLE',
  'POSTAL_CODES_TABLE',
  'ROUTE_CACHE_TABLE',
];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('handler de quotes-create', () => {
  it.each(VARS)('falla al arrancar con un mensaje claro si falta %s', async (faltante) => {
    for (const v of VARS) vi.stubEnv(v, v === faltante ? '' : 'x');
    await expect(import('../handler')).rejects.toThrow(new RegExp(faltante));
  });

  it('con el entorno completo pero SIN verificador de captcha, falla cerrado (503) sin tocar AWS', async () => {
    for (const v of VARS) vi.stubEnv(v, 'x');
    vi.stubEnv('AWS_REGION', 'us-east-1');
    vi.stubEnv('TURNSTILE_MODE', '');
    vi.stubEnv('TURNSTILE_SECRET_PARAM', '');
    const mod = await import('../handler');
    const res = await mod.handler(event(validBody()));
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body as string)).toEqual({ error: 'captcha_not_configured' });
  });

  it('un cuerpo demasiado grande se rechaza antes de cualquier otra cosa', async () => {
    for (const v of VARS) vi.stubEnv(v, 'x');
    vi.stubEnv('AWS_REGION', 'us-east-1');
    const mod = await import('../handler');
    const res = await mod.handler(event('x'.repeat(20_000)));
    expect(res.statusCode).toBe(413);
  });

  it('TURNSTILE_MODE inválido impide arrancar (no se degrada en silencio)', async () => {
    for (const v of VARS) vi.stubEnv(v, 'x');
    vi.stubEnv('TURNSTILE_MODE', 'off');
    await expect(import('../handler')).rejects.toThrow(/TURNSTILE_MODE/);
  });

  it('ROUTE_PROVIDER inválido impide arrancar (nunca cae a un proveedor por defecto)', async () => {
    for (const v of VARS) vi.stubEnv(v, 'x');
    vi.stubEnv('ROUTE_PROVIDER', 'otro');
    await expect(import('../handler')).rejects.toThrow(/ROUTE_PROVIDER/);
  });

  it('sin ROUTE_PROVIDER arranca: la solicitud sigue funcionando, solo sin estimado de flete', async () => {
    for (const v of VARS) vi.stubEnv(v, 'x');
    vi.stubEnv('AWS_REGION', 'us-east-1');
    vi.stubEnv('ROUTE_PROVIDER', '');
    const mod = await import('../handler');
    expect(typeof mod.handler).toBe('function');
  });

  it('con ROUTE_PROVIDER=haversine arranca sin crear el cliente de Location', async () => {
    for (const v of VARS) vi.stubEnv(v, 'x');
    vi.stubEnv('AWS_REGION', 'us-east-1');
    vi.stubEnv('ROUTE_PROVIDER', 'haversine');
    const mod = await import('../handler');
    expect(typeof mod.handler).toBe('function');
  });
});

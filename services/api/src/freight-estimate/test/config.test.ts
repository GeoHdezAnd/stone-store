import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config';

const ENV = {
  FREIGHT_CONFIG_TABLE: 'FreightConfig',
  STONES_TABLE: 'Stones',
  POSTAL_CODES_TABLE: 'PostalCodes',
  ROUTE_CACHE_TABLE: 'RouteCache',
};

describe('loadConfig', () => {
  it('lee los nombres de las 4 tablas', () => {
    expect(loadConfig(ENV)).toEqual({
      freightConfig: 'FreightConfig',
      stones: 'Stones',
      postalCodes: 'PostalCodes',
      routeCache: 'RouteCache',
    });
  });

  it.each(Object.keys(ENV))('falta %s: error claro en español', (name) => {
    const env: Record<string, string | undefined> = { ...ENV };
    delete env[name];
    expect(() => loadConfig(env)).toThrow(new RegExp(`Falta la variable de entorno ${name}`));
    expect(() => loadConfig({ ...env, [name]: '' })).toThrow(name);
  });
});

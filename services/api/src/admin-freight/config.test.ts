import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';

const completo = {
  FREIGHT_CONFIG_TABLE: 't-freight',
  STONES_TABLE: 't-stones',
  AUDIT_TABLE: 't-audit',
};

describe('loadConfig de flete', () => {
  it('lee las 3 variables', () => {
    expect(loadConfig(completo)).toEqual({
      freightConfig: 't-freight',
      stones: 't-stones',
      auditLog: 't-audit',
    });
  });

  it.each(Object.keys(completo))('lanza un error claro si falta %s', (clave) => {
    const env: Record<string, string | undefined> = { ...completo };
    delete env[clave];
    expect(() => loadConfig(env)).toThrow(new RegExp(`Falta la variable de entorno ${clave}`));
  });

  it.each(Object.keys(completo))('lanza si %s está vacía', (clave) => {
    expect(() => loadConfig({ ...completo, [clave]: '' })).toThrow(new RegExp(clave));
  });
});

import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config';

const completo = { SETTINGS_TABLE: 't-settings', AUDIT_TABLE: 't-audit' };

describe('loadConfig de settings', () => {
  it('lee las 2 variables', () => {
    expect(loadConfig(completo)).toEqual({ settingsTable: 't-settings', auditTable: 't-audit' });
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

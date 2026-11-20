import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';

const completo = {
  QUOTES_TABLE: 't-quotes',
  AUDIT_TABLE: 't-audit',
  QUOTES_BY_STATUS_INDEX: 'byStatus',
  QUOTES_BY_DATE_INDEX: 'byDate',
  SETTINGS_TABLE: 't-settings',
};

describe('loadConfig de solicitudes', () => {
  it('lee las 5 variables', () => {
    expect(loadConfig(completo)).toEqual({
      quotes: 't-quotes',
      auditLog: 't-audit',
      byStatusIndex: 'byStatus',
      byDateIndex: 'byDate',
      settings: 't-settings',
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

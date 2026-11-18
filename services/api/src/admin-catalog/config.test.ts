import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';

const completo = {
  STONES_TABLE: 't-stones',
  PROJECTS_TABLE: 't-projects',
  FINISHES_TABLE: 't-finishes',
  SERVICES_TABLE: 't-services',
  AUDIT_TABLE: 't-audit',
};

describe('loadConfig', () => {
  it('lee las 5 variables', () => {
    expect(loadConfig(completo)).toEqual({
      tables: {
        stone: 't-stones',
        project: 't-projects',
        finish: 't-finishes',
        service: 't-services',
      },
      auditTable: 't-audit',
    });
  });

  it.each(Object.keys(completo))('lanza un error claro si falta %s', (clave) => {
    const env: Record<string, string | undefined> = { ...completo };
    delete env[clave];
    expect(() => loadConfig(env)).toThrow(new RegExp(`Falta la variable de entorno ${clave}`));
  });

  it('una variable vacía cuenta como faltante', () => {
    expect(() => loadConfig({ ...completo, AUDIT_TABLE: '' })).toThrow(/AUDIT_TABLE/);
  });
});

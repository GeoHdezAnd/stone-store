import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config';

const ENV = {
  QUOTES_TABLE: 'T-quotes',
  QUOTES_BY_STATUS_INDEX: 'byStatus',
  POSTAL_CODES_TABLE: 'T-cp',
};

describe('loadConfig (admin-metrics)', () => {
  it('lee las 3 variables (el resumen solo consulta por estado)', () => {
    expect(loadConfig(ENV)).toEqual({
      quotes: 'T-quotes',
      byStatusIndex: 'byStatus',
      postalCodes: 'T-cp',
    });
  });
  it.each(Object.keys(ENV))('falla con un mensaje claro si falta %s', (name) => {
    const env: Record<string, string | undefined> = { ...ENV, [name]: undefined };
    expect(() => loadConfig(env)).toThrow(name);
  });
  it('ignora QUOTES_BY_DATE_INDEX: el resumen no usa ese índice', () => {
    expect(loadConfig({ ...ENV, QUOTES_BY_DATE_INDEX: 'byDate' })).not.toHaveProperty(
      'byDateIndex',
    );
  });
  it('trata la cadena vacía como ausente', () => {
    expect(() => loadConfig({ ...ENV, QUOTES_TABLE: '' })).toThrow('QUOTES_TABLE');
  });
});

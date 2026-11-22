import { describe, expect, it } from 'vitest';
import { FREIGHT_VERSION_PATTERN, freightConfigSchema } from '../config';
import { makeConfigInput } from './test-fixtures';

const falla = (patch: Record<string, unknown>) =>
  !freightConfigSchema.safeParse(makeConfigInput(patch)).success;

const camion = (patch: Record<string, unknown> = {}) => ({
  id: 'a',
  nombre: 'A',
  capacidadKg: 1000,
  base: 100,
  porKm: 10,
  minimo: 200,
  ...patch,
});

describe('freightConfigSchema', () => {
  it('parsea una configuración válida y aplica idaYVuelta=false por defecto', () => {
    const cfg = freightConfigSchema.parse(makeConfigInput());
    expect(cfg.idaYVuelta).toBe(false);
    expect(cfg.ejemplo).toBe(true);
    expect(cfg.camiones).toHaveLength(3);
  });

  it('acepta activa opcional en la entrada', () => {
    expect(freightConfigSchema.parse(makeConfigInput({ activa: true })).activa).toBe(true);
    expect(freightConfigSchema.parse(makeConfigInput()).activa).toBeUndefined();
  });

  it('rechaza campos extra (strictObject)', () => {
    expect(falla({ extra: 1 })).toBe(true);
    expect(falla({ camiones: [camion({ extra: 1 })] })).toBe(true);
  });

  it('rechaza ids de camión duplicados', () => {
    expect(falla({ camiones: [camion(), camion()] })).toBe(true);
    expect(falla({ camiones: [camion(), camion({ id: 'b' })] })).toBe(false);
  });

  it('exige al menos un camión', () => {
    expect(falla({ camiones: [] })).toBe(true);
  });

  it.each([
    ['capacidadKg', 0],
    ['capacidadKg', -1],
    ['porKm', 0],
    ['minimo', 0],
    ['base', -1],
    ['base', Number.NaN],
    ['porKm', Number.POSITIVE_INFINITY],
    ['base', 100.123],
  ])('rechaza camión con %s = %s', (campo, valor) => {
    expect(falla({ camiones: [camion({ [campo]: valor })] })).toBe(true);
  });

  it('acepta base 0', () => {
    expect(falla({ camiones: [camion({ base: 0 })] })).toBe(false);
  });

  it.each([-0.01, 1.01, Number.NaN])('rechaza margenRango fuera de 0..1 (%s)', (m) => {
    expect(falla({ margenRango: m })).toBe(true);
  });
  it('acepta margenRango 0 y 1', () => {
    expect(falla({ margenRango: 0 })).toBe(false);
    expect(falla({ margenRango: 1 })).toBe(false);
  });

  it('rechaza mermaPct y recargoDescarga negativos', () => {
    expect(falla({ mermaPct: -1 })).toBe(true);
    expect(falla({ recargoDescarga: -1 })).toBe(true);
    expect(falla({ recargoDescarga: 0 })).toBe(false);
  });

  it('valida zonasCubiertas: prefijos de 2 a 5 dígitos y únicos', () => {
    expect(falla({ zonasCubiertas: ['7'] })).toBe(true);
    expect(falla({ zonasCubiertas: ['720000'] })).toBe(true);
    expect(falla({ zonasCubiertas: ['7a'] })).toBe(true);
    expect(falla({ zonasCubiertas: ['72', '72'] })).toBe(true);
    expect(falla({ zonasCubiertas: [] })).toBe(true);
    expect(falla({ zonasCubiertas: ['72', '74000'] })).toBe(false);
  });

  it('valida origen, maxKm, versión y fecha', () => {
    expect(falla({ origen: { lat: 91, lng: 0, nombre: 'x' } })).toBe(true);
    expect(falla({ origen: { lat: 0, lng: 181, nombre: 'x' } })).toBe(true);
    expect(falla({ maxKm: 0 })).toBe(true);
    expect(falla({ version: '' })).toBe(true);
    expect(falla({ creadaAt: 'ayer' })).toBe(true);
    expect(falla({ creadaPor: '' })).toBe(true);
  });
});

describe('FREIGHT_VERSION_PATTERN', () => {
  it.each(['t0001', 't0042', 't9999', 't10000'])('acepta %s', (v) => {
    expect(FREIGHT_VERSION_PATTERN.test(v)).toBe(true);
  });

  it.each([
    '',
    'ACTIVE',
    't1',
    't001',
    'T0001',
    'v0001',
    't0001x',
    'xt0001',
    't0001\n',
    't 0001',
    '../t0001',
  ])('rechaza %j', (v) => {
    expect(FREIGHT_VERSION_PATTERN.test(v)).toBe(false);
  });
});

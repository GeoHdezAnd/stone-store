import { describe, expect, it } from 'vitest';
import {
  CATALOG_MAX_BYTES,
  CATALOG_MIN_VERSION_ATTEMPTS,
  catalogSizeExceeded,
  compareCatalogVersions,
  decideCatalogVersion,
  decideUrlFailure,
  readCatalogBuildOptions,
} from '../rebuild';

describe('compareCatalogVersions', () => {
  it('compara numéricamente, no como texto', () => {
    expect(compareCatalogVersions('v0007', 'v0007')).toBe(0);
    expect(compareCatalogVersions('v0008', 'v0007')).toBeGreaterThan(0);
    expect(compareCatalogVersions('v0007', 'v0008')).toBeLessThan(0);
    // Con comparación lexicográfica «v9999» ganaría a «v10000».
    expect(compareCatalogVersions('v10000', 'v9999')).toBeGreaterThan(0);
    expect(compareCatalogVersions('v9999', 'v10000')).toBeLessThan(0);
  });

  it('rechaza versiones con formato inválido', () => {
    expect(() => compareCatalogVersions('7', 'v0007')).toThrow();
    expect(() => compareCatalogVersions('v0007', 'v7')).toThrow();
  });
});

describe('readCatalogBuildOptions', () => {
  it('sin variables: nada obligatorio (comportamiento de siempre)', () => {
    expect(readCatalogBuildOptions({})).toEqual({ required: false, minVersion: null });
  });

  it("CATALOG_REQUIRED: '1' = requerido; ausente, vacío o '0' = no requerido", () => {
    expect(readCatalogBuildOptions({ CATALOG_REQUIRED: '1' }).required).toBe(true);
    for (const v of ['0', '', undefined]) {
      expect(readCatalogBuildOptions({ CATALOG_REQUIRED: v }).required).toBe(false);
    }
  });

  it.each(['true', 'TRUE', 'yes', ' 1', '1 ', '01', '2', 'on'])(
    'CATALOG_REQUIRED con un valor ambiguo (%j) LANZA en vez de caer al seed en silencio',
    (v) => {
      expect(() => readCatalogBuildOptions({ CATALOG_REQUIRED: v })).toThrow(/CATALOG_REQUIRED/);
    },
  );

  it('lee CATALOG_MIN_VERSION y trata vacío como ausente', () => {
    expect(readCatalogBuildOptions({ CATALOG_MIN_VERSION: 'v0007' }).minVersion).toBe('v0007');
    expect(readCatalogBuildOptions({ CATALOG_MIN_VERSION: '' }).minVersion).toBeNull();
  });

  it('una versión mínima inválida es un error (no se ignora en silencio)', () => {
    expect(() => readCatalogBuildOptions({ CATALOG_MIN_VERSION: 'latest' })).toThrow(
      /CATALOG_MIN_VERSION/,
    );
  });
});

describe('catalogSizeExceeded', () => {
  it('el tope es de 2 MiB y el límite exacto sí cabe', () => {
    expect(CATALOG_MAX_BYTES).toBe(2 * 1024 * 1024);
    expect(catalogSizeExceeded(CATALOG_MAX_BYTES)).toBe(false);
    expect(catalogSizeExceeded(CATALOG_MAX_BYTES + 1)).toBe(true);
  });

  it('un tamaño no finito o negativo cuenta como excedido', () => {
    expect(catalogSizeExceeded(Number.NaN)).toBe(true);
    expect(catalogSizeExceeded(-1)).toBe(true);
  });
});

describe('decideCatalogVersion', () => {
  const base = { maxAttempts: 3 };

  it('sin versión mínima acepta cualquiera', () => {
    expect(
      decideCatalogVersion({ ...base, minVersion: null, version: 'v0001', attempt: 1 }),
    ).toEqual({
      action: 'accept',
    });
  });

  it('acepta una versión igual o mayor a la mínima', () => {
    for (const version of ['v0007', 'v0008', 'v10000']) {
      expect(decideCatalogVersion({ ...base, minVersion: 'v0007', version, attempt: 1 })).toEqual({
        action: 'accept',
      });
    }
  });

  it('si es más vieja, reintenta mientras queden intentos y luego falla', () => {
    const viejo = { ...base, minVersion: 'v0007', version: 'v0006' };
    expect(decideCatalogVersion({ ...viejo, attempt: 1 })).toEqual({ action: 'retry' });
    expect(decideCatalogVersion({ ...viejo, attempt: 2 })).toEqual({ action: 'retry' });
    expect(decideCatalogVersion({ ...viejo, attempt: 3 })).toEqual({
      action: 'fail',
      reason: 'version_too_old',
    });
  });

  it('el número de intentos por defecto es razonable', () => {
    expect(CATALOG_MIN_VERSION_ATTEMPTS).toBeGreaterThanOrEqual(3);
    expect(CATALOG_MIN_VERSION_ATTEMPTS).toBeLessThanOrEqual(10);
  });
});

describe('decideUrlFailure', () => {
  it('sin CATALOG_REQUIRED cae al seed (como hoy)', () => {
    expect(decideUrlFailure({ required: false })).toBe('use_seed');
  });

  it('con CATALOG_REQUIRED el build falla', () => {
    expect(decideUrlFailure({ required: true })).toBe('fail');
  });
});

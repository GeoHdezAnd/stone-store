import { describe, expect, it } from 'vitest';
import { folioCounterName, folioYear, MAX_FOLIO_NUMBER } from './folio';
import { formatFolio } from './schema';

describe('folioCounterName', () => {
  it('usa la clave `folio#<año>` de la tabla Counters', () => {
    expect(folioCounterName(2026)).toBe('folio#2026');
    expect(folioCounterName(2027)).toBe('folio#2027');
  });

  it.each([1999, 10000, 2026.5, Number.NaN])('rechaza el año %s', (y) => {
    expect(() => folioCounterName(y)).toThrow(RangeError);
  });
});

describe('folioYear', () => {
  it('toma el año en UTC (el mismo que `createdAt`)', () => {
    expect(folioYear(new Date('2026-12-31T23:59:59.999Z'))).toBe(2026);
    expect(folioYear(new Date('2027-01-01T00:00:00.000Z'))).toBe(2027);
    // 18:30 del 31 de dic en CDMX ya es 2027 en UTC: el folio sigue a `createdAt`.
    expect(folioYear(new Date('2027-01-01T00:30:00.000Z'))).toBe(2027);
  });
});

describe('MAX_FOLIO_NUMBER', () => {
  it('coincide con el último número que admite formatFolio', () => {
    expect(MAX_FOLIO_NUMBER).toBe(99_999);
    expect(formatFolio(2026, MAX_FOLIO_NUMBER)).toBe('CN-2026-99999');
    expect(() => formatFolio(2026, MAX_FOLIO_NUMBER + 1)).toThrow(RangeError);
  });
});

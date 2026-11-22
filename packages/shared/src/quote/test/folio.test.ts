import { describe, expect, it } from 'vitest';
import { folioCounterName, folioYear, MAX_FOLIO_NUMBER } from '../folio';
import { FOLIO_PATTERN, formatFolio } from '../schema';

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
  it('el tope es 999 999 (6 dígitos): mucho más de lo que un año de solicitudes puede gastar', () => {
    expect(MAX_FOLIO_NUMBER).toBe(999_999);
  });

  it('formatFolio y FOLIO_PATTERN llegan hasta el tope y no pasan de él', () => {
    expect(formatFolio(2026, MAX_FOLIO_NUMBER)).toBe('CN-2026-999999');
    expect(() => formatFolio(2026, MAX_FOLIO_NUMBER + 1)).toThrow(RangeError);
  });
});

describe('formatFolio: frontera de 5 a 6 dígitos', () => {
  it.each([
    [1, 'CN-2026-00001'],
    [99_999, 'CN-2026-99999'],
    [100_000, 'CN-2026-100000'],
    [100_001, 'CN-2026-100001'],
    [999_999, 'CN-2026-999999'],
  ])('%i -> %s, y el resultado cumple FOLIO_PATTERN', (n, esperado) => {
    expect(formatFolio(2026, n)).toBe(esperado);
    expect(FOLIO_PATTERN.test(esperado)).toBe(true);
  });

  it.each([0, -1, 1_000_000, 1.5, Number.NaN])('rechaza el número %s', (n) => {
    expect(() => formatFolio(2026, n)).toThrow(RangeError);
  });
});

describe('FOLIO_PATTERN', () => {
  it.each(['CN-2026-00042', 'CN-2026-99999', 'CN-2026-100000', 'CN-2026-999999'])(
    'acepta %s',
    (f) => expect(FOLIO_PATTERN.test(f)).toBe(true),
  );

  it.each([
    'CN-2026-0042',
    'CN-2026-1000000',
    'CN-2026-012345',
    'CN-2026-',
    'cn-2026-00042',
    'CN-2026-00042\n',
  ])('rechaza %j', (f) => expect(FOLIO_PATTERN.test(f)).toBe(false));
});

import { describe, expect, it } from 'vitest';
import { generateUlid, isUlid, ulidTime, ULID_PATTERN } from './ulid';

describe('ULID', () => {
  it('genera 26 caracteres válidos y ordenables por tiempo', () => {
    const rnd = () => 0.5;
    const a = generateUlid(1_700_000_000_000, rnd);
    const b = generateUlid(1_700_000_000_001, rnd);
    expect(a).toMatch(ULID_PATTERN);
    expect(a).toHaveLength(26);
    expect(a < b).toBe(true);
    expect(ulidTime(a)).toBe(1_700_000_000_000);
  });

  it('isUlid solo acepta mayúsculas Crockford de 26 caracteres', () => {
    expect(isUlid('01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe(true);
    for (const x of [
      '',
      '01arz3ndektsv4rrffq69g5fav',
      '01ARZ3NDEKTSV4RRFFQ69G5FAU',
      '01ARZ3NDEKTSV4RRFFQ69G5FA',
      'export.csv',
      null,
      5,
      '../etc/passwd',
    ]) {
      expect(isUlid(x)).toBe(false);
    }
  });

  it('rechaza tiempos fuera de rango', () => {
    expect(() => generateUlid(-1, () => 0)).toThrow();
    expect(() => generateUlid(2 ** 48, () => 0)).toThrow();
  });
});

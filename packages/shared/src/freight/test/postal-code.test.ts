import { describe, expect, it } from 'vitest';
import { postalCodeFileSchema, postalCodeSchema } from '../postal-code';

const cp = (patch: Record<string, unknown> = {}) => ({
  cp: '72000',
  estado: 'Puebla',
  municipio: 'Puebla',
  colonia: 'Centro',
  lat: 19.04,
  lng: -98.2,
  ...patch,
});

const falla = (patch: Record<string, unknown>) => !postalCodeSchema.safeParse(cp(patch)).success;

describe('postalCodeSchema', () => {
  it('acepta un código postal válido', () => {
    expect(postalCodeSchema.parse(cp())).toEqual(cp());
  });

  it('el cp debe ser de exactamente 5 dígitos', () => {
    for (const malo of ['7200', '720000', 'abcde', '7200a', ' 72000', '72000\n', '']) {
      expect(falla({ cp: malo }), malo).toBe(true);
    }
    expect(falla({ cp: 72000 })).toBe(true);
  });

  it('exige estado, municipio y colonia no vacíos', () => {
    for (const campo of ['estado', 'municipio', 'colonia']) {
      expect(falla({ [campo]: '' }), campo).toBe(true);
    }
  });

  it('lat y lng deben estar en rango y ser finitas', () => {
    expect(falla({ lat: 90.1 })).toBe(true);
    expect(falla({ lat: -90.1 })).toBe(true);
    expect(falla({ lng: 180.1 })).toBe(true);
    expect(falla({ lng: -180.1 })).toBe(true);
    expect(falla({ lat: Number.NaN })).toBe(true);
    expect(falla({ lng: Number.POSITIVE_INFINITY })).toBe(true);
    expect(falla({ lat: '19' })).toBe(true);
    expect(falla({ lat: 90, lng: 180 })).toBe(true);
  });

  it('las coordenadas deben caer en México (lat 14 a 33, lng -118 a -86)', () => {
    expect(falla({ lat: 13.99 })).toBe(true);
    expect(falla({ lat: 33.01 })).toBe(true);
    expect(falla({ lng: -118.01 })).toBe(true);
    expect(falla({ lng: -85.99 })).toBe(true);
    expect(falla({ lat: 14, lng: -118 })).toBe(false);
    expect(falla({ lat: 33, lng: -86 })).toBe(false);
    // Coordenadas invertidas (lng, lat) también se rechazan.
    expect(falla({ lat: -98.2, lng: 19.04 })).toBe(true);
  });

  it('rechaza campos desconocidos (esquema estricto)', () => {
    expect(falla({ extra: 1 })).toBe(true);
  });
});

describe('postalCodeFileSchema (sobre de content/postal-codes.json)', () => {
  const sobre = (patch: Record<string, unknown> = {}) => ({
    ejemplo: true,
    aviso: 'Datos de ejemplo, no reales.',
    items: [cp()],
    ...patch,
  });

  it('acepta el sobre con ejemplo:true, aviso e items', () => {
    expect(postalCodeFileSchema.safeParse(sobre()).success).toBe(true);
  });

  it('exige ejemplo:true literal', () => {
    expect(postalCodeFileSchema.safeParse(sobre({ ejemplo: false })).success).toBe(false);
    expect(postalCodeFileSchema.safeParse(sobre({ ejemplo: undefined })).success).toBe(false);
  });

  it('exige aviso no vacío y al menos un item', () => {
    expect(postalCodeFileSchema.safeParse(sobre({ aviso: '' })).success).toBe(false);
    expect(postalCodeFileSchema.safeParse(sobre({ items: [] })).success).toBe(false);
  });

  it('rechaza cps repetidos', () => {
    expect(postalCodeFileSchema.safeParse(sobre({ items: [cp(), cp()] })).success).toBe(false);
  });
});

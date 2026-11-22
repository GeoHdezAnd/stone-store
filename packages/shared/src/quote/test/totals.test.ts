import { describe, expect, it } from 'vitest';
import { computeFinalQuote, mxnFromCents } from '../totals';

const items = [
  { stoneId: 'arenisca', cantidad: 10.5, unidad: 'm2' as const },
  { stoneId: 'caliza', cantidad: 3, unidad: 'pieza' as const },
];

describe('computeFinalQuote (centavos enteros)', () => {
  it('calcula subtotales, subtotal y total en el servidor', () => {
    const r = computeFinalQuote({
      items,
      prices: [
        { stoneId: 'arenisca', precioUnitario: 120.1 },
        { stoneId: 'caliza', precioUnitario: 0.1 },
      ],
      fleteFinal: 1500.05,
      vigenciaDias: 15,
    });
    expect(r.items).toEqual([
      { stoneId: 'arenisca', precioUnitario: 120.1, subtotal: 1261.05 },
      { stoneId: 'caliza', precioUnitario: 0.1, subtotal: 0.3 },
    ]);
    expect(r.subtotal).toBe(1261.35);
    expect(r.total).toBe(2761.4);
    expect(r.iva).toBeNull();
    expect(r.ivaPct).toBeNull();
    expect(r.vigenciaDias).toBe(15);
  });

  it('0.1 + 0.2 no deja ruido de coma flotante', () => {
    const r = computeFinalQuote({
      items: [
        { stoneId: 'a', cantidad: 1, unidad: 'pieza' },
        { stoneId: 'b', cantidad: 1, unidad: 'pieza' },
      ],
      prices: [
        { stoneId: 'a', precioUnitario: 0.1 },
        { stoneId: 'b', precioUnitario: 0.2 },
      ],
      fleteFinal: 0,
      vigenciaDias: 15,
    });
    expect(r.subtotal).toBe(0.3);
    expect(r.total).toBe(0.3);
  });

  it('redondea el subtotal a centavos enteros (3.33 × 0.10 = 0.33)', () => {
    const r = computeFinalQuote({
      items: [{ stoneId: 'a', cantidad: 3.33, unidad: 'm2' }],
      prices: [{ stoneId: 'a', precioUnitario: 0.1 }],
      fleteFinal: 0,
      vigenciaDias: 15,
    });
    expect(r.items[0]!.subtotal).toBe(0.33);
    expect(r.total).toBe(0.33);
  });

  it('respeta el orden de los renglones de la solicitud', () => {
    const r = computeFinalQuote({
      items,
      prices: [
        { stoneId: 'caliza', precioUnitario: 1 },
        { stoneId: 'arenisca', precioUnitario: 1 },
      ],
      fleteFinal: 0,
      vigenciaDias: 15,
    });
    expect(r.items.map((i) => i.stoneId)).toEqual(['arenisca', 'caliza']);
  });

  it('lanza si falta, sobra o se repite un precio', () => {
    const base = { items, fleteFinal: 0, vigenciaDias: 15 };
    expect(() =>
      computeFinalQuote({ ...base, prices: [{ stoneId: 'arenisca', precioUnitario: 1 }] }),
    ).toThrow();
    expect(() =>
      computeFinalQuote({
        ...base,
        prices: [
          { stoneId: 'arenisca', precioUnitario: 1 },
          { stoneId: 'caliza', precioUnitario: 1 },
          { stoneId: 'otra', precioUnitario: 1 },
        ],
      }),
    ).toThrow();
    expect(() =>
      computeFinalQuote({
        ...base,
        prices: [
          { stoneId: 'arenisca', precioUnitario: 1 },
          { stoneId: 'arenisca', precioUnitario: 1 },
        ],
      }),
    ).toThrow();
  });

  it('mxnFromCents convierte a pesos con 2 decimales', () => {
    expect(mxnFromCents(126135)).toBe(1261.35);
  });
});

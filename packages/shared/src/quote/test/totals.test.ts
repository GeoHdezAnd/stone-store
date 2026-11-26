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
      ivaPct: null,
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
      ivaPct: null,
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
      ivaPct: null,
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
      ivaPct: null,
    });
    expect(r.items.map((i) => i.stoneId)).toEqual(['arenisca', 'caliza']);
  });

  it('lanza si falta, sobra o se repite un precio', () => {
    const base = { items, fleteFinal: 0, vigenciaDias: 15, ivaPct: null };
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

describe('computeFinalQuote: IVA solo sobre la piedra (centavos enteros)', () => {
  const one = [{ stoneId: 'a', cantidad: 1, unidad: 'pieza' as const }];
  const calc = (precio: number, flete: number, ivaPct: 8 | 16 | null) =>
    computeFinalQuote({
      items: one,
      prices: [{ stoneId: 'a', precioUnitario: precio }],
      fleteFinal: flete,
      vigenciaDias: 15,
      ivaPct,
    });

  it('16 %: IVA sobre la piedra y flete aparte', () => {
    const r = calc(1000, 500, 16);
    expect(r.subtotal).toBe(1000);
    expect(r.iva).toBe(160);
    expect(r.ivaPct).toBe(16);
    expect(r.fleteFinal).toBe(500);
    expect(r.total).toBe(1660);
  });

  it('8 %', () => {
    const r = calc(1000, 500, 8);
    expect(r.iva).toBe(80);
    expect(r.ivaPct).toBe(8);
    expect(r.total).toBe(1580);
  });

  it('null: sin IVA (iva null) y total = piedra + flete', () => {
    const r = calc(1000, 500, null);
    expect(r.iva).toBeNull();
    expect(r.ivaPct).toBeNull();
    expect(r.total).toBe(1500);
  });

  it('el flete NO paga IVA: cambiar el flete no cambia el IVA', () => {
    expect(calc(1000, 0, 16).iva).toBe(160);
    expect(calc(1000, 99999, 16).iva).toBe(160);
    expect(calc(1000, 99999, 16).total).toBe(1160 + 99999);
  });

  it('flete 0: total = piedra + IVA', () => {
    expect(calc(250, 0, 16).total).toBe(290);
  });

  it('redondea el IVA al centavo más cercano (no trunca)', () => {
    // 3 centavos × 16 % = 0.48 centavos → 0
    expect(calc(0.03, 0, 16).iva).toBe(0);
    // 4 centavos × 16 % = 0.64 → 1 (con floor daría 0)
    expect(calc(0.04, 0, 16).iva).toBe(0.01);
    // 94 centavos × 8 % = 7.52 → 8 (con floor daría 7)
    expect(calc(0.94, 0, 8).iva).toBe(0.08);
    // 31 centavos × 8 % = 2.48 → 2
    expect(calc(0.31, 0, 8).iva).toBe(0.02);
    // exacto: 6.25 × 8 % = 0.50
    expect(calc(6.25, 0, 8).iva).toBe(0.5);
  });

  it('identidad: piedra + IVA + flete = total en muchos renglones', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      stoneId: `s${i}`,
      cantidad: 1.37 + i,
      unidad: 'm2' as const,
    }));
    for (const ivaPct of [null, 8, 16] as const) {
      const r = computeFinalQuote({
        items: many,
        prices: many.map((m, i) => ({ stoneId: m.stoneId, precioUnitario: 12.34 + i * 0.07 })),
        fleteFinal: 1234.56,
        vigenciaDias: 15,
        ivaPct,
      });
      const cents = (n: number) => Math.round(n * 100);
      const sumItems = r.items.reduce((a, i) => a + cents(i.subtotal), 0);
      expect(cents(r.subtotal)).toBe(sumItems);
      expect(cents(r.subtotal) + cents(r.iva ?? 0) + cents(r.fleteFinal)).toBe(cents(r.total));
    }
  });

  it('enteros evitan ruido de flotantes con IVA (0.1 + 0.2 a 16 %)', () => {
    const r = computeFinalQuote({
      items: [
        { stoneId: 'a', cantidad: 1, unidad: 'pieza' },
        { stoneId: 'b', cantidad: 1, unidad: 'pieza' },
      ],
      prices: [
        { stoneId: 'a', precioUnitario: 0.1 },
        { stoneId: 'b', precioUnitario: 0.2 },
      ],
      fleteFinal: 0.1,
      vigenciaDias: 15,
      ivaPct: 16,
    });
    expect(r.subtotal).toBe(0.3);
    expect(r.iva).toBe(0.05); // 30 × 16 / 100 = 4.8 → 5 centavos
    expect(r.total).toBe(0.45);
  });

  it('rechaza una tasa fuera del enum aunque llegue con tipos forzados', () => {
    expect(() => calc(100, 0, 7 as never)).toThrow();
    expect(() => calc(100, 0, 0 as never)).toThrow();
    expect(() => calc(100, 0, undefined as never)).toThrow();
  });
});

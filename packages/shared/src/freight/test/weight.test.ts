import { describe, expect, it } from 'vitest';
import { freightConfigSchema } from '../config';
import { FreightError } from '../errors';
import {
  MAX_ITEM_QUANTITY,
  MAX_ITEMS,
  MAX_TOTAL_WEIGHT_KG,
  MIN_ITEM_QUANTITY,
  computeWeightKg,
} from '../weight';
import { arenisca, caliza, makeConfigInput, makeStone, stones } from './test-fixtures';

const cfg = freightConfigSchema.parse(makeConfigInput());
const cfgMerma = freightConfigSchema.parse(makeConfigInput({ mermaPct: 5 }));

function codigo(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(FreightError);
    return (e as FreightError).code;
  }
  throw new Error('se esperaba FreightError');
}

describe('computeWeightKg', () => {
  it('1 m² a 5 cm pesa 110 kg (densidad 2200)', () => {
    const w = computeWeightKg(
      [{ stoneId: 'arenisca', cantidad: 1, unidad: 'm2', espesorCm: 5 }],
      stones,
      cfg,
    );
    expect(w).toBe(110);
  });

  it('210 m² a 5 cm pesan 23100 kg exactos (sin ruido de coma flotante)', () => {
    expect(
      computeWeightKg(
        [{ stoneId: 'arenisca', cantidad: 210, unidad: 'm2', espesorCm: 5 }],
        stones,
        cfg,
      ),
    ).toBe(23100);
  });

  it('usa la densidad aunque la piedra traiga pesoKgPorM2PorCm (precedencia: densidad primero)', () => {
    const rara = makeStone({ id: 'rara', pesoKgPorM2PorCm: 999, densidadKgM3: 2000 });
    expect(
      computeWeightKg([{ stoneId: 'rara', cantidad: 1, unidad: 'm2', espesorCm: 5 }], [rara], cfg),
    ).toBe(100);
  });

  it('pieza: pesoKgPorPieza × n', () => {
    expect(
      computeWeightKg([{ stoneId: 'arenisca', cantidad: 4, unidad: 'pieza' }], stones, cfg),
    ).toBe(140);
  });

  it('tonelada: n × 1000', () => {
    expect(
      computeWeightKg([{ stoneId: 'caliza', cantidad: 2.5, unidad: 'tonelada' }], stones, cfg),
    ).toBe(2500);
  });

  it('suma una mezcla de piedras y unidades', () => {
    const w = computeWeightKg(
      [
        { stoneId: 'arenisca', cantidad: 10, unidad: 'm2', espesorCm: 3 },
        { stoneId: 'caliza', cantidad: 1, unidad: 'tonelada' },
        { stoneId: 'arenisca', cantidad: 2, unidad: 'pieza' },
      ],
      stones,
      cfg,
    );
    expect(w).toBe(660 + 1000 + 70);
  });

  it('agrega la merma (mermaPct = 5 %)', () => {
    expect(
      computeWeightKg([{ stoneId: 'caliza', cantidad: 1, unidad: 'tonelada' }], stones, cfgMerma),
    ).toBe(1050);
  });

  it('rechaza piedra inexistente', () => {
    expect(
      codigo(() =>
        computeWeightKg([{ stoneId: 'nada', cantidad: 1, unidad: 'tonelada' }], stones, cfg),
      ),
    ).toBe('unknown_stone');
  });

  it('rechaza piedra inactiva', () => {
    expect(
      codigo(() =>
        computeWeightKg([{ stoneId: 'travertino', cantidad: 1, unidad: 'tonelada' }], stones, cfg),
      ),
    ).toBe('inactive_stone');
  });

  it('rechaza unidad no vendida por la piedra', () => {
    expect(
      codigo(() =>
        computeWeightKg([{ stoneId: 'caliza', cantidad: 1, unidad: 'pieza' }], stones, cfg),
      ),
    ).toBe('unit_not_sold');
  });

  it('rechaza unidad desconocida', () => {
    expect(
      codigo(() =>
        computeWeightKg(
          [{ stoneId: 'caliza', cantidad: 1, unidad: 'litro' as never }],
          stones,
          cfg,
        ),
      ),
    ).toBe('unit_not_sold');
  });

  it('rechaza espesor no disponible o ausente en m²', () => {
    expect(
      codigo(() =>
        computeWeightKg(
          [{ stoneId: 'arenisca', cantidad: 1, unidad: 'm2', espesorCm: 4 }],
          stones,
          cfg,
        ),
      ),
    ).toBe('thickness_not_available');
    expect(
      codigo(() =>
        computeWeightKg([{ stoneId: 'arenisca', cantidad: 1, unidad: 'm2' }], stones, cfg),
      ),
    ).toBe('thickness_not_available');
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, MAX_ITEM_QUANTITY + 1])(
    'rechaza cantidad inválida (%s)',
    (cantidad) => {
      expect(
        codigo(() =>
          computeWeightKg([{ stoneId: 'caliza', cantidad, unidad: 'tonelada' }], stones, cfg),
        ),
      ).toBe('invalid_quantity');
    },
  );

  it('acepta la cantidad tope exacta (por ítem)', () => {
    const liviana = makeStone({ id: 'liviana', vendidaPor: ['pieza'], pesoKgPorPieza: 1 });
    expect(
      computeWeightKg(
        [{ stoneId: 'liviana', cantidad: MAX_ITEM_QUANTITY, unidad: 'pieza' }],
        [liviana],
        cfg,
      ),
    ).toBe(MAX_ITEM_QUANTITY);
  });

  it('rechaza piezas no enteras', () => {
    expect(
      codigo(() =>
        computeWeightKg([{ stoneId: 'arenisca', cantidad: 1.5, unidad: 'pieza' }], stones, cfg),
      ),
    ).toBe('invalid_quantity');
  });

  it('rechaza lista vacía o demasiado larga', () => {
    expect(codigo(() => computeWeightKg([], stones, cfg))).toBe('invalid_items');
    const muchos = Array.from({ length: MAX_ITEMS + 1 }, () => ({
      stoneId: 'caliza',
      cantidad: 1,
      unidad: 'tonelada' as const,
    }));
    expect(codigo(() => computeWeightKg(muchos, stones, cfg))).toBe('invalid_items');
  });

  it('los mensajes de error están en español y no reproducen datos enviados', () => {
    expect.assertions(3);
    try {
      computeWeightKg([{ stoneId: '<script>', cantidad: 1, unidad: 'tonelada' }], stones, cfg);
    } catch (e) {
      expect(e).toBeInstanceOf(FreightError);
      expect((e as Error).message).not.toContain('<script>');
      expect((e as Error).message).toMatch(/piedra/i);
    }
  });

  it('cantidad mínima: por debajo de MIN_ITEM_QUANTITY es invalid_quantity', () => {
    const f = (cantidad: number) => () =>
      computeWeightKg([{ stoneId: 'caliza', cantidad, unidad: 'tonelada' }], stones, cfg);
    expect(MIN_ITEM_QUANTITY).toBe(0.01);
    expect(codigo(f(MIN_ITEM_QUANTITY / 2))).toBe('invalid_quantity');
    expect(f(MIN_ITEM_QUANTITY)).not.toThrow();
  });

  it('un peso total que redondea a 0 es error', () => {
    const ligera = makeStone({
      id: 'ligera',
      vendidaPor: ['pieza'],
      pesoKgPorPieza: 0.0001,
      espesoresCm: [],
    });
    expect(
      codigo(() =>
        computeWeightKg([{ stoneId: 'ligera', cantidad: 1, unidad: 'pieza' }], [ligera], cfg),
      ),
    ).toBe('invalid_quantity');
  });

  it('tope total: 50 renglones de 100000 t → too_large (mensaje en español)', () => {
    const muchos = Array.from({ length: MAX_ITEMS }, () => ({
      stoneId: 'caliza',
      cantidad: MAX_ITEM_QUANTITY,
      unidad: 'tonelada' as const,
    }));
    expect(codigo(() => computeWeightKg(muchos, stones, cfg))).toBe('too_large');
    expect.assertions(3);
    try {
      computeWeightKg(muchos, stones, cfg);
    } catch (e) {
      expect((e as Error).message).toMatch(/WhatsApp/);
    }
  });

  it('tope total exacto: MAX_TOTAL_WEIGHT_KG pasa, un kg más no (merma incluida)', () => {
    const t = (kg: number) => () =>
      computeWeightKg(
        [{ stoneId: 'caliza', cantidad: kg / 1000, unidad: 'tonelada' }],
        stones,
        cfg,
      );
    expect(MAX_TOTAL_WEIGHT_KG).toBe(500_000);
    expect(t(MAX_TOTAL_WEIGHT_KG)).not.toThrow();
    expect(codigo(t(MAX_TOTAL_WEIGHT_KG + 1))).toBe('too_large');
    // la merma cuenta para el tope
    const conMerma = () =>
      computeWeightKg([{ stoneId: 'caliza', cantidad: 480, unidad: 'tonelada' }], stones, cfgMerma);
    expect(codigo(conMerma)).toBe('too_large'); // 480 t × 1.05 = 504 t
  });

  it('usa arenisca y caliza distintas (sanidad de fixtures)', () => {
    expect(arenisca.densidadKgM3).not.toBe(caliza.densidadKgM3);
  });
});

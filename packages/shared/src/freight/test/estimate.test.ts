import { describe, expect, it } from 'vitest';
import { freightConfigSchema, type FreightConfig } from '../config';
import { FreightError } from '../errors';
import { estimateFreight, FREIGHT_NOTICE, MAX_TRIPS } from '../estimate';
import { stones, makeConfigInput } from './test-fixtures';

const make = (patch: Record<string, unknown> = {}): FreightConfig =>
  freightConfigSchema.parse(makeConfigInput(patch));
const cfg = make();
const CP = '74000';
const m2 = (cantidad: number, espesorCm = 5) => ({
  stoneId: 'arenisca',
  cantidad,
  unidad: 'm2' as const,
  espesorCm,
});

function codigo(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(FreightError);
    return (e as FreightError).code;
  }
  throw new Error('se esperaba FreightError');
}

describe('estimateFreight', () => {
  it('1 m²: camioneta, 1 viaje, rango redondeado a 50', () => {
    // 1544 + 500 = 2044; ±10 %: 1839.6 → 1800 (floor), 2248.4 → 2250 (ceil)
    expect(
      estimateFreight({
        codigoPostal: '74000',
        distanciaKm: 62,
        items: [m2(1)],
        stones,
        config: cfg,
      }),
    ).toEqual({
      estimadoMin: 1800,
      estimadoMax: 2250,
      moneda: 'MXN',
      pesoTotalKg: 110,
      distanciaKm: 62,
      camion: 'Camioneta',
      viajes: 1,
      versionTarifa: 'v1',
      ejemplo: true,
      aviso: 'Estimado sujeto a confirmación.',
    });
    expect(FREIGHT_NOTICE).toBe('Estimado sujeto a confirmación.');
  });

  it('210 m² en tráiler (23100 kg): un viaje', () => {
    const r = estimateFreight({
      codigoPostal: CP,
      distanciaKm: 62,
      items: [m2(210)],
      stones,
      config: cfg,
    });
    expect(r).toMatchObject({
      camion: 'Tráiler',
      viajes: 1,
      pesoTotalKg: 23100,
      estimadoMin: 5850,
      estimadoMax: 7150,
    });
  });

  it('210 m² con varios viajes cuando el camión mayor es chico', () => {
    const c = make({
      camiones: [
        { id: 'c', nombre: 'Camión 10 t', capacidadKg: 10000, base: 1000, porKm: 20, minimo: 2000 },
      ],
    });
    // 3 viajes × (1000 + 1240 = 2240) + 500 = 7220; ±10 %: 6498 → 6450, 7942 → 7950
    const r = estimateFreight({
      codigoPostal: CP,
      distanciaKm: 62,
      items: [m2(210)],
      stones,
      config: c,
    });
    expect(r).toMatchObject({ viajes: 3, estimadoMin: 6450, estimadoMax: 7950 });
  });

  it('tonelada y mezcla de piedras suman peso', () => {
    const r = estimateFreight({
      codigoPostal: CP,
      distanciaKm: 62,
      stones,
      config: cfg,
      items: [{ stoneId: 'caliza', cantidad: 2, unidad: 'tonelada' }, m2(10, 3)],
    });
    expect(r.pesoTotalKg).toBe(2000 + 660);
    expect(r.camion).toBe('Camioneta');
  });

  it('merma aumenta el peso y puede cambiar de camión', () => {
    const items = [{ stoneId: 'caliza', cantidad: 3.4, unidad: 'tonelada' as const }];
    expect(
      estimateFreight({ codigoPostal: CP, distanciaKm: 62, items, stones, config: cfg }).camion,
    ).toBe('Camioneta');
    const r = estimateFreight({
      codigoPostal: CP,
      distanciaKm: 62,
      items,
      stones,
      config: make({ mermaPct: 5 }),
    });
    expect(r.pesoTotalKg).toBe(3570);
    expect(r.camion).toBe('Torton');
  });

  it('pesoTotalKg se redondea hacia arriba para no contradecir el camión elegido', () => {
    // 3.50001 t = 3500.01 kg > 3500 kg de la camioneta → torton, y el peso mostrado es 3501
    const items = [{ stoneId: 'caliza', cantidad: 3.50001, unidad: 'tonelada' as const }];
    const r = estimateFreight({ codigoPostal: CP, distanciaKm: 62, items, stones, config: cfg });
    expect(r).toMatchObject({ camion: 'Torton', pesoTotalKg: 3501 });
    const exacto = estimateFreight({
      codigoPostal: CP,
      distanciaKm: 62,
      items: [m2(210)],
      stones,
      config: cfg,
    });
    expect(exacto.pesoTotalKg).toBe(23100);
  });

  it('MAX_TRIPS: demasiados viajes → too_large', () => {
    const c = make({
      camiones: [{ id: 'c', nombre: 'C', capacidadKg: 1000, base: 100, porKm: 10, minimo: 100 }],
    });
    const items = (t: number) => [{ stoneId: 'caliza', cantidad: t, unidad: 'tonelada' as const }];
    expect(
      estimateFreight({
        codigoPostal: CP,
        distanciaKm: 10,
        items: items(MAX_TRIPS),
        stones,
        config: c,
      }).viajes,
    ).toBe(MAX_TRIPS);
    expect(
      codigo(() =>
        estimateFreight({
          codigoPostal: CP,
          distanciaKm: 10,
          items: items(MAX_TRIPS + 1),
          stones,
          config: c,
        }),
      ),
    ).toBe('too_large');
  });

  it('tarifa mínima: a distancia corta manda el mínimo del camión', () => {
    // camioneta a 5 km: 800 + 60 = 860 < 1500 → 1500 + 500 = 2000; 1800 / 2200
    const r = estimateFreight({
      codigoPostal: CP,
      distanciaKm: 5,
      items: [m2(1)],
      stones,
      config: cfg,
    });
    expect(r).toMatchObject({ estimadoMin: 1800, estimadoMax: 2200 });
  });

  it('ida y vuelta duplica el costo de viajes pero no el recargo de descarga', () => {
    const c = make({ idaYVuelta: true });
    // 1544 × 2 + 500 = 3588; 3229.2 → 3200, 3946.8 → 3950
    const r = estimateFreight({
      codigoPostal: CP,
      distanciaKm: 62,
      items: [m2(1)],
      stones,
      config: c,
    });
    expect(r).toMatchObject({ estimadoMin: 3200, estimadoMax: 3950 });
  });

  it('redondeo: min hacia abajo y max hacia arriba a múltiplos de 50 (incluye frontera exacta)', () => {
    // margen 0: el costo exacto ya es múltiplo de 50 → no se mueve; si no, floor/ceil
    const exacto = estimateFreight({
      codigoPostal: CP,
      distanciaKm: 5,
      items: [m2(1)],
      stones,
      config: make({ margenRango: 0 }),
    });
    expect(exacto).toMatchObject({ estimadoMin: 2000, estimadoMax: 2000 });
    const no = estimateFreight({
      codigoPostal: CP,
      distanciaKm: 62,
      items: [m2(1)],
      stones,
      config: make({ margenRango: 0 }),
    });
    expect(no).toMatchObject({ estimadoMin: 2000, estimadoMax: 2050 });
  });

  it('el rango nunca invierte: min <= max y ambos múltiplos de 50', () => {
    for (const margen of [0, 0.05, 0.1, 0.33, 1]) {
      for (const km of [1, 17, 62, 123.4, 349]) {
        const r = estimateFreight({
          codigoPostal: CP,
          distanciaKm: km,
          items: [m2(3)],
          stones,
          config: make({ margenRango: margen }),
        });
        expect(r.estimadoMin).toBeLessThanOrEqual(r.estimadoMax);
        expect(r.estimadoMin % 50).toBe(0);
        expect(r.estimadoMax % 50).toBe(0);
      }
    }
  });

  it('CP con formato inválido', () => {
    for (const cp of ['7400', '740000', 'abcde', '74 00', '']) {
      expect(
        codigo(() =>
          estimateFreight({
            codigoPostal: cp,
            distanciaKm: 10,
            items: [m2(1)],
            stones,
            config: cfg,
          }),
        ),
      ).toBe('invalid_postal_code');
    }
  });

  it('CP fuera de zona cubierta → out_of_zone con mensaje de WhatsApp', () => {
    try {
      estimateFreight({
        codigoPostal: '20000',
        distanciaKm: 10,
        items: [m2(1)],
        stones,
        config: cfg,
      });
      throw new Error('debía fallar');
    } catch (e) {
      expect((e as FreightError).code).toBe('out_of_zone');
      expect((e as Error).message).toMatch(/consúltenos por WhatsApp/);
    }
  });

  it('el prefijo de zona debe estar al inicio del CP (no en medio)', () => {
    const c = make({ zonasCubiertas: ['74'] });
    expect(
      codigo(() =>
        estimateFreight({
          codigoPostal: '17400',
          distanciaKm: 10,
          items: [m2(1)],
          stones,
          config: c,
        }),
      ),
    ).toBe('out_of_zone');
  });

  it('peso con merma que cae justo en la capacidad cabe en un viaje (sin ruido de coma flotante)', () => {
    // 3 t × 1.10 = 3300.0000000000005 en flotante; el camión de 3300 kg debe bastar
    const c = make({
      mermaPct: 10,
      camiones: [{ id: 'c', nombre: 'C', capacidadKg: 3300, base: 100, porKm: 10, minimo: 100 }],
    });
    const items = [{ stoneId: 'caliza', cantidad: 3, unidad: 'tonelada' as const }];
    expect(
      estimateFreight({ codigoPostal: CP, distanciaKm: 10, items, stones, config: c }),
    ).toMatchObject({
      viajes: 1,
      pesoTotalKg: 3300,
    });
  });

  it('CP dentro de zona por prefijo (2 a 5 dígitos)', () => {
    expect(() =>
      estimateFreight({
        codigoPostal: '74000',
        distanciaKm: 10,
        items: [m2(1)],
        stones,
        config: cfg,
      }),
    ).not.toThrow();
    const c = make({ zonasCubiertas: ['74000'] });
    expect(() =>
      estimateFreight({
        codigoPostal: '74000',
        distanciaKm: 10,
        items: [m2(1)],
        stones,
        config: c,
      }),
    ).not.toThrow();
    expect(
      codigo(() =>
        estimateFreight({
          codigoPostal: '74001',
          distanciaKm: 10,
          items: [m2(1)],
          stones,
          config: c,
        }),
      ),
    ).toBe('out_of_zone');
  });

  it('codigoPostal es obligatorio: omitirlo NO salta la validación en silencio', () => {
    const sinCp = { distanciaKm: 10, items: [m2(1)], stones, config: cfg } as never;
    expect(codigo(() => estimateFreight(sinCp))).toBe('invalid_postal_code');
  });

  it('skipZoneCheck: true permite omitir el CP (simulador) y salta solo la zona', () => {
    const r = estimateFreight({
      distanciaKm: 10,
      items: [m2(1)],
      stones,
      config: cfg,
      skipZoneCheck: true,
    });
    expect(r.viajes).toBe(1);
    // con CP fuera de zona tampoco falla por zona...
    expect(() =>
      estimateFreight({
        codigoPostal: '20000',
        distanciaKm: 10,
        items: [m2(1)],
        stones,
        config: cfg,
        skipZoneCheck: true,
      }),
    ).not.toThrow();
    // ...pero el formato del CP, si se da, se sigue validando
    expect(
      codigo(() =>
        estimateFreight({
          codigoPostal: '2000',
          distanciaKm: 10,
          items: [m2(1)],
          stones,
          config: cfg,
          skipZoneCheck: true,
        }),
      ),
    ).toBe('invalid_postal_code');
    // y maxKm sigue aplicando
    expect(
      codigo(() =>
        estimateFreight({
          distanciaKm: 351,
          items: [m2(1)],
          stones,
          config: cfg,
          skipZoneCheck: true,
        }),
      ),
    ).toBe('out_of_zone');
  });

  it('skipZoneCheck distinto de true (p. ej. 1 o "true") no salta la zona', () => {
    const base = { codigoPostal: '20000', distanciaKm: 10, items: [m2(1)], stones, config: cfg };
    expect(codigo(() => estimateFreight({ ...base, skipZoneCheck: 1 } as never))).toBe(
      'out_of_zone',
    );
    expect(codigo(() => estimateFreight({ ...base, skipZoneCheck: 'true' } as never))).toBe(
      'out_of_zone',
    );
  });

  it('distancia mayor a maxKm → out_of_zone; igual a maxKm es válida', () => {
    expect(
      codigo(() =>
        estimateFreight({
          codigoPostal: CP,
          distanciaKm: 350.01,
          items: [m2(1)],
          stones,
          config: cfg,
        }),
      ),
    ).toBe('out_of_zone');
    expect(() =>
      estimateFreight({ codigoPostal: CP, distanciaKm: 350, items: [m2(1)], stones, config: cfg }),
    ).not.toThrow();
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('distancia inválida (%s)', (d) => {
    expect(
      codigo(() =>
        estimateFreight({ codigoPostal: CP, distanciaKm: d, items: [m2(1)], stones, config: cfg }),
      ),
    ).toBe('invalid_distance');
  });

  it('propaga errores de ítems (piedra, unidad, espesor, cantidad)', () => {
    const f = (item: never) =>
      codigo(() =>
        estimateFreight({ codigoPostal: CP, distanciaKm: 10, items: [item], stones, config: cfg }),
      );
    expect(f({ stoneId: 'x', cantidad: 1, unidad: 'm2', espesorCm: 5 } as never)).toBe(
      'unknown_stone',
    );
    expect(f({ stoneId: 'travertino', cantidad: 1, unidad: 'm2', espesorCm: 5 } as never)).toBe(
      'inactive_stone',
    );
    expect(f({ stoneId: 'caliza', cantidad: 1, unidad: 'pieza' } as never)).toBe('unit_not_sold');
    expect(f({ stoneId: 'caliza', cantidad: 1, unidad: 'm2', espesorCm: 8 } as never)).toBe(
      'thickness_not_available',
    );
    expect(f({ stoneId: 'caliza', cantidad: 0, unidad: 'm2', espesorCm: 3 } as never)).toBe(
      'invalid_quantity',
    );
  });

  it('ejemplo se omite si la config no es de ejemplo', () => {
    const r = estimateFreight({
      codigoPostal: CP,
      distanciaKm: 10,
      items: [m2(1)],
      stones,
      config: make({ ejemplo: undefined }),
    });
    expect(r.ejemplo).toBeUndefined();
    expect('ejemplo' in r).toBe(false);
  });

  describe('propiedades', () => {
    it('más km nunca baja el estimado', () => {
      for (const cant of [1, 50, 210, 600]) {
        let prev = { min: 0, max: 0 };
        for (let km = 0; km <= 350; km += 7) {
          const r = estimateFreight({
            codigoPostal: CP,
            distanciaKm: km,
            items: [m2(cant)],
            stones,
            config: cfg,
          });
          expect(r.estimadoMin).toBeGreaterThanOrEqual(prev.min);
          expect(r.estimadoMax).toBeGreaterThanOrEqual(prev.max);
          prev = { min: r.estimadoMin, max: r.estimadoMax };
        }
      }
    });

    it('más peso nunca baja el estimado', () => {
      for (const km of [5, 62, 300]) {
        let prev = { min: 0, max: 0 };
        for (let cant = 1; cant <= 900; cant += 13) {
          const r = estimateFreight({
            codigoPostal: CP,
            distanciaKm: km,
            items: [m2(cant)],
            stones,
            config: cfg,
          });
          expect(r.estimadoMin).toBeGreaterThanOrEqual(prev.min);
          expect(r.estimadoMax).toBeGreaterThanOrEqual(prev.max);
          expect(r.estimadoMin).toBeLessThanOrEqual(r.estimadoMax);
          prev = { min: r.estimadoMin, max: r.estimadoMax };
        }
      }
    });
  });
});

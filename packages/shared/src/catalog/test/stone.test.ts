import { describe, expect, it } from 'vitest';
import { USE_CATEGORIES, USE_CATEGORY_LABELS, stoneSchema, stoneWeightKgPerM2 } from '../stone';

// Datos de EJEMPLO (proyecto académico): pesos y cifras no son reales.
const valido = {
  id: 'arenisca',
  nombre: 'Arenisca',
  origen: 'Sedimentaria',
  tipoRoca: 'Roca sedimentaria',
  colores: ['Beige', 'Crema'],
  categoriasUso: ['fachadas', 'muros-silleria'],
  acabados: ['Labrado', 'Cepillado'],
  formatos: ['Bloque', 'Placa 60 × 40'],
  espesoresCm: [3, 5, 8],
  absorcionPct: 4.2,
  descripcion: 'Piedra de ejemplo.',
  existencia: 'En patio, San Salvador el Seco',
  entregaDias: 7,
  vendidaPor: ['m2', 'pieza', 'tonelada'],
  pesoKgPorPieza: 35,
  densidadKgM3: 2200,
  fotos: ['stones/arenisca/1.jpg'],
  proyectosRelacionados: ['casa-tepeyahualco'],
  activa: true,
};

const falla = (parche: Record<string, unknown>) =>
  stoneSchema.safeParse({ ...valido, ...parche }).success === false;

describe('stoneSchema', () => {
  it('parsea un ejemplo válido completo', () => {
    expect(stoneSchema.parse(valido)).toEqual(valido);
  });

  it('acepta pesos nulos cuando no se venden por pieza', () => {
    expect(
      stoneSchema.safeParse({
        ...valido,
        vendidaPor: ['m2', 'tonelada'],
        pesoKgPorPieza: null,
      }).success,
    ).toBe(true);
  });

  it('falla si falta cualquier campo obligatorio', () => {
    for (const campo of Object.keys(valido)) {
      const resto = Object.fromEntries(Object.entries(valido).filter(([k]) => k !== campo));
      expect(stoneSchema.safeParse(resto).success, campo).toBe(false);
    }
  });

  it('rechaza claves extra', () => {
    expect(falla({ precio: 100 })).toBe(true);
    // Campo retirado: la densidad es la única fuente de verdad del peso por m².
    expect(falla({ pesoKgPorM2PorCm: 22 })).toBe(true);
    expect(falla({ pesoKgPorM2PorCm: null })).toBe(true);
  });

  it('respeta los límites de longitud y de listas', () => {
    expect(falla({ nombre: 'x'.repeat(121) })).toBe(true);
    expect(falla({ nombre: '' })).toBe(true);
    expect(falla({ descripcion: 'x'.repeat(4001) })).toBe(true);
    expect(falla({ colores: Array.from({ length: 31 }, (_, i) => `c${i}`) })).toBe(true);
    expect(falla({ fotos: Array.from({ length: 31 }, (_, i) => `stones/a/${i}.jpg`) })).toBe(true);
  });

  it('rechaza números fuera de rango, NaN e Infinity', () => {
    expect(falla({ absorcionPct: -1 })).toBe(true);
    expect(falla({ absorcionPct: 100.1 })).toBe(true);
    expect(falla({ absorcionPct: Number.NaN })).toBe(true);
    expect(falla({ entregaDias: -1 })).toBe(true);
    expect(falla({ entregaDias: 366 })).toBe(true);
    expect(falla({ entregaDias: 1.5 })).toBe(true);
    expect(falla({ densidadKgM3: 499 })).toBe(true);
    expect(falla({ densidadKgM3: 5001 })).toBe(true);
    expect(falla({ densidadKgM3: Number.POSITIVE_INFINITY })).toBe(true);
    expect(falla({ pesoKgPorPieza: -3 })).toBe(true);
    expect(falla({ espesoresCm: [0] })).toBe(true);
    expect(falla({ espesoresCm: [101] })).toBe(true);
    expect(falla({ espesoresCm: [2.5] })).toBe(true);
  });

  it('rechaza categoriasUso y unidades fuera del enum', () => {
    expect(falla({ categoriasUso: ['techos'] })).toBe(true);
    expect(falla({ vendidaPor: ['kg'] })).toBe(true);
    expect(falla({ vendidaPor: [] })).toBe(true);
  });

  it('rechaza ids inválidos', () => {
    expect(falla({ id: 'Arenisca' })).toBe(true);
    expect(falla({ id: 'a b' })).toBe(true);
    expect(falla({ id: '../x' })).toBe(true);
    expect(falla({ proyectosRelacionados: ['../x'] })).toBe(true);
  });

  it('rechaza fotos inválidas', () => {
    for (const foto of [
      'http://x.com/stones/a/1.jpg',
      'stones/../x/1.jpg',
      'projects/a/1.jpg',
      'stones/a/1.svg',
      'stones/a/1.exe',
      '/stones/a/1.jpg',
    ]) {
      expect(falla({ fotos: [foto] }), foto).toBe(true);
    }
  });

  describe('reglas cruzadas', () => {
    it('exige pesoKgPorPieza si se vende por pieza', () => {
      expect(falla({ vendidaPor: ['pieza'], pesoKgPorPieza: null })).toBe(true);
    });

    it('exige espesores si se vende por m2', () => {
      expect(falla({ vendidaPor: ['m2'], espesoresCm: [] })).toBe(true);
    });

    it('rechaza elementos repetidos en listas de enums, ids y espesores', () => {
      expect(falla({ vendidaPor: ['m2', 'm2'] })).toBe(true);
      expect(falla({ categoriasUso: ['pisos', 'pisos'] })).toBe(true);
      expect(falla({ proyectosRelacionados: ['a', 'a'] })).toBe(true);
      expect(falla({ espesoresCm: [5, 5] })).toBe(true);
    });
  });
});

describe('categorías de uso', () => {
  it('tiene 6 categorías con etiqueta en español', () => {
    expect(USE_CATEGORIES).toHaveLength(6);
    expect(USE_CATEGORY_LABELS['cubiertas-cocina']).toBe('Cubiertas de cocina');
    expect(USE_CATEGORY_LABELS['exteriores-jardin']).toBe('Exteriores y jardín');
    for (const c of USE_CATEGORIES) expect(USE_CATEGORY_LABELS[c]).toBeTruthy();
  });
});

describe('stoneWeightKgPerM2', () => {
  it('calcula 110 kg/m² a 5 cm con densidad 2200', () => {
    expect(stoneWeightKgPerM2({ densidadKgM3: 2200 })).toBe(110);
  });

  it('usa el espesor indicado: 2200 a 8 cm son 176 kg/m²', () => {
    expect(stoneWeightKgPerM2({ densidadKgM3: 2200 }, 8)).toBe(176);
  });

  it('acepta una piedra completa', () => {
    expect(stoneWeightKgPerM2(valido)).toBe(110);
  });

  it('lanza con espesor cero, negativo o no finito', () => {
    for (const e of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => stoneWeightKgPerM2({ densidadKgM3: 2200 }, e), String(e)).toThrow();
    }
  });
});

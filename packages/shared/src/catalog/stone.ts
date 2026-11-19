import { z } from 'zod';
import {
  addPhotoOwnershipIssues,
  idList,
  idSchema,
  photoKeySchema,
  text,
  textOrEmpty,
  uniqueArray,
} from './common';

// Categorías de uso. PROPUESTA: los slugs se derivan de las 6 categorías de
// CLAUDE.md 5.1 (Pisos, Fachadas, Cubiertas de cocina, Escultura y ornamento,
// Exteriores y jardín, Muros y sillería); CLAUDE.md no define los slugs.
export const USE_CATEGORIES = [
  'pisos',
  'fachadas',
  'cubiertas-cocina',
  'escultura-ornamento',
  'exteriores-jardin',
  'muros-silleria',
] as const;
export type UseCategory = (typeof USE_CATEGORIES)[number];

export const USE_CATEGORY_LABELS: Readonly<Record<UseCategory, string>> = {
  pisos: 'Pisos',
  fachadas: 'Fachadas',
  'cubiertas-cocina': 'Cubiertas de cocina',
  'escultura-ornamento': 'Escultura y ornamento',
  'exteriores-jardin': 'Exteriores y jardín',
  'muros-silleria': 'Muros y sillería',
};

export const SOLD_BY_UNITS = ['m2', 'pieza', 'tonelada'] as const;
export type SoldByUnit = (typeof SOLD_BY_UNITS)[number];

const shortList = (label: string) => uniqueArray(text(120, label), 30, label);

const positiveOrNull = (label: string) =>
  z
    .number({ error: `${label} debe ser un número` })
    .finite(`${label} debe ser un número finito`)
    .positive(`${label} debe ser mayor que 0`)
    .max(100000, `${label} es demasiado grande`)
    .nullable();

// Piedra (CLAUDE.md 6.1 y 5.5). Los pesos son DE EJEMPLO hasta que el dueño dé los reales.
export const stoneSchema = z
  .strictObject({
    id: idSchema,
    nombre: text(120, 'El nombre'),
    origen: text(120, 'El origen'),
    tipoRoca: text(120, 'El tipo de roca'),
    colores: shortList('Los colores'),
    usos: shortList('Los usos'),
    categoriasUso: uniqueArray(
      z.enum(USE_CATEGORIES, { error: 'Categoría de uso no válida' }),
      USE_CATEGORIES.length,
      'Las categorías de uso',
    ),
    acabados: shortList('Los acabados'),
    formatos: shortList('Los formatos'),
    espesoresCm: uniqueArray(
      z
        .number({ error: 'El espesor debe ser un número' })
        .int('El espesor debe ser un entero en cm')
        .positive('El espesor debe ser mayor que 0')
        .max(100, 'El espesor máximo es 100 cm'),
      30,
      'Los espesores',
    ),
    absorcionPct: z
      .number({ error: 'La absorción debe ser un número' })
      .finite('La absorción debe ser un número finito')
      .min(0, 'La absorción mínima es 0 %')
      .max(100, 'La absorción máxima es 100 %'),
    descripcion: textOrEmpty(4000, 'La descripción'),
    existencia: text(120, 'La existencia'),
    entregaDias: z
      .number({ error: 'Los días de entrega deben ser un número' })
      .int('Los días de entrega deben ser un entero')
      .min(0, 'Los días de entrega no pueden ser negativos')
      .max(365, 'Los días de entrega máximos son 365'),
    vendidaPor: uniqueArray(
      z.enum(SOLD_BY_UNITS, { error: 'Unidad de venta no válida' }),
      SOLD_BY_UNITS.length,
      'Las unidades de venta',
    ).refine((xs) => xs.length >= 1, 'Debe venderse por al menos una unidad'),
    // AVISO: el flete (packages/shared/src/freight) IGNORA este campo y usa densidadKgM3; editarlo
    // no cambia ningún estimado. Pendiente: quitarlo del dashboard o derivarlo (docs/siguiente-sesion.md).
    pesoKgPorM2PorCm: positiveOrNull('El peso por m² por cm'),
    pesoKgPorPieza: positiveOrNull('El peso por pieza'),
    densidadKgM3: z
      .number({ error: 'La densidad debe ser un número' })
      .finite('La densidad debe ser un número finito')
      .min(500, 'La densidad mínima es 500 kg/m³')
      .max(5000, 'La densidad máxima es 5000 kg/m³'),
    fotos: uniqueArray(photoKeySchema('stones'), 30, 'Las fotos'),
    proyectosRelacionados: idList(50, 'Los proyectos relacionados'),
    activa: z.boolean({ error: 'activa debe ser verdadero o falso' }),
  })
  .superRefine((stone, ctx) => {
    addPhotoOwnershipIssues(ctx, 'stones', stone.id, stone.fotos, ['fotos']);
    if (stone.vendidaPor.includes('pieza') && stone.pesoKgPorPieza === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['pesoKgPorPieza'],
        message: 'Si se vende por pieza, el peso por pieza es obligatorio',
      });
    }
    // El peso por m² se deriva de densidadKgM3 (siempre requerida), así que solo
    // se exige que existan espesores para poder calcularlo.
    if (stone.vendidaPor.includes('m2') && stone.espesoresCm.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['espesoresCm'],
        message: 'Si se vende por m², debe haber al menos un espesor',
      });
    }
  });
export type Stone = z.infer<typeof stoneSchema>;

/**
 * Peso por m² (CLAUDE.md 5.5): densidad ÷ 100 × espesor en cm. A 5 cm, 2200 kg/m³ → 110 kg/m².
 */
export function stoneWeightKgPerM2(stone: Pick<Stone, 'densidadKgM3'>, espesorCm = 5): number {
  if (!Number.isFinite(espesorCm) || espesorCm <= 0) {
    throw new RangeError('El espesor debe ser un número mayor que 0');
  }
  if (!Number.isFinite(stone.densidadKgM3) || stone.densidadKgM3 <= 0) {
    throw new RangeError('La densidad debe ser un número mayor que 0');
  }
  return (stone.densidadKgM3 / 100) * espesorCm;
}

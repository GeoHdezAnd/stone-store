import { z } from 'zod';
import { idList, idSchema, photoKeySchema, text, textOrEmpty, uniqueArray } from './common';

export const PROJECT_CATEGORIES = [
  'fachadas',
  'cocinas',
  'restauracion',
  'jardin-exterior',
  'escultura',
] as const;
export const PROJECT_STATUSES = ['publicado', 'borrador'] as const;

// Proyecto (CLAUDE.md 6.1). Solo los `publicado` entran a catalog.json (5.5).
export const projectSchema = z.strictObject({
  id: idSchema,
  titulo: text(120, 'El título'),
  categoria: z.enum(PROJECT_CATEGORIES, { error: 'Categoría de proyecto no válida' }),
  ubicacion: text(120, 'La ubicación'),
  anio: z
    .number({ error: 'El año debe ser un número' })
    .int('El año debe ser un entero')
    .min(1900, 'El año mínimo es 1900')
    .max(2100, 'El año máximo es 2100'),
  descripcion: textOrEmpty(4000, 'La descripción'),
  superficie: textOrEmpty(60, 'La superficie'),
  piedras: idList(50, 'Las piedras'),
  acabados: idList(50, 'Los acabados'),
  piezasLabradas: z
    .number({ error: 'Las piezas labradas deben ser un número' })
    .int('Las piezas labradas deben ser un entero')
    .min(0, 'Las piezas labradas no pueden ser negativas')
    .max(100000, 'Demasiadas piezas labradas')
    .nullable(),
  entrega: textOrEmpty(60, 'La entrega'),
  testimonio: z
    .strictObject({
      texto: text(2000, 'El texto del testimonio'),
      autor: text(120, 'El autor del testimonio'),
    })
    .nullable(),
  fotos: uniqueArray(photoKeySchema('projects'), 30, 'Las fotos'),
  estado: z.enum(PROJECT_STATUSES, { error: 'Estado de proyecto no válido' }),
  activa: z.boolean({ error: 'activa debe ser verdadero o falso' }),
});
export type Project = z.infer<typeof projectSchema>;

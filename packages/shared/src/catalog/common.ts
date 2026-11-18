import { z } from 'zod';

// Piezas compartidas por los esquemas del catálogo (CLAUDE.md 6.1).
// Dominio puro: sin I/O ni dependencias del repo.

/** Slug en minúsculas: letras, números y guiones simples (sin `..`, `/` ni espacios). */
export const idSchema = z
  .string({ error: 'El id debe ser texto' })
  .min(1, 'El id es obligatorio')
  .max(64, 'El id admite máximo 64 caracteres')
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    'El id solo admite minúsculas, números y guiones simples (ej. "cantera-rosa")',
  );

/** Texto obligatorio con longitud máxima. */
export function text(max: number, label = 'El texto') {
  return z
    .string({ error: `${label} debe ser texto` })
    .min(1, `${label} es obligatorio`)
    .max(max, `${label} admite máximo ${max} caracteres`);
}

/** Texto opcional en el sentido de que puede ir vacío (pero no pasar del máximo). */
export function textOrEmpty(max: number, label = 'El texto') {
  return z
    .string({ error: `${label} debe ser texto` })
    .max(max, `${label} admite máximo ${max} caracteres`);
}

export const PHOTO_FOLDERS = ['stones', 'projects', 'finishes'] as const;
export type PhotoFolder = (typeof PHOTO_FOLDERS)[number];

/**
 * Clave RELATIVA de S3 (no URL) de una foto. La carpeta debe coincidir con la entidad.
 * El patrón ya excluye `..`, barra inicial y esquemas como `http:`.
 */
export function photoKeySchema(folder: PhotoFolder) {
  return z
    .string({ error: 'La foto debe ser una clave de texto' })
    .max(200, 'La clave de la foto admite máximo 200 caracteres')
    .regex(
      new RegExp(`^${folder}/[a-z0-9-]+/[a-z0-9._-]+\\.(jpg|jpeg|png|webp|avif)$`),
      `La foto debe ser una clave relativa "${folder}/<id>/<archivo>.(jpg|jpeg|png|webp|avif)"`,
    )
    .refine((k) => !k.includes('..'), 'La clave de la foto no puede contener ".."');
}

/** Arreglo con máximo de elementos y sin repetidos. */
export function uniqueArray<T extends z.ZodType>(item: T, max: number, label = 'La lista') {
  return z
    .array(item, { error: `${label} debe ser una lista` })
    .max(max, `${label} admite máximo ${max} elementos`)
    .refine((xs) => new Set(xs).size === xs.length, `${label} no admite elementos repetidos`);
}

/** Lista de ids (slugs) sin repetidos. */
export function idList(max: number, label = 'La lista de ids') {
  return uniqueArray(idSchema, max, label);
}

import { PHOTO_FOLDERS, photoKeySchema } from '../catalog/common';

// Contrato de nombres de las variantes de imagen (CLAUDE.md 6.3, fase 6.3). Dominio puro: sin I/O.
// FUENTE ÚNICA: la Lambda `media-variants` genera con estas funciones y el sitio
// (`apps/web/src/lib/media.ts`) espera exactamente esta regla, que además se replica en el test.

/** Anchos (px) de las variantes WebP que genera la Lambda y lista el `srcset` del sitio. */
export const MEDIA_VARIANT_WIDTHS = [480, 960, 1600] as const;
export type MediaVariantWidth = (typeof MEDIA_VARIANT_WIDTHS)[number];

/** Extensión de la última parte del nombre (misma regla que `mediaSrcSet` del sitio). */
const EXTENSION_RE = /\.[^./]+$/;

/** `-480w.webp`, `-960w.webp` o `-1600w.webp` al final de la clave. */
const VARIANT_SUFFIX_RE = new RegExp(`-(?:${MEDIA_VARIANT_WIDTHS.join('|')})w\\.webp$`);

/**
 * Clave de la variante: `<clave original sin extensión>-<ancho>w.webp`.
 * Ej.: `stones/arenisca/<uuid>.jpg` + 480 -> `stones/arenisca/<uuid>-480w.webp`.
 * Nota de diseño: se QUITA la extensión original (así lo hace el sitio), por lo que dos originales
 * con el mismo nombre y distinta extensión compartirían variantes; no ocurre porque las claves
 * llevan un UUID v4 único generado por el servidor.
 */
export function variantKey(originalKey: string, width: number): string {
  if (originalKey === '') throw new Error('La clave original no puede estar vacía');
  if (!(MEDIA_VARIANT_WIDTHS as readonly number[]).includes(width)) {
    throw new Error(`Ancho de variante no permitido: ${width}`);
  }
  return `${originalKey.replace(EXTENSION_RE, '')}-${width}w.webp`;
}

/** `true` si la clave tiene forma de variante generada. Es el freno ANTI-BUCLE de la Lambda. */
export function isVariantKey(key: string): boolean {
  return VARIANT_SUFFIX_RE.test(key);
}

const ORIGINAL_SCHEMAS = PHOTO_FOLDERS.map((folder) => photoKeySchema(folder));

/**
 * `true` si la clave es un ORIGINAL que la Lambda debe procesar: cumple el formato de foto del
 * catálogo (`<entidad>/<id>/<archivo>.<ext>`, sin `..`) y NO es una variante.
 */
export function isProcessableOriginalKey(key: string): boolean {
  if (isVariantKey(key)) return false;
  return ORIGINAL_SCHEMAS.some((schema) => schema.safeParse(key).success);
}

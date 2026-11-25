// URLs de fotos. Las claves de S3 (`stones/<id>/<archivo>.jpg`) se resuelven contra una URL base
// configurable (variable de build `PUBLIC_MEDIA_BASE_URL`, normalmente la de CloudFront).

const base = (import.meta.env.PUBLIC_MEDIA_BASE_URL ?? '/media').replace(/\/+$/, '');

// Las variantes las genera la Lambda `MediaVariants` (fase 6.3) con el nombre
// `<clave sin extensión>-<ancho>w.webp` (480, 960 y 1600 px). El contrato vive en
// `packages/shared/src/media/variants.ts`.
export const MEDIA_WIDTHS = [480, 960, 1600] as const;
export type MediaWidth = (typeof MEDIA_WIDTHS)[number];

/** Ancho de la variante que sirve de `src` (respaldo para navegadores sin `srcset`). */
export const FALLBACK_WIDTH: MediaWidth = 960;
/** Ancho de la variante para la vista previa al compartir (Open Graph). */
export const SHARE_WIDTH: MediaWidth = 1600;

/** URL de una clave tal cual. No uses esta función con fotos: el original conserva EXIF/GPS. */
export function mediaUrl(key: string): string {
  return `${base}/${key}`;
}

/**
 * URL de una variante WebP. Las fotos siempre se sirven por aquí: las variantes salen sin
 * metadatos (EXIF/GPS), mientras que el original puede traer la ubicación de la obra.
 */
export function mediaVariantUrl(key: string, width: MediaWidth): string {
  const stem = key.replace(/\.[^./]+$/, '');
  return mediaUrl(`${stem}-${width}w.webp`);
}

export function mediaSrcSet(key: string): string {
  return MEDIA_WIDTHS.map((w) => `${mediaVariantUrl(key, w)} ${w}w`).join(', ');
}

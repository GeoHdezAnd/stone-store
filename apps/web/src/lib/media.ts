// URLs de fotos. Las claves de S3 (`stones/<id>/<archivo>.jpg`) se resuelven contra una URL base
// configurable (variable de build `PUBLIC_MEDIA_BASE_URL`, normalmente la de CloudFront).

const base = (import.meta.env.PUBLIC_MEDIA_BASE_URL ?? '/media').replace(/\/+$/, '');

// PROPUESTA: la optimización de imágenes es de la fase 6 y aún no define el nombre de las
// variantes. Se asume `<clave sin extensión>-<ancho>w.webp` (480, 960 y 1600 px, CLAUDE.md 6.3).
export const MEDIA_WIDTHS = [480, 960, 1600] as const;

export function mediaUrl(key: string): string {
  return `${base}/${key}`;
}

export function mediaSrcSet(key: string): string {
  const stem = key.replace(/\.[^./]+$/, '');
  return MEDIA_WIDTHS.map((w) => `${mediaUrl(`${stem}-${w}w.webp`)} ${w}w`).join(', ');
}

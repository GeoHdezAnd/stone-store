import { MAX_MEDIA_BYTES } from '@canteras/shared';

// Límites defensivos: el original lo sube un usuario (entrada NO confiable).

/** Tope de bytes del original: el MISMO que el presigner (`MAX_MEDIA_BYTES`, 5 MiB). */
export const MAX_ORIGINAL_BYTES = MAX_MEDIA_BYTES;

/**
 * Tope de píxeles que sharp acepta decodificar (`limitInputPixels`): defensa contra bombas de
 * descompresión (un PNG de pocos KB puede declarar decenas de miles de píxeles por lado y agotar la
 * memoria). 40 MP cubre cámaras de 12 a 24 MP con holgura y cuesta ~160 MB de RGBA al decodificar,
 * cómodo en 1024 MB.
 */
export const MAX_INPUT_PIXELS = 40_000_000;

/**
 * Tope PROPIO de píxeles para AVIF (16 MP). AVIF (AV1) expande muchísimo más memoria al decodificar
 * que JPEG/PNG/WebP: una bomba AVIF de 40 MP pesa ~2 KB y llegó a ~1.3 GB de RSS, más que los 1024 MB
 * de la Lambda. Se aplica en `inspect` sobre el ENCABEZADO (antes de decodificar nada) y se rechaza
 * de forma permanente (`pixel_limit`). 16 MP cubre sobrado una foto web (4000 x 4000) y el resto de
 * formatos conserva `MAX_INPUT_PIXELS`.
 */
export const MAX_AVIF_PIXELS = 16_000_000;

/** Lado mínimo (px): por debajo es un icono o una imagen de seguimiento, no una foto de piedra. */
export const MIN_DIMENSION_PX = 16;

/** Lado máximo (px) de entrada, aunque no pase de `MAX_INPUT_PIXELS` (p. ej. 40000 x 1). */
export const MAX_DIMENSION_PX = 12_000;

/** Calidad del WebP de salida (0-100): buen equilibrio peso/nitidez para fotos de piedra. */
export const WEBP_QUALITY = 80;

/** Esfuerzo de compresión WebP (0-6). 4 es el valor por defecto de libwebp: rápido y razonable. */
export const WEBP_EFFORT = 4;

/** Las variantes no cambian nunca para una misma clave (UUID único): caché de un año, inmutable. */
export const VARIANT_CACHE_CONTROL = 'public, max-age=31536000, immutable';

export const VARIANT_CONTENT_TYPE = 'image/webp';

/*
 * LÍMITES CONOCIDOS (decididos a propósito):
 * - Colisión `x.jpg` / `x.png`: la clave de variante QUITA la extensión (contrato con el sitio), así que
 *   dos originales con el mismo nombre y distinta extensión compartirían variantes. No es alcanzable:
 *   el servidor genera `<uuid v4>.<ext>` y el UUID es único.
 * - Políglota: un archivo con cabecera JPEG válida que además contiene HTML sigue siendo un JPEG
 *   para los magic bytes. Las VARIANTES son WebP re-codificadas por libvips (el HTML no sobrevive),
 *   pero el ORIGINAL se guarda tal cual: al servir originales (CloudFront) hará falta
 *   `X-Content-Type-Options: nosniff` y el `Content-Type` de la subida.
 * - Una tira de 16 x 12000 px (192 000 px) pasa los mínimos y máximos: es inofensiva (pocos píxeles).
 */

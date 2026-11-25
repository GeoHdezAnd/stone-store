import { MEDIA_VARIANT_WIDTHS, type MediaVariantWidth } from '@canteras/shared';
import { detectImageType } from './image-type';
import { MAX_DIMENSION_PX, MAX_ORIGINAL_BYTES, MIN_DIMENSION_PX } from './limits';
import { ImageRejectedError, type ImageProcessor } from './processor';

export interface BuiltVariant {
  /** Ancho NOMINAL (el de la clave: 480, 960 o 1600). */
  width: MediaVariantWidth;
  /** WebP ya codificado (puede ser el mismo buffer que otra variante si el original es angosto). */
  body: Uint8Array;
}

/**
 * Valida el original y genera las variantes WebP. Lógica pura sobre un `ImageProcessor`.
 *
 * Decisión de diseño (sin ampliar): SIEMPRE se producen las tres claves (480, 960 y 1600), porque el
 * `srcset` del sitio las pide todas y una ausente sería un 404. Cada una se codifica a
 * `min(ancho nominal, ancho del original)`; si dos coinciden (original angosto) se codifica una vez y
 * se reutiliza el buffer. Nunca sale una variante más ancha que el original.
 */
export async function buildVariants(
  processor: ImageProcessor,
  original: Uint8Array,
): Promise<BuiltVariant[]> {
  if (original.length === 0) throw new ImageRejectedError('empty');
  if (original.length > MAX_ORIGINAL_BYTES) throw new ImageRejectedError('too_large');

  const type = detectImageType(original);
  if (type === null) throw new ImageRejectedError('unsupported_type');

  const info = await processor.inspect(original);
  if (info.format !== type) throw new ImageRejectedError('format_mismatch');
  if (
    info.width < MIN_DIMENSION_PX ||
    info.height < MIN_DIMENSION_PX ||
    info.width > MAX_DIMENSION_PX ||
    info.height > MAX_DIMENSION_PX
  ) {
    throw new ImageRejectedError('bad_dimensions');
  }

  const encoded = new Map<number, Uint8Array>();
  const out: BuiltVariant[] = [];
  for (const width of MEDIA_VARIANT_WIDTHS) {
    const effective = Math.min(width, info.width);
    let body = encoded.get(effective);
    if (body === undefined) {
      body = await processor.toWebp(original, effective);
      encoded.set(effective, body);
    }
    out.push({ width, body });
  }
  return out;
}

import type { ImageFormat } from './processor';

const startsWith = (b: Uint8Array, sig: readonly number[], offset = 0): boolean =>
  b.length >= offset + sig.length && sig.every((v, i) => b[offset + i] === v);

const ascii = (b: Uint8Array, offset: number, len: number): string => {
  if (b.length < offset + len) return '';
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(b[offset + i] ?? 0);
  return s;
};

/** Cuántos bytes de la caja `ftyp` se inspeccionan como máximo (acota la lectura). */
const MAX_FTYP_BYTES = 64;

/**
 * Tipo REAL del archivo por sus magic bytes (nunca por extensión ni Content-Type, que controla
 * quien sube). `null` si no es JPEG, PNG, WebP ni AVIF. No lanza con entradas cortas.
 */
export function detectImageType(bytes: Uint8Array): ImageFormat | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'webp';
  if (ascii(bytes, 4, 4) === 'ftyp') {
    // Caja `ftyp`: tamaño (4) + 'ftyp' + marca principal (4) + versión (4) + marcas compatibles.
    const size =
      (bytes[0] ?? 0) * 2 ** 24 +
      (bytes[1] ?? 0) * 2 ** 16 +
      (bytes[2] ?? 0) * 256 +
      (bytes[3] ?? 0);
    const end = Math.min(size, bytes.length, MAX_FTYP_BYTES);
    if (end < 12) return null;
    if (isAvifBrand(ascii(bytes, 8, 4))) return 'avif';
    for (let off = 16; off + 4 <= end; off += 4) {
      if (isAvifBrand(ascii(bytes, off, 4))) return 'avif';
    }
  }
  return null;
}

const isAvifBrand = (brand: string): boolean => brand === 'avif' || brand === 'avis';

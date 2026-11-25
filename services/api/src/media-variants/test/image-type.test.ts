import { describe, expect, it } from 'vitest';
import { detectImageType } from '../image-type';
import { MAGIC } from './fixtures';

describe('detectImageType: tipo real por magic bytes', () => {
  it('reconoce JPEG, PNG, WebP y AVIF', () => {
    expect(detectImageType(MAGIC.jpeg)).toBe('jpeg');
    expect(detectImageType(MAGIC.png)).toBe('png');
    expect(detectImageType(MAGIC.webp)).toBe('webp');
    expect(detectImageType(MAGIC.avif)).toBe('avif');
  });

  it('reconoce AVIF cuando la marca está en la lista de marcas compatibles', () => {
    expect(detectImageType(MAGIC.avifBrandInCompatibleList)).toBe('avif');
  });

  it('rechaza SVG, HTML, GIF y HEIC aunque la extensión diga .jpg', () => {
    for (const bytes of [MAGIC.svg, MAGIC.html, MAGIC.gif, MAGIC.heic]) {
      expect(detectImageType(bytes)).toBeNull();
    }
  });

  it('un RIFF que no es WebP (p. ej. WAVE) no pasa', () => {
    expect(detectImageType(MAGIC.riffNotWebp)).toBeNull();
  });

  it('entradas vacías o demasiado cortas devuelven null sin lanzar', () => {
    expect(detectImageType(new Uint8Array(0))).toBeNull();
    expect(detectImageType(new Uint8Array([0xff, 0xd8]))).toBeNull();
    expect(detectImageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
  });

  it('un ftyp con tamaño de caja absurdo no lee fuera del buffer', () => {
    const bytes = new Uint8Array([
      0xff, 0xff, 0xff, 0xff, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x69, 0x66, 0x31,
    ]);
    expect(detectImageType(bytes)).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import {
  MEDIA_VARIANT_WIDTHS,
  isProcessableOriginalKey,
  isVariantKey,
  variantKey,
} from '../variants';

const UUID = '3f2b8c1e-9a4d-4e6b-8c7a-1d2e3f4a5b6c';

describe('variantKey: contrato de nombres con el sitio', () => {
  it('quita la extensión de la clave original y agrega -<ancho>w.webp', () => {
    expect(variantKey(`stones/arenisca/${UUID}.jpg`, 480)).toBe(
      `stones/arenisca/${UUID}-480w.webp`,
    );
    expect(variantKey(`projects/casa/${UUID}.png`, 960)).toBe(`projects/casa/${UUID}-960w.webp`);
    expect(variantKey(`stones/a/${UUID}.avif`, 1600)).toBe(`stones/a/${UUID}-1600w.webp`);
  });

  it('un original .webp no choca con su propia variante', () => {
    const original = `stones/a/${UUID}.webp`;
    expect(variantKey(original, 480)).toBe(`stones/a/${UUID}-480w.webp`);
    expect(variantKey(original, 480)).not.toBe(original);
  });

  it('solo quita la última extensión del último segmento', () => {
    expect(variantKey('stones/a/foto.v2.jpg', 480)).toBe('stones/a/foto.v2-480w.webp');
    expect(variantKey('stones/a.b/foto', 480)).toBe('stones/a.b/foto-480w.webp');
  });

  it('coincide con la regla que usa el sitio (apps/web/src/lib/media.ts)', () => {
    // Réplica literal de `mediaSrcSet` del sitio: el contrato NO puede divergir.
    const siteRule = (key: string, w: number) => `${key.replace(/\.[^./]+$/, '')}-${w}w.webp`;
    for (const key of [
      `stones/a/${UUID}.jpg`,
      'stones/a/1.jpg',
      'stones/a/foto.v2.png',
      'stones/a.b/sin-extension',
    ]) {
      for (const w of MEDIA_VARIANT_WIDTHS) expect(variantKey(key, w)).toBe(siteRule(key, w));
    }
  });

  it('rechaza anchos fuera del contrato y claves vacías', () => {
    expect(() => variantKey('stones/a/x.jpg', 500)).toThrow();
    expect(() => variantKey('stones/a/x.jpg', 0)).toThrow();
    expect(() => variantKey('', 480)).toThrow();
  });

  it('los anchos del contrato son 480, 960 y 1600', () => {
    expect([...MEDIA_VARIANT_WIDTHS]).toEqual([480, 960, 1600]);
  });
});

describe('isVariantKey', () => {
  it('reconoce las variantes generadas', () => {
    for (const w of MEDIA_VARIANT_WIDTHS) {
      expect(isVariantKey(variantKey(`stones/a/${UUID}.jpg`, w))).toBe(true);
    }
  });

  it('no marca como variante un original normal', () => {
    for (const ext of ['jpg', 'jpeg', 'png', 'webp', 'avif']) {
      expect(isVariantKey(`stones/a/${UUID}.${ext}`)).toBe(false);
    }
  });

  it('no confunde anchos distintos ni otras extensiones', () => {
    expect(isVariantKey('stones/a/x-500w.webp')).toBe(false);
    expect(isVariantKey('stones/a/x-480w.jpg')).toBe(false);
    expect(isVariantKey('stones/a/x-480w.webp.jpg')).toBe(false);
    expect(isVariantKey('stones/a/x-480.webp')).toBe(false);
  });

  it('cualquier salida de variantKey es siempre una variante (anti-bucle)', () => {
    for (const key of ['stones/a/x.webp', 'stones/a/x.avif', 'projects/p/y.png', 'stones/a/z']) {
      for (const w of MEDIA_VARIANT_WIDTHS) expect(isVariantKey(variantKey(key, w))).toBe(true);
    }
  });
});

describe('isProcessableOriginalKey', () => {
  it('acepta originales bajo los prefijos permitidos', () => {
    expect(isProcessableOriginalKey(`stones/arenisca/${UUID}.jpg`)).toBe(true);
    expect(isProcessableOriginalKey(`projects/casa/${UUID}.png`)).toBe(true);
    expect(isProcessableOriginalKey(`finishes/labrado/${UUID}.webp`)).toBe(true);
  });

  it('rechaza variantes, prefijos ajenos y claves raras', () => {
    expect(isProcessableOriginalKey(`stones/a/${UUID}-480w.webp`)).toBe(false);
    expect(isProcessableOriginalKey(`published/catalog.json`)).toBe(false);
    expect(isProcessableOriginalKey(`otros/a/${UUID}.jpg`)).toBe(false);
    expect(isProcessableOriginalKey(`stones/${UUID}.jpg`)).toBe(false);
    expect(isProcessableOriginalKey(`stones/../x/${UUID}.jpg`)).toBe(false);
    expect(isProcessableOriginalKey(`/stones/a/${UUID}.jpg`)).toBe(false);
    expect(isProcessableOriginalKey(`stones/a/${UUID}.gif`)).toBe(false);
    expect(isProcessableOriginalKey('stones/a/')).toBe(false);
  });
});

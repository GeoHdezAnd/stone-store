import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { MAX_AVIF_PIXELS, MAX_INPUT_PIXELS } from '../limits';
import { ImageRejectedError } from '../processor';
import { SharpImageProcessor } from '../sharp-processor';
import { buildVariants } from '../variants';

// Estas pruebas usan el binario NATIVO de sharp (libvips) con imágenes reales diminutas generadas
// en memoria. En el hito de AWS real se repite lo mismo contra el binario linux-arm64 del paquete.

const solid = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: { r: 180, g: 90, b: 40 } } });

const rejection = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof ImageRejectedError) return e.reason;
    throw e;
  }
  return 'no-rechazado';
};

describe('SharpImageProcessor.inspect', () => {
  const proc = new SharpImageProcessor();

  it('lee formato y dimensiones de JPEG, PNG, WebP y AVIF', async () => {
    const cases = [
      ['jpeg', await solid(120, 80).jpeg().toBuffer()],
      ['png', await solid(120, 80).png().toBuffer()],
      ['webp', await solid(120, 80).webp().toBuffer()],
      ['avif', await solid(64, 48).avif({ effort: 0 }).toBuffer()],
    ] as const;
    for (const [format, buf] of cases) {
      const got = await proc.inspect(buf);
      expect(got.format).toBe(format);
      expect(got.width).toBeGreaterThan(0);
    }
    expect(await proc.inspect(await solid(120, 80).jpeg().toBuffer())).toEqual({
      format: 'jpeg',
      width: 120,
      height: 80,
    });
  });

  it('con orientación EXIF 6 informa las dimensiones ya rotadas (las que se verán)', async () => {
    const buf = await solid(200, 100).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    expect(await proc.inspect(buf)).toEqual({ format: 'jpeg', width: 100, height: 200 });
  });

  it('rechaza bytes que no decodifican como corruptos', async () => {
    const good = await solid(100, 100).jpeg().toBuffer();
    const truncated = good.subarray(0, 40);
    expect(await rejection(proc.inspect(truncated))).toBe('corrupt');
    expect(await rejection(proc.inspect(new Uint8Array([1, 2, 3, 4])))).toBe('corrupt');
  });

  it('rechaza lo que excede limitInputPixels (bomba de descompresión)', async () => {
    const small = new SharpImageProcessor({ limitInputPixels: 1000 });
    const png = await solid(100, 100).png().toBuffer(); // 10 000 px > 1000
    expect(await rejection(small.inspect(png))).toBe('pixel_limit');
    expect(await rejection(small.toWebp(png, 50))).toBe('pixel_limit');
  });
});

describe('SharpImageProcessor.toWebp', () => {
  const proc = new SharpImageProcessor();

  it('produce un WebP del ancho pedido', async () => {
    const out = await proc.toWebp(await solid(1000, 500).jpeg().toBuffer(), 480);
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(480);
    expect(meta.height).toBe(240);
  });

  it('NUNCA amplía: un original angosto conserva su ancho', async () => {
    const out = await proc.toWebp(await solid(200, 100).png().toBuffer(), 1600);
    expect((await sharp(out).metadata()).width).toBe(200);
  });

  it('aplica la orientación EXIF (el píxel queda en pie)', async () => {
    const buf = await solid(200, 100).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const meta = await sharp(await proc.toWebp(buf, 1600)).metadata();
    expect(meta.width).toBe(100);
    expect(meta.height).toBe(200);
  });

  it('quita TODOS los metadatos: EXIF con GPS, XMP, ICC y orientación (se verifica en los bytes)', async () => {
    const conMetadatos = await solid(200, 100)
      .jpeg()
      .withIccProfile('p3')
      .withExif({
        IFD0: { Copyright: 'Fulano', Artist: 'Persona' },
        IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '19/1 3/1 0/1' },
      })
      .withXmp('<x:xmpmeta xmlns:x="adobe:ns:meta/"><r>Persona</r></x:xmpmeta>')
      .toBuffer();
    // La entrada SÍ trae EXIF, XMP e ICC (la prueba no puede pasar en falso).
    const entrada = await sharp(conMetadatos).metadata();
    expect(entrada.exif).toBeDefined();
    expect(entrada.xmp).toBeDefined();
    expect(entrada.icc).toBeDefined();

    const out = Buffer.from(await proc.toWebp(conMetadatos, 480));
    // Un WebP es un contenedor RIFF: EXIF, XMP e ICC viajan en trozos propios (EXIF, XMP , ICCP).
    const trozos = riffChunks(out);
    expect(trozos.some((t) => t.startsWith('VP8'))).toBe(true);
    for (const prohibido of ['EXIF', 'XMP ', 'ICCP']) expect(trozos).not.toContain(prohibido);
    // Y ninguna de las cadenas sembradas sobrevive en ninguna parte del archivo.
    for (const marca of ['Fulano', 'Persona', 'xmpmeta']) {
      expect(out.includes(Buffer.from(marca))).toBe(false);
    }
    const meta = await sharp(out).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
    expect(meta.icc).toBeUndefined();
  });
});

describe('límite propio de píxeles para AVIF (bomba de descompresión)', () => {
  it('MAX_AVIF_PIXELS es menor que el tope general y de ~16 MP', () => {
    expect(MAX_AVIF_PIXELS).toBe(16_000_000);
    expect(MAX_AVIF_PIXELS).toBeLessThan(MAX_INPUT_PIXELS);
  });

  it('inspect rechaza un AVIF real de 20 MP con pixel_limit, SIN decodificarlo', async () => {
    const avif = await solid(5000, 4000).avif({ effort: 0 }).toBuffer(); // pesa < 2 KB
    expect(avif.length).toBeLessThan(10_000);
    const proc = new SharpImageProcessor();
    expect(await rejection(proc.inspect(avif))).toBe('pixel_limit');
    // toWebp (llamado directo) aplica el mismo tope: defensa en profundidad.
    expect(await rejection(proc.toWebp(avif, 480))).toBe('pixel_limit');
  });

  it('la frontera se respeta: igual al tope pasa, un píxel más no', async () => {
    const avif = await solid(64, 48).avif({ effort: 0 }).toBuffer(); // 3072 px
    expect((await new SharpImageProcessor({ maxAvifPixels: 3072 }).inspect(avif)).format).toBe(
      'avif',
    );
    expect(await rejection(new SharpImageProcessor({ maxAvifPixels: 3071 }).inspect(avif))).toBe(
      'pixel_limit',
    );
  });

  it('los demás formatos conservan el tope general (no se les aplica el de AVIF)', async () => {
    const proc = new SharpImageProcessor({ maxAvifPixels: 100 });
    for (const buf of [
      await solid(64, 48).jpeg().toBuffer(),
      await solid(64, 48).png().toBuffer(),
      await solid(64, 48).webp().toBuffer(),
    ]) {
      await expect(proc.inspect(buf)).resolves.toMatchObject({ width: 64, height: 48 });
    }
  });
});

/** Nombres (fourcc) de los trozos de un contenedor RIFF/WebP. */
function riffChunks(buf: Buffer): string[] {
  const out: string[] = [];
  for (let off = 12; off + 8 <= buf.length;) {
    out.push(buf.toString('ascii', off, off + 4));
    off += 8 + buf.readUInt32LE(off + 4) + (buf.readUInt32LE(off + 4) % 2);
  }
  return out;
}

describe('buildVariants con sharp real', () => {
  it('imagen de 700 px: variantes de 480, 700 y 700 px de ancho, todas WebP', async () => {
    const buf = await solid(700, 500).jpeg().toBuffer();
    const out = await buildVariants(new SharpImageProcessor(), buf);
    const widths = await Promise.all(out.map(async (v) => (await sharp(v.body).metadata()).width));
    expect(widths).toEqual([480, 700, 700]);
  });
});

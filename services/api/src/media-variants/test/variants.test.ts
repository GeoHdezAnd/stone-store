import { describe, expect, it } from 'vitest';
import { MAX_MEDIA_BYTES } from '@canteras/shared';
import { MAX_DIMENSION_PX, MIN_DIMENSION_PX } from '../limits';
import { ImageRejectedError } from '../processor';
import { buildVariants } from '../variants';
import { FakeProcessor, MAGIC, info } from './fixtures';

const rejection = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof ImageRejectedError) return e.reason;
    throw e;
  }
  return 'no-rechazado';
};

describe('buildVariants: validación del original (entrada no confiable)', () => {
  it('rechaza un archivo vacío sin invocar al procesador', async () => {
    const proc = new FakeProcessor();
    expect(await rejection(buildVariants(proc, new Uint8Array(0)))).toBe('empty');
    expect(proc.inspected).toBe(0);
  });

  it('rechaza lo que pasa del tope de 5 MiB del presigner sin decodificar', async () => {
    const proc = new FakeProcessor();
    const big = new Uint8Array(MAX_MEDIA_BYTES + 1);
    big.set(MAGIC.jpeg);
    expect(await rejection(buildVariants(proc, big))).toBe('too_large');
    expect(proc.inspected).toBe(0);
  });

  it('acepta exactamente el tope de 5 MiB', async () => {
    const proc = new FakeProcessor();
    const exact = new Uint8Array(MAX_MEDIA_BYTES);
    exact.set(MAGIC.jpeg);
    await expect(buildVariants(proc, exact)).resolves.toHaveLength(3);
  });

  it('rechaza tipos no permitidos por magic bytes sin decodificar', async () => {
    for (const bytes of [MAGIC.svg, MAGIC.html, MAGIC.gif, MAGIC.heic]) {
      const proc = new FakeProcessor();
      expect(await rejection(buildVariants(proc, bytes))).toBe('unsupported_type');
      expect(proc.inspected).toBe(0);
    }
  });

  it('rechaza si el decodificador ve otro formato que los magic bytes (políglota)', async () => {
    const proc = new FakeProcessor(info('png', 2000, 1000));
    expect(await rejection(buildVariants(proc, MAGIC.jpeg))).toBe('format_mismatch');
    expect(proc.resized).toEqual([]);
  });

  it('rechaza dimensiones por debajo del mínimo o por encima del máximo', async () => {
    const small = new FakeProcessor(info('jpeg', MIN_DIMENSION_PX - 1, 2000));
    expect(await rejection(buildVariants(small, MAGIC.jpeg))).toBe('bad_dimensions');
    const flat = new FakeProcessor(info('jpeg', 2000, MIN_DIMENSION_PX - 1));
    expect(await rejection(buildVariants(flat, MAGIC.jpeg))).toBe('bad_dimensions');
    const huge = new FakeProcessor(info('jpeg', MAX_DIMENSION_PX + 1, 100));
    expect(await rejection(buildVariants(huge, MAGIC.jpeg))).toBe('bad_dimensions');
    const edge = new FakeProcessor(info('jpeg', MIN_DIMENSION_PX, MIN_DIMENSION_PX));
    await expect(buildVariants(edge, MAGIC.jpeg)).resolves.toHaveLength(3);
  });

  it('un original corrupto (el procesador lo rechaza) se propaga como ImageRejectedError', async () => {
    const proc = new FakeProcessor(undefined, new ImageRejectedError('corrupt'));
    expect(await rejection(buildVariants(proc, MAGIC.jpeg))).toBe('corrupt');
  });

  it('un fallo NO clasificado del procesador se propaga tal cual (transitorio)', async () => {
    const proc = new FakeProcessor(undefined, new Error('sharp no cargó'));
    await expect(buildVariants(proc, MAGIC.jpeg)).rejects.toThrow('sharp no cargó');
  });
});

describe('buildVariants: tamaños (nunca se amplía)', () => {
  it('original grande: una variante por ancho del contrato', async () => {
    const proc = new FakeProcessor(info('jpeg', 4000, 3000));
    const out = await buildVariants(proc, MAGIC.jpeg);
    expect(out.map((v) => v.width)).toEqual([480, 960, 1600]);
    expect(proc.resized).toEqual([480, 960, 1600]);
  });

  it('original de 1000 px: 1600 se limita a 1000 y se reutiliza lo ya codificado', async () => {
    const proc = new FakeProcessor(info('jpeg', 1000, 700));
    const out = await buildVariants(proc, MAGIC.jpeg);
    expect(out.map((v) => v.width)).toEqual([480, 960, 1600]);
    expect(proc.resized).toEqual([480, 960, 1000]);
  });

  it('original menor que 480: las tres claves existen y comparten UNA sola codificación', async () => {
    const proc = new FakeProcessor(info('png', 300, 200));
    const out = await buildVariants(proc, MAGIC.png);
    expect(out.map((v) => v.width)).toEqual([480, 960, 1600]);
    expect(proc.resized).toEqual([300]);
    const bodies = new Set(out.map((v) => new TextDecoder().decode(v.body)));
    expect(bodies).toEqual(new Set(['webp:300']));
  });

  it('nunca pide al procesador un ancho mayor que el del original', async () => {
    for (const w of [16, 479, 480, 481, 959, 960, 1599, 1600, 5000]) {
      const proc = new FakeProcessor(info('webp', w, 100));
      await buildVariants(proc, MAGIC.webp);
      expect(Math.max(...proc.resized)).toBeLessThanOrEqual(w);
    }
  });
});

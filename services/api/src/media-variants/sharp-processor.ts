import type SharpModule from 'sharp';
import { MAX_AVIF_PIXELS, MAX_INPUT_PIXELS, WEBP_EFFORT, WEBP_QUALITY } from './limits';
import {
  ImageRejectedError,
  type ImageFormat,
  type ImageInfo,
  type ImageProcessor,
} from './processor';

/*
 * sharp (https://sharp.pixelplumbing.com) es una biblioteca de Node que usa libvips, una librería
 * nativa en C muy rápida y de poco consumo de memoria para redimensionar imágenes. Trae binarios
 * precompilados POR PLATAFORMA (macOS, linux-x64, linux-arm64...): en Lambda hay que empaquetar el
 * de la arquitectura de la función (ver `MediaStack`). Es gratis (licencia Apache-2.0); el único
 * costo es el tiempo de cómputo de la Lambda.
 */

type SharpFn = typeof SharpModule;

let cached: Promise<SharpFn> | undefined;

/**
 * Carga sharp una sola vez y de forma PEREZOSA (`import()`): si el binario nativo falta o no es de
 * la plataforma, el fallo ocurre al procesar (error transitorio que dispara la alarma de errores) y
 * no al importar el módulo, así la lógica pura sigue siendo probable sin el binario.
 */
function loadSharp(): Promise<SharpFn> {
  cached ??= import('sharp').then((m) => {
    const sharp = (m as unknown as { default?: SharpFn }).default ?? (m as unknown as SharpFn);
    // Sin caché de operaciones: en una Lambda de una sola invocación a la vez solo gasta memoria.
    sharp.cache(false);
    return sharp;
  });
  return cached;
}

const SUPPORTED: Readonly<Record<string, ImageFormat>> = {
  jpeg: 'jpeg',
  png: 'png',
  webp: 'webp',
};

export interface SharpImageProcessorOptions {
  /** Tope de píxeles de entrada (por defecto `MAX_INPUT_PIXELS`). */
  limitInputPixels?: number;
  /** Tope de píxeles de entrada solo para AVIF (por defecto `MAX_AVIF_PIXELS`). */
  maxAvifPixels?: number;
}

export class SharpImageProcessor implements ImageProcessor {
  private readonly limitInputPixels: number;
  private readonly maxAvifPixels: number;

  public constructor(options: SharpImageProcessorOptions = {}) {
    this.limitInputPixels = options.limitInputPixels ?? MAX_INPUT_PIXELS;
    this.maxAvifPixels = options.maxAvifPixels ?? MAX_AVIF_PIXELS;
  }

  public async inspect(input: Uint8Array): Promise<ImageInfo> {
    const sharp = await loadSharp();
    let meta;
    try {
      meta = await sharp(input, { limitInputPixels: this.limitInputPixels }).metadata();
    } catch (err) {
      throw classify(err);
    }
    let format: ImageFormat | undefined = SUPPORTED[meta.format ?? ''];
    // AVIF es un contenedor HEIF con compresión AV1; HEIC (HEVC) NO está permitido.
    if (meta.format === 'heif' && meta.compression === 'av1') format = 'avif';
    if (format === undefined) throw new ImageRejectedError('unsupported_type');

    const rawW = meta.width ?? 0;
    const rawH = meta.height ?? 0;
    // Orientaciones EXIF 5 a 8 giran 90 grados: ancho y alto se intercambian al aplicarla.
    const rotated = (meta.orientation ?? 1) >= 5;
    const width = rotated ? rawH : rawW;
    const height = rotated ? rawW : rawH;
    const limit =
      format === 'avif'
        ? Math.min(this.maxAvifPixels, this.limitInputPixels)
        : this.limitInputPixels;
    if (width * height > limit) throw new ImageRejectedError('pixel_limit');
    return { format, width, height };
  }

  public async toWebp(input: Uint8Array, width: number): Promise<Uint8Array> {
    // Defensa en profundidad: aplica los topes de píxeles por formato (incluido el de AVIF) sobre el
    // encabezado aunque quien llame no haya hecho `inspect` antes (`buildVariants` sí lo hace).
    await this.inspect(input);
    const sharp = await loadSharp();
    try {
      // `autoOrient()` aplica la orientación EXIF y la quita; sharp NO copia EXIF/GPS/XMP/ICC al
      // resultado salvo que se pida (`keepMetadata`/`withMetadata`): aquí no se pide, privacidad.
      return await sharp(input, { limitInputPixels: this.limitInputPixels, sequentialRead: true })
        .autoOrient()
        .resize({ width, withoutEnlargement: true })
        .webp({ quality: WEBP_QUALITY, effort: WEBP_EFFORT })
        .toBuffer();
    } catch (err) {
      throw classify(err);
    }
  }
}

/** Errores de decodificación = imagen mala (permanente). `ImageRejectedError` pasa tal cual. */
function classify(err: unknown): ImageRejectedError {
  if (err instanceof ImageRejectedError) return err;
  const message = err instanceof Error ? err.message : '';
  return new ImageRejectedError(/pixel limit/i.test(message) ? 'pixel_limit' : 'corrupt');
}

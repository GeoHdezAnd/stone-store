/** Formatos de entrada permitidos (coinciden con `MEDIA_CONTENT_TYPES` del presigner). */
export type ImageFormat = 'jpeg' | 'png' | 'webp' | 'avif';

export interface ImageInfo {
  /** Formato que ve el DECODIFICADOR (se cruza con los magic bytes). */
  format: ImageFormat;
  /** Dimensiones tal como se VERÁN (ya con la orientación EXIF aplicada). */
  width: number;
  height: number;
}

export type RejectReason =
  | 'empty'
  | 'too_large'
  | 'unsupported_type'
  | 'format_mismatch'
  | 'bad_dimensions'
  | 'pixel_limit'
  | 'corrupt'
  | 'not_found'
  | 'bad_key';

/**
 * Rechazo PERMANENTE del original (reintentar no lo arregla): se registra y se termina sin
 * reintento. Cualquier OTRO error del procesador se considera transitorio.
 */
export class ImageRejectedError extends Error {
  public constructor(public readonly reason: RejectReason) {
    super(`Imagen rechazada: ${reason}`);
    this.name = 'ImageRejectedError';
  }
}

/** Puerto del procesamiento de imagen: la lógica no depende de sharp (se prueba con un doble). */
export interface ImageProcessor {
  /** Lee formato y dimensiones con límites defensivos. Lanza `ImageRejectedError` si no decodifica. */
  inspect(input: Uint8Array): Promise<ImageInfo>;
  /**
   * WebP de `width` px de ancho: aplica la orientación EXIF, quita TODOS los metadatos (EXIF/GPS)
   * y NO amplía (si el original es más angosto, conserva su ancho).
   */
  toWebp(input: Uint8Array, width: number): Promise<Uint8Array>;
}

import { z } from 'zod';
import { idSchema, photoKeySchema, type PhotoFolder } from '../catalog/common';

// Subida de fotos con URL prefirmada (CLAUDE.md 6.3 y 8). Dominio puro: sin I/O ni AWS SDK.

/** Entidades que pueden tener fotos; coinciden con las carpetas de `photoKeySchema`. */
export const MEDIA_ENTITIES = [
  'stones',
  'projects',
  'finishes',
] as const satisfies readonly PhotoFolder[];
export type MediaEntity = (typeof MEDIA_ENTITIES)[number];

/** Solo imágenes rasterizadas. SVG y HTML quedan fuera a propósito (pueden ejecutar script). */
export const MEDIA_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/avif'] as const;
export type MediaContentType = (typeof MEDIA_CONTENT_TYPES)[number];

/** Extensión de la clave de S3 según el tipo MIME. */
export const MEDIA_EXTENSIONS: Readonly<Record<MediaContentType, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/avif': 'avif',
};

/** Tope por foto: 5 MiB. */
export const MAX_MEDIA_BYTES = 5 * 1024 * 1024;

/** Vigencia de la URL prefirmada de subida. */
export const UPLOAD_URL_TTL_SECONDS = 300;

/** El cliente solo declara qué sube; nunca el nombre ni la clave (los genera el servidor). */
export const uploadRequestSchema = z.strictObject({
  entity: z.enum(MEDIA_ENTITIES, {
    error: 'La entidad debe ser stones, projects o finishes',
  }),
  id: idSchema,
  contentType: z.enum(MEDIA_CONTENT_TYPES, {
    error: 'El tipo de archivo debe ser JPEG, PNG, WebP o AVIF',
  }),
  sizeBytes: z
    .number({ error: 'El tamaño debe ser un número' })
    .int('El tamaño debe ser un número entero de bytes')
    .min(1, 'El archivo no puede estar vacío')
    .max(MAX_MEDIA_BYTES, 'La foto admite máximo 5 MiB'),
});
export type UploadRequest = z.infer<typeof uploadRequestSchema>;

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Clave de S3 `<entity>/<id>/<uuid>.<ext>`. El `uuid` (v4, minúsculas) lo aporta quien llama
 * para que la función siga siendo pura. Lanza si algo no valida o si la clave resultante no
 * pasara `photoKeySchema` (la API de catálogo rechazaría la foto).
 */
export function buildMediaKey(
  entity: MediaEntity,
  id: string,
  contentType: MediaContentType,
  uuid: string,
): string {
  if (!(MEDIA_ENTITIES as readonly string[]).includes(entity)) {
    throw new Error('Entidad de media inválida');
  }
  const ext = (MEDIA_EXTENSIONS as Record<string, string | undefined>)[contentType];
  if (ext === undefined) throw new Error('Tipo de archivo no permitido');
  if (!idSchema.safeParse(id).success) throw new Error('Id inválido');
  if (!UUID_V4_RE.test(uuid)) throw new Error('El identificador debe ser un UUID v4 en minúsculas');
  const key = `${entity}/${id}/${uuid}.${ext}`;
  if (!photoKeySchema(entity).safeParse(key).success) {
    throw new Error('La clave generada no es una clave de foto válida');
  }
  return key;
}

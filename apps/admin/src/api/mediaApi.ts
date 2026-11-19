import { MAX_MEDIA_BYTES, MEDIA_CONTENT_TYPES } from '@canteras/shared';
import type { MediaContentType, MediaEntity } from '@canteras/shared';
import { UserMessageError } from './errors';
import type { ApiFetch } from './client';

interface UploadUrlResponse {
  key: string;
  url: string;
  headers: { 'content-type': string };
}

/** Valida tipo y tamaño en el cliente; devuelve el mensaje en español o `null` si es válido. */
export function validateImageFile(file: File): string | null {
  if (!(MEDIA_CONTENT_TYPES as readonly string[]).includes(file.type)) {
    return 'La foto debe ser JPEG, PNG, WebP o AVIF.';
  }
  if (file.size === 0) return 'El archivo está vacío.';
  if (file.size > MAX_MEDIA_BYTES) return 'La foto admite máximo 5 MiB.';
  return null;
}

export interface MediaApi {
  /** Sube la foto a S3 y devuelve su clave. No toca el registro: la clave se guarda al guardar. */
  upload(entity: MediaEntity, ownerId: string, file: File): Promise<string>;
}

/** Único lugar que conoce el flujo de subida: URL prefirmada y PUT directo a S3. */
export function createMediaApi(
  api: ApiFetch,
  fetchImpl: typeof fetch = (...a) => fetch(...a),
): MediaApi {
  return {
    upload: async (entity, ownerId, file) => {
      const invalid = validateImageFile(file);
      if (invalid) throw new UserMessageError(invalid);

      const presigned = await api<UploadUrlResponse>('/admin/media/upload-url', {
        method: 'POST',
        body: {
          entity,
          id: ownerId,
          contentType: file.type as MediaContentType,
          sizeBytes: file.size,
        },
      });

      // PUT directo a S3: solo content-type (nada de Authorization, la URL ya va firmada).
      let res: Response;
      try {
        res = await fetchImpl(presigned.url, {
          method: 'PUT',
          headers: { 'content-type': presigned.headers['content-type'] },
          body: file,
        });
      } catch {
        throw new UserMessageError('No pudimos subir la foto. Revisa tu conexión.');
      }
      if (!res.ok) throw new UserMessageError('No pudimos subir la foto. Inténtalo de nuevo.');
      return presigned.key;
    },
  };
}

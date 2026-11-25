import { GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { MAX_ORIGINAL_BYTES } from './limits';
import type { ObjectStore } from './process-event';
import { ImageRejectedError } from './processor';

/** Implementación de `ObjectStore` sobre el SDK v3 de S3. */
export class S3ObjectStore implements ObjectStore {
  public constructor(private readonly client: S3Client) {}

  public async get(bucket: string, key: string): Promise<Uint8Array> {
    let res;
    try {
      res = await this.client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    } catch (err) {
      // Foto borrada antes de procesarse: no hay nada que reintentar ni que alarmar.
      // OJO: sin `s3:ListBucket` (que la Lambda no tiene a propósito, mínimo privilegio) S3 contesta
      // 403 AccessDenied, no NoSuchKey, para una clave ausente; en ese caso se reintenta una vez y
      // cuenta como error. Esta rama solo cubre al servicio cuando sí informa NoSuchKey.
      if (err instanceof Error && err.name === 'NoSuchKey')
        throw new ImageRejectedError('not_found');
      throw err;
    }
    // La longitud la informa S3 (no el cliente): se corta ANTES de leer el cuerpo a memoria.
    if ((res.ContentLength ?? 0) > MAX_ORIGINAL_BYTES) throw new ImageRejectedError('too_large');
    if (res.Body === undefined) throw new Error('GetObject sin cuerpo');
    return res.Body.transformToByteArray();
  }

  public async put(
    bucket: string,
    key: string,
    body: Uint8Array,
    meta: { contentType: string; cacheControl: string },
  ): Promise<void> {
    // Sin ACL (el bucket las tiene deshabilitadas) ni cifrado explícito: aplica el SSE-S3 por defecto.
    await this.client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: meta.contentType,
        CacheControl: meta.cacheControl,
      }),
    );
  }
}

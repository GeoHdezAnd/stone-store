import { PutObjectCommand } from '@aws-sdk/client-s3';
import { UPLOAD_URL_TTL_SECONDS, buildMediaKey, uploadRequestSchema } from '@canteras/shared';
import { randomUUID } from 'node:crypto';
import { jsonResponse } from '../lib/http';
import { createRouter, route, type Route, type RouterOptions } from '../lib/router';
import { validationErrorResponse } from '../lib/validation';
import type { Presign } from './presigner';

export type { Presign } from './presigner';

export interface MediaDeps {
  /** Nombre del bucket de media (variable `MEDIA_BUCKET`). */
  bucket: string;
  /** Presigner inyectado: en producción el real; en pruebas uno falso (sin red). */
  presign: Presign;
  /** Para pruebas: generador de UUID (por defecto `crypto.randomUUID`). */
  uuid?: () => string;
}

/**
 * `POST /admin/media/upload-url`: devuelve una URL prefirmada para SUBIR (PUT) una foto.
 * El cliente solo declara entidad, id, tipo y tamaño; la clave la genera el servidor y
 * `content-type` y `content-length` van firmados (S3 rechaza lo que no coincida).
 */
export function createMediaRoutes(deps: MediaDeps): Route[] {
  const uuid = deps.uuid ?? randomUUID;
  return [
    route('POST', '/admin/media/upload-url', ['owner', 'staff'], async (ctx) => {
      const parsed = uploadRequestSchema.safeParse(ctx.body);
      if (!parsed.success) return validationErrorResponse(parsed.error);
      const { entity, id, contentType, sizeBytes } = parsed.data;

      const key = buildMediaKey(entity, id, contentType, uuid());
      const url = await deps.presign(
        new PutObjectCommand({
          Bucket: deps.bucket,
          Key: key,
          ContentType: contentType,
          ContentLength: sizeBytes,
        }),
        { expiresIn: UPLOAD_URL_TTL_SECONDS },
      );

      // Nunca se registra la URL: es un secreto de corta vida.
      ctx.log.info('media_upload_url_issued', { userId: ctx.userId, key, sizeBytes });
      return jsonResponse(200, {
        key,
        url,
        method: 'PUT',
        // `content-length` también va firmado, pero el navegador lo pone solo (no se puede
        // fijar desde JS): el cliente solo debe enviar este `content-type`.
        headers: { 'content-type': contentType },
        expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
      });
    }),
  ];
}

export function createMediaRouter(deps: MediaDeps, options: RouterOptions = {}) {
  return createRouter(createMediaRoutes(deps), options);
}

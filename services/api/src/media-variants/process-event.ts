import { isProcessableOriginalKey, isVariantKey, variantKey } from '@canteras/shared';
import type { Context, S3Event } from 'aws-lambda';
import { createLogger, type Logger } from '../lib/logger';
import { MAX_ORIGINAL_BYTES, VARIANT_CACHE_CONTROL, VARIANT_CONTENT_TYPE } from './limits';
import { ImageRejectedError, type ImageProcessor } from './processor';
import { buildVariants } from './variants';

/** Acceso mínimo a S3 (puerto): en pruebas es un doble; en producción, `S3ObjectStore`. */
export interface ObjectStore {
  /** Descarga el objeto. Lanza `ImageRejectedError('too_large')` si pasa de `MAX_ORIGINAL_BYTES`. */
  get(bucket: string, key: string): Promise<Uint8Array>;
  put(
    bucket: string,
    key: string,
    body: Uint8Array,
    meta: { contentType: string; cacheControl: string },
  ): Promise<void>;
}

export interface VariantsHandlerDeps {
  /** Bucket esperado (`MEDIA_BUCKET`): eventos de otro bucket se ignoran. */
  bucket: string;
  store: ObjectStore;
  processor: ImageProcessor;
  /** Logger base; por invocación se deriva uno con el `requestId`. */
  logger?: Logger;
}

/** Mensaje genérico que se lanza para que Lambda reintente: no filtra detalles internos. */
export const TRANSIENT_FAILURE_MESSAGE = 'media_variants_failed';

/**
 * S3 entrega la clave URL-encoded (`+` = espacio, `%xx`). Una secuencia inválida es un rechazo
 * permanente de ese registro.
 */
export function decodeS3Key(raw: string): string {
  try {
    return decodeURIComponent(raw.replace(/\+/g, ' '));
  } catch {
    throw new ImageRejectedError('bad_key');
  }
}

/** Pista de la clave SIN identificar el archivo completo: carpeta + cola corta (para logs). */
export function partialKey(key: string): string {
  const folder = key.split('/')[0]?.slice(0, 16) ?? '';
  return `${folder}/…${key.slice(-8)}`;
}

/**
 * Handler del evento `ObjectCreated` de S3 (puede traer varios registros). Reglas:
 * - Ignora lo que no es creación de objeto, otro bucket, variantes (ANTI-BUCLE: escribir una
 *   variante vuelve a disparar el evento) y claves fuera de los prefijos de fotos.
 * - Rechazo permanente (tipo, tamaño, corrupción): se registra y se sigue, sin reintento.
 * - Fallo transitorio (S3, sharp no disponible): se sigue con los demás registros y al final se
 *   lanza un error genérico para que Lambda reintente (acotado por `retryAttempts` en la infra).
 */
export function createVariantsHandler(deps: VariantsHandlerDeps) {
  const baseLogger = deps.logger;
  return async (event: S3Event, context?: Pick<Context, 'awsRequestId'>): Promise<void> => {
    const log =
      baseLogger ??
      createLogger(context?.awsRequestId === undefined ? {} : { requestId: context.awsRequestId });
    let transientFailures = 0;

    for (const record of event.Records ?? []) {
      let hint = '?';
      try {
        if (!record.eventName.startsWith('ObjectCreated:')) continue;
        if (record.s3.bucket.name !== deps.bucket) {
          log.warn('unexpected_bucket', {});
          continue;
        }
        const key = decodeS3Key(record.s3.object.key);
        hint = partialKey(key);
        if (isVariantKey(key)) {
          log.info('skipped', { keyHint: hint, reason: 'variant' });
          continue;
        }
        if (!isProcessableOriginalKey(key)) {
          log.info('skipped', { keyHint: hint, reason: 'key_not_allowed' });
          continue;
        }
        const declared = record.s3.object.size;
        if (declared === 0) throw new ImageRejectedError('empty');
        if (declared > MAX_ORIGINAL_BYTES) throw new ImageRejectedError('too_large');

        const original = await deps.store.get(deps.bucket, key);
        const variants = await buildVariants(deps.processor, original);
        for (const v of variants) {
          await deps.store.put(deps.bucket, variantKey(key, v.width), v.body, {
            contentType: VARIANT_CONTENT_TYPE,
            cacheControl: VARIANT_CACHE_CONTROL,
          });
        }
        log.info('variants_created', { keyHint: hint, count: variants.length });
      } catch (err) {
        if (err instanceof ImageRejectedError) {
          log.warn('image_rejected', { keyHint: hint, reason: err.reason });
        } else {
          transientFailures += 1;
          // Solo el nombre del error: el mensaje puede traer ARN, bucket o claves completas.
          log.error('variants_failed', {
            keyHint: hint,
            errorName: err instanceof Error ? err.name : 'unknown',
          });
        }
      }
    }

    if (transientFailures > 0) throw new Error(TRANSIENT_FAILURE_MESSAGE);
  };
}

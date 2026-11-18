import { S3Client, type PutObjectCommand, type S3ClientConfig } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/**
 * Cabeceras que DEBEN ir firmadas. Sin esto S3 aceptaría cualquier Content-Type (el presigner
 * del SDK solo firma `content-length` por defecto) y, en una subida directa desde el navegador,
 * podría guardarse un HTML o SVG con un tipo distinto al validado. Con ambas firmadas, S3
 * rechaza (403) una subida cuyo tipo o tamaño difiera de lo que autorizó el servidor.
 */
const SIGNED_HEADERS = ['content-type', 'content-length'] as const;

export type Presign = (
  command: PutObjectCommand,
  options: { expiresIn: number },
) => Promise<string>;

/**
 * Cliente S3 para firmar. Se crea una vez por arranque.
 * - `requestChecksumCalculation: 'WHEN_REQUIRED'`: el SDK reciente añade `x-amz-checksum-crc32`
 *   a la URL, y el navegador no puede enviar ese checksum.
 * - Con `S3_PUBLIC_ENDPOINT` (solo emulador) se firma contra el endpoint que alcanza el
 *   navegador (path-style); sin ella, el cliente estándar de AWS.
 */
export function createS3Client(
  env: { S3_PUBLIC_ENDPOINT?: string | undefined },
  overrides: S3ClientConfig = {},
): S3Client {
  const publicEndpoint = env.S3_PUBLIC_ENDPOINT;
  return new S3Client({
    requestChecksumCalculation: 'WHEN_REQUIRED',
    ...(publicEndpoint ? { endpoint: publicEndpoint, forcePathStyle: true } : {}),
    ...overrides,
  });
}

/** Presigner real: firma el PUT con `content-type` y `content-length` como cabeceras firmadas. */
export function createPresigner(client: S3Client): Presign {
  return (command, { expiresIn }) =>
    getSignedUrl(client, command, {
      expiresIn,
      signableHeaders: new Set(SIGNED_HEADERS),
      unhoistableHeaders: new Set(SIGNED_HEADERS),
    });
}

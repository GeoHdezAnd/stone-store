import { GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';

/** El objeto inmutable de esa versión ya existe (no se sobrescribe sin permiso explícito). */
export class ObjectExistsError extends Error {
  constructor() {
    super('El objeto de esa versión ya existe.');
    this.name = 'ObjectExistsError';
  }
}

/** El objeto inmutable de esa versión no se encontró. */
export class ObjectMissingError extends Error {
  constructor() {
    super('No se encontró el objeto de esa versión.');
    this.name = 'ObjectMissingError';
  }
}

export const CURRENT_COPY_KEY = 'published/catalog.json';
export const immutableKey = (version: string): string => `published/${version}/catalog.json`;

/**
 * Almacén del catálogo publicado. Las versiones son objetos INMUTABLES
 * (`published/v<N>/catalog.json`); `published/catalog.json` es la copia vigente que lee el sitio.
 */
export interface PublishStorage {
  /** Sin `overwrite`, falla con `ObjectExistsError` si la clave ya existe. */
  putImmutable(version: string, body: string, options: { overwrite: boolean }): Promise<void>;
  getImmutable(version: string): Promise<string>;
  /** Idempotente: pisa la copia vigente. */
  putCurrentCopy(body: string): Promise<void>;
}

const CONTENT_TYPE = 'application/json; charset=utf-8';

export class S3PublishStorage implements PublishStorage {
  constructor(
    private readonly client: Pick<S3Client, 'send'>,
    private readonly bucket: string,
  ) {}

  async putImmutable(
    version: string,
    body: string,
    options: { overwrite: boolean },
  ): Promise<void> {
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: immutableKey(version),
          Body: body,
          ContentType: CONTENT_TYPE,
          // Las versiones no cambian nunca: el sitio o un revert pueden cachearlas sin miedo.
          CacheControl: 'public, max-age=31536000, immutable',
          // Escritura condicional de S3: solo si la clave NO existe (evita que dos publicaciones
          // simultáneas se pisen el objeto de la misma versión).
          ...(options.overwrite ? {} : { IfNoneMatch: '*' }),
        }),
      );
    } catch (err) {
      if (isPreconditionFailed(err)) throw new ObjectExistsError();
      throw err;
    }
  }

  async getImmutable(version: string): Promise<string> {
    try {
      const out = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: immutableKey(version) }),
      );
      if (out.Body === undefined) throw new ObjectMissingError();
      return await out.Body.transformToString('utf-8');
    } catch (err) {
      if ((err as { name?: string } | null)?.name === 'NoSuchKey') throw new ObjectMissingError();
      throw err;
    }
  }

  async putCurrentCopy(body: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: CURRENT_COPY_KEY,
        Body: body,
        ContentType: CONTENT_TYPE,
        // Caché corta: además la invalidación de CloudFront la limpia al publicar.
        CacheControl: 'public, max-age=60',
      }),
    );
  }
}

function isPreconditionFailed(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } } | null;
  return (
    e?.name === 'PreconditionFailed' ||
    e?.name === 'ConditionalRequestConflict' ||
    e?.$metadata?.httpStatusCode === 412
  );
}

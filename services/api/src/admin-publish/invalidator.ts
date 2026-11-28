import { randomUUID } from 'node:crypto';
import { CreateInvalidationCommand, type CloudFrontClient } from '@aws-sdk/client-cloudfront';

/**
 * Configuración del `CloudFrontClient` de esta Lambda: sin ella el SDK espera sin límite y reintenta.
 * Peor caso: 1 intento × (1 s de conexión + 2 s de petición) = 3 s (mismo patrón que
 * `SES_CLIENT_CONFIG` en `quotes-create/budget.ts`; las opciones son de `NodeHttpHandlerOptions`).
 */
export const CLOUDFRONT_CLIENT_CONFIG = {
  maxAttempts: 1,
  requestHandler: { requestTimeout: 2000, connectionTimeout: 1000 },
} as const;

export type InvalidationResult = 'ok' | 'skipped';

/**
 * Pide a CloudFront que olvide rutas en caché. Lanza si la petición falla: quien llama decide
 * (publicar NO falla por una invalidación fallida).
 */
export interface Invalidator {
  invalidate(paths: readonly string[]): Promise<InvalidationResult>;
}

/** Sin distribución configurada (p. ej. en emulador o antes de existir el sitio): no hace nada. */
export class NoopInvalidator implements Invalidator {
  async invalidate(): Promise<InvalidationResult> {
    return 'skipped';
  }
}

/** CreateInvalidation sobre UNA distribución (el rol IAM solo puede invalidar esa). */
export class CloudFrontInvalidator implements Invalidator {
  constructor(
    private readonly client: Pick<CloudFrontClient, 'send'>,
    private readonly distributionId: string,
    private readonly newReference: () => string = randomUUID,
  ) {}

  async invalidate(paths: readonly string[]): Promise<InvalidationResult> {
    await this.client.send(
      new CreateInvalidationCommand({
        DistributionId: this.distributionId,
        InvalidationBatch: {
          CallerReference: this.newReference(),
          Paths: { Quantity: paths.length, Items: [...paths] },
        },
      }),
    );
    return 'ok';
  }
}

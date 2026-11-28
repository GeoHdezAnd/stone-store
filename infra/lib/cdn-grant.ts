import { Annotations, Aws, type Stack } from 'aws-cdk-lib';
import { Effect, PolicyStatement, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { type Bucket } from 'aws-cdk-lib/aws-s3';

/** Formato de un id de distribución de CloudFront (p. ej. `E1ABCDEF234567`). */
const DISTRIBUTION_ID_RE = /^[A-Z0-9]{8,20}$/;

/**
 * Valida el id de la distribución del sitio (variable `SITE_DISTRIBUTION_ID`).
 * Vacío o ausente = `undefined` (sin permiso para CloudFront: falla cerrado). Un valor con otro
 * formato LANZA: un id mal escrito no debe terminar en una política de bucket.
 */
export function parseSiteDistributionId(raw: string | undefined): string | undefined {
  const value = (raw ?? '').trim();
  if (value === '') return undefined;
  if (!DISTRIBUTION_ID_RE.test(value)) {
    throw new Error(
      'SITE_DISTRIBUTION_ID no tiene el formato de un id de distribución de CloudFront (p. ej. E1ABCDEF234567).',
    );
  }
  return value;
}

export interface CdnGrantOptions {
  readonly stack: Stack;
  readonly bucket: Bucket;
  /** Id ya validado (o `undefined`/vacío = sin permiso). Se vuelve a validar por defensa. */
  readonly distributionId: string | undefined;
  /** Patrones de objeto (sin `/` inicial). Nunca `*` a secas: se limita a lo que debe ser público. */
  readonly objectPatterns: readonly string[];
  /** Con emulador no se avisa: Floci no aplica bucket policies. */
  readonly emulated: boolean;
  /** Qué sirve el bucket, para el texto del aviso. */
  readonly what: string;
}

/**
 * Permiso OAC en la política del bucket DUEÑO: CloudFront (y solo la distribución del sitio, por
 * `AWS:SourceArn` exacto) puede hacer `s3:GetObject` de los patrones indicados. Nada más.
 * Sin id no hay permiso (falla cerrado) y, fuera del emulador, se avisa de que habrá 403.
 */
export function grantCdnRead(options: CdnGrantOptions): void {
  const { stack, bucket, objectPatterns, emulated, what } = options;
  const distributionId = parseSiteDistributionId(options.distributionId);
  if (distributionId === undefined) {
    if (!emulated) {
      Annotations.of(stack).addWarning(
        `Sin SITE_DISTRIBUTION_ID, CloudFront no podrá leer ${what}: darán 403 hasta desplegar de nuevo con el id de la distribución del sitio.`,
      );
    }
    return;
  }
  bucket.addToResourcePolicy(
    new PolicyStatement({
      sid: 'AllowSiteCdnReadOnly',
      effect: Effect.ALLOW,
      principals: [new ServicePrincipal('cloudfront.amazonaws.com')],
      actions: ['s3:GetObject'],
      resources: objectPatterns.map((pattern) => bucket.arnForObjects(pattern)),
      conditions: {
        StringEquals: {
          'AWS:SourceArn': `arn:${Aws.PARTITION}:cloudfront::${Aws.ACCOUNT_ID}:distribution/${distributionId}`,
        },
      },
    }),
  );
}

import { join } from 'node:path';

import { Annotations, CfnOutput, Duration, Stack, type StackProps } from 'aws-cdk-lib';
import {
  AllowedMethods,
  CachePolicy,
  Function as CfFunction,
  FunctionCode,
  FunctionEventType,
  FunctionRuntime,
  HeadersFrameOption,
  HeadersReferrerPolicy,
  ResponseHeadersPolicy,
  S3OriginAccessControl,
  ViewerProtocolPolicy,
  type BehaviorOptions,
} from 'aws-cdk-lib/aws-cloudfront';
import { S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { type Construct } from 'constructs';

import { MEDIA_PATH, PUBLISHED_PATH, mediaBucketName, publishBucketName } from './bucket-names.js';
import { type DeployEnv } from './config.js';
import { StaticSite } from './static-site.js';

export interface SiteStackProps extends StackProps {
  readonly deploy: DeployEnv;
}

/** CSP de las fotos: son imágenes y nada más; `sandbox` evita que un archivo se ejecute como página. */
export const MEDIA_CSP = "default-src 'none'; img-src 'self'; sandbox";

/**
 * Sitio público: bucket privado + UNA sola distribución de CloudFront (sin dominio propio en la
 * fase 1: se usa `*.cloudfront.net`; Route 53 y ACM llegan cuando haya dominio).
 *
 * La misma distribución sirve, además del sitio:
 * - `/media/*`: las fotos (variantes WebP) del bucket de media, filtradas por una CloudFront Function.
 * - `/published/*`: el `catalog.json` del bucket de publicación.
 * Así el navegador usa un solo origen (sin CORS ni segundo dominio) y los buckets siguen privados.
 *
 * Sin ciclos entre stacks: los buckets de media y de publicación se IMPORTAN por su nombre fijo
 * (`bucket-names.ts`) en vez de recibirlos de sus stacks. La política que deja leer a CloudFront
 * (con el ARN exacto de esta distribución) la escribe el stack dueño de cada bucket, a partir de
 * `SITE_DISTRIBUTION_ID`. Por eso este stack se despliega PRIMERO y no depende de ningún otro.
 */
export class SiteStack extends Stack {
  public readonly site: StaticSite;

  public constructor(scope: Construct, id: string, props: SiteStackProps) {
    const { deploy, ...stackProps } = props;
    super(scope, id, stackProps);

    // Buckets de OTROS stacks importados por nombre fijo: sin referencias cruzadas.
    const publish = Bucket.fromBucketName(this, 'PublishBucket', publishBucketName(deploy.name));
    const oac = new S3OriginAccessControl(this, 'ExtraOriginsOac');

    // Solo lectura: GET y HEAD, nunca ALLOW_ALL (los buckets no aceptan escrituras por aquí).
    const readOnly = {
      viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: AllowedMethods.ALLOW_GET_HEAD,
      cachePolicy: CachePolicy.CACHING_OPTIMIZED,
    } satisfies Partial<BehaviorOptions>;

    const additionalBehaviors: Record<string, BehaviorOptions> = {};

    // Con Floci (emulador) NO existe `/media/*`: Floci no ejecuta CloudFront Functions ni soporta
    // `ResponseHeadersPolicy` propias (CLAUDE.md 9.2), así que sin la función nada filtraría la
    // ruta. Fallar cerrado es lo más seguro: las fotos se prueban en el hito de AWS real.
    if (!deploy.emulated) {
      const media = Bucket.fromBucketName(this, 'MediaBucket', mediaBucketName(deploy.name));
      const mediaFunction = new CfFunction(this, 'MediaViewerRequest', {
        runtime: FunctionRuntime.JS_2_0,
        code: FunctionCode.fromFile({
          filePath: join(import.meta.dirname, '..', 'functions', 'media-viewer-request.js'),
        }),
        comment: 'Solo variantes WebP de /media/*; quita el prefijo y la query',
      });
      // El origen ya fija Content-Type y Cache-Control: la política NO los pisa.
      const mediaHeaders = new ResponseHeadersPolicy(this, 'MediaHeaders', {
        securityHeadersBehavior: {
          contentSecurityPolicy: { contentSecurityPolicy: MEDIA_CSP, override: true },
          contentTypeOptions: { override: true },
          strictTransportSecurity: {
            accessControlMaxAge: Duration.days(730),
            includeSubdomains: true,
            override: true,
          },
          frameOptions: { frameOption: HeadersFrameOption.DENY, override: true },
          referrerPolicy: { referrerPolicy: HeadersReferrerPolicy.NO_REFERRER, override: true },
        },
      });
      additionalBehaviors[MEDIA_PATH] = {
        ...readOnly,
        origin: S3BucketOrigin.withOriginAccessControl(media, { originAccessControl: oac }),
        responseHeadersPolicy: mediaHeaders,
        functionAssociations: [
          { eventType: FunctionEventType.VIEWER_REQUEST, function: mediaFunction },
        ],
      };
    }

    // `/published/*` no necesita función: la clave del objeto ya empieza con `published/`.
    additionalBehaviors[PUBLISHED_PATH] = {
      ...readOnly,
      origin: S3BucketOrigin.withOriginAccessControl(publish, { originAccessControl: oac }),
      responseHeadersPolicy: ResponseHeadersPolicy.SECURITY_HEADERS,
    };

    // Solo `dev` puede borrar el bucket junto con el stack (CLAUDE.md 9.2).
    // Con Floci se apaga el autodelete (límite del emulador, ver `StaticSite`).
    this.site = new StaticSite(this, 'Site', {
      ephemeral: deploy.name === 'dev',
      autoDeleteObjects: !deploy.emulated,
      additionalBehaviors,
    });

    // Con un bucket importado CDK no escribe su política y avisa; es lo esperado: la escribe el
    // stack dueño (MediaStack/PublishStack) con el ARN exacto de la distribución.
    Annotations.of(this).acknowledgeWarning(
      '@aws-cdk/aws-cloudfront-origins:updateImportedBucketPolicyOac',
      'MediaStack y PublishStack agregan el permiso OAC con SITE_DISTRIBUTION_ID.',
    );

    // Salidas con nombre lógico fijo: `scripts/sync-site.ts` las lee para saber a qué
    // bucket subir y qué distribución invalidar. No cambiar estos ids sin ajustar el script.
    new CfnOutput(this, 'BucketName', { value: this.site.bucket.bucketName });
    new CfnOutput(this, 'DistributionId', { value: this.site.distribution.distributionId });
    new CfnOutput(this, 'DistributionDomainName', {
      value: this.site.distribution.domainName,
    });
  }
}

import { CfnOutput, Stack, type StackProps } from 'aws-cdk-lib';
import { type Construct } from 'constructs';

import { type DeployEnv } from './config.js';
import { StaticSite } from './static-site.js';

export interface AdminSiteStackProps extends StackProps {
  readonly deploy: DeployEnv;
  /**
   * Origen (`https://host`, sin ruta) de la API de administración para `connect-src`.
   * Por defecto cualquier API Gateway de la región. NO se importa de `ApiStack`: este stack
   * no depende de la API (ver «Circularidad CORS» abajo).
   */
  readonly apiOrigin?: string;
}

export interface AdminCspOptions {
  readonly region: string;
  readonly apiOrigin?: string;
}

/**
 * CSP del dashboard (cabecera de CloudFront; en desarrollo una `<meta>` rompería el HMR de Vite).
 *
 * - `default-src 'self'` y `script-src`/`style-src`/`font-src 'self'`: el build de Vite emite
 *   JS, CSS y fuentes (woff2, autoalojadas) como archivos propios y la app no usa estilos en
 *   línea (verificado con el build); sin `unsafe-inline`.
 * - `connect-src`: la API, Cognito (`cognito-idp`, SRP/refresh desde el navegador) y el bucket
 *   de media (subida con URL prefirmada por PUT).
 * - `img-src 'self' data:` + el bucket de media: NO se abre todo `https:` (evita exfiltrar
 *   datos con imágenes remotas); las fotos del catálogo vienen del bucket de media.
 */
export function buildAdminCsp(options: AdminCspOptions): string {
  const { region } = options;
  const apiOrigin = options.apiOrigin ?? `https://*.execute-api.${region}.amazonaws.com`;
  // Solo https y sin caracteres que permitan inyectar otras directivas.
  if (!/^https:\/\/[A-Za-z0-9*.-]+(:\d+)?$/.test(apiOrigin)) {
    throw new Error(
      `apiOrigin inválido: "${apiOrigin}". Debe ser https://host (sin ruta ni caracteres especiales).`,
    );
  }
  const media = `https://*.s3.${region}.amazonaws.com`;
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "font-src 'self'",
    `img-src 'self' data: ${media}`,
    `connect-src 'self' ${apiOrigin} https://cognito-idp.${region}.amazonaws.com ${media}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');
}

/**
 * Dashboard del dueño: bucket privado + CloudFront (reutiliza `StaticSite`), SPA, `noindex`
 * y CSP propia. Sin dominio propio por ahora (`*.cloudfront.net`).
 *
 * Circularidad CORS (decisión del dueño, pendiente para el hito de AWS real): `ApiStack` y
 * `MediaStack` necesitan el origen del admin (`ADMIN_ORIGINS`) y el origen real solo se conoce
 * al desplegar este stack. Por eso `ADMIN_ORIGINS` sigue en `http://localhost:5173` en dev y
 * este stack NO depende de `ApiStack`. En AWS real: despliegue en dos pasos (1. este stack,
 * 2. redesplegar API/Media con `ADMIN_ORIGINS=https://<dominio>.cloudfront.net`) o dominio propio.
 */
export class AdminSiteStack extends Stack {
  public readonly site: StaticSite;

  public constructor(scope: Construct, id: string, props: AdminSiteStackProps) {
    const { deploy, apiOrigin, ...stackProps } = props;
    super(scope, id, stackProps);

    this.site = new StaticSite(this, 'Site', {
      ephemeral: deploy.name === 'dev',
      autoDeleteObjects: !deploy.emulated,
      spaFallback: true,
      responseHeaders: {
        contentSecurityPolicy: buildAdminCsp({
          region: deploy.region,
          ...(apiOrigin === undefined ? {} : { apiOrigin }),
        }),
        noIndex: true,
        // Floci no soporta ResponseHeadersPolicy propias: usa la administrada.
        disabled: deploy.emulated,
      },
    });

    // Ids fijos: los leen `scripts/sync-site.ts` (modo admin). No cambiar sin ajustar el script.
    new CfnOutput(this, 'BucketName', { value: this.site.bucket.bucketName });
    new CfnOutput(this, 'DistributionId', { value: this.site.distribution.distributionId });
    new CfnOutput(this, 'DistributionDomainName', {
      value: this.site.distribution.domainName,
    });
  }
}

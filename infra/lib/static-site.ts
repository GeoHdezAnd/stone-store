import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import {
  type BehaviorOptions,
  Distribution,
  HeadersFrameOption,
  HeadersReferrerPolicy,
  PriceClass,
  ResponseHeadersPolicy,
  ViewerProtocolPolicy,
} from 'aws-cdk-lib/aws-cloudfront';
import { S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { BlockPublicAccess, Bucket, BucketEncryption, type IBucket } from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export interface StaticSiteProps {
  /**
   * `true` solo en `dev`: el bucket se vacía y se borra junto con el stack.
   * En `prod` debe ser `false` (el bucket se conserva aunque se destruya el stack).
   */
  readonly ephemeral: boolean;
  /**
   * Si el bucket se vacía automáticamente al destruir el stack (Lambda de CDK).
   * Por defecto sigue a `ephemeral`. Se apaga con Floci: esa Lambda no alcanza al
   * emulador (ECONNREFUSED al puerto 443), así que el bucket se vacía a mano.
   */
  readonly autoDeleteObjects?: boolean;
  /**
   * Para SPA (el dashboard): 403 y 404 devuelven `/index.html` con 200 y un TTL corto,
   * así las rutas del cliente (`/piedras/arenisca`) cargan la app en vez de un error.
   * Opt-in: el sitio público (Astro, páginas reales) no lo usa.
   */
  readonly spaFallback?: boolean;
  /**
   * Política de cabeceras propia (CSP, HSTS, nosniff, frame DENY, referrer-policy y,
   * opcionalmente, `X-Robots-Tag`). Sin esta opción se usa la administrada SECURITY_HEADERS.
   */
  readonly responseHeaders?: StaticSiteResponseHeaders;
  /** Comportamientos extra por ruta (p. ej. `/media/*`). Cada uno trae su propio origen y OAC. */
  readonly additionalBehaviors?: Record<string, BehaviorOptions>;
}

export interface StaticSiteResponseHeaders {
  /** Valor completo de `Content-Security-Policy`. */
  readonly contentSecurityPolicy: string;
  /** Agrega `X-Robots-Tag: noindex, nofollow` (para áreas privadas). */
  readonly noIndex?: boolean;
  /**
   * Apaga la política propia y vuelve a la administrada. Se usa con Floci, que no soporta
   * `ResponseHeadersPolicy` personalizadas vía CloudFormation (CLAUDE.md 9.2).
   */
  readonly disabled?: boolean;
}

/**
 * Sitio estático servido por CloudFront desde un bucket S3 privado.
 *
 * Se reutiliza para el sitio público (`SiteStack`) y para el dashboard (`AdminSiteStack`).
 * El contenido NO lo despliega CDK: lo sube la CI con `aws s3 sync` (ver CLAUDE.md 9.1).
 */
export class StaticSite extends Construct {
  public readonly bucket: Bucket;
  public readonly distribution: Distribution;

  public constructor(scope: Construct, id: string, props: StaticSiteProps) {
    super(scope, id);

    // Bucket privado: nadie puede leerlo directo, solo CloudFront (vía OAC).
    this.bucket = new Bucket(this, 'Bucket', {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: props.ephemeral ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN,
      autoDeleteObjects: props.ephemeral && (props.autoDeleteObjects ?? true),
    });

    const customHeaders = props.responseHeaders;
    const headersPolicy =
      customHeaders && customHeaders.disabled !== true
        ? new ResponseHeadersPolicy(this, 'Headers', {
            securityHeadersBehavior: {
              contentSecurityPolicy: {
                contentSecurityPolicy: customHeaders.contentSecurityPolicy,
                override: true,
              },
              strictTransportSecurity: {
                accessControlMaxAge: Duration.days(730),
                includeSubdomains: true,
                override: true,
              },
              contentTypeOptions: { override: true },
              frameOptions: { frameOption: HeadersFrameOption.DENY, override: true },
              referrerPolicy: {
                referrerPolicy: HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
                override: true,
              },
            },
            ...(customHeaders.noIndex === true
              ? {
                  customHeadersBehavior: {
                    customHeaders: [
                      { header: 'X-Robots-Tag', value: 'noindex, nofollow', override: true },
                    ],
                  },
                }
              : {}),
          })
        : ResponseHeadersPolicy.SECURITY_HEADERS;

    this.distribution = new Distribution(this, 'Distribution', {
      defaultRootObject: 'index.html',
      defaultBehavior: {
        // Crea el OAC y agrega a la bucket policy el permiso de ESTA distribución.
        // El cast a IBucket es por una incompatibilidad de tipos de aws-cdk-lib con
        // `exactOptionalPropertyTypes` (`Bucket.isWebsite` es opcional en la clase y obligatorio en la interfaz).
        origin: S3BucketOrigin.withOriginAccessControl(this.bucket as IBucket),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        // Política propia (CSP, noindex) si se pidió; si no, la administrada de AWS.
        responseHeadersPolicy: headersPolicy,
      },
      ...(props.additionalBehaviors ? { additionalBehaviors: props.additionalBehaviors } : {}),
      ...(props.spaFallback === true
        ? {
            errorResponses: [403, 404].map((httpStatus) => ({
              httpStatus,
              responseHttpStatus: 200,
              responsePagePath: '/index.html',
              ttl: Duration.seconds(10),
            })),
          }
        : {}),
      // minimumProtocolVersion se agrega junto con el dominio y el certificado ACM: sin
      // certificado propio CloudFront usa el predeterminado y la propiedad no tiene efecto.
      // La clase más barata (NA y Europa): suficiente para un proyecto académico.
      priceClass: PriceClass.PRICE_CLASS_100,
    });
  }
}

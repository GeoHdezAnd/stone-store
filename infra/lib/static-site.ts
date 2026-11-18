import { CfnOutput, RemovalPolicy } from 'aws-cdk-lib';
import {
  Distribution,
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
      autoDeleteObjects: props.ephemeral,
    });

    this.distribution = new Distribution(this, 'Distribution', {
      defaultRootObject: 'index.html',
      defaultBehavior: {
        // Crea el OAC y agrega a la bucket policy el permiso de ESTA distribución.
        // El cast a IBucket es por una incompatibilidad de tipos de aws-cdk-lib con
        // `exactOptionalPropertyTypes` (`Bucket.isWebsite` es opcional en la clase y obligatorio en la interfaz).
        origin: S3BucketOrigin.withOriginAccessControl(this.bucket as IBucket),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        // Política administrada de AWS (HSTS, nosniff, etc.). La CSP llega después.
        responseHeadersPolicy: ResponseHeadersPolicy.SECURITY_HEADERS,
      },
      // minimumProtocolVersion se agrega junto con el dominio y el certificado ACM: sin
      // certificado propio CloudFront usa el predeterminado y la propiedad no tiene efecto.
      // La clase más barata (NA y Europa): suficiente para un proyecto académico.
      priceClass: PriceClass.PRICE_CLASS_100,
    });

    new CfnOutput(this, 'DistributionDomainName', { value: this.distribution.domainName });
  }
}

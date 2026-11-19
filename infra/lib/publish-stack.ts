import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import {
  BlockPublicAccess,
  Bucket,
  BucketEncryption,
  ObjectOwnership,
  type IBucket,
} from 'aws-cdk-lib/aws-s3';
import { type Construct } from 'constructs';

import { type DeployEnv } from './config.js';

export interface PublishStackProps extends StackProps {
  readonly deploy: DeployEnv;
}

/**
 * Bucket S3 del catálogo publicado (`catalog.json`): PRIVADO y con VERSIONADO.
 *
 * - Objetos inmutables `published/v<N>/catalog.json` (el historial para revertir) y la copia
 *   vigente `published/catalog.json`, que es la que lee el sitio público (más adelante, por
 *   CloudFront con OAC como segundo origen; el bucket NUNCA es público).
 * - Es un bucket PROPIO, no el del sitio: el deploy del sitio usa `aws s3 sync --delete` y
 *   borraría estos objetos (CLAUDE.md 9.1: el contenido y la infra tienen ciclos de vida
 *   distintos).
 * - El versionado de S3 es la red de seguridad extra (un objeto sobrescrito o borrado por error
 *   se recupera); las versiones NO vigentes caducan a los 90 días para no acumular costo.
 */
export class PublishStack extends Stack {
  public readonly bucket: Bucket;

  public constructor(scope: Construct, id: string, props: PublishStackProps) {
    const { deploy, ...stackProps } = props;
    super(scope, id, stackProps);

    const ephemeral = deploy.name === 'dev';

    this.bucket = new Bucket(this, 'Bucket', {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      objectOwnership: ObjectOwnership.BUCKET_OWNER_ENFORCED,
      enforceSSL: true,
      versioned: true,
      lifecycleRules: [
        {
          abortIncompleteMultipartUploadAfter: Duration.days(1),
          noncurrentVersionExpiration: Duration.days(90),
        },
      ],
      // Solo `dev` puede borrar el bucket con el stack. El autodelete usa una custom resource
      // que no funciona con Floci (ECONNREFUSED al puerto 443): se apaga con emulador.
      removalPolicy: ephemeral ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN,
      autoDeleteObjects: ephemeral && !deploy.emulated,
    });

    new CfnOutput(this, 'PublishBucketName', { value: this.bucket.bucketName });
  }
}

/** Referencia estrecha que consume ApiStack (evita arrastrar `Bucket` completo). */
export type PublishBucketRef = Pick<IBucket, 'bucketName' | 'bucketArn'>;

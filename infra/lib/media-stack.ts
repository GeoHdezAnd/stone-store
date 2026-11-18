import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import {
  BlockPublicAccess,
  Bucket,
  BucketEncryption,
  HttpMethods,
  ObjectOwnership,
  type IBucket,
} from 'aws-cdk-lib/aws-s3';
import { type Construct } from 'constructs';

import { type DeployEnv } from './config.js';
import { validateAllowedOrigins } from './origins.js';

export interface MediaStackProps extends StackProps {
  readonly deploy: DeployEnv;
  /** Orígenes del dashboard que pueden subir fotos con PUT (mismos que el CORS de la API). */
  readonly allowedOrigins: string[];
}

/**
 * Bucket S3 de fotos (`media`): PRIVADO. Las subidas llegan por URL prefirmada que emite la
 * Lambda de administración; la lectura pública llegará después por CloudFront con OAC
 * (CLAUDE.md 6.3). S3 con poco tráfico cuesta centavos (almacenamiento por GB).
 */
export class MediaStack extends Stack {
  public readonly bucket: Bucket;

  public constructor(scope: Construct, id: string, props: MediaStackProps) {
    const { deploy, allowedOrigins, ...stackProps } = props;
    super(scope, id, stackProps);

    const origins = validateAllowedOrigins(deploy, allowedOrigins);
    if (origins.length === 0) {
      throw new Error('MediaStack requiere al menos un origen CORS en allowedOrigins.');
    }
    const ephemeral = deploy.name === 'dev';

    this.bucket = new Bucket(this, 'Bucket', {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      // ACL deshabilitadas: solo valen las políticas IAM/bucket (el dueño del bucket es dueño de todo).
      objectOwnership: ObjectOwnership.BUCKET_OWNER_ENFORCED,
      enforceSSL: true,
      // Sin versionado: una foto reemplazada no se recupera; las claves son únicas (UUID).
      versioned: false,
      // Las subidas multiparte abandonadas siguen cobrando almacenamiento: se abortan a 1 día.
      lifecycleRules: [{ abortIncompleteMultipartUploadAfter: Duration.days(1) }],
      // CORS para el PUT directo desde el navegador con la URL prefirmada. Nunca `*`.
      // `content-type` va en la preflight; `content-length` lo pone el navegador (se incluye
      // por si algún cliente lo lista). Solo PUT: no se lee ni se borra desde el navegador.
      cors: [
        {
          allowedOrigins: origins,
          allowedMethods: [HttpMethods.PUT],
          allowedHeaders: ['content-type', 'content-length'],
          exposedHeaders: ['ETag'],
          maxAge: 3000,
        },
      ],
      // Solo `dev` puede borrar el bucket con el stack. El autodelete usa una custom resource que
      // no funciona con Floci (ECONNREFUSED al puerto 443), así que se apaga con emulador.
      removalPolicy: ephemeral ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN,
      autoDeleteObjects: ephemeral && !deploy.emulated,
    });

    new CfnOutput(this, 'MediaBucketName', { value: this.bucket.bucketName });
  }
}

/** Referencia estrecha que consume ApiStack (evita arrastrar `Bucket` completo). */
export type MediaBucketRef = Pick<IBucket, 'bucketName' | 'bucketArn'>;

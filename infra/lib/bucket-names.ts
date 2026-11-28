import { Aws, Fn } from 'aws-cdk-lib';

import { type DeployEnv } from './config.js';

/*
 * Nombres de bucket FIJOS (no generados por CloudFormation).
 *
 * Por qué: `SiteStack` (la distribución de CloudFront) necesita apuntar a los buckets de media y de
 * publicación, y ESOS stacks necesitan el id de la distribución para su política OAC. Si `SiteStack`
 * recibiera el `Bucket` real, CDK escribiría la política en el stack del sitio y habría un ciclo
 * (publish -> site por `Distribution.Ref`, site -> publish por `RegionalDomainName`). Con el nombre
 * conocido de antemano, `SiteStack` importa el bucket con `Bucket.fromBucketName` y no depende de
 * nadie. Se incluyen cuenta y región porque los nombres de S3 son únicos a nivel global.
 *
 * Longitud: `canteras-publish-prod-<12 dígitos>-<región>` mide 49 caracteres con la región más larga
 * actual (14), por debajo del límite de 63 de S3.
 */
type EnvName = DeployEnv['name'];

const fixedName = (prefix: string, env: EnvName): string =>
  Fn.join('-', [prefix, env, Aws.ACCOUNT_ID, Aws.REGION]);

export const mediaBucketName = (env: EnvName): string => fixedName('canteras-media', env);
export const publishBucketName = (env: EnvName): string => fixedName('canteras-publish', env);

/** Rutas de CloudFront (comportamientos) que sirven los buckets de fotos y de catálogo. */
export const MEDIA_PATH = '/media/*';
export const PUBLISHED_PATH = '/published/*';

import { CloudFrontClient } from '@aws-sdk/client-cloudfront';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { SSMClient } from '@aws-sdk/client-ssm';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { loadConfig } from './config';
import { SsmSecretProvider } from '../lib/ssm-secret';
import { CLOUDFRONT_CLIENT_CONFIG, CloudFrontInvalidator, NoopInvalidator } from './invalidator';
import { DynamoPublishRepository } from './repository';
import { createPublishRouter } from './routes';
import { sha256Hex } from './sha256';
import { GithubRebuilder, NoopRebuilder, type SiteRebuilder } from './site-rebuild';
import { S3PublishStorage } from './storage';

export { createPublishRouter };

// Se lee el entorno y se crean los clientes UNA vez, al arrancar (se reutilizan entre invocaciones).
// Si falta una variable obligatoria, el arranque falla con un error claro en los logs.
const config = loadConfig(process.env);
const repo = new DynamoPublishRepository(
  DynamoDBDocumentClient.from(new DynamoDBClient({})),
  config.tables,
);
const storage = new S3PublishStorage(new S3Client({}), config.bucket);
// Sin `SITE_DISTRIBUTION_ID` (emulador o sitio aún sin desplegar) no se invalida nada.
const invalidator =
  config.siteDistributionId === undefined
    ? new NoopInvalidator()
    : new CloudFrontInvalidator(
        new CloudFrontClient({ ...CLOUDFRONT_CLIENT_CONFIG }),
        config.siteDistributionId,
      );
// Sin configuración completa (o en el emulador, donde la infraestructura no define las variables)
// no se dispara nada. El token se lee de SSM en cada petición (con caché en memoria de 5 minutos).
let rebuilder: SiteRebuilder = new NoopRebuilder();
if (config.siteRebuild !== undefined) {
  const secret = new SsmSecretProvider(new SSMClient({}), config.siteRebuild.tokenParam);
  rebuilder = new GithubRebuilder({
    token: () => secret.get(),
    repository: config.siteRebuild.repository,
    workflowFile: config.siteRebuild.workflowFile,
    ref: config.siteRebuild.ref,
  });
}

export const handler = createPublishRouter({
  repo,
  storage,
  invalidator,
  rebuilder,
  sha256: sha256Hex,
}).handle;

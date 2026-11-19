import { CloudFrontClient } from '@aws-sdk/client-cloudfront';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { loadConfig } from './config';
import { CloudFrontInvalidator, NoopInvalidator } from './invalidator';
import { DynamoPublishRepository } from './repository';
import { createPublishRouter } from './routes';
import { sha256Hex } from './sha256';
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
    : new CloudFrontInvalidator(new CloudFrontClient({}), config.siteDistributionId);

export const handler = createPublishRouter({
  repo,
  storage,
  invalidator,
  sha256: sha256Hex,
}).handle;

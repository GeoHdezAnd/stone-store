/**
 * Rellena las variantes WebP (480/960/1600) de las fotos que no las tienen: las subidas antes de
 * desplegar la Lambda `MediaVariants` o cuyo evento de S3 se perdió. Idempotente.
 *
 * Uso:
 *   npx tsx scripts/media-backfill.ts              # simulación (dry-run): solo informa
 *   npx tsx scripts/media-backfill.ts --apply      # genera y sube las variantes faltantes
 * Variables (iguales que seed.ts):
 *   APP_ENV=dev|prod         (por defecto dev). Con AWS_ENDPOINT_URL apunta a Floci (credenciales `test`).
 *   SEED_CONFIRM_PROD=si     obligatoria con APP_ENV=prod.
 * Permisos: necesita `s3:ListBucket`, `s3:GetObject` y `s3:PutObject` sobre el bucket de media (las
 * credenciales del dueño, no las de la Lambda, que no puede listar). Usa sharp en LOCAL: no hace falta
 * el binario linux-arm64. La salida no incluye claves completas ni datos personales.
 */
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { MEDIA_ENTITIES } from '@canteras/shared';

import { S3ObjectStore } from '../services/api/src/media-variants/s3-store';
import { SharpImageProcessor } from '../services/api/src/media-variants/sharp-processor';
import {
  checkBackfillEnv,
  formatBackfillReport,
  parseBackfillArgs,
  runBackfill,
  type StoredObject,
} from './media-backfill-lib';

async function readBucketName(stackName: string): Promise<string> {
  const cfn = new CloudFormationClient({});
  const { Stacks } = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
  const out = Stacks?.[0]?.Outputs?.find((o) => o.OutputKey === 'MediaBucketName')?.OutputValue;
  if (!out) {
    throw new Error(`El stack ${stackName} no tiene la salida "MediaBucketName". ¿Se desplegó?`);
  }
  return out;
}

async function listObjects(client: S3Client, bucket: string): Promise<StoredObject[]> {
  const objects: StoredObject[] = [];
  for (const prefix of MEDIA_ENTITIES) {
    let token: string | undefined;
    do {
      const res = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: `${prefix}/`,
          ...(token === undefined ? {} : { ContinuationToken: token }),
        }),
      );
      for (const o of res.Contents ?? []) {
        if (o.Key !== undefined) objects.push({ key: o.Key, size: o.Size ?? 0 });
      }
      token = res.NextContinuationToken;
    } while (token !== undefined);
  }
  return objects;
}

async function main(): Promise<void> {
  const appEnv = checkBackfillEnv(process.env);
  const { apply } = parseBackfillArgs(process.argv.slice(2));

  const bucket = await readBucketName(`canteras-media-${appEnv}`);
  // Floci usa rutas (path-style) para los buckets.
  const client = new S3Client({ forcePathStyle: Boolean(process.env['AWS_ENDPOINT_URL']) });
  const objects = await listObjects(client, bucket);

  const report = await runBackfill(
    { bucket, store: new S3ObjectStore(client), processor: new SharpImageProcessor(), apply },
    objects,
  );
  console.log(formatBackfillReport(report, apply));
  if (report.failed > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

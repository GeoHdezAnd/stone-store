/**
 * Carga los códigos postales de EJEMPLO (`content/postal-codes.json`) en la tabla `PostalCodes`.
 * No son datos de SEPOMEX: solo sirven para probar el estimado de flete.
 *
 * Uso: npx tsx scripts/seed-postal-codes.ts
 * Variables (iguales que seed.ts):
 *   APP_ENV=dev|prod         (por defecto dev). Con AWS_ENDPOINT_URL apunta a Floci.
 *   SEED_CONFIRM_PROD=si     obligatoria con APP_ENV=prod.
 *
 * NO sobrescribe: consulta con BatchGetItem qué `cp` ya existen y escribe solo los que faltan con
 * BatchWriteItem (lotes de 25). Correrlo dos veces no cambia nada. La lógica pura vive en
 * seed-postal-codes-lib.ts.
 */
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { BatchGetCommand, BatchWriteCommand, DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { join } from 'node:path';

import {
  BATCH_WRITE_SIZE,
  buildPostalCodesSeed,
  checkSeedEnv,
  chunk,
  readPostalCodesContent,
  selectNewPostalCodes,
} from './seed-postal-codes-lib';

const MAX_ATTEMPTS = 6;
// BatchGetItem admite 100 claves por llamada.
const BATCH_GET_SIZE = 100;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function readOutputs(stackName: string): Promise<Record<string, string>> {
  const cfn = new CloudFormationClient({});
  const { Stacks } = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
  const outputs = Stacks?.[0]?.Outputs ?? [];
  return Object.fromEntries(outputs.map((o) => [o.OutputKey ?? '', o.OutputValue ?? '']));
}

async function existingKeys(
  db: DynamoDBDocumentClient,
  table: string,
  cps: readonly string[],
): Promise<Set<string>> {
  const found = new Set<string>();
  for (const lote of chunk(cps, BATCH_GET_SIZE)) {
    let keys: Record<string, unknown>[] = lote.map((cp) => ({ cp }));
    for (let attempt = 0; keys.length > 0; attempt++) {
      if (attempt >= MAX_ATTEMPTS) throw new Error('BatchGetItem no resolvió todas las claves.');
      if (attempt > 0) await sleep(100 * 2 ** attempt);
      const out = await db.send(
        new BatchGetCommand({
          RequestItems: { [table]: { Keys: keys, ProjectionExpression: 'cp' } },
        }),
      );
      for (const item of out.Responses?.[table] ?? []) found.add(String(item['cp']));
      keys = out.UnprocessedKeys?.[table]?.Keys ?? [];
    }
  }
  return found;
}

async function main(): Promise<void> {
  const appEnv = checkSeedEnv(process.env);

  // Valida todo antes de tocar AWS.
  const contentDir = join(import.meta.dirname, '..', 'content');
  const items = buildPostalCodesSeed(readPostalCodesContent(contentDir));

  // Debe coincidir con el id del stack en infra/bin/app.ts.
  const stackName = `canteras-data-${appEnv}`;
  const tableName = (await readOutputs(stackName))['PostalCodesTableName'];
  if (!tableName) {
    throw new Error(
      `El stack ${stackName} no tiene la salida "PostalCodesTableName". ¿Se desplegó?`,
    );
  }

  const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const existing = await existingKeys(
    db,
    tableName,
    items.map((i) => i.cp),
  );
  const { toWrite, skipped } = selectNewPostalCodes(items, existing);

  for (const lote of chunk(toWrite, BATCH_WRITE_SIZE)) {
    let pending: Record<string, unknown>[] = lote.map((Item) => ({ PutRequest: { Item } }));
    for (let attempt = 0; pending.length > 0; attempt++) {
      if (attempt >= MAX_ATTEMPTS) throw new Error('BatchWriteItem no escribió todos los items.');
      if (attempt > 0) await sleep(100 * 2 ** attempt);
      const out = await db.send(
        new BatchWriteCommand({ RequestItems: { [tableName]: pending as never } }),
      );
      pending = (out.UnprocessedItems?.[tableName] as Record<string, unknown>[] | undefined) ?? [];
    }
  }
  console.log(`PostalCodes: ${toWrite.length} insertados, ${skipped} omitidos (ya existían).`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

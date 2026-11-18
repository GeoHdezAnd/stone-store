/**
 * Carga los datos de ejemplo de `content/*.json` en las tablas del DataStack.
 *
 * Uso: npx tsx scripts/seed.ts
 * Variables:
 *   APP_ENV=dev|prod         (por defecto dev). Con AWS_ENDPOINT_URL apunta a Floci.
 *   SEED_CONFIRM_PROD=si     obligatoria con APP_ENV=prod; sin ella el script aborta.
 *
 * Salvaguardas (mismas que sync-site.ts e infra/lib/config.ts):
 *   - APP_ENV distinto de dev/prod: error.
 *   - prod + AWS_ENDPOINT_URL (emulador): error.
 *   - prod sin SEED_CONFIRM_PROD=si: error.
 *   - Todo se valida con los esquemas de packages/shared ANTES de escribir.
 *   - PutItem con attribute_not_exists(<clave>): NO sobrescribe lo editado desde el
 *     dashboard, así que correrlo dos veces no cambia nada (idempotente).
 *
 * La lógica pura (validar, armar items) vive en seed-lib.ts.
 */
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { join } from 'node:path';

import { buildSeedPlan, readContent } from './seed-lib';

function checkEnv(env: NodeJS.ProcessEnv): 'dev' | 'prod' {
  const appEnv = env['APP_ENV'] ?? 'dev';
  if (appEnv !== 'dev' && appEnv !== 'prod') {
    throw new Error(`APP_ENV inválido: "${appEnv}". Usa "dev" o "prod".`);
  }
  if (appEnv === 'prod' && env['AWS_ENDPOINT_URL']) {
    throw new Error('APP_ENV=prod no puede usar AWS_ENDPOINT_URL (emulador).');
  }
  if (appEnv === 'prod' && env['SEED_CONFIRM_PROD'] !== 'si') {
    throw new Error('Para cargar datos en prod define SEED_CONFIRM_PROD=si. Abortado.');
  }
  return appEnv;
}

async function readOutputs(stackName: string): Promise<Record<string, string>> {
  const cfn = new CloudFormationClient({});
  const { Stacks } = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
  const outputs = Stacks?.[0]?.Outputs ?? [];
  return Object.fromEntries(outputs.map((o) => [o.OutputKey ?? '', o.OutputValue ?? '']));
}

async function main(): Promise<void> {
  const appEnv = checkEnv(process.env);

  // Valida todo antes de tocar AWS.
  const contentDir = join(import.meta.dirname, '..', 'content');
  const plan = buildSeedPlan(readContent(contentDir));

  // Debe coincidir con el id del stack en infra/bin/app.ts.
  const stackName = `canteras-data-${appEnv}`;
  const outputs = await readOutputs(stackName);

  const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  for (const { table, key, items } of plan) {
    const tableName = outputs[`${table}TableName`];
    if (!tableName) {
      throw new Error(
        `El stack ${stackName} no tiene la salida "${table}TableName". ¿Se desplegó?`,
      );
    }
    let inserted = 0;
    let skipped = 0;
    for (const item of items) {
      try {
        await db.send(
          new PutCommand({
            TableName: tableName,
            Item: item,
            ConditionExpression: 'attribute_not_exists(#k)',
            ExpressionAttributeNames: { '#k': key },
          }),
        );
        inserted++;
      } catch (error) {
        if (error instanceof ConditionalCheckFailedException) skipped++;
        else throw error;
      }
    }
    console.log(`${table}: ${inserted} insertados, ${skipped} omitidos (ya existían).`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

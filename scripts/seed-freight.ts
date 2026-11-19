/**
 * Carga la configuración de flete de EJEMPLO (`content/freight-config.json`) en la tabla
 * `FreightConfig` como versión `t0001`, y deja la fila puntero `ACTIVE` apuntando a ella.
 *
 * Uso: npx tsx scripts/seed-freight.ts
 * Variables (iguales que seed.ts):
 *   APP_ENV=dev|prod         (por defecto dev). Con AWS_ENDPOINT_URL apunta a Floci.
 *   SEED_CONFIRM_PROD=si     obligatoria con APP_ENV=prod.
 *
 * Idempotente y NO sobrescribe: una sola transacción con `attribute_not_exists` en ambas filas.
 * Si ya existe `t0001` o el puntero (p. ej. el dueño ya guardó tarifas desde el dashboard), no
 * cambia nada. La lógica pura (validar, armar filas) vive en seed-freight-lib.ts.
 */
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { DynamoDBClient, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { join } from 'node:path';

import {
  buildFreightSeed,
  checkSeedEnv,
  readFreightContent,
  SEED_VERSION,
} from './seed-freight-lib';

async function readOutputs(stackName: string): Promise<Record<string, string>> {
  const cfn = new CloudFormationClient({});
  const { Stacks } = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
  const outputs = Stacks?.[0]?.Outputs ?? [];
  return Object.fromEntries(outputs.map((o) => [o.OutputKey ?? '', o.OutputValue ?? '']));
}

async function main(): Promise<void> {
  const appEnv = checkSeedEnv(process.env);

  // Valida todo antes de tocar AWS.
  const contentDir = join(import.meta.dirname, '..', 'content');
  const { row, pointer } = buildFreightSeed(
    readFreightContent(contentDir),
    new Date().toISOString(),
  );

  // Debe coincidir con el id del stack en infra/bin/app.ts.
  const stackName = `canteras-data-${appEnv}`;
  const tableName = (await readOutputs(stackName))['FreightConfigTableName'];
  if (!tableName) {
    throw new Error(
      `El stack ${stackName} no tiene la salida "FreightConfigTableName". ¿Se desplegó?`,
    );
  }

  const notExists = {
    ConditionExpression: 'attribute_not_exists(#v)',
    ExpressionAttributeNames: { '#v': 'version' },
  };
  const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  try {
    await db.send(
      new TransactWriteCommand({
        TransactItems: [
          { Put: { TableName: tableName, Item: row, ...notExists } },
          { Put: { TableName: tableName, Item: pointer, ...notExists } },
        ],
      }),
    );
    console.log(`FreightConfig: ${SEED_VERSION} insertada y activa.`);
  } catch (error) {
    if (
      error instanceof TransactionCanceledException &&
      error.CancellationReasons?.some((r) => r.Code === 'ConditionalCheckFailed')
    ) {
      console.log(`FreightConfig: omitida (ya existía ${SEED_VERSION} o el puntero ACTIVE).`);
      return;
    }
    throw error;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

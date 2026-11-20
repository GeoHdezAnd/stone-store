/**
 * Carga ~30 solicitudes de EJEMPLO (`ejemplo: true`) en la tabla `Quotes`, con folios `CN-AAAA-NNNNN`
 * reservados en `Counters` (`folio#<año>`, ADD atómico).
 *
 * Uso: npx tsx scripts/seed-quotes.ts
 * Variables (iguales que seed.ts):
 *   APP_ENV=dev|prod         (por defecto dev). Con AWS_ENDPOINT_URL apunta a Floci.
 *   SEED_CONFIRM_PROD=si     obligatoria con APP_ENV=prod.
 *
 *   SEED_ALLOW_PROD_COUNTERS=si  también obligatoria con APP_ENV=prod (consume folios reales).
 *
 * Idempotente y reanudable: cuenta las solicitudes de ejemplo que ya hay. Con 30 o más no hace nada
 * (ni toca el contador); con menos (corrida interrumpida) genera solo las que faltan, en el orden
 * del plan. Orden: 1) valida todo sin tocar AWS, 2) cuenta ejemplos, 3) reserva folios, 4) inserta
 * con `attribute_not_exists`. Si se interrumpe entre 3 y 4 quedan folios sin usar (huecos en el
 * contador): es inofensivo en un proyecto de ejemplo. Requiere haber sembrado antes `seed.ts`
 * (piedras) y `seed-freight.ts` solo en el sentido de que usa los mismos archivos de `content/`.
 */
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { join } from 'node:path';

import {
  buildQuoteSeeds,
  checkQuotesSeedEnv,
  SEED_QUOTE_COUNT,
  folioCounterName,
  loadSeedInputs,
  seedYearCounts,
} from './seed-quotes-lib';

async function readOutputs(stackName: string): Promise<Record<string, string>> {
  const cfn = new CloudFormationClient({});
  const { Stacks } = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
  const outputs = Stacks?.[0]?.Outputs ?? [];
  return Object.fromEntries(outputs.map((o) => [o.OutputKey ?? '', o.OutputValue ?? '']));
}

async function main(): Promise<void> {
  const appEnv = checkQuotesSeedEnv(process.env);
  const now = new Date();

  // Valida todo antes de tocar AWS (los folios de prueba no se usan).
  const contentDir = join(import.meta.dirname, '..', 'content');
  const inputs = loadSeedInputs(contentDir, now.toISOString());
  const counts = seedYearCounts(now);
  buildQuoteSeeds({
    now,
    ...inputs,
    folioStart: Object.fromEntries(Object.keys(counts).map((y) => [y, 1])),
  });

  const outputs = await readOutputs(`canteras-data-${appEnv}`);
  const quotesTable = outputs['QuotesTableName'];
  const countersTable = outputs['CountersTableName'];
  if (!quotesTable || !countersTable) {
    throw new Error(
      'El stack de datos no tiene las salidas QuotesTableName y CountersTableName. ¿Se desplegó?',
    );
  }
  const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));

  // ¿Cuántos ejemplos hay? (Scan acotado a esta tabla de desarrollo; el filtro se evalúa tras leer.)
  let existing = 0;
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await db.send(
      new ScanCommand({
        TableName: quotesTable,
        FilterExpression: 'ejemplo = :t',
        ExpressionAttributeValues: { ':t': true },
        Select: 'COUNT',
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }),
    );
    existing += page.Count ?? 0;
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  if (existing >= SEED_QUOTE_COUNT) {
    console.log('Quotes: omitida (ya hay solicitudes de ejemplo completas).');
    return;
  }
  const pending = seedYearCounts(now, existing);

  // Reserva un bloque de folios por año con un ADD atómico.
  const folioStart: Record<string, number> = {};
  for (const [year, n] of Object.entries(pending)) {
    const out = await db.send(
      new UpdateCommand({
        TableName: countersTable,
        Key: { name: folioCounterName(Number(year)) },
        UpdateExpression: 'ADD #v :n',
        ExpressionAttributeNames: { '#v': 'value' },
        ExpressionAttributeValues: { ':n': n },
        ReturnValues: 'UPDATED_NEW',
      }),
    );
    folioStart[year] = Number(out.Attributes?.['value']) - n + 1;
  }

  const rows = buildQuoteSeeds({ now, ...inputs, folioStart, from: existing });
  for (const row of rows) {
    await db.send(
      new PutCommand({
        TableName: quotesTable,
        Item: row,
        ConditionExpression: 'attribute_not_exists(quoteId)',
      }),
    );
  }
  console.log(`Quotes: ${rows.length} solicitudes de ejemplo insertadas.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

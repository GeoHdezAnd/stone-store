import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { loadConfig } from './config';
import { DynamoMetricsRepository } from './repository';
import { createMetricsRouter } from './routes';

// Se lee el entorno y se crea el cliente UNA vez, al arrancar (se reutiliza entre invocaciones).
const tables = loadConfig(process.env);
const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const repo = new DynamoMetricsRepository(doc, tables);

export const handler = createMetricsRouter({ repo }).handle;

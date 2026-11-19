import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { loadConfig } from './config';
import { DynamoFreightRepository } from './repository';
import { createFreightRouter } from './routes';

export { createFreightRouter };

// Se lee el entorno y se crea el cliente UNA vez, al arrancar (se reutiliza entre invocaciones).
// Si falta una variable obligatoria, el arranque falla con un error claro en los logs.
const tables = loadConfig(process.env);
const repo = new DynamoFreightRepository(
  DynamoDBDocumentClient.from(new DynamoDBClient({})),
  tables,
);

export const handler = createFreightRouter({ repo }).handle;

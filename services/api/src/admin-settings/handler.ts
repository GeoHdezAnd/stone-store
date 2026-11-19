import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { loadConfig } from './config';
import { DynamoSettingsRepository } from './repository';
import { createSettingsRouter } from './routes';

export { createSettingsRouter };

// Se lee el entorno y se crea el cliente UNA vez, al arrancar (se reutiliza entre invocaciones).
// Si falta una variable, el arranque falla con un error claro en los logs.
const config = loadConfig(process.env);
const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const repo = new DynamoSettingsRepository(client, config.settingsTable, config.auditTable);

export const handler = createSettingsRouter(repo).handle;

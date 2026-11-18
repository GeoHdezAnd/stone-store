import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { loadConfig } from './config';
import { DynamoCatalogRepository } from './repository';
import { createCatalogRouter } from './routes';

// Se lee el entorno y se crea el cliente UNA vez, al arrancar (se reutiliza entre invocaciones).
// Si falta una variable, el arranque falla con un error claro en los logs.
const config = loadConfig(process.env);
const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const repo = new DynamoCatalogRepository(client, config.tables, config.auditTable);

export const handler = createCatalogRouter(repo).handle;

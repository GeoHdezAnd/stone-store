import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { SESv2Client } from '@aws-sdk/client-sesv2';
import { createMailer } from '../lib/mailer';
import { loadConfig } from './config';
import { DynamoQuoteRepository } from './repository';
import { createQuotesRouter } from './routes';

export { createQuotesRouter };

// Se lee el entorno y se crea el cliente UNA vez, al arrancar (se reutiliza entre invocaciones).
const tables = loadConfig(process.env);
const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const repo = new DynamoQuoteRepository(doc, tables);
// `null` si el correo no está configurado: la ruta de envío responde 409 `mail_not_configured`.
const mailer = createMailer(process.env, { ses: () => new SESv2Client({}), doc: () => doc });

export const handler = createQuotesRouter({ repo, mailer }).handle;

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SESv2Client } from '@aws-sdk/client-sesv2';
import { SSMClient } from '@aws-sdk/client-ssm';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createMailer } from '../lib/mailer';
import { createCaptchaVerifier } from './captcha';
import { loadConfig } from './config';
import { createQuotesCreateHandler } from './create';
import { DynamoQuotesCreateRepository } from './repository';

// `POST /quotes` es una ruta PÚBLICA: no pasa por el authorizer ni por `createRouter`.
// El entorno se lee y los clientes se crean UNA vez, al arrancar (se reutilizan entre invocaciones).
const config = loadConfig(process.env);
const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const repo = new DynamoQuotesCreateRepository(doc, config);
// `null` si el correo no está configurado: la solicitud se guarda igual y se registra una advertencia.
const mailer = createMailer(process.env, { ses: () => new SESv2Client({}), doc: () => doc });
// `null` si no hay modo fake ni parámetro de SSM: la ruta falla cerrado (503 `captcha_not_configured`).
const captcha = createCaptchaVerifier(config, { ssm: () => new SSMClient({}) });

export const handler = createQuotesCreateHandler({
  repo,
  captcha,
  mailer,
  adminBaseUrl: config.adminBaseUrl,
}).handle;

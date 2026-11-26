import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SESv2Client } from '@aws-sdk/client-sesv2';
import { SSMClient } from '@aws-sdk/client-ssm';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { GeoRoutesClient } from '@aws-sdk/client-geo-routes';
import { createMailer } from '../lib/mailer';
import { createRouteProvider, GEO_ROUTES_CLIENT_CONFIG } from '../lib/route-provider';
import { SES_CLIENT_CONFIG } from './budget';
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
const mailer = createMailer(process.env, {
  ses: () => new SESv2Client({ ...SES_CLIENT_CONFIG }),
  doc: () => doc,
});
// `null` si no hay modo fake ni parámetro de SSM: la ruta falla cerrado (503 `captcha_not_configured`).
const captcha = createCaptchaVerifier(config, { ssm: () => new SSMClient({}) });

// Proveedor de distancias del estimado de flete: `location` (AWS real) o `haversine` (emulador). Sin
// `ROUTE_PROVIDER` no hay estimado (la solicitud se guarda sin `freight`); un valor inválido falla
// al arrancar.
const routes =
  (process.env['ROUTE_PROVIDER'] ?? '') === ''
    ? undefined
    : createRouteProvider(process.env, {
        geoRoutes: () => new GeoRoutesClient({ ...GEO_ROUTES_CLIENT_CONFIG }),
      });

export const handler = createQuotesCreateHandler({
  repo,
  captcha,
  mailer,
  routes,
  adminBaseUrl: config.adminBaseUrl,
}).handle;

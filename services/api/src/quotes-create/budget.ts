/**
 * Presupuesto de tiempo de `POST /quotes`: la Lambda tiene 10 s (`infra/lib/api-stack.ts`) y el
 * `putQuote` ocurre ANTES de los correos, así que un correo lento no pierde la solicitud pero sí
 * puede hacer que la Lambda expire y API Gateway responda 5xx a una solicitud ya guardada.
 *
 * Peor caso por etapa (todas con plazo propio):
 *   captcha            3 000 ms  (`CAPTCHA_TIMEOUT_MS`, incluye la lectura de SSM)
 *   estimado de flete  2 000 ms  (`FREIGHT_TIMEOUT_MS`, `Promise.race` en `create.ts`)
 *   SES                3 000 ms  (conexión 1 000 + petición 2 000, un solo intento; los dos correos
 *                                 salen en paralelo, así que cuenta el más lento)
 *   resto              1 500 ms  (`OTHER_WORK_ALLOWANCE_MS`: ~8 lecturas/escrituras de DynamoDB
 *                                 de unos pocos ms cada una, arranque en frío y serialización)
 *   -------------------------------------------------------
 *   total              9 500 ms  -> margen de 500 ms bajo los 10 s.
 * (Antes: captcha 3 s + ruta 4 s + SES sin plazo superaba los 10 s: medido en 10 428 ms.)
 */

/** Plazo de la Lambda de `QuotesCreate` (el mismo de `makeFunction` en `infra/lib/api-stack.ts`). */
export const LAMBDA_TIMEOUT_MS = 10_000;

/** Margen para todo lo que no tiene plazo propio (DynamoDB, arranque en frío, serialización). */
export const OTHER_WORK_ALLOWANCE_MS = 1500;

/**
 * Configuración del `SESv2Client` de esta Lambda: sin ella el SDK espera sin límite y reintenta.
 * Fuente: `SESv2ClientConfig.requestHandler` y `maxAttempts` en
 * `@aws-sdk/client-sesv2/dist-types/SESv2Client.d.ts`; `requestTimeout` y `connectionTimeout` son
 * opciones de `NodeHttpHandlerOptions` (`@smithy/node-http-handler`), que el cliente instancia
 * cuando `requestHandler` es un objeto de opciones (mismo patrón que `GEO_ROUTES_CLIENT_CONFIG`).
 * Peor caso: 1 intento × (1 s de conexión + 2 s de petición) = 3 s.
 */
export const SES_CLIENT_CONFIG = {
  maxAttempts: 1,
  requestHandler: { requestTimeout: 2000, connectionTimeout: 1000 },
} as const;

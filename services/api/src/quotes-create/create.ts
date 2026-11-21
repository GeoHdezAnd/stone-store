import {
  buildCustomerConfirmationEmail,
  buildNewQuote,
  buildOwnerNotificationEmail,
  createQuoteRequestSchema,
  folioYear,
  formatFolio,
  freightConfigSchema,
  generateUlid,
  MAX_FOLIO_NUMBER,
  NewQuoteError,
  publicSettingsSchema,
  stoneSchema,
  type PublicSettings,
  type Quote,
  type Stone,
} from '@canteras/shared';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { HttpError, jsonResponse } from '../lib/http';
import { createLogger, type Logger, type LogSink } from '../lib/logger';
import type { Mailer, MailMessage } from '../lib/mailer';
import { validationErrorResponse } from '../lib/validation';
import type { CaptchaVerifier } from './captcha';
import { FolioExhaustedError, type QuotesCreateRepository } from './repository';

/**
 * `POST /quotes`: ruta PÚBLICA (sin authorizer) que escribe en la base y manda correos. No usa
 * `createRouter` (que exige claims de Cognito): el cuerpo se mide, se parsea y se valida aquí.
 *
 * Orden fijo, de lo más barato a lo más caro, y SIN efectos hasta el final:
 *   método, tipo de contenido, tamaño (bytes, ANTES de parsear), JSON, esquema, honeypot, captcha,
 *   tarifa activa, piedras, armado y validación del documento, folio, Put, correos (best-effort).
 * El folio se reserva solo cuando todo lo demás es válido, para no gastar números en peticiones malas.
 */

/** Tope del cuerpo: un formulario normal pesa menos de 4 KB. */
export const MAX_BODY_BYTES = 16 * 1024;

export interface QuotesCreateDeps {
  repo: QuotesCreateRepository;
  /** `null` = sin verificador configurado: la ruta falla cerrado (503 `captcha_not_configured`). */
  captcha: CaptchaVerifier | null;
  /** `null` = sin transporte de correo: la solicitud se guarda igual y se registra una advertencia. */
  mailer: Mailer | null;
  /** Origen del dashboard para el enlace del aviso; sin él, el aviso va sin enlace. */
  adminBaseUrl?: string | undefined;
  now?: () => Date;
  newQuoteId?: (now: Date) => string;
  /** Azar del folio señuelo del honeypot (no es criptográfico). */
  random?: () => number;
  /** Para pruebas: destino de los logs. */
  logSink?: LogSink;
}

function cryptoRandom(): number {
  return globalThis.crypto.getRandomValues(new Uint32Array(1))[0]! / 2 ** 32;
}

const JSON_TYPE_RE = /^application\/json\s*(?:;|$)/i;

function header(event: APIGatewayProxyEventV2, name: string): string | undefined {
  for (const [k, v] of Object.entries(event.headers ?? {})) {
    if (k.toLowerCase() === name && typeof v === 'string') return v;
  }
  return undefined;
}

const errorName = (err: unknown): string => (err instanceof Error ? err.name : 'unknown');

export function createQuotesCreateHandler(deps: QuotesCreateDeps) {
  const { repo } = deps;
  const now = deps.now ?? (() => new Date());
  const newQuoteId = deps.newQuoteId ?? ((d: Date) => generateUlid(d.getTime(), cryptoRandom));
  const random = deps.random ?? Math.random;

  /** Correos best-effort: nada de lo que pase aquí cambia la respuesta ni deshace lo guardado. */
  async function notify(quote: Quote, log: Logger): Promise<void> {
    const ref = { quoteId: quote.quoteId, folio: quote.folio };
    try {
      if (deps.mailer === null) {
        log.warn('mail_not_configured', ref);
        return;
      }
      const raw = await repo.getPublicSettings();
      if (raw === null) {
        log.warn('settings_missing', ref);
        return;
      }
      const { key: _key, ...data } = raw;
      void _key;
      const settings = publicSettingsSchema.safeParse(data);
      if (!settings.success) {
        log.warn('invalid_stored_item', { entity: 'settings', ...ref });
        return;
      }
      const pub: PublicSettings = settings.data;
      const messages: [string, MailMessage][] = [
        ['customer', buildCustomerConfirmationEmail({ quote, publicSettings: pub })],
        [
          'owner',
          buildOwnerNotificationEmail({
            quote,
            publicSettings: pub,
            adminBaseUrl: deps.adminBaseUrl,
          }),
        ],
      ];
      const mailer = deps.mailer;
      const results = await Promise.allSettled(messages.map(([, m]) => mailer.send(m)));
      results.forEach((r, i) => {
        // Solo el tipo de correo y el nombre del error: el mensaje puede traer el destinatario.
        if (r.status === 'rejected') {
          log.warn('mail_send_failed', {
            ...ref,
            kind: messages[i]![0],
            errName: errorName(r.reason),
          });
        }
      });
    } catch (err) {
      log.warn('mail_failed', { ...ref, errName: errorName(err) });
    }
  }

  async function handleRequest(
    event: APIGatewayProxyEventV2,
    log: Logger,
  ): Promise<APIGatewayProxyStructuredResultV2> {
    if (event.requestContext?.http?.method !== 'POST')
      throw new HttpError(405, 'method_not_allowed');
    if (!JSON_TYPE_RE.test(header(event, 'content-type') ?? '')) {
      throw new HttpError(415, 'unsupported_media_type');
    }

    // Tamaño real en bytes (UTF-8 o ya decodificado de base64), ANTES de parsear nada.
    const rawBody = typeof event.body === 'string' ? event.body : '';
    const base64 = event.isBase64Encoded === true;
    const size = Buffer.byteLength(rawBody, base64 ? 'base64' : 'utf8');
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'payload_too_large');

    let parsed: unknown;
    try {
      parsed = JSON.parse(base64 ? Buffer.from(rawBody, 'base64').toString('utf8') : rawBody);
    } catch {
      throw new HttpError(400, 'invalid_json');
    }
    const body = createQuoteRequestSchema.safeParse(parsed);
    if (!body.success) return validationErrorResponse(body.error);
    const request = body.data;

    const startedAt = now();
    const year = folioYear(startedAt);

    // Honeypot: se responde EXACTAMENTE como un éxito (201 con un folio de forma válida) para que el
    // bot no sepa que fue detectado; no se guarda nada, no se manda correo y no se gasta un folio.
    if (request.website !== undefined && request.website.trim() !== '') {
      log.info('honeypot_triggered');
      const decoy = 1 + Math.floor(random() * MAX_FOLIO_NUMBER);
      return jsonResponse(201, { folio: formatFolio(year, Math.min(decoy, MAX_FOLIO_NUMBER)) });
    }

    // Captcha: falla cerrado. Sin verificador configurado nunca se acepta una solicitud.
    if (deps.captcha === null) {
      log.warn('captcha_not_configured');
      throw new HttpError(503, 'captcha_not_configured');
    }
    const remoteIp = event.requestContext.http.sourceIp;
    let verified: boolean;
    try {
      verified =
        (await deps.captcha.verify({
          token: request.turnstileToken,
          ...(typeof remoteIp === 'string' && remoteIp !== '' ? { remoteIp } : {}),
        })) === true;
    } catch {
      verified = false;
    }
    if (!verified) {
      log.warn('captcha_failed');
      throw new HttpError(403, 'captcha_failed');
    }

    // Tarifa activa (de ahí sale la merma del peso) y piedras pedidas.
    const freightRow = await repo.getActiveFreightRow();
    if (freightRow === null) {
      log.error('freight_config_missing');
      throw new HttpError(503, 'quotes_unavailable');
    }
    const freight = freightConfigSchema.safeParse(freightRow);
    if (!freight.success) {
      log.error('invalid_stored_item', { entity: 'freight-config' });
      throw new HttpError(503, 'quotes_unavailable');
    }
    const stoneRows = await repo.getStones(request.items.map((i) => i.stoneId));
    const stones: Stone[] = [];
    for (const row of stoneRows) {
      const stone = stoneSchema.safeParse(row);
      if (!stone.success) {
        log.error('invalid_stored_item', {
          entity: 'stone',
          id: typeof row['id'] === 'string' ? row['id'] : undefined,
        });
        throw new HttpError(503, 'quotes_unavailable');
      }
      stones.push(stone.data);
    }

    const quoteId = newQuoteId(startedAt);
    const source = { userAgent: header(event, 'user-agent'), referrer: header(event, 'referer') };
    const build = (folio: string) =>
      buildNewQuote({
        request,
        stones,
        freight: freight.data,
        now: startedAt,
        quoteId,
        folio,
        source,
      });

    // Primero se valida el pedido con un folio provisional: un 422 no debe gastar un número real.
    try {
      build(formatFolio(year, 1));
    } catch (err) {
      if (err instanceof NewQuoteError) {
        return jsonResponse(422, {
          error: 'validation_error',
          issues: [{ path: 'items', message: err.message }],
        });
      }
      throw err;
    }

    let number: number;
    try {
      number = await repo.reserveFolioNumber(year);
    } catch (err) {
      if (err instanceof FolioExhaustedError) {
        log.error('folio_exhausted', { year });
        throw new HttpError(503, 'quotes_unavailable');
      }
      throw err;
    }
    if (number > MAX_FOLIO_NUMBER) {
      log.error('folio_exhausted', { year });
      throw new HttpError(503, 'quotes_unavailable');
    }

    const { quote, item } = build(formatFolio(year, number));
    // Duplicado (`DuplicateQuoteError`) u otro fallo: sube como error inesperado (500 sin detalles).
    await repo.putQuote(item);
    log.info('quote_created', { quoteId: quote.quoteId, folio: quote.folio });

    await notify(quote, log);
    return jsonResponse(201, { folio: quote.folio });
  }

  async function handle(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
    const requestId =
      typeof event?.requestContext?.requestId === 'string' && event.requestContext.requestId !== ''
        ? event.requestContext.requestId
        : 'unknown';
    const log = createLogger({ requestId }, deps.logSink);
    try {
      return await handleRequest(event, log);
    } catch (err) {
      if (err instanceof HttpError) return jsonResponse(err.status, { error: err.code });
      // Nunca el mensaje ni el stack: pueden traer datos del cliente. Solo el nombre del error.
      log.error('unhandled_error', { errName: errorName(err) });
      return jsonResponse(500, { error: 'internal_error', requestId });
    }
  }

  return { handle };
}

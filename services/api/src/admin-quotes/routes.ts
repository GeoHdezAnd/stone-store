import {
  buildQuoteEmail,
  canRoleTransition,
  maskEmail,
  mailSettingsSchema,
  publicSettingsSchema,
  isValidRecipient,
  SEND_LOCK_TTL_MS,
  sendBodySchema,
  canTransition,
  computeFinalQuote,
  isUlid,
  MAX_EXPORT_ROWS,
  MAX_HISTORY,
  MAX_NOTES,
  noteBodySchema,
  normalizeSearchQuery,
  quoteIndexKeys,
  patchBodySchema,
  QUOTE_STATUSES,
  quoteSchema,
  quotesToCsv,
  stripStorageKeys,
  type HistoryEntry,
  type Quote,
  type QuoteStatus,
  type Role,
} from '@canteras/shared';
import { buildAuditEntry, type AuditAction } from '../lib/audit';
import { csvResponse, HttpError, jsonResponse } from '../lib/http';
import type { Mailer } from '../lib/mailer';
import {
  createRouter,
  route,
  type HandlerContext,
  type Route,
  type RouterOptions,
} from '../lib/router';
import { validationErrorResponse } from '../lib/validation';
import { decodeCursor, encodeCursor } from './cursor';
import {
  ConflictError,
  type ListQuery,
  type QuoteRepository,
  type StoredQuote,
} from './repository';

export interface QuotesDeps {
  repo: QuoteRepository;
  /** Transporte de correo; `null`/ausente = no configurado (el envío responde 409). */
  mailer?: Mailer | null;
  /** Para pruebas: reloj. */
  now?: () => Date;
}

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 50;
const LIMIT_RE = /^\d{1,3}$/;
const MIN_Q = 2;
const MAX_Q = 60;
// Exportación: páginas de 200 y como máximo 50 páginas (10 000 ítems revisados) para no pasar el
// tiempo de la Lambda ni los 6 MB de respuesta.
const EXPORT_PAGE = 200;
const EXPORT_MAX_PAGES = 50;
const MAX_CSV_BYTES = 5 * 1024 * 1024;
// Tope del ítem serializado (UTF-8): DynamoDB admite 400 KB; se deja margen para las claves de índice.
const MAX_ITEM_BYTES = 350_000;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const LIST_PARAMS = ['status', 'q', 'from', 'to', 'limit', 'cursor'];
const EXPORT_PARAMS = ['status', 'q', 'from', 'to'];

/** 409 `quote_too_large` si la solicitud (con sus claves de índice) pasa del umbral en bytes UTF-8. */
function tooLargeResponse(next: Quote): ReturnType<typeof jsonResponse> | null {
  const bytes = Buffer.byteLength(JSON.stringify({ ...next, ...quoteIndexKeys(next) }), 'utf8');
  if (bytes <= MAX_ITEM_BYTES) return null;
  return jsonResponse(409, {
    error: 'quote_too_large',
    message:
      'La solicitud ya es demasiado grande para guardar más cambios o notas. Archiva o resume la información.',
  });
}

const bad = (code: string): never => {
  throw new HttpError(400, code);
};

/** `YYYY-MM-DD` (día completo en UTC) o ISO con milisegundos. Devuelve el instante ISO. */
function parseBound(raw: string, edge: 'from' | 'to'): string {
  let iso: string;
  if (DATE_RE.test(raw)) iso = edge === 'from' ? `${raw}T00:00:00.000Z` : `${raw}T23:59:59.999Z`;
  else if (ISO_RE.test(raw)) iso = raw;
  else return bad('invalid_query');
  const t = Date.parse(iso);
  if (Number.isNaN(t) || new Date(t).toISOString() !== iso) return bad('invalid_query');
  return iso;
}

interface Filters {
  status?: QuoteStatus;
  q?: string;
  from?: string;
  to?: string;
}

function parseFilters(query: Record<string, string>, allowed: readonly string[]): Filters {
  for (const k of Object.keys(query)) if (!allowed.includes(k)) bad('invalid_query');
  const out: Filters = {};
  const status = query['status'];
  if (status !== undefined) {
    if (!(QUOTE_STATUSES as readonly string[]).includes(status)) bad('invalid_query');
    out.status = status as QuoteStatus;
  }
  const q = query['q'];
  if (q !== undefined) {
    const n = normalizeSearchQuery(q);
    if (n.length < MIN_Q || n.length > MAX_Q) bad('invalid_query');
    out.q = n;
  }
  const from = query['from'] === undefined ? undefined : parseBound(query['from'], 'from');
  const to = query['to'] === undefined ? undefined : parseBound(query['to'], 'to');
  if (from !== undefined && to !== undefined && from > to) bad('invalid_query');
  // Clave de orden = `createdAt#quoteId`: el tope superior usa `#~` (~ > cualquier letra de ULID).
  if (from !== undefined) out.from = from;
  if (to !== undefined) out.to = `${to}#~`;
  return out;
}

const toListQuery = (f: Filters, limit: number, start?: Record<string, string>): ListQuery => ({
  index: f.status === undefined ? 'date' : 'status',
  ...(f.status === undefined ? {} : { status: f.status }),
  ...(f.q === undefined ? {} : { q: f.q }),
  ...(f.from === undefined ? {} : { from: f.from }),
  ...(f.to === undefined ? {} : { to: f.to }),
  limit,
  ...(start ? { exclusiveStartKey: start } : {}),
});

/** Resumen para la lista: sin notas, historial ni claves internas. */
function summarize(q: Quote) {
  return {
    quoteId: q.quoteId,
    folio: q.folio,
    createdAt: q.createdAt,
    status: q.status,
    customer: {
      nombre: q.customer.nombre,
      telefono: q.customer.telefono,
      correo: q.customer.correo,
    },
    works: { lugar: q.works.lugar, codigoPostal: q.works.codigoPostal },
    piedras: q.items.map((i) => i.nombre),
    estimadoMin: q.freight?.estimadoMin ?? null,
    estimadoMax: q.freight?.estimadoMax ?? null,
    total: q.finalQuote?.total ?? null,
    rev: q.rev,
    ...(q.ejemplo === undefined ? {} : { ejemplo: q.ejemplo }),
  };
}

/** Auditoría SIN PII: nunca `customer`, `works`, notas ni items; solo estado, importes y rev. */
function auditView(q: Quote) {
  return {
    status: q.status,
    rev: q.rev,
    ...(q.lostReason === undefined ? {} : { lostReason: q.lostReason }),
    ...(q.finalQuote === undefined
      ? {}
      : {
          finalQuote: {
            subtotal: q.finalQuote.subtotal,
            fleteFinal: q.finalQuote.fleteFinal,
            total: q.finalQuote.total,
            vigenciaDias: q.finalQuote.vigenciaDias,
          },
        }),
  };
}

/** Candado de envío vigente (puesto por un envío en curso y aún sin vencer). */
function lockActive(q: Quote, nowMs: number): boolean {
  if (q.sendLock === undefined) return false;
  return nowMs - Date.parse(q.sendLock.at) < SEND_LOCK_TTL_MS;
}

/** Copia sin el candado (uno vencido se descarta al volver a escribir la solicitud). */
function clearLock(q: Quote): Quote {
  const { sendLock: _lock, ...rest } = q;
  void _lock;
  return rest;
}

const PRICING_STATUSES: readonly QuoteStatus[] = ['en_revision', 'cotizada'];

export function createQuotesRoutes(deps: QuotesDeps): Route[] {
  const { repo } = deps;
  const mailer = deps.mailer ?? null;
  const now = deps.now ?? (() => new Date());

  const parseStored = (raw: StoredQuote, ctx: HandlerContext): Quote => {
    const parsed = quoteSchema.safeParse(stripStorageKeys(raw));
    if (!parsed.success) {
      // Solo el id (nunca datos del cliente).
      ctx.log.error('invalid_stored_item', {
        entity: 'quote',
        id: typeof raw['quoteId'] === 'string' ? raw['quoteId'] : null,
      });
      throw new HttpError(500, 'internal_error');
    }
    return parsed.data;
  };

  const load = async (ctx: HandlerContext): Promise<Quote> => {
    const id = ctx.params['quoteId'] as string;
    const raw = await repo.get(id);
    if (raw === null) throw new HttpError(404, 'not_found');
    return parseStored(raw, ctx);
  };

  const save = async (
    ctx: HandlerContext,
    current: Quote,
    next: Quote,
    action: AuditAction,
    before: unknown,
    after: unknown,
  ): Promise<void> => {
    const audit = buildAuditEntry({
      entityType: 'quote',
      entityId: next.quoteId,
      userId: ctx.userId,
      action,
      before,
      after,
      at: now(),
      requestId: ctx.requestId,
    });
    try {
      await repo.update({ next, expectedRev: current.rev, audit });
    } catch (err) {
      if (err instanceof ConflictError) throw new HttpError(409, 'conflict');
      throw err;
    }
    // Sin teléfono, correo, nombre ni notas: solo ids y la acción.
    ctx.log.info('quote_updated', {
      quoteId: next.quoteId,
      folio: next.folio,
      action,
      userId: ctx.userId,
    });
  };

  const roleCan = (roles: readonly Role[], from: QuoteStatus, to: QuoteStatus): boolean =>
    roles.some((r) => canRoleTransition(r, from, to));

  const quoteIdParam = { paramPattern: /^[0-9A-HJKMNP-TV-Z]{26}$/ };

  return [
    route('GET', '/admin/quotes', ['owner', 'staff'], async (ctx) => {
      const filters = parseFilters(ctx.query, LIST_PARAMS);
      let limit = DEFAULT_LIMIT;
      if (ctx.query['limit'] !== undefined) {
        const n = LIMIT_RE.test(ctx.query['limit']) ? Number(ctx.query['limit']) : Number.NaN;
        if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) bad('invalid_query');
        limit = n;
      }
      let start: Record<string, string> | undefined;
      if (ctx.query['cursor'] !== undefined) {
        const key = decodeCursor(ctx.query['cursor'], filters);
        if (key === null) bad('invalid_cursor');
        start = key as Record<string, string>;
      }
      const page = await repo.list(toListQuery(filters, limit, start));
      const items: ReturnType<typeof summarize>[] = [];
      for (const raw of page.items) {
        const parsed = quoteSchema.safeParse(stripStorageKeys(raw));
        if (parsed.success) items.push(summarize(parsed.data));
        else {
          ctx.log.warn('invalid_stored_item', {
            entity: 'quote',
            id: typeof raw['quoteId'] === 'string' ? raw['quoteId'] : null,
          });
        }
      }
      // Con `q` el filtro se aplica después del Limit: puede haber páginas vacías con nextCursor.
      return jsonResponse(200, {
        items,
        nextCursor: page.lastKey ? encodeCursor(page.lastKey) : null,
      });
    }),

    // Ruta literal ANTES que `{quoteId}`: `export.csv` nunca se interpreta como id (además el
    // parámetro solo acepta ULID). Solo owner (exporta datos de contacto de todos los clientes).
    route('GET', '/admin/quotes/export.csv', ['owner'], async (ctx) => {
      const filters = parseFilters(ctx.query, EXPORT_PARAMS);
      const rows: Quote[] = [];
      let skipped = 0;
      let start: Record<string, string> | undefined;
      let more = false;
      for (let page = 0; page < EXPORT_MAX_PAGES; page++) {
        const res = await repo.list(toListQuery(filters, EXPORT_PAGE, start));
        for (const raw of res.items) {
          const parsed = quoteSchema.safeParse(stripStorageKeys(raw));
          if (parsed.success) rows.push(parsed.data);
          else {
            skipped++;
            ctx.log.warn('invalid_stored_item', {
              entity: 'quote',
              id: typeof raw['quoteId'] === 'string' ? raw['quoteId'] : null,
            });
          }
        }
        if (res.lastKey === null) {
          more = false;
          break;
        }
        more = true;
        start = res.lastKey;
        if (rows.length > MAX_EXPORT_ROWS) break;
      }
      let truncated = more;
      if (rows.length > MAX_EXPORT_ROWS) {
        rows.length = MAX_EXPORT_ROWS;
        truncated = true;
      }
      let csv = quotesToCsv(rows);
      // Más de ~5 MB (límite de respuesta de Lambda 6 MB): se recorta por bytes, nunca falla.
      if (Buffer.byteLength(csv, 'utf8') > MAX_CSV_BYTES) {
        let lo = 0;
        let hi = rows.length;
        while (lo < hi) {
          const mid = Math.ceil((lo + hi) / 2);
          if (Buffer.byteLength(quotesToCsv(rows.slice(0, mid)), 'utf8') <= MAX_CSV_BYTES) lo = mid;
          else hi = mid - 1;
        }
        rows.length = lo;
        csv = quotesToCsv(rows);
        truncated = true;
      }
      // Solo conteos: nunca el query string ni datos de clientes.
      ctx.log.info('quotes_exported', {
        rows: rows.length,
        truncated,
        skipped,
        userId: ctx.userId,
      });
      const day = now().toISOString().slice(0, 10);
      return csvResponse(csv, `solicitudes-${day}.csv`, {
        ...(truncated ? { 'x-export-truncated': 'true' } : {}),
        ...(skipped > 0 ? { 'x-export-skipped': String(skipped) } : {}),
      });
    }),

    route(
      'GET',
      '/admin/quotes/{quoteId}',
      ['owner', 'staff'],
      async (ctx) => jsonResponse(200, await load(ctx)),
      quoteIdParam,
    ),

    route(
      'PATCH',
      '/admin/quotes/{quoteId}',
      ['owner', 'staff'],
      async (ctx) => {
        const parsed = patchBodySchema.safeParse(ctx.body);
        if (!parsed.success) return validationErrorResponse(parsed.error);
        const body = parsed.data;
        const current = await load(ctx);
        const nowDate = now();
        // Un envío en curso bloquea toda edición (el correo se arma con lo guardado).
        if (lockActive(current, nowDate.getTime())) throw new HttpError(409, 'send_in_progress');
        if (body.rev !== current.rev) throw new HttpError(409, 'conflict');

        const at = nowDate.toISOString();
        const history: HistoryEntry[] = [];
        let next: Quote = clearLock(current);

        // Permiso y validez de la transición (el rol se decide por transición, no solo por ruta).
        if (body.status !== undefined) {
          if (!canTransition(current.status, body.status))
            throw new HttpError(409, 'invalid_transition');
          if (!roleCan(ctx.roles, current.status, body.status))
            throw new HttpError(403, 'forbidden');
        }
        // Precios y flete: solo mientras la solicitud se prepara.
        if (body.finalQuote !== undefined) {
          if (!PRICING_STATUSES.includes(current.status)) throw new HttpError(409, 'quote_locked');
          let computed;
          try {
            computed = computeFinalQuote({
              items: current.items,
              prices: body.finalQuote.items,
              fleteFinal: body.finalQuote.fleteFinal,
              vigenciaDias: body.finalQuote.vigenciaDias,
            });
          } catch {
            return jsonResponse(422, {
              error: 'validation_error',
              issues: [
                {
                  path: 'finalQuote.items',
                  message: 'Debe haber exactamente un precio por cada piedra de la solicitud',
                },
              ],
            });
          }
          next = { ...next, finalQuote: computed };
          history.push({
            at,
            by: ctx.userId,
            tipo: 'edicion',
            texto: 'Precios y flete actualizados',
          });
        }
        if (body.status !== undefined) {
          next = { ...next, status: body.status };
          if (body.lostReason !== undefined) next = { ...next, lostReason: body.lostReason };
          history.push({
            at,
            by: ctx.userId,
            tipo: 'estado',
            de: current.status,
            a: body.status,
            ...(body.lostReason === undefined ? {} : { texto: `Motivo: ${body.lostReason}` }),
          });
        }
        if (current.history.length + history.length > MAX_HISTORY) {
          throw new HttpError(409, 'history_full');
        }
        next = { ...next, history: [...current.history, ...history], rev: current.rev + 1 };
        // Aún no se envía nada al cliente: `respondedAt` lo fija la acción de envío (3.3b).
        const validated = quoteSchema.safeParse(next);
        if (!validated.success) return validationErrorResponse(validated.error);
        const big = tooLargeResponse(validated.data);
        if (big) return big;
        await save(
          ctx,
          current,
          validated.data,
          body.status === undefined ? 'update' : 'status',
          auditView(current),
          auditView(validated.data),
        );
        return jsonResponse(200, validated.data);
      },
      quoteIdParam,
    ),

    // Enviar la cotización final al cliente por correo. Solo owner. Orden:
    // 1) validar todo y armar el correo; 2) RECLAMAR el envío (escritura condicionada a `rev` que
    // pone `sendLock` y sube el rev; si pierde, 409 `send_in_progress` y NO se envía); 3) enviar;
    // 4) si SES falla, liberar el candado (502 `send_failed`, nada más cambia salvo el rev);
    // 5) guardar `enviada` + auditoría en una transacción condicionada al rev del reclamo.
    // `rev` coherente: el cliente recibe el rev final (= rev leído + 2: reclamo + guardado).
    // Riesgo aceptado para el MVP: si el paso 5 falla DESPUÉS de enviar (conflicto o error), o el
    // proceso muere entre 3 y 5, el correo ya salió pero la solicitud queda `cotizada` con el
    // candado puesto; responde `conflict_after_send` y, al vencer el candado (5 min), reintentar
    // mandaría un duplicado al cliente.
    route(
      'POST',
      '/admin/quotes/{quoteId}/send',
      ['owner'],
      async (ctx) => {
        const parsed = sendBodySchema.safeParse(ctx.body);
        if (!parsed.success) return validationErrorResponse(parsed.error);
        const current = await load(ctx);
        if (lockActive(current, now().getTime())) throw new HttpError(409, 'send_in_progress');
        if (parsed.data.rev !== current.rev) throw new HttpError(409, 'conflict');
        if (current.status !== 'cotizada' || !canTransition(current.status, 'enviada')) {
          throw new HttpError(409, 'invalid_transition');
        }
        const fq = current.finalQuote;
        if (
          fq === undefined ||
          fq.items.length !== current.items.length ||
          !current.items.every((i) => fq.items.some((p) => p.stoneId === i.stoneId))
        ) {
          return jsonResponse(422, {
            error: 'final_quote_incomplete',
            message: 'La cotización final está incompleta: captura el precio de cada piedra.',
          });
        }
        if (mailer === null) throw new HttpError(409, 'mail_not_configured');
        if (!isValidRecipient(current.customer.correo)) {
          return jsonResponse(422, {
            error: 'invalid_recipient',
            message: 'El correo del cliente no es una dirección válida para enviar.',
          });
        }

        const [rawPublic, rawMail] = await Promise.all([
          repo.getSettings('PUBLIC'),
          repo.getSettings('MAIL'),
        ]);
        if (rawPublic === null || rawMail === null) throw new HttpError(409, 'settings_missing');
        const { key: _p, ...publicData } = rawPublic;
        const { key: _m, ...mailData } = rawMail;
        void _p;
        void _m;
        const pub = publicSettingsSchema.safeParse(publicData);
        const mail = mailSettingsSchema.safeParse(mailData);
        if (!pub.success || !mail.success) {
          ctx.log.warn('invalid_stored_item', { entity: 'settings' });
          throw new HttpError(409, 'settings_invalid');
        }

        const sentAt = now();
        const at = sentAt.toISOString();
        let email;
        try {
          email = buildQuoteEmail({
            quote: current,
            mailSettings: mail.data,
            publicSettings: pub.data,
            sentAt,
          });
        } catch {
          // Plantilla con variables no permitidas u otro dato inválido: nada se envía.
          throw new HttpError(409, 'settings_invalid');
        }

        // El estado futuro se valida ANTES de enviar: no se manda un correo que luego no se pueda guardar.
        if (current.history.length + 2 > MAX_HISTORY) throw new HttpError(409, 'history_full');
        // El `rev` final es `current.rev + 2`: +1 por el reclamo del envío y +1 por el guardado.
        const next: Quote = {
          ...clearLock(current),
          status: 'enviada',
          finalQuote: { ...fq, enviadaAt: at },
          respondedAt: current.respondedAt ?? at,
          history: [
            ...current.history,
            // Correo enmascarado: el completo nunca va a historial, auditoría ni logs.
            {
              at,
              by: ctx.userId,
              tipo: 'correo',
              texto: `Cotización enviada a ${maskEmail(current.customer.correo)}`,
            },
            { at, by: ctx.userId, tipo: 'estado', de: 'cotizada', a: 'enviada' },
          ],
          rev: current.rev + 2,
        };
        const validated = quoteSchema.safeParse(next);
        if (!validated.success) return validationErrorResponse(validated.error);
        const big = tooLargeResponse(validated.data);
        if (big) return big;

        // PASO 2: RECLAMAR el envío ANTES de mandar nada. Escritura condicionada a `rev` que sube el
        // rev y pone el candado: de dos envíos simultáneos solo uno la gana; el otro responde 409
        // `send_in_progress` SIN enviar. (Sin auditoría: no es un cambio de negocio.)
        const claimed: Quote = {
          ...current,
          sendLock: { at, by: ctx.userId },
          rev: current.rev + 1,
        };
        try {
          await repo.update({ next: claimed, expectedRev: current.rev });
        } catch (err) {
          if (err instanceof ConflictError) throw new HttpError(409, 'send_in_progress');
          throw err;
        }

        let messageId: string;
        try {
          ({ messageId } = await mailer.send(email));
        } catch (err) {
          // Solo el nombre del error: su mensaje podría traer el destinatario.
          ctx.log.error('send_failed', {
            quoteId: current.quoteId,
            folio: current.folio,
            userId: ctx.userId,
            errName: err instanceof Error ? err.name : 'unknown',
          });
          // PASO 4: SES falló -> se libera el candado (escritura condicionada al rev del reclamo).
          // No queda nada en historial ni auditoría; solo el `rev` sube (+2 en total). Si la
          // liberación también falla, el candado vence solo a los 5 minutos.
          try {
            await repo.update({
              next: { ...clearLock(claimed), rev: claimed.rev + 1 },
              expectedRev: claimed.rev,
            });
          } catch {
            ctx.log.warn('send_lock_release_failed', {
              quoteId: current.quoteId,
              folio: current.folio,
            });
          }
          return jsonResponse(502, {
            error: 'send_failed',
            message: 'No se pudo enviar el correo. La solicitud no cambió; intenta de nuevo.',
          });
        }

        const audit = buildAuditEntry({
          entityType: 'quote',
          entityId: current.quoteId,
          userId: ctx.userId,
          action: 'send',
          before: auditView(current),
          after: { ...auditView(validated.data), enviadaAt: at },
          at: sentAt,
          requestId: ctx.requestId,
        });
        try {
          await repo.update({ next: validated.data, expectedRev: claimed.rev, audit });
        } catch (err) {
          const base = {
            quoteId: current.quoteId,
            folio: current.folio,
            messageId,
            userId: ctx.userId,
          };
          if (err instanceof ConflictError) {
            ctx.log.warn('conflict_after_send', base);
            return jsonResponse(409, {
              error: 'conflict_after_send',
              message:
                'El correo sí salió al cliente, pero la solicitud cambió mientras tanto y no se guardó el envío. Recarga y revisa antes de volver a enviar (se duplicaría el correo).',
            });
          }
          ctx.log.error('send_state_not_saved', base);
          throw err;
        }
        ctx.log.info('quote_sent', {
          quoteId: current.quoteId,
          folio: current.folio,
          messageId,
          userId: ctx.userId,
        });
        return jsonResponse(200, validated.data);
      },
      quoteIdParam,
    ),

    route(
      'POST',
      '/admin/quotes/{quoteId}/notes',
      ['owner', 'staff'],
      async (ctx) => {
        const parsed = noteBodySchema.safeParse(ctx.body);
        if (!parsed.success) return validationErrorResponse(parsed.error);
        const { texto, rev } = parsed.data;
        const current = await load(ctx);
        const nowDate = now();
        if (lockActive(current, nowDate.getTime())) throw new HttpError(409, 'send_in_progress');
        if (rev !== current.rev) throw new HttpError(409, 'conflict');
        if (current.notes.length >= MAX_NOTES) throw new HttpError(409, 'notes_limit');
        if (current.history.length >= MAX_HISTORY) throw new HttpError(409, 'history_full');
        const at = nowDate.toISOString();
        const next: Quote = {
          ...clearLock(current),
          notes: [...current.notes, { at, by: ctx.userId, texto }],
          // El historial no repite el texto de la nota (puede traer PII): solo que hubo una.
          history: [
            ...current.history,
            { at, by: ctx.userId, tipo: 'nota', texto: 'Nota interna agregada' },
          ],
          rev: current.rev + 1,
        };
        const validated = quoteSchema.safeParse(next);
        if (!validated.success) return validationErrorResponse(validated.error);
        const big = tooLargeResponse(validated.data);
        if (big) return big;
        // La auditoría guarda solo la longitud de la nota, nunca el texto.
        await save(
          ctx,
          current,
          validated.data,
          'update',
          { rev: current.rev, notas: current.notes.length },
          { rev: next.rev, notas: next.notes.length, longitudNota: texto.length },
        );
        return jsonResponse(201, validated.data);
      },
      quoteIdParam,
    ),
  ];
}

export function createQuotesRouter(deps: QuotesDeps, options: RouterOptions = {}) {
  return createRouter(createQuotesRoutes(deps), options);
}

// Reexportado para que las pruebas y otros módulos no dependan de la implementación.
export { isUlid };

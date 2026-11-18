import { idSchema } from '@canteras/shared';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { ZodIssue } from 'zod';
import { buildAuditEntry, type AuditAction, type AuditEntry } from '../lib/audit';
import { HttpError, jsonResponse } from '../lib/http';
import {
  createRouter,
  route,
  type HandlerContext,
  type Route,
  type RouterOptions,
} from '../lib/router';
import { decodeCursor, encodeCursor } from './cursor';
import { ENTITIES, ENTITY_NAMES, type EntityConfig } from './entities';
import {
  AlreadyExistsError,
  ConflictError,
  NotFoundError,
  type CatalogItem,
  type CatalogRepository,
} from './repository';

type Response = APIGatewayProxyStructuredResultV2;

export interface CatalogRouterOptions extends RouterOptions {
  /** Para pruebas: reloj de la auditoría. */
  now?: () => Date;
}

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 50;
const LIMIT_RE = /^\d{1,3}$/;

/** `testimonio.texto`, `piedras[0]`. Nunca incluye valores, solo la ruta del campo. */
function formatPath(path: readonly PropertyKey[]): string {
  let out = '';
  for (const part of path) {
    if (typeof part === 'number') out += `[${part}]`;
    else out += out === '' ? String(part) : `.${String(part)}`;
  }
  return out;
}

// Los mensajes de zod ya vienen en español (los define packages/shared). Se sustituyen los que
// de otro modo mencionarían nombres de claves enviadas por el cliente o saldrían en inglés.
function toIssue(issue: ZodIssue): { path: string; message: string } {
  if (issue.code === 'unrecognized_keys') {
    return { path: formatPath(issue.path), message: 'El cuerpo incluye campos no permitidos' };
  }
  if (issue.code === 'invalid_type' && issue.path.length === 0) {
    return { path: '', message: 'El cuerpo debe ser un objeto JSON' };
  }
  return { path: formatPath(issue.path), message: issue.message };
}

function validate(
  cfg: EntityConfig,
  body: unknown,
): { ok: true; item: CatalogItem } | { ok: false; res: Response } {
  const parsed = cfg.schema.safeParse(body);
  if (parsed.success) return { ok: true, item: parsed.data };
  return {
    ok: false,
    res: jsonResponse(422, {
      error: 'validation_error',
      issues: parsed.error.issues.map(toIssue),
    }),
  };
}

function pathId(ctx: HandlerContext): string {
  const parsed = idSchema.safeParse(ctx.params['id']);
  if (!parsed.success) throw new HttpError(400, 'invalid_path');
  return parsed.data;
}

function parseListQuery(query: Record<string, string>): {
  limit: number;
  exclusiveStartKey?: { id: string };
} {
  let limit = DEFAULT_LIMIT;
  const rawLimit = query['limit'];
  if (rawLimit !== undefined) {
    const n = LIMIT_RE.test(rawLimit) ? Number(rawLimit) : Number.NaN;
    if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) throw new HttpError(400, 'invalid_query');
    limit = n;
  }
  const rawCursor = query['cursor'];
  if (rawCursor === undefined) return { limit };
  const key = decodeCursor(rawCursor);
  if (key === null) throw new HttpError(400, 'invalid_cursor');
  return { limit, exclusiveStartKey: key };
}

/** Todas las referencias deben existir; devuelve la respuesta 422 del primer campo que falle. */
async function checkReferences(
  repo: CatalogRepository,
  cfg: EntityConfig,
  item: CatalogItem,
): Promise<Response | null> {
  for (const ref of cfg.references) {
    const ids = ref.pick(item);
    if (ids.length === 0) continue;
    const missing = await repo.existsAll(ref.target, ids);
    if (missing.length > 0) {
      return jsonResponse(422, { error: 'invalid_reference', field: ref.field, ids: missing });
    }
  }
  return null;
}

export function createCatalogRoutes(
  repo: CatalogRepository,
  now: () => Date = () => new Date(),
): Route[] {
  const routes: Route[] = [];

  for (const name of ENTITY_NAMES) {
    const cfg = ENTITIES[name];
    const base = `/admin/${cfg.segment}`;

    const audit = (
      ctx: HandlerContext,
      id: string,
      action: AuditAction,
      before: unknown,
      after: unknown,
    ): AuditEntry =>
      buildAuditEntry({
        entityType: cfg.auditType,
        entityId: id,
        userId: ctx.userId,
        action,
        before,
        after,
        at: now(),
        requestId: ctx.requestId,
      });

    const logWrite = (ctx: HandlerContext, id: string, action: AuditAction) =>
      ctx.log.info('catalog_write', { entity: name, id, action, userId: ctx.userId });

    routes.push(
      route('GET', base, ['owner', 'staff'], async (ctx) => {
        const { limit, exclusiveStartKey } = parseListQuery(ctx.query);
        const page = await repo.list(name, {
          limit,
          ...(exclusiveStartKey ? { exclusiveStartKey } : {}),
        });
        const items: unknown[] = [];
        for (const raw of page.items) {
          const parsed = cfg.schema.safeParse(raw);
          if (parsed.success) items.push(parsed.data);
          else {
            // Se omite: sin PII (solo entidad e id) para no filtrar datos ni romper el listado.
            ctx.log.warn('invalid_stored_item', {
              entity: name,
              id: typeof raw['id'] === 'string' ? raw['id'] : null,
            });
          }
        }
        return jsonResponse(200, {
          items,
          nextCursor: page.lastKey ? encodeCursor(page.lastKey.id) : null,
        });
      }),

      route('GET', `${base}/{id}`, ['owner', 'staff'], async (ctx) => {
        const id = pathId(ctx);
        const raw = await repo.get(name, id);
        if (raw === null) throw new HttpError(404, 'not_found');
        const parsed = cfg.schema.safeParse(raw);
        if (!parsed.success) {
          ctx.log.error('invalid_stored_item', { entity: name, id });
          throw new HttpError(500, 'internal_error');
        }
        return jsonResponse(200, parsed.data);
      }),

      route('POST', base, ['owner', 'staff'], async (ctx) => {
        const v = validate(cfg, ctx.body);
        if (!v.ok) return v.res;
        // Solo owner puede crear un registro ya inactivo (la baja es decisión de owner).
        if (v.item.activa === false && !ctx.roles.includes('owner')) {
          throw new HttpError(403, 'forbidden');
        }
        const refs = await checkReferences(repo, cfg, v.item);
        if (refs) return refs;
        const entry = audit(ctx, v.item.id, 'create', null, v.item);
        try {
          await repo.create(name, v.item, entry);
        } catch (err) {
          if (err instanceof AlreadyExistsError) throw new HttpError(409, 'already_exists');
          if (err instanceof ConflictError) throw new HttpError(409, 'conflict');
          throw err;
        }
        logWrite(ctx, v.item.id, 'create');
        return jsonResponse(201, v.item);
      }),

      route('PUT', `${base}/{id}`, ['owner', 'staff'], async (ctx) => {
        const id = pathId(ctx);
        const v = validate(cfg, ctx.body);
        if (!v.ok) return v.res;
        if (v.item.id !== id) throw new HttpError(400, 'id_mismatch');
        const current = await repo.get(name, id);
        if (current === null) throw new HttpError(404, 'not_found');
        // `activa` es parte del esquema: cambiarla por PUT equivale a dar de baja o resucitar el
        // registro, así que solo owner puede hacerlo (staff no puede saltarse el DELETE).
        // La vía normal de baja es DELETE; si owner usa PUT, la auditoría queda como `update`.
        const currentActiva = current['activa'] !== false;
        if (v.item.activa !== currentActiva && !ctx.roles.includes('owner')) {
          throw new HttpError(403, 'forbidden');
        }
        const refs = await checkReferences(repo, cfg, v.item);
        if (refs) return refs;
        const entry = audit(ctx, id, 'update', current, v.item);
        try {
          await repo.replace(name, v.item, entry);
        } catch (err) {
          if (err instanceof NotFoundError) throw new HttpError(404, 'not_found');
          if (err instanceof ConflictError) throw new HttpError(409, 'conflict');
          throw err;
        }
        logWrite(ctx, id, 'update');
        return jsonResponse(200, v.item);
      }),

      // Baja lógica: nunca borra. Solo owner (staff recibe 403 del router, sin tocar el repo).
      route('DELETE', `${base}/{id}`, ['owner'], async (ctx) => {
        const id = pathId(ctx);
        const current = await repo.get(name, id);
        if (current === null) throw new HttpError(404, 'not_found');
        // Se valida con el esquema ANTES de escribir y de responder: un atributo fuera del
        // esquema nunca se filtra; si el ítem guardado no valida, 500 genérico sin escribir.
        const parsed = cfg.schema.safeParse({ ...current, activa: false });
        if (!parsed.success) {
          ctx.log.error('invalid_stored_item', { entity: name, id });
          throw new HttpError(500, 'internal_error');
        }
        if (current['activa'] === false) return jsonResponse(200, parsed.data); // idempotente
        const after = parsed.data;
        const entry = audit(ctx, id, 'delete', current, after);
        try {
          await repo.softDelete(name, id, entry);
        } catch (err) {
          if (err instanceof NotFoundError) throw new HttpError(404, 'not_found');
          if (err instanceof ConflictError) throw new HttpError(409, 'conflict');
          throw err;
        }
        logWrite(ctx, id, 'delete');
        return jsonResponse(200, after);
      }),
    );
  }
  return routes;
}

export function createCatalogRouter(repo: CatalogRepository, options: CatalogRouterOptions = {}) {
  const { now, ...routerOptions } = options;
  return createRouter(createCatalogRoutes(repo, now), routerOptions);
}

import {
  buildCatalogDocument,
  canonicalJson,
  CATALOG_VERSION_PATTERN,
  catalogDocumentSchema,
  finishSchema,
  projectSchema,
  publicSettingsSchema,
  serviceSchema,
  stoneSchema,
  type CatalogDocument,
  type Sha256Hex,
} from '@canteras/shared';
import type { ZodType } from 'zod';
import { buildAuditEntry } from '../lib/audit';
import { HttpError, jsonResponse } from '../lib/http';
import {
  createRouter,
  route,
  type HandlerContext,
  type Route,
  type RouterOptions,
} from '../lib/router';
import type { Invalidator } from './invalidator';
import {
  ConflictError,
  type CurrentRow,
  type PublicationAction,
  type PublicationCounts,
  type PublicationRow,
  type PublishRepository,
} from './repository';
import type { SiteRebuilder } from './site-rebuild';
import {
  immutableKey,
  ObjectExistsError,
  ObjectMissingError,
  type PublishStorage,
} from './storage';

export interface PublishDeps {
  repo: PublishRepository;
  storage: PublishStorage;
  invalidator: Invalidator;
  /** Pide reconstruir el sitio público (best-effort; `NoopRebuilder` si no está configurado). */
  rebuilder: SiteRebuilder;
  sha256: Sha256Hex;
  /** Para pruebas: reloj. */
  now?: () => Date;
  /** Para pruebas: plazo de la invalidación (por defecto `INVALIDATION_TIMEOUT_MS`). */
  invalidationTimeoutMs?: number;
}

/**
 * Presupuesto de tiempo: la Lambda `AdminPublish` tiene 10 s (`infra/lib/api-stack.ts`). Peor caso:
 *   invalidación de CloudFront   3 000 ms  (aquí; además el cliente tiene 1 intento y 3 s en total)
 *   pedido de reconstrucción     3 000 ms  (`REBUILD_TIMEOUT_MS`, incluye la lectura de SSM)
 *   resto                        1 500 ms  (~10 llamadas a DynamoDB/S3 de unos pocos ms, arranque en frío)
 *   -------------------------------------------------------
 *   total                        7 500 ms  -> margen de 2 500 ms bajo los 10 s.
 * Ambos pasos son best-effort: si se agotan, la publicación (ya confirmada) responde 200 con
 * `invalidation: failed` / `rebuild: failed` en vez de expirar y devolver un 5xx.
 */
export const INVALIDATION_TIMEOUT_MS = 3000;

/** Ruta del sitio que CloudFront debe olvidar tras publicar. */
export const INVALIDATION_PATHS = ['/published/catalog.json'] as const;

const HISTORY_LIMIT = 20;
const PENDING_LIMIT = 100;

type InvalidationStatus = 'ok' | 'skipped' | 'failed';
type RebuildStatus = 'requested' | 'failed' | 'not_configured';

const formatVersion = (n: number): string => `v${String(n).padStart(4, '0')}`;
const sequenceOf = (version: string): number => Number(version.slice(1));
const nextVersionAfter = (current: CurrentRow | null): string =>
  formatVersion(current === null ? 1 : sequenceOf(current.currentVersion) + 1);

function countsOf(doc: CatalogDocument): PublicationCounts {
  return {
    stones: doc.stones.length,
    finishes: doc.finishes.length,
    projects: doc.projects.length,
    services: doc.services.length,
  };
}

/** Quita el atributo `key` (clave de la tabla Settings) de una fila guardada. */
function withoutKey(row: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...row };
  delete rest['key'];
  return rest;
}

/**
 * Valida cada fila con el esquema de su entidad. Si alguna no cumple, la publicación se bloquea
 * (422) en vez de omitirla en silencio: el sitio no debe perder una piedra sin que nadie lo note.
 * El log lleva SOLO la entidad y el id; el cuerpo de la respuesta, solo el código.
 */
function parseRows<T>(
  rows: Record<string, unknown>[],
  schema: ZodType<T>,
  entity: string,
  ctx: HandlerContext,
): T[] {
  return rows.map((row) => {
    const parsed = schema.safeParse(row);
    if (!parsed.success) {
      ctx.log.warn('invalid_stored_item', {
        entity,
        id: typeof row['id'] === 'string' ? row['id'] : undefined,
      });
      throw new HttpError(422, 'invalid_stored_item');
    }
    return parsed.data;
  });
}

export function createPublishRoutes(deps: PublishDeps): Route[] {
  const { repo, storage, invalidator, rebuilder, sha256 } = deps;
  const now = deps.now ?? (() => new Date());
  const invalidationTimeoutMs = deps.invalidationTimeoutMs ?? INVALIDATION_TIMEOUT_MS;

  /** Invalidación sin romper la publicación: un fallo se registra (sin detalles) y se informa. */
  async function invalidate(ctx: HandlerContext): Promise<InvalidationStatus> {
    try {
      const work = invalidator.invalidate(INVALIDATION_PATHS);
      // Si se agota el plazo, la petición original puede rechazar más tarde: no debe quedar sin atender.
      work.catch(() => undefined);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), invalidationTimeoutMs);
      });
      try {
        return await Promise.race([work, timeout]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    } catch (err) {
      ctx.log.error('invalidation_failed', {
        errName: err instanceof Error ? err.name : 'unknown',
      });
      return 'failed';
    }
  }

  /**
   * Pide reconstruir el sitio. BEST-EFFORT: nunca lanza ni falla la publicación. Un fallo se
   * registra solo con un código corto (`reason`), jamás con el token ni mensajes crudos.
   */
  async function requestRebuild(version: string, ctx: HandlerContext): Promise<RebuildStatus> {
    try {
      const out = await rebuilder.request({ version, requestId: ctx.requestId });
      if (out.status === 'failed') {
        ctx.log.error('site_rebuild_failed', {
          event: 'site_rebuild_failed',
          version,
          reason: out.reason,
        });
        return 'failed';
      }
      return out.status;
    } catch {
      ctx.log.error('site_rebuild_failed', {
        event: 'site_rebuild_failed',
        version,
        reason: 'unexpected',
      });
      return 'failed';
    }
  }

  /**
   * Re-afirma la copia vigente `published/catalog.json` desde el objeto inmutable de la versión
   * vigente. Es idempotente: sirve para la ruta «sin cambios» (reintento tras un 502 o una
   * invalidación fallida) sin crear versión nueva.
   */
  async function healCurrent(current: CurrentRow, ctx: HandlerContext) {
    let body: string;
    try {
      body = await storage.getImmutable(current.currentVersion);
      await storage.putCurrentCopy(body);
    } catch (err) {
      ctx.log.error('copy_failed', { version: current.currentVersion, errName: errName(err) });
      return jsonResponse(502, {
        error: 'copy_failed',
        version: current.currentVersion,
        retry: true,
      });
    }
    const invalidation = await invalidate(ctx);
    const rebuild = await requestRebuild(current.currentVersion, ctx);
    ctx.log.info('publish_unchanged', { version: current.currentVersion, userId: ctx.userId });
    return jsonResponse(200, {
      changed: false,
      version: current.currentVersion,
      invalidation,
      rebuild,
    });
  }

  /**
   * Orden: (2) objeto inmutable, (3) transacción (fila + CURRENT + auditoría), (4) copia vigente,
   * (5) invalidación. Si (4) falla, CURRENT ya apunta a una versión cuyo objeto existe: es
   * consistente y un reintento lo completa.
   */
  async function publishDocument(
    ctx: HandlerContext,
    current: CurrentRow | null,
    doc: CatalogDocument,
    action: PublicationAction,
    revertedFrom?: string,
  ) {
    const version = doc.version;
    const body = canonicalJson(doc);

    try {
      await storage.putImmutable(version, body, { overwrite: false });
    } catch (err) {
      if (!(err instanceof ObjectExistsError)) throw err;
      // El objeto existe: si ya hay fila de esa versión, otro publicó antes (409). Si no hay
      // fila, es un huérfano de un intento que no llegó a la transacción: se sobrescribe (el
      // bucket está versionado, así que no se pierde nada).
      if ((await repo.getPublication(version)) !== null) throw new HttpError(409, 'conflict');
      await storage.putImmutable(version, body, { overwrite: true });
    }

    const publishedAt = now().toISOString();
    const publication: PublicationRow = {
      version,
      action,
      hash: doc.hash,
      generatedAt: doc.generatedAt,
      publishedAt,
      publishedBy: ctx.userId,
      s3Key: immutableKey(version),
      ...(revertedFrom === undefined ? {} : { revertedFrom }),
      counts: countsOf(doc),
    };
    // Sin PII: solo versiones, hash y conteos.
    const audit = buildAuditEntry({
      entityType: 'publication',
      entityId: version,
      userId: ctx.userId,
      action,
      before: current === null ? null : { version: current.currentVersion, hash: current.hash },
      after: {
        version,
        hash: doc.hash,
        counts: publication.counts,
        ...(revertedFrom === undefined ? {} : { revertedFrom }),
      },
      at: new Date(publishedAt),
      requestId: ctx.requestId,
    });
    try {
      await repo.commit({
        baseVersion: current === null ? null : current.currentVersion,
        publication,
        audit,
      });
    } catch (err) {
      if (err instanceof ConflictError) throw new HttpError(409, 'conflict');
      throw err;
    }

    try {
      await storage.putCurrentCopy(body);
    } catch (err) {
      ctx.log.error('copy_failed', { version, errName: errName(err) });
      return jsonResponse(502, { error: 'copy_failed', version, retry: true });
    }

    const invalidation = await invalidate(ctx);
    const rebuild = await requestRebuild(version, ctx);
    ctx.log.info(action === 'publish' ? 'publish' : 'revert', {
      version,
      userId: ctx.userId,
      invalidation,
      rebuild,
      ...(revertedFrom === undefined ? {} : { revertedFrom }),
    });
    return jsonResponse(200, {
      changed: true,
      version,
      publishedAt,
      counts: publication.counts,
      invalidation,
      rebuild,
      ...(revertedFrom === undefined ? {} : { revertedFrom }),
    });
  }

  return [
    route('POST', '/admin/publish', ['owner'], async (ctx) => {
      // Corte para «cambios pendientes»: se toma ANTES de leer, así un cambio que llegue durante
      // la lectura queda como pendiente en vez de perderse.
      const generatedAt = now().toISOString();
      const current = await repo.getCurrent();
      const raw = await repo.readCatalog();

      if (raw.publicSettings === null) throw new HttpError(422, 'settings_missing');
      const settingsParsed = publicSettingsSchema.safeParse(withoutKey(raw.publicSettings));
      if (!settingsParsed.success) {
        ctx.log.warn('invalid_stored_item', { entity: 'settings', id: 'public' });
        throw new HttpError(422, 'invalid_stored_item');
      }

      const doc = buildCatalogDocument(
        {
          stones: parseRows(raw.stones, stoneSchema, 'stone', ctx),
          finishes: parseRows(raw.finishes, finishSchema, 'finish', ctx),
          projects: parseRows(raw.projects, projectSchema, 'project', ctx),
          services: parseRows(raw.services, serviceSchema, 'service', ctx),
          publicSettings: settingsParsed.data,
          version: nextVersionAfter(current),
          generatedAt,
        },
        sha256,
      );

      if (current !== null && current.hash === doc.hash) return healCurrent(current, ctx);
      return publishDocument(ctx, current, doc, 'publish');
    }),

    route(
      'POST',
      '/admin/publications/{version}/revert',
      ['owner'],
      async (ctx) => {
        const target = ctx.params['version'] as string;
        const row = await repo.getPublication(target);
        if (row === null) throw new HttpError(404, 'not_found');
        const current = await repo.getCurrent();
        if (current !== null && current.hash === row.hash) return healCurrent(current, ctx);

        // Se reutiliza el contenido de la versión pedida; se escribe como una versión NUEVA.
        let stored: CatalogDocument;
        try {
          const parsed = catalogDocumentSchema.safeParse(
            JSON.parse(await storage.getImmutable(target)),
          );
          if (!parsed.success || parsed.data.hash !== row.hash || parsed.data.version !== target) {
            throw new HttpError(500, 'invalid_publication');
          }
          stored = parsed.data;
        } catch (err) {
          if (err instanceof HttpError) {
            ctx.log.error('invalid_publication', { version: target });
            throw err;
          }
          if (err instanceof ObjectMissingError || err instanceof SyntaxError) {
            ctx.log.error('invalid_publication', { version: target });
            throw new HttpError(500, 'invalid_publication');
          }
          throw err;
        }

        // Mismo contenido y mismo `generatedAt` (corte del contenido), versión nueva.
        const doc: CatalogDocument = { ...stored, version: nextVersionAfter(current) };
        return publishDocument(ctx, current, doc, 'revert', target);
      },
      { paramPattern: CATALOG_VERSION_PATTERN },
    ),

    route('GET', '/admin/publications', ['owner', 'staff'], async () => {
      const current = await repo.getCurrent();
      const latest = current === null ? 0 : sequenceOf(current.currentVersion);
      const versions: string[] = [];
      for (let n = latest; n >= 1 && versions.length < HISTORY_LIMIT; n--)
        versions.push(formatVersion(n));
      const [rows, pending] = await Promise.all([
        repo.getPublications(versions),
        repo.listPending(current === null ? null : current.generatedAt, PENDING_LIMIT),
      ]);
      return jsonResponse(200, {
        current:
          current === null
            ? null
            : {
                version: current.currentVersion,
                action: current.action,
                publishedAt: current.publishedAt,
                publishedBy: current.publishedBy,
              },
        publications: rows.map((r) => ({
          version: r.version,
          action: r.action,
          publishedAt: r.publishedAt,
          publishedBy: r.publishedBy,
          counts: r.counts,
          ...(r.revertedFrom === undefined ? {} : { revertedFrom: r.revertedFrom }),
        })),
        pending,
      });
    }),
  ];
}

function errName(err: unknown): string {
  return err instanceof Error ? err.name : 'unknown';
}

export function createPublishRouter(deps: PublishDeps, options: RouterOptions = {}) {
  return createRouter(createPublishRoutes(deps), options);
}

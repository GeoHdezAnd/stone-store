import {
  estimateFreight,
  FREIGHT_VERSION_PATTERN,
  FreightError,
  freightConfigSchema,
  parseFreightSimulateRequest,
  stoneSchema,
  type FreightConfig,
  type FreightItem,
  type Stone,
} from '@canteras/shared';
import { z } from 'zod';
import { buildAuditEntry } from '../lib/audit';
import { HttpError, jsonResponse } from '../lib/http';
import { createRouter, route, type Route, type RouterOptions } from '../lib/router';
import { validationErrorResponse } from '../lib/validation';
import {
  ACTIVE_KEY,
  ConflictError,
  type FreightRepository,
  type PointerRow,
  type VersionRow,
} from './repository';

export interface FreightDeps {
  repo: FreightRepository;
  /** Para pruebas: reloj. */
  now?: () => Date;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

const formatVersion = (n: number): string => `t${String(n).padStart(4, '0')}`;
const sequenceOf = (version: string): number => Number(version.slice(1));

/**
 * Cuerpo de `PUT /admin/freight-config`: la configuración SIN lo que decide el servidor
 * (`version`, `activa`, `creadaPor`, `creadaAt`), con `resumenCambio` obligatorio (1 a 300),
 * `baseVersion` opcional (control de concurrencia) y `activar` opcional. Estricto: cualquier
 * campo desconocido (incluido uno que intente fijar autor o fecha) se rechaza.
 */
const putBodySchema = freightConfigSchema
  .omit({ version: true, activa: true, creadaPor: true, creadaAt: true, resumenCambio: true })
  .extend({
    resumenCambio: z
      .string({ error: 'El resumen del cambio debe ser texto' })
      .min(1, 'El resumen del cambio es obligatorio')
      .max(300, 'El resumen del cambio admite máximo 300 caracteres'),
    baseVersion: z
      .string({ error: 'baseVersion debe ser texto' })
      .regex(FREIGHT_VERSION_PATTERN, 'baseVersion no es una versión válida')
      .optional(),
    activar: z.boolean({ error: 'activar debe ser verdadero o falso' }).optional(),
  });

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Copia solo los campos del resumen de una versión, con su tipo comprobado. */
function summarize(row: VersionRow, activeVersion: string | null) {
  const str = (k: string): string | undefined =>
    typeof row[k] === 'string' ? (row[k] as string) : undefined;
  const version = str('version') ?? '';
  return {
    version,
    activa: version === activeVersion,
    ...(typeof row['ejemplo'] === 'boolean' ? { ejemplo: row['ejemplo'] } : {}),
    creadaPor: str('creadaPor') ?? null,
    creadaAt: str('creadaAt') ?? null,
    resumenCambio: str('resumenCambio') ?? '',
  };
}

export function createFreightRoutes(deps: FreightDeps): Route[] {
  const { repo } = deps;
  const now = deps.now ?? (() => new Date());

  /** Valida una fila guardada; si no cumple, 500 sin detalles (y un log con la versión). */
  const parseStored = (
    row: VersionRow,
    version: string,
    log: { warn: (m: string, f?: Record<string, unknown>) => void },
  ): FreightConfig => {
    const parsed = freightConfigSchema.safeParse(row);
    if (!parsed.success) {
      log.warn('invalid_stored_item', { entity: 'freight-config', id: version });
      throw new HttpError(500, 'invalid_stored_item');
    }
    return parsed.data;
  };

  return [
    route('GET', '/admin/freight-config', ['owner', 'staff'], async (ctx) => {
      const rawLimit = ctx.query['limit'];
      const rawCursor = ctx.query['cursor'];
      if (
        (rawLimit !== undefined && !/^\d{1,3}$/.test(rawLimit)) ||
        (rawCursor !== undefined && !FREIGHT_VERSION_PATTERN.test(rawCursor))
      ) {
        throw new HttpError(400, 'invalid_query');
      }
      const limit = rawLimit === undefined ? DEFAULT_LIMIT : Number(rawLimit);
      if (limit < 1 || limit > MAX_LIMIT) throw new HttpError(400, 'invalid_query');

      const pointer = await repo.getPointer();
      if (pointer === null) {
        return jsonResponse(200, {
          activeVersion: null,
          latestVersion: null,
          versions: [],
          nextCursor: null,
        });
      }
      // Versiones consecutivas hacia atrás desde el cursor (exclusivo) o desde la última.
      const latest = sequenceOf(pointer.latestVersion);
      const start = rawCursor === undefined ? latest : Math.min(latest, sequenceOf(rawCursor) - 1);
      const wanted: string[] = [];
      for (let n = start; n >= 1 && wanted.length < limit; n--) wanted.push(formatVersion(n));
      const rows = await repo.getVersions(wanted);
      const last = wanted[wanted.length - 1];
      return jsonResponse(200, {
        activeVersion: pointer.activeVersion,
        latestVersion: pointer.latestVersion,
        versions: rows.map((r) => summarize(r, pointer.activeVersion)),
        nextCursor: last !== undefined && sequenceOf(last) > 1 ? last : null,
      });
    }),

    route(
      'GET',
      '/admin/freight-config/{version}',
      ['owner', 'staff'],
      async (ctx) => {
        const version = ctx.params['version'] as string;
        const [row, pointer] = await Promise.all([repo.getVersion(version), repo.getPointer()]);
        if (row === null) throw new HttpError(404, 'not_found');
        const config = parseStored(row, version, ctx.log);
        return jsonResponse(200, { ...config, activa: pointer?.activeVersion === version });
      },
      { paramPattern: FREIGHT_VERSION_PATTERN },
    ),

    route('PUT', '/admin/freight-config', ['owner'], async (ctx) => {
      const parsed = putBodySchema.safeParse(ctx.body);
      if (!parsed.success) return validationErrorResponse(parsed.error);
      const { baseVersion, activar, ...fields } = parsed.data;

      const pointer = await repo.getPointer();
      // Concurrencia optimista: «base» = la última versión que vio quien edita.
      if (baseVersion !== undefined && baseVersion !== (pointer?.latestVersion ?? null)) {
        throw new HttpError(409, 'conflict');
      }
      const version = formatVersion(pointer === null ? 1 : sequenceOf(pointer.latestVersion) + 1);
      const at = now();
      const atIso = at.toISOString();

      // Autor y fecha los fija el servidor. Se re-valida el documento completo (defensa en
      // profundidad: lo que se guarda es exactamente lo que el esquema del flete acepta).
      const full = freightConfigSchema.safeParse({
        ...fields,
        version,
        creadaPor: ctx.userId,
        creadaAt: atIso,
      });
      if (!full.success) return validationErrorResponse(full.error);
      const row = full.data;

      // La primera versión siempre queda activa (si no, no habría tarifa vigente).
      const activate = activar === true || pointer === null;
      const next: PointerRow = {
        version: ACTIVE_KEY,
        activeVersion: activate ? version : (pointer as PointerRow).activeVersion,
        latestVersion: version,
        activadaPor: activate ? ctx.userId : (pointer as PointerRow).activadaPor,
        activadaAt: activate ? atIso : (pointer as PointerRow).activadaAt,
      };
      // Resumen sin camiones ni tarifas: la versión completa ya es inmutable en su fila.
      const audit = buildAuditEntry({
        entityType: 'freight-config',
        entityId: version,
        userId: ctx.userId,
        action: 'create',
        before:
          pointer === null
            ? null
            : { activeVersion: pointer.activeVersion, latestVersion: pointer.latestVersion },
        after: {
          version,
          resumenCambio: row.resumenCambio,
          activa: activate,
          ...(row.ejemplo === undefined ? {} : { ejemplo: row.ejemplo }),
        },
        at,
        requestId: ctx.requestId,
      });
      try {
        await repo.createVersion({ basePointer: pointer, row, pointer: next, audit });
      } catch (err) {
        if (err instanceof ConflictError) throw new HttpError(409, 'conflict');
        throw err;
      }
      ctx.log.info('freight_config_created', { version, activa: activate, userId: ctx.userId });
      return jsonResponse(201, { ...row, activa: activate });
    }),

    route(
      'POST',
      '/admin/freight-config/{version}/activate',
      ['owner'],
      async (ctx) => {
        const version = ctx.params['version'] as string;
        const [pointer, row] = await Promise.all([repo.getPointer(), repo.getVersion(version)]);
        if (pointer === null || row === null) throw new HttpError(404, 'not_found');
        // No se activa una versión que el cálculo no podría leer.
        parseStored(row, version, ctx.log);
        if (pointer.activeVersion === version) {
          return jsonResponse(200, { changed: false, version, activa: true });
        }
        const at = now();
        const next: PointerRow = {
          ...pointer,
          activeVersion: version,
          activadaPor: ctx.userId,
          activadaAt: at.toISOString(),
        };
        const audit = buildAuditEntry({
          entityType: 'freight-config',
          entityId: version,
          userId: ctx.userId,
          action: 'update',
          before: { activa: false, activaAnterior: pointer.activeVersion },
          after: { activa: true },
          at,
          requestId: ctx.requestId,
        });
        try {
          await repo.setActive({ basePointer: pointer, pointer: next, audit });
        } catch (err) {
          if (err instanceof ConflictError) throw new HttpError(409, 'conflict');
          throw err;
        }
        ctx.log.info('freight_config_activated', {
          version,
          previous: pointer.activeVersion,
          userId: ctx.userId,
        });
        return jsonResponse(200, { changed: true, version, activa: true });
      },
      { paramPattern: FREIGHT_VERSION_PATTERN },
    ),

    route('POST', '/admin/freight/simulate', ['owner', 'staff'], async (ctx) => {
      const invalid = (errors: string[]) =>
        jsonResponse(400, { error: 'invalid_request', message: errors[0], errors });
      if (!isObject(ctx.body)) return invalid(['El cuerpo debe ser un objeto JSON']);

      // `version` y `skipZoneCheck` son de ESTA ruta (no del dominio): se separan antes de
      // validar el resto con el esquema estricto del simulador.
      const { version, skipZoneCheck, ...rest } = ctx.body;
      if (
        version !== undefined &&
        (typeof version !== 'string' || !FREIGHT_VERSION_PATTERN.test(version))
      ) {
        return invalid(['La versión de tarifas no es válida']);
      }
      if (skipZoneCheck !== undefined && typeof skipZoneCheck !== 'boolean') {
        return invalid(['skipZoneCheck debe ser verdadero o falso']);
      }
      const request = parseFreightSimulateRequest(rest);
      if (!request.ok) return invalid(request.errors);
      const { codigoPostal, distanciaKm, items } = request.data;

      // Tarifa: la pedida o la ACTIVA.
      let configRow: VersionRow | null;
      let configVersion: string;
      if (version !== undefined) {
        configVersion = version;
        configRow = await repo.getVersion(version);
        if (configRow === null) throw new HttpError(404, 'not_found');
      } else {
        const pointer = await repo.getPointer();
        if (pointer === null) throw new HttpError(409, 'freight_config_missing');
        configVersion = pointer.activeVersion;
        configRow = await repo.getVersion(configVersion);
        if (configRow === null) {
          ctx.log.error('active_version_missing', { version: configVersion });
          throw new HttpError(409, 'freight_config_missing');
        }
      }
      const config = parseStored(configRow, configVersion, ctx.log);

      // Piedras: solo las pedidas. El peso lo calcula el servidor con SUS datos.
      const stoneRows = await repo.getStones(items.map((i) => i.stoneId));
      const stones: Stone[] = stoneRows.map((r) => {
        const s = stoneSchema.safeParse(r);
        if (!s.success) {
          ctx.log.warn('invalid_stored_item', {
            entity: 'stone',
            id: typeof r['id'] === 'string' ? r['id'] : undefined,
          });
          throw new HttpError(500, 'invalid_stored_item');
        }
        return s.data;
      });

      try {
        const base = { distanciaKm, items: items as FreightItem[], stones, config };
        const estimate =
          skipZoneCheck === true
            ? estimateFreight({
                ...base,
                skipZoneCheck: true,
                ...(codigoPostal === undefined ? {} : { codigoPostal }),
              })
            : estimateFreight({ ...base, codigoPostal: codigoPostal as string });
        ctx.log.info('freight_simulated', { version: configVersion, userId: ctx.userId });
        return jsonResponse(200, estimate);
      } catch (err) {
        if (!(err instanceof FreightError)) throw err;
        // Solo el código (nunca los datos enviados) llega al log; el mensaje es seguro para el cliente.
        ctx.log.warn('freight_simulation_rejected', { code: err.code, userId: ctx.userId });
        const status = err.code === 'out_of_zone' || err.code === 'too_large' ? 422 : 400;
        return jsonResponse(status, { error: err.code, message: err.message });
      }
    }),
  ];
}

export function createFreightRouter(deps: FreightDeps, options: RouterOptions = {}) {
  return createRouter(createFreightRoutes(deps), options);
}

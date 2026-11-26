import {
  mailSettingsSchema,
  publicSettingsSchema,
  quotingSettingsSchema,
  SETTINGS_ROW_KEYS,
  type MailSettings,
  type PublicSettings,
  type QuotingSettings,
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
import { validationErrorResponse } from '../lib/validation';
import { ConflictError, type SettingsRepository, type SettingsRowKey } from './repository';

export interface SettingsRouterOptions extends RouterOptions {
  /** Para pruebas: reloj de la auditoría. */
  now?: () => Date;
}

const DEFAULT_QUOTING_SETTINGS: QuotingSettings = { ivaPctDefault: null };

/** Quita el atributo `key` (clave de la tabla) de una fila guardada. */
function withoutKey(row: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...row };
  delete rest['key'];
  return rest;
}

/**
 * Lee una fila y la valida. Ausente -> null. Inválida -> null y un `warn` con SOLO la clave de
 * fila (nunca valores): así el dashboard carga el formulario vacío y se corrige con PUT.
 */
async function readRow<T>(
  repo: SettingsRepository,
  key: SettingsRowKey,
  schema: ZodType<T>,
  ctx: HandlerContext,
): Promise<T | null> {
  const raw = await repo.get(key);
  if (raw === null) return null;
  const parsed = schema.safeParse(withoutKey(raw));
  if (parsed.success) return parsed.data;
  ctx.log.warn('invalid_stored_item', { key });
  return null;
}

export function createSettingsRoutes(
  repo: SettingsRepository,
  now: () => Date = () => new Date(),
): Route[] {
  // Un PUT por fila: una sola implementación para todas, parametrizada por clave y esquema.
  const putRoute = <T extends Record<string, unknown>>(
    id: 'public' | 'mail' | 'quoting',
    schema: ZodType<T>,
  ): Route =>
    route('PUT', `/admin/settings/${id}`, ['owner'], async (ctx) => {
      const parsed = schema.safeParse(ctx.body);
      if (!parsed.success) return validationErrorResponse(parsed.error);
      const data = parsed.data;
      const key = SETTINGS_ROW_KEYS[id];

      // Registro ÚNICO: UPSERT. La fila previa solo sirve para `antes` y para create/update.
      const current = await repo.get(key);
      const before = current === null ? null : withoutKey(current);
      const action = current === null ? 'create' : 'update';
      const entry = buildAuditEntry({
        entityType: 'settings',
        entityId: id,
        userId: ctx.userId,
        action,
        before,
        after: data,
        at: now(),
        requestId: ctx.requestId,
        // Solo la fila PUBLIC entra a catalog.json; MAIL (plantillas) y QUOTING (IVA por defecto) no.
        ...(id === 'public' ? { scope: 'CATALOG' as const } : {}),
      });
      try {
        await repo.put(key, data, entry);
      } catch (err) {
        if (err instanceof ConflictError) throw new HttpError(409, 'conflict');
        throw err;
      }
      // Sin valores: WhatsApp y correo nunca van a los logs.
      ctx.log.info('settings_write', { entity: 'settings', id, action, userId: ctx.userId });
      return jsonResponse(200, data);
    });

  return [
    route('GET', '/admin/settings', ['owner', 'staff'], async (ctx) => {
      const [pub, mail, quoting] = await Promise.all([
        readRow<PublicSettings>(repo, SETTINGS_ROW_KEYS.public, publicSettingsSchema, ctx),
        readRow<MailSettings>(repo, SETTINGS_ROW_KEYS.mail, mailSettingsSchema, ctx),
        readRow<QuotingSettings>(repo, SETTINGS_ROW_KEYS.quoting, quotingSettingsSchema, ctx),
      ]);
      // QUOTING ausente o inválida = valor por defecto (sin IVA): nunca tumba las otras filas.
      return jsonResponse(200, {
        public: pub,
        mail,
        quoting: quoting ?? DEFAULT_QUOTING_SETTINGS,
      });
    }),
    putRoute('public', publicSettingsSchema),
    putRoute('mail', mailSettingsSchema),
    putRoute('quoting', quotingSettingsSchema),
  ];
}

export function createSettingsRouter(
  repo: SettingsRepository,
  options: SettingsRouterOptions = {},
) {
  const { now, ...routerOptions } = options;
  return createRouter(createSettingsRoutes(repo, now), routerOptions);
}

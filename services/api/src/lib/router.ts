import { hasAnyRole, isRole, parseGroupsClaim, rolesFromGroups, type Role } from '@canteras/shared';
import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import { HttpError, jsonResponse } from './http';
import { createLogger, type LogSink, type Logger } from './logger';

export const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type Method = (typeof METHODS)[number];

export interface HandlerContext {
  body: unknown;
  params: Record<string, string>;
  query: Record<string, string>;
  userId: string;
  roles: Role[];
  requestId: string;
  log: Logger;
}

export type Handler = (ctx: HandlerContext) => Promise<APIGatewayProxyStructuredResultV2>;

export interface Route {
  readonly method: Method;
  readonly path: string;
  readonly roles: readonly [Role, ...Role[]];
  readonly handler: Handler;
  /** Lista blanca de cada parámetro ya decodificado. Por defecto `DEFAULT_PARAM_PATTERN`. */
  readonly paramPattern: RegExp;
}

export interface RouteOptions {
  paramPattern?: RegExp;
}

// Excluye '.', '..', '/', '#', '%' y espacios: protege claves de DynamoDB y rutas de S3.
export const DEFAULT_PARAM_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface RouterOptions {
  /** Prefijo de etapa a recortar de `rawPath` (p. ej. `/dev`). Sin barra final. */
  basePath?: string;
  /** Tope del cuerpo ya decodificado, en bytes. Por defecto 262144. */
  maxBodyBytes?: number;
  /** Para pruebas: destino de los logs. */
  logSink?: LogSink;
}

const DEFAULT_MAX_BODY = 262_144;
const LITERAL_RE = /^[A-Za-z0-9._~-]+$/;
const PARAM_RE = /^\{([A-Za-z][A-Za-z0-9]*)\}$/;

/**
 * Declara una ruta. `roles` es obligatorio y no vacío: la API deniega por defecto y cada
 * ruta enumera explícitamente quién puede entrar (sin jerarquía: owner no implica staff).
 */
export function route(
  method: Method,
  path: string,
  roles: readonly [Role, ...Role[]],
  handler: Handler,
  options: RouteOptions = {},
): Route {
  if (!Array.isArray(roles) || roles.length === 0 || !roles.every(isRole)) {
    throw new Error(`Ruta ${method} ${path}: roles vacíos o inválidos.`);
  }
  return Object.freeze({
    method,
    path,
    roles: Object.freeze([...roles]) as unknown as readonly [Role, ...Role[]],
    handler,
    paramPattern: options.paramPattern ?? DEFAULT_PARAM_PATTERN,
  });
}

interface Compiled {
  route: Route;
  segments: string[];
  paramNames: string[];
}

function compile(r: Route): Compiled {
  if (!(METHODS as readonly string[]).includes(r.method)) {
    throw new Error(`Método no permitido: ${String(r.method)}.`);
  }
  if (typeof r.path !== 'string' || !r.path.startsWith('/')) {
    throw new Error(`Patrón inválido (debe empezar con "/"): ${String(r.path)}.`);
  }
  const segments = r.path === '/' ? [] : r.path.slice(1).split('/');
  const paramNames: string[] = [];
  for (const seg of segments) {
    const m = PARAM_RE.exec(seg);
    if (m) {
      const name = m[1] as string;
      if (paramNames.includes(name))
        throw new Error(`Patrón inválido (parámetro repetido): ${r.path}.`);
      paramNames.push(name);
    } else if (!LITERAL_RE.test(seg)) {
      throw new Error(`Patrón inválido (segmento no permitido "${seg}"): ${r.path}.`);
    }
  }
  return { route: r, segments, paramNames };
}

function shapeKey(c: Compiled): string {
  return `${c.route.method} /${c.segments.map((s) => (PARAM_RE.test(s) ? '{}' : s)).join('/')}`;
}

function splitPath(path: string): string[] | null {
  let p = path;
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  if (!p.startsWith('/')) return null;
  return p === '/' ? [] : p.slice(1).split('/');
}

function stripBase(rawPath: string, basePath: string): string | null {
  if (basePath === '') return rawPath;
  if (rawPath === basePath) return '/';
  return rawPath.startsWith(`${basePath}/`) ? rawPath.slice(basePath.length) : null;
}

const json = jsonResponse;

export function createRouter(routes: readonly Route[], options: RouterOptions = {}) {
  const basePath = options.basePath ?? '';
  if (basePath !== '' && (!basePath.startsWith('/') || basePath.endsWith('/'))) {
    throw new Error('basePath debe empezar con "/" y no terminar con "/".');
  }
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY;
  if (!Number.isFinite(maxBodyBytes) || maxBodyBytes <= 0) {
    throw new Error('maxBodyBytes debe ser un número positivo.');
  }

  const compiled = routes.map((r) => {
    // Se re-valida aunque el tipo ya lo exija: route() puede haberse esquivado con un cast.
    if (!Array.isArray(r.roles) || r.roles.length === 0 || !r.roles.every(isRole)) {
      throw new Error(`Ruta ${r.method} ${r.path}: roles vacíos o inválidos.`);
    }
    return compile(r);
  });
  const seen = new Set<string>();
  for (const c of compiled) {
    const key = shapeKey(c);
    if (seen.has(key)) throw new Error(`Ruta duplicada: ${key}.`);
    seen.add(key);
  }

  function find(method: string, segs: string[]): { c: Compiled; raw: string[] } | null {
    for (const c of compiled) {
      if (c.route.method !== method || c.segments.length !== segs.length) continue;
      const ok = c.segments.every((s, i) => {
        const v = segs[i] as string;
        return PARAM_RE.test(s) ? v !== '' : s === v;
      });
      if (ok) return { c, raw: segs };
    }
    return null;
  }

  async function handle(
    event: APIGatewayProxyEventV2WithJWTAuthorizer,
  ): Promise<APIGatewayProxyStructuredResultV2> {
    // (1) contexto
    const rc = event?.requestContext as
      Partial<APIGatewayProxyEventV2WithJWTAuthorizer['requestContext']> | undefined;
    const requestId =
      typeof rc?.requestId === 'string' && rc.requestId !== '' ? rc.requestId : 'unknown';
    const log = createLogger({ requestId }, options.logSink);

    try {
      // (2) sin claims = la ruta no pasó por el authorizer: se falla cerrado.
      const claims = rc?.authorizer?.jwt?.claims;
      if (claims === undefined || claims === null || typeof claims !== 'object') {
        log.warn('missing_jwt_claims');
        return json(401, { error: 'unauthorized' });
      }
      // Solo access tokens: un id token también pasa el authorizer del gateway y trae los mismos
      // grupos, pero no es una credencial de API. Falla cerrado ANTES de buscar la ruta.
      // Nota: un token revocado sigue siendo válido hasta que expira (1 h), porque API Gateway
      // valida la firma sin consultar a Cognito.
      if ((claims as Record<string, unknown>).token_use !== 'access') {
        log.warn('invalid_token_use');
        return json(401, { error: 'unauthorized' });
      }
      const sub = (claims as Record<string, unknown>).sub;
      if (typeof sub !== 'string' || sub === '') {
        log.warn('missing_sub_claim');
        return json(401, { error: 'unauthorized' });
      }

      // (3) ruta por método + ruta
      const method = rc?.http?.method ?? '';
      const stripped =
        typeof event.rawPath === 'string' ? stripBase(event.rawPath, basePath) : null;
      const segs = stripped === null ? null : splitPath(stripped);
      const match = segs === null ? null : find(method, segs);
      if (match === null) return json(404, { error: 'not_found' });
      const { c } = match;

      // (4) autorización ANTES de tocar el cuerpo
      const roles = rolesFromGroups(
        parseGroupsClaim((claims as Record<string, unknown>)['cognito:groups']),
      );
      if (!hasAnyRole(roles, c.route.roles)) {
        log.warn('forbidden', { userId: sub, method, route: c.route.path });
        return json(403, { error: 'forbidden' });
      }

      // (5) tope de tamaño (bytes decodificados)
      const rawBody = typeof event.body === 'string' ? event.body : '';
      const size =
        event.isBase64Encoded === true
          ? Buffer.byteLength(rawBody, 'base64')
          : Buffer.byteLength(rawBody, 'utf8');
      if (size > maxBodyBytes) return json(413, { error: 'payload_too_large' });

      // (6) JSON solo si hay cuerpo
      let body: unknown;
      if (rawBody !== '') {
        const text =
          event.isBase64Encoded === true
            ? Buffer.from(rawBody, 'base64').toString('utf8')
            : rawBody;
        try {
          body = JSON.parse(text);
        } catch {
          return json(400, { error: 'invalid_json' });
        }
      }

      // Parámetros (objetos sin prototipo: `__proto__` es un valor más, no un atajo).
      const params: Record<string, string> = Object.create(null) as Record<string, string>;
      try {
        c.segments.forEach((s, i) => {
          const m = PARAM_RE.exec(s);
          if (!m) return;
          const value = decodeURIComponent(match.raw[i] as string);
          // Sin /g ni /y: `test` no guarda estado entre llamadas.
          if (!c.route.paramPattern.test(value)) throw new Error('invalid_param');
          params[m[1] as string] = value;
        });
      } catch {
        return json(400, { error: 'invalid_path' });
      }
      const query: Record<string, string> = Object.create(null) as Record<string, string>;
      for (const [k, v] of Object.entries(event.queryStringParameters ?? {})) {
        if (typeof v === 'string') query[k] = v;
      }

      // (7) handler
      return await c.route.handler({ body, params, query, userId: sub, roles, requestId, log });
    } catch (err) {
      // (8) errores
      if (err instanceof HttpError) {
        const ok = Number.isInteger(err.status) && err.status >= 400 && err.status <= 599;
        return ok
          ? json(err.status, { error: err.code })
          : json(500, { error: 'internal_error', requestId });
      }
      log.error('unhandled_error', {
        err,
        stack: err instanceof Error ? err.stack : undefined,
      });
      return json(500, { error: 'internal_error', requestId });
    }
  }

  return { handle };
}

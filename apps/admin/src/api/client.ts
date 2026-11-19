import { z } from 'zod';
import { ApiError, API_ERROR_CODES } from './errors';
import type { ApiErrorCode, ApiIssue } from './errors';

/** Lo que el cliente necesita de la sesión (la implementa `AuthService`). */
export interface ApiAuth {
  getAccessToken(): Promise<string>;
  refreshAccessToken(): Promise<string>;
  signOut(): Promise<void>;
}

export interface ApiRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
}

export type ApiFetch = <T = unknown>(path: string, options?: ApiRequestOptions) => Promise<T>;

const errorBody = z.object({
  error: z.string().optional(),
  issues: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  message: z.string().optional(),
  field: z.string().optional(),
  ids: z.array(z.string()).optional(),
  requestId: z.string().optional(),
});

const KNOWN = new Set<string>(API_ERROR_CODES);

/** Código a partir del estado HTTP cuando el cuerpo no trae uno reconocible. */
function codeFromStatus(status: number): ApiErrorCode {
  switch (status) {
    case 401:
      return 'unauthorized';
    case 403:
      return 'forbidden';
    case 404:
      return 'not_found';
    case 413:
      return 'payload_too_large';
    case 429:
      return 'rate_limited';
    case 500:
      return 'internal_error';
    default:
      return 'unknown';
  }
}

async function readJson(res: Response): Promise<unknown> {
  let text: string;
  try {
    text = await res.text();
  } catch {
    return undefined;
  }
  if (text === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Solo se acepta cuerpo vacío (204 incluido) o JSON válido con content-type JSON. */
async function readSuccessBody(res: Response): Promise<unknown> {
  if (res.status === 204) return undefined;
  let text: string;
  try {
    text = await res.text();
  } catch {
    throw new ApiError({ status: res.status, code: 'unknown' });
  }
  if (text === '') return undefined;
  const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (type !== 'application/json' && !type.endsWith('+json')) {
    throw new ApiError({ status: res.status, code: 'unknown' });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiError({ status: res.status, code: 'unknown' });
  }
}

/**
 * Valida la ruta ANTES de adjuntar el token: una sola `/` inicial, sin `\`, sin caracteres de
 * control y sin segmentos `.`/`..` (ni codificados, ni con doble o triple codificación). Evita que
 * `/stones/../../otra-api` se normalice dentro del mismo host con el Bearer adjunto.
 * El mensaje es fijo: no repite la ruta.
 */
function assertSafePath(path: string): void {
  const invalid = () => new TypeError('La ruta de la API no es válida.');
  if (!path.startsWith('/') || path.startsWith('//')) throw invalid();
  // eslint-disable-next-line no-control-regex
  if (/[\\\u0000-\u001f\u007f]/.test(path)) throw invalid();
  const pathname = path.split(/[?#]/)[0]!;
  for (const segment of pathname.split('/')) {
    let decoded = segment;
    for (let i = 0; i < 4; i += 1) {
      let next: string;
      try {
        next = decodeURIComponent(decoded);
      } catch {
        throw invalid();
      }
      if (next === decoded) break;
      decoded = next;
    }
    // eslint-disable-next-line no-control-regex
    if (decoded === '.' || decoded === '..' || /[\\\u0000-\u001f\u007f]/.test(decoded)) {
      throw invalid();
    }
  }
}

async function toApiError(res: Response): Promise<ApiError> {
  const parsed = errorBody.safeParse(await readJson(res));
  const body = parsed.success ? parsed.data : {};
  // Un código que el servidor mande pero no conocemos NO se propaga (podría ser cualquier texto).
  const code: ApiErrorCode =
    body.error !== undefined && KNOWN.has(body.error) && body.error !== 'network'
      ? (body.error as ApiErrorCode)
      : codeFromStatus(res.status);
  const issues: ApiIssue[] | undefined = body.issues;
  return new ApiError({
    status: res.status,
    code,
    issues,
    detail: body.message,
    field: body.field,
    ids: body.ids,
    requestId: body.requestId,
  });
}

/**
 * Cliente de la API de administración. Adjunta el ACCESS token (nunca el id token) en la
 * cabecera Authorization; jamás en la URL. Ante un 401 renueva UNA vez y reintenta UNA vez;
 * si vuelve a fallar, cierra la sesión.
 */
export function createApiClient(deps: {
  apiUrl: string;
  auth: ApiAuth;
  fetchImpl?: typeof fetch;
}): ApiFetch {
  const { apiUrl, auth } = deps;
  const doFetch = deps.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));

  async function send(path: string, token: string, options: ApiRequestOptions): Promise<Response> {
    const headers = new Headers({ Accept: 'application/json', Authorization: `Bearer ${token}` });
    const init: RequestInit = { method: options.method ?? 'GET', headers };
    if (options.body !== undefined) {
      headers.set('Content-Type', 'application/json');
      init.body = JSON.stringify(options.body);
    }
    if (options.signal) init.signal = options.signal;
    try {
      return await doFetch(`${apiUrl}${path}`, init);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      throw new ApiError({ status: 0, code: 'network' });
    }
  }

  const unauthorized = () => new ApiError({ status: 401, code: 'unauthorized' });

  return async function apiFetch<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
    assertSafePath(path);

    let token: string;
    try {
      token = await auth.getAccessToken();
    } catch {
      throw unauthorized();
    }

    let res = await send(path, token, options);

    if (res.status === 401) {
      let fresh: string;
      try {
        fresh = await auth.refreshAccessToken();
      } catch {
        throw unauthorized();
      }
      res = await send(path, fresh, options);
      if (res.status === 401) {
        await auth.signOut();
        throw unauthorized();
      }
    }

    if (!res.ok) throw await toApiError(res);
    return (await readSuccessBody(res)) as T;
  };
}

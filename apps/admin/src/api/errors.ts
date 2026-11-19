export type ApiErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'invalid_path'
  | 'invalid_query'
  | 'invalid_cursor'
  | 'invalid_json'
  | 'id_mismatch'
  | 'payload_too_large'
  | 'already_exists'
  | 'conflict'
  | 'validation_error'
  | 'invalid_reference'
  | 'rate_limited'
  | 'internal_error'
  | 'network'
  | 'unknown';

export type ApiErrorKind =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'bad_request'
  | 'too_large'
  | 'conflict'
  | 'validation'
  | 'rate_limited'
  | 'server'
  | 'network'
  | 'unknown';

export interface ApiIssue {
  path: string;
  message: string;
}

const KIND: Record<ApiErrorCode, ApiErrorKind> = {
  unauthorized: 'unauthorized',
  forbidden: 'forbidden',
  not_found: 'not_found',
  invalid_path: 'bad_request',
  invalid_query: 'bad_request',
  invalid_cursor: 'bad_request',
  invalid_json: 'bad_request',
  id_mismatch: 'bad_request',
  payload_too_large: 'too_large',
  already_exists: 'conflict',
  conflict: 'conflict',
  validation_error: 'validation',
  invalid_reference: 'validation',
  rate_limited: 'rate_limited',
  internal_error: 'server',
  network: 'network',
  unknown: 'unknown',
};

export const API_ERROR_CODES = Object.keys(KIND) as ApiErrorCode[];

/**
 * Error de la API. El `message` solo lleva el código (nunca issues, requestId ni tokens);
 * para mostrarlo a la persona usa `describeError`.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly kind: ApiErrorKind;
  readonly issues?: ApiIssue[];
  /** Solo en `invalid_reference`: campo con la referencia rota e ids que no existen. */
  readonly field?: string;
  readonly ids?: string[];
  readonly requestId?: string;

  constructor(init: {
    status: number;
    code: ApiErrorCode;
    issues?: ApiIssue[] | undefined;
    field?: string | undefined;
    ids?: string[] | undefined;
    requestId?: string | undefined;
  }) {
    super(`API ${init.status} ${init.code}`);
    this.name = 'ApiError';
    this.status = init.status;
    this.code = init.code;
    this.kind = KIND[init.code];
    if (init.issues) this.issues = init.issues;
    if (init.field) this.field = init.field;
    if (init.ids) this.ids = init.ids;
    if (init.requestId) this.requestId = init.requestId;
  }
}

/** Error con un mensaje ya listo para mostrar en español (p. ej. fallos de subida de archivos). */
export class UserMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserMessageError';
  }
}

const MESSAGES: Record<ApiErrorCode, string> = {
  unauthorized: 'Tu sesión expiró. Inicia sesión de nuevo.',
  forbidden: 'No tienes permiso para realizar esta acción.',
  not_found: 'No encontramos lo que buscas. Puede que ya no exista.',
  invalid_path: 'La solicitud no es válida. Recarga la página e inténtalo de nuevo.',
  invalid_query: 'La solicitud no es válida. Recarga la página e inténtalo de nuevo.',
  invalid_cursor: 'La lista cambió mientras la consultabas. Vuelve a cargarla.',
  invalid_json: 'La solicitud no es válida. Recarga la página e inténtalo de nuevo.',
  id_mismatch: 'La solicitud no es válida. Recarga la página e inténtalo de nuevo.',
  payload_too_large: 'El contenido enviado es demasiado grande.',
  already_exists: 'Ya existe un registro con ese identificador.',
  conflict: 'El registro cambió mientras lo editabas. Recárgalo e inténtalo de nuevo.',
  validation_error: 'Hay datos que no son válidos. Revisa los campos e inténtalo de nuevo.',
  invalid_reference: 'Hay una referencia a un elemento que no existe.',
  rate_limited: 'Demasiadas solicitudes. Espera unos segundos e inténtalo de nuevo.',
  internal_error: 'Ocurrió un error en el servidor. Inténtalo de nuevo más tarde.',
  network: 'No pudimos conectarnos con el servidor. Revisa tu conexión.',
  unknown: 'Ocurrió un error inesperado. Inténtalo de nuevo.',
};

/** Mensaje en español para mostrar. No expone detalles internos ni repite datos del usuario. */
export function describeError(err: unknown): string {
  if (err instanceof UserMessageError) return err.message;
  if (err instanceof ApiError) {
    if (err.code === 'invalid_reference' && err.field && err.ids?.length) {
      return `El campo «${err.field}» hace referencia a elementos que no existen: ${err.ids.join(', ')}.`;
    }
    return MESSAGES[err.code];
  }
  return 'Ocurrió un error inesperado. Inténtalo de nuevo.';
}

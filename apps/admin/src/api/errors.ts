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
  | 'copy_failed'
  | 'invalid_request'
  | 'invalid_postal_code'
  | 'invalid_distance'
  | 'invalid_items'
  | 'invalid_quantity'
  | 'unknown_stone'
  | 'inactive_stone'
  | 'unit_not_sold'
  | 'thickness_not_available'
  | 'out_of_zone'
  | 'too_large'
  | 'freight_config_missing'
  | 'invalid_stored_item'
  | 'settings_missing'
  | 'invalid_publication'
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
  copy_failed: 'server',
  invalid_request: 'bad_request',
  invalid_postal_code: 'bad_request',
  invalid_distance: 'bad_request',
  invalid_items: 'bad_request',
  invalid_quantity: 'bad_request',
  unknown_stone: 'bad_request',
  inactive_stone: 'bad_request',
  unit_not_sold: 'bad_request',
  thickness_not_available: 'bad_request',
  out_of_zone: 'validation',
  too_large: 'validation',
  freight_config_missing: 'conflict',
  invalid_stored_item: 'validation',
  settings_missing: 'validation',
  invalid_publication: 'server',
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
  /** Mensaje del servidor ya en español (solo para errores de reglas de negocio de flete). */
  readonly detail?: string;
  readonly requestId?: string;

  constructor(init: {
    status: number;
    code: ApiErrorCode;
    issues?: ApiIssue[] | undefined;
    detail?: string | undefined;
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
    if (init.detail) this.detail = init.detail;
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
  conflict: 'Otra persona guardó cambios antes que tú. Recarga e inténtalo de nuevo.',
  validation_error: 'Hay datos que no son válidos. Revisa los campos e inténtalo de nuevo.',
  invalid_reference: 'Hay una referencia a un elemento que no existe.',
  invalid_request: 'La solicitud no es válida.',
  invalid_postal_code: 'El código postal no es válido.',
  invalid_distance: 'La distancia no es válida.',
  invalid_items: 'Los renglones no son válidos.',
  invalid_quantity: 'Una cantidad no es válida.',
  unknown_stone: 'Una piedra ya no existe.',
  inactive_stone: 'Una piedra está dada de baja.',
  unit_not_sold: 'Esa piedra no se vende en esa unidad.',
  thickness_not_available: 'Ese espesor no está disponible para la piedra.',
  out_of_zone: 'Esa ubicación queda fuera de la zona de entrega: consúltenos por WhatsApp.',
  too_large: 'El pedido es demasiado grande: consúltenos por WhatsApp.',
  freight_config_missing:
    'Todavía no hay una tarifa de flete activa. Carga el seed de ejemplo o guarda una versión.',
  copy_failed:
    'La publicación se guardó, pero no se pudo actualizar la copia vigente del sitio. Vuelve a intentarlo.',
  invalid_stored_item:
    'Hay un registro guardado con datos no válidos y no se puede publicar. Revísalo en su pantalla.',
  settings_missing: 'Falta guardar los datos del patio en Configuración antes de publicar.',
  invalid_publication: 'Esa versión guardada está dañada y no se puede usar.',
  rate_limited: 'Demasiadas solicitudes. Espera unos segundos e inténtalo de nuevo.',
  internal_error: 'Ocurrió un error en el servidor. Inténtalo de nuevo más tarde.',
  network: 'No pudimos conectarnos con el servidor. Revisa tu conexión.',
  unknown: 'Ocurrió un error inesperado. Inténtalo de nuevo.',
};

/** Códigos cuyo mensaje del servidor es seguro y más preciso que el genérico. */
const DETAIL_CODES = new Set<ApiErrorCode>([
  'invalid_request',
  'invalid_postal_code',
  'invalid_distance',
  'invalid_items',
  'invalid_quantity',
  'unknown_stone',
  'inactive_stone',
  'unit_not_sold',
  'thickness_not_available',
  'out_of_zone',
  'too_large',
]);

/** Mensaje en español para mostrar. No expone detalles internos ni repite datos del usuario. */
export function describeError(err: unknown): string {
  if (err instanceof UserMessageError) return err.message;
  if (err instanceof ApiError) {
    if (err.code === 'invalid_reference' && err.field && err.ids?.length) {
      return `El campo «${err.field}» hace referencia a elementos que no existen: ${err.ids.join(', ')}.`;
    }
    if (err.detail && DETAIL_CODES.has(err.code)) return err.detail;
    return MESSAGES[err.code];
  }
  return 'Ocurrió un error inesperado. Inténtalo de nuevo.';
}

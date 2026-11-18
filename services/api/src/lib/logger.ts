export type LogSink = (line: string) => void;
export type LogFields = Record<string, unknown>;

export interface Logger {
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

// Se compara la clave normalizada (minúsculas, sin `_`, `-` ni espacios) por SUBCADENA.
// `codigoPostal` se deja en claro a propósito: por sí solo no identifica a una persona
// y sirve para diagnosticar cobertura de flete.
const REDACTED_FRAGMENTS = [
  'token',
  'secret',
  'password',
  'contrasena',
  'cookie',
  'auth',
  'apikey',
  'correo',
  'email',
  'telefono',
  'phone',
  'whatsapp',
  'customer',
  'nombre',
  // URLs prefirmadas de S3: la URL y su firma son secretos de corta vida.
  'url',
  'signature',
  'credential',
];

const MAX_DEPTH = 8;
const MAX_STRING = 2048;
const MAX_LINE = 16 * 1024;
// Todos los regex están acotados y se aplican sobre cadenas ya truncadas (anti-ReDoS).
// Limitación documentada: correos ofuscados como `juan[at]x.com` NO se enmascaran.
const EMAIL_RE = /[^\s@]{1,64}@[^\s@]{1,255}/g;
// Parámetros de firma de S3 (`X-Amz-Signature=...`) dentro de un texto libre, crudos o con la URL
// codificada (`=` como %3D, hasta 4 niveles de %25). El valor termina en `&`, `%26`, espacio,
// comilla o fin. Acotado (2048 y hasta 4 niveles) para evitar ReDoS.
const SIGNED_PARAM_RE =
  /X-Amz-(?:Signature|Credential|Security-Token)(?:=|%(?:25){0,4}3D)(?:(?!%(?:25){0,4}26)[^&\s"'`]){0,2048}/gi;
const DIGITS_RE = /(?:\+?\d[\s().-]{0,2}){10,20}/g;

function isSensitiveKey(key: string): boolean {
  const k = key.toLowerCase().replace(/[_\s-]/g, '');
  return REDACTED_FRAGMENTS.some((f) => k.includes(f));
}

// Un UUID no es un dato personal y sus dígitos con guiones parecen un teléfono: se conserva
// tal cual (las claves de S3 llevan uno) y solo se enmascara el resto del texto.
const UUID_SPLIT_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;

function maskString(s: string): string {
  const t = s.length > MAX_STRING ? `${s.slice(0, MAX_STRING)}…[truncated]` : s;
  // Con grupo de captura, `split` deja los UUID en los índices impares.
  return t
    .split(UUID_SPLIT_RE)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part
            .replace(SIGNED_PARAM_RE, 'X-Amz-[redacted]=[redacted]')
            .replace(EMAIL_RE, '[email]')
            .replace(DIGITS_RE, '[digits]'),
    )
    .join('');
}

function sanitize(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return maskString(value);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function' || typeof value === 'symbol') return '[unserializable]';
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  if (depth >= MAX_DEPTH) return '[max-depth]';
  seen.add(value);
  try {
    if (value instanceof Error) {
      // El stack lo agrega explícitamente quien lo necesite (el router); aquí no se filtra solo.
      const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      out.name = value.name;
      out.message = maskString(value.message);
      if (value.cause !== undefined) out.cause = sanitize(value.cause, depth + 1, seen);
      return out;
    }
    if (Array.isArray(value)) return value.map((v) => sanitize(v, depth + 1, seen));
    // Sin prototipo: una clave `__proto__` se conserva como dato y no cambia el prototipo.
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [k, v] of Object.entries(value)) {
      out[k] = isSensitiveKey(k) ? '[redacted]' : sanitize(v, depth + 1, seen);
    }
    return out;
  } finally {
    // Permite el mismo objeto en ramas hermanas; solo se detectan ciclos reales.
    seen.delete(value);
  }
}

/** Logger JSON estructurado: una línea por evento, con redacción de PII y secretos. */
export function createLogger(
  base: { requestId?: string } = {},
  sink: LogSink = (line) => console.log(line),
): Logger {
  const emit = (level: 'info' | 'warn' | 'error', msg: string, fields: LogFields = {}) => {
    let line: string;
    try {
      const safe = sanitize(fields, 0, new WeakSet()) as Record<string, unknown>;
      const head = {
        level,
        msg: maskString(msg),
        ...(base.requestId === undefined ? {} : { requestId: base.requestId }),
      };
      line = JSON.stringify({ ...safe, ...head });
      if (line.length > MAX_LINE) line = JSON.stringify({ ...head, truncated: true });
    } catch {
      line = JSON.stringify({ level, msg: '[log-serialization-failed]' });
    }
    try {
      sink(line);
    } catch {
      // Un fallo del log nunca debe tumbar la petición.
    }
  };
  return {
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
  };
}

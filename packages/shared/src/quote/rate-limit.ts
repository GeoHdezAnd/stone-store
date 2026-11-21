// Límite de solicitudes de `POST /quotes` (anti abuso). Dominio puro: aquí solo van los topes y los
// nombres de las claves del contador en la tabla `Counters`. El hash (sha256) lo calcula quien llama
// (services, con `node:crypto`): shared es isomórfico y las claves NUNCA llevan correo ni IP en claro.

/** Solicitudes aceptadas por día (UTC) para un mismo correo normalizado. */
export const MAX_QUOTES_PER_EMAIL_PER_DAY = 5;
/** Solicitudes aceptadas por día (UTC) desde una misma IP. */
export const MAX_QUOTES_PER_IP_PER_DAY = 20;
/** Vida del contador (atributo `ttl` de DynamoDB): el día en curso más margen para el desfase de zona. */
export const RATE_LIMIT_TTL_SECONDS = 2 * 24 * 60 * 60;

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/** Fecha UTC `AAAA-MM-DD`: el cupo se reinicia a las 00:00 UTC. */
export function rateLimitDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function key(kind: 'email' | 'ip', hash: string, now: Date): string {
  if (!SHA256_HEX_RE.test(hash)) {
    throw new RangeError('La clave del límite solo admite un sha256 en hexadecimal minúscula.');
  }
  return `rate#${kind}#${hash}#${rateLimitDay(now)}`;
}

/** `rate#email#<sha256 del correo normalizado>#<AAAA-MM-DD UTC>`. */
export const emailRateKey = (emailHash: string, now: Date): string => key('email', emailHash, now);

/** `rate#ip#<sha256 de la IP>#<AAAA-MM-DD UTC>`. */
export const ipRateKey = (ipHash: string, now: Date): string => key('ip', ipHash, now);

/** Segundos epoch en que expira el contador (valor del atributo `ttl`). */
export function rateLimitExpiresAt(now: Date): number {
  return Math.floor(now.getTime() / 1000) + RATE_LIMIT_TTL_SECONDS;
}

/**
 * Correo para contar: minúsculas, sin espacios y sin la etiqueta `+algo` del usuario, para que
 * `ana+1@x.mx` y `ana+2@x.mx` (el mismo buzón en casi todos los proveedores) compartan cupo.
 */
export function normalizeEmailForRate(correo: string): string {
  const clean = correo.trim().toLowerCase();
  const at = clean.lastIndexOf('@');
  if (at < 1) return clean;
  const local = clean.slice(0, at);
  const plus = local.indexOf('+');
  return `${plus > 0 ? local.slice(0, plus) : local}${clean.slice(at)}`;
}

/** Segundos hasta que el cupo se reinicia (00:00 UTC siguiente), para la cabecera `retry-after`. */
export function secondsUntilNextRateLimitDay(now: Date): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}
